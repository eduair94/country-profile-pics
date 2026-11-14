/**
 * Everything on disk lives under one output folder, shared by every run, so a
 * picture is never downloaded twice — not by a resumed run, not by a second
 * run with different filters, not by an "all countries" run.
 *
 *   <out>/pictures/UY/598XXXXXXXX.jpg     current picture of a number
 *   <out>/pictures/UY/598XXXXXXXX_2.jpg   an older picture ("include history")
 *   <out>/data/UY.jsonl                   every search record seen (newest line wins)
 *   <out>/data/UY.files.csv               ledger: one row per picture of a number (newest row
 *                                         wins); `shared` names the identical picture it links to
 *   <out>/runs/<run>.json                 cursor + totals of one filter combination
 *   <out>/runs/<run>.numbers              numbers that run matched ("UY,598…" per line)
 *   <out>/runs/<run>.failed.json          pictures that failed, retried by the next run
 *   <out>/exports/<run>.csv / .zip        generated on request
 */
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'

export const FILES_COLUMNS = ['country', 'number', 'kind', 'file', 'bytes', 'md5', 'source_md5', 'shared', 'saved_at']
const STATE_VERSION = 2

export const hashKey = (md5) => String(md5 ?? '').slice(0, 16).toLowerCase()

export async function fileExists(file) {
  try {
    const s = await stat(file)
    return s.isFile() && s.size > 0
  } catch {
    return false
  }
}

function csvCell(value) {
  const s = value == null ? '' : String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Parse one CSV line written by csvCell (quotes, escaped quotes, commas). */
export function parseCsvLine(line) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (c === '"') quoted = false
      else cur += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

export async function* readLines(file) {
  if (!(await fileExists(file))) return
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of rl) if (line) yield line
}

export class Store {
  constructor(root) {
    this.root = path.resolve(root)
    /** md5 prefix of the saved bytes → relative picture path. */
    this.hashes = new Map()
    /**
     * The API's `md5Image` hashes the source image, not the JPEG the CDN
     * serves, so it has its own index. It recognises an identical picture
     * before anything is downloaded.
     */
    this.sourceHashes = new Map()
    this.indexedCountries = new Set()
    /** country → Map(number → source md5 of its current picture, own or linked), for "refresh changed". */
    this.currentSource = new Map()
    /** Own picture paths (`UY/598….jpg`, `UY/598…_2.jpg`) that are links to an identical picture. */
    this.linkedPaths = new Set()
    /** Saved picture path → Map(own path of each link to it → its ledger row). */
    this.linksTo = new Map()
    /** country → tail of its ledger write queue. */
    this.queues = new Map()
  }

  picturesDir(cc) {
    return path.join(this.root, 'pictures', cc)
  }
  picturePath(relPath) {
    return path.join(this.root, 'pictures', ...relPath.split('/'))
  }
  recordsFile(cc) {
    return path.join(this.root, 'data', `${cc}.jsonl`)
  }
  filesCsv(cc) {
    return path.join(this.root, 'data', `${cc}.files.csv`)
  }
  runFile(slug) {
    return path.join(this.root, 'runs', `${slug}.json`)
  }
  runNumbersFile(slug) {
    return path.join(this.root, 'runs', `${slug}.numbers`)
  }
  runFailedFile(slug) {
    return path.join(this.root, 'runs', `${slug}.failed.json`)
  }
  exportsDir() {
    return path.join(this.root, 'exports')
  }

  async init() {
    for (const d of ['pictures', 'data', 'runs', 'exports']) await mkdir(path.join(this.root, d), { recursive: true })
  }

  async ensureCountry(cc) {
    await mkdir(this.picturesDir(cc), { recursive: true })
  }

  // ── Runs ────────────────────────────────────────────────────────────────

  async loadRun(slug) {
    try {
      const state = JSON.parse(await readFile(this.runFile(slug), 'utf8'))
      return state?.version === STATE_VERSION ? state : null
    } catch (err) {
      if (err.code === 'ENOENT') return null
      throw new Error(`Could not read run ${slug}: ${err.message}`)
    }
  }

  async saveRun(slug, state) {
    const file = this.runFile(slug)
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify({ ...state, version: STATE_VERSION, updatedAt: new Date().toISOString() }, null, 2))
    await renameRetry(tmp, file)
  }

  async listRuns() {
    let names = []
    try {
      names = await readdir(path.join(this.root, 'runs'))
    } catch {
      return []
    }
    const runs = []
    for (const name of names.filter((n) => n.endsWith('.json') && !n.endsWith('.failed.json'))) {
      const slug = name.slice(0, -5)
      const state = await this.loadRun(slug).catch(() => null)
      if (state) runs.push({ ...state, slug })
    }
    return runs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  }

  /** Pictures of a run that failed to download, kept so a later run retries them for free. */
  async loadFailed(slug) {
    try {
      const list = JSON.parse(await readFile(this.runFailedFile(slug), 'utf8'))
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  async saveFailed(slug, list) {
    const file = this.runFailedFile(slug)
    if (!list.length) return rm(file, { force: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(list))
    await renameRetry(tmp, file)
  }

  /**
   * One process at a time per run. A lock left behind by a process that died
   * is taken over. Returns a function that releases the lock.
   */
  async lockRun(slug) {
    const file = path.join(this.root, 'runs', `${slug}.lock`)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(file, 'wx')
        await handle.writeFile(String(process.pid))
        await handle.close()
        return () => rm(file, { force: true })
      } catch (err) {
        if (err.code !== 'EEXIST') throw err
        const pid = Number(await readFile(file, 'utf8').catch(() => ''))
        if (pid && isAlive(pid)) {
          throw Object.assign(
            new Error(
              'This run is already in progress. Stop it first, or wait for it to finish. ' +
                `If nothing is running, delete ${file} and try again.`,
            ),
            { code: 'RUN_LOCKED' },
          )
        }
        await rm(file, { force: true })
      }
    }
    throw new Error('Could not lock the run.')
  }

  async appendRunNumbers(slug, entries) {
    if (!entries.length) return
    await appendFile(this.runNumbersFile(slug), `${entries.join('\n')}\n`)
  }

  // ── Records and picture files ───────────────────────────────────────────

  async appendRecords(cc, docs) {
    if (!docs.length) return
    await appendFile(this.recordsFile(cc), `${docs.map((d) => JSON.stringify(d)).join('\n')}\n`)
  }

  /**
   * Append ledger rows. Writes to one country's ledger are queued, never
   * interleaved. A row's `file` is the number's own picture path; `shared`,
   * when set, is the path of the identical picture it links to instead.
   */
  appendFiles(cc, rows) {
    if (!rows.length) return Promise.resolve()
    const previous = this.queues.get(cc) ?? Promise.resolve()
    const next = previous.then(async () => {
      const file = this.filesCsv(cc)
      const header = (await fileExists(file)) ? '' : `${FILES_COLUMNS.join(',')}\n`
      const body = rows.map((r) => FILES_COLUMNS.map((c) => csvCell(r[c])).join(',')).join('\n')
      await appendFile(file, `${header}${body}\n`)
    })
    this.queues.set(
      cc,
      next.catch(() => {}),
    )
    return next
  }

  async *readFiles(cc) {
    let first = true
    for await (const line of readLines(this.filesCsv(cc))) {
      if (first) {
        first = false
        continue
      }
      const cells = parseCsvLine(line)
      yield Object.fromEntries(FILES_COLUMNS.map((c, i) => [c, cells[i] ?? '']))
    }
  }

  /** Make a ledger row visible to the dedupe checks at once, before it is written. */
  remember(cc, row) {
    // A newer row for the same own path replaces whatever it was before.
    this._forget(row.file)
    if (row.shared) {
      this.linkedPaths.add(row.file)
      if (!this.linksTo.has(row.shared)) this.linksTo.set(row.shared, new Map())
      this.linksTo.get(row.shared).set(row.file, row)
    } else {
      if (row.md5 && !this.hashes.has(hashKey(row.md5))) this.hashes.set(hashKey(row.md5), row.file)
      if (row.source_md5 && !this.sourceHashes.has(hashKey(row.source_md5))) {
        this.sourceHashes.set(hashKey(row.source_md5), row.file)
      }
    }
    if (row.kind === 'current' && row.source_md5 && this.currentSource.has(cc)) {
      this.currentSource.get(cc).set(row.number, hashKey(row.source_md5))
    }
  }

  _forget(ownPath) {
    if (!this.linkedPaths.has(ownPath)) return
    this.linkedPaths.delete(ownPath)
    for (const links of this.linksTo.values()) links.delete(ownPath)
  }

  /**
   * Load what the dedupe checks need for a country, once per process. Only the
   * latest row of each own path counts: a refreshed or re-linked picture
   * replaces the old row.
   */
  async loadCountryIndex(cc, { refresh = false } = {}) {
    if (this.indexedCountries.has(cc)) return
    this.indexedCountries.add(cc)
    if (refresh) this.currentSource.set(cc, new Map())
    const latest = new Map()
    for await (const row of this.readFiles(cc)) latest.set(row.file, row)
    for (const row of latest.values()) this.remember(cc, row)
  }

  /** A picture is about to be overwritten: its old hashes must not lead anyone to it any more. */
  dropHashesFor(relPath) {
    for (const [k, v] of this.hashes) if (v === relPath) this.hashes.delete(k)
    for (const [k, v] of this.sourceHashes) if (v === relPath) this.sourceHashes.delete(k)
  }

  /** Point the hash indexes at a new home for a picture (used when one is handed over). */
  moveHashes(from, to) {
    for (const [k, v] of this.hashes) if (v === from) this.hashes.set(k, to)
    for (const [k, v] of this.sourceHashes) if (v === from) this.sourceHashes.set(k, to)
  }

  /** Path of an already-saved picture with these exact bytes. */
  findByHash(md5) {
    return md5 ? this.hashes.get(hashKey(md5)) ?? null : null
  }

  /** Path of an already-saved picture made from the same source image (API md5Image). */
  findBySource(md5Image) {
    return md5Image ? this.sourceHashes.get(hashKey(md5Image)) ?? null : null
  }

  /** Is this own picture path (`UY/598….jpg`) already a link to an identical picture? */
  isLinked(ownPath) {
    return this.linkedPaths.has(ownPath)
  }

  /** Ledger rows of the numbers linked to this saved picture. */
  linksToPath(relPath) {
    return [...(this.linksTo.get(relPath)?.values() ?? [])]
  }

  /** Source md5 of a number's current picture (own or linked), when "refresh changed" is on. */
  savedSource(cc, number) {
    return this.currentSource.get(cc)?.get(number) ?? null
  }
}

/**
 * fs.rename that rides out the short locks Windows antivirus and indexers
 * take on fresh files (EPERM / EBUSY / EACCES).
 */
export async function renameRetry(from, to, attempts = 6) {
  for (let i = 0; ; i++) {
    try {
      return await rename(from, to)
    } catch (err) {
      if (i >= attempts - 1 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err
      await new Promise((r) => setTimeout(r, 50 * 2 ** i))
    }
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}
