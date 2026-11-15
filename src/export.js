/**
 * Exports for one run:
 *
 *   CSV  one row per number the run matched: where its picture is on disk,
 *        plus every field the API returned for it, flattened to columns
 *        (`businessProfile.email`, `faceAnalysis.summary.total`, …). When a
 *        number was seen more than once, its newest record wins.
 *   ZIP  the CSV plus every picture it references, each file once.
 *
 * Both stream from disk in two passes, so memory grows with the number of
 * matched numbers (~100 bytes each), not with the size of the records.
 */
import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { once } from 'node:events'
import yazl from 'yazl'
import { fileExists, readLines, renameRetry } from './store.js'
import { byCodeUnit } from './util.js'

const LEAD_COLUMNS = [
  'country',
  'number',
  'picture_file',
  'picture_shared',
  'picture_bytes',
  'picture_md5',
  'history_files',
]
const LEAD_RECORD_FIELDS = [
  'about',
  'isBusiness',
  'date',
  'creation_date',
  'businessProfile.displayName',
  'businessProfile.description',
  'businessProfile.email',
  'businessProfile.website',
  'businessProfile.address',
  'businessProfile.categories',
]
const SKIP_FIELDS = new Set(['number', 'countryCode'])
const MAX_COLUMNS = 600
const MAX_DEPTH = 3

/** Flatten nested objects to dot paths; arrays and deep objects become JSON. */
export function flattenRecord(value, prefix = '', out = {}, depth = 0) {
  for (const [k, v] of Object.entries(value ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v === null || v === undefined) out[key] = ''
    else if (Array.isArray(v)) out[key] = v.length ? JSON.stringify(v) : ''
    else if (typeof v === 'object') {
      if (typeof v.$oid === 'string') out[key] = v.$oid
      else if (typeof v.$date === 'string') out[key] = v.$date
      else if (depth >= MAX_DEPTH) out[key] = JSON.stringify(v)
      else flattenRecord(v, key, out, depth + 1)
    } else out[key] = v
  }
  return out
}

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (=, +, -, @ …)
 * is prefixed with an apostrophe, so opening the file can never execute it.
 */
export function csvCell(value) {
  if (value === null || value === undefined) return ''
  let s = typeof value === 'string' ? value : String(value)
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** country → Set(number) for everything a run matched. */
export async function readRunNumbers(store, slug) {
  const byCountry = new Map()
  for await (const line of readLines(store.runNumbersFile(slug))) {
    const [cc, number] = line.split(',')
    if (!cc || !number) continue
    if (!byCountry.has(cc)) byCountry.set(cc, new Set())
    byCountry.get(cc).add(number)
  }
  return byCountry
}

/** Where a ledger row's picture really is: its own file, or the identical one it links to. */
const locationOf = (row) => row.shared || row.file

/** number → { current, history: Map(own path → row) } from the country's ledger (latest row wins). */
async function pictureMap(store, cc, numbers) {
  const map = new Map()
  for await (const row of store.readFiles(cc)) {
    if (!numbers.has(row.number)) continue
    if (!map.has(row.number)) map.set(row.number, { current: null, history: new Map() })
    const entry = map.get(row.number)
    if (row.kind === 'history') entry.history.set(row.file, row)
    else entry.current = row
  }
  return map
}

class Writer {
  constructor(file) {
    this.stream = createWriteStream(file) // NOSONAR: writes inside the output folder the user chose
  }
  async write(text) {
    if (!this.stream.write(text)) await once(this.stream, 'drain')
  }
  async close() {
    this.stream.end()
    await once(this.stream, 'finish')
  }
}

/**
 * Write the run's CSV to `outFile`. Returns { rows, columns, pictures }.
 * @param {import('./store.js').Store} store
 */
export async function writeRunCsv(store, slug, outFile, { onProgress } = {}) {
  const numbersByCountry = await readRunNumbers(store, slug)
  const countries = [...numbersByCountry.keys()].sort(byCodeUnit)

  // Pass 1: newest record line per number, and the union of all fields.
  const latest = new Map()
  const fields = new Set()
  for (const cc of countries) {
    const numbers = numbersByCountry.get(cc)
    const lastLine = new Map()
    let index = 0
    for await (const line of readLines(store.recordsFile(cc))) {
      const i = index++
      let doc
      try {
        doc = JSON.parse(line)
      } catch {
        continue // a line cut short by a crash
      }
      const number = String(doc?.number ?? '')
      if (!numbers.has(number)) continue
      lastLine.set(number, i)
      if (fields.size < MAX_COLUMNS) for (const k of Object.keys(flattenRecord(doc))) fields.add(k)
    }
    latest.set(cc, lastLine)
    onProgress?.({ phase: 'scan', country: cc })
  }

  for (const k of SKIP_FIELDS) fields.delete(k)
  const recordColumns = [
    ...LEAD_RECORD_FIELDS.filter((f) => fields.has(f)),
    ...[...fields].filter((f) => !LEAD_RECORD_FIELDS.includes(f)).sort(byCodeUnit),
  ]
  const columns = [...LEAD_COLUMNS, ...recordColumns]

  const tmp = `${outFile}.tmp`
  const out = new Writer(tmp)
  // A byte-order mark makes Excel read the file as UTF-8.
  await out.write(`\uFEFF${columns.map(csvCell).join(',')}\r\n`)

  let rows = 0
  let pictures = 0
  try {
    for (const cc of countries) {
      const numbers = numbersByCountry.get(cc)
      const files = await pictureMap(store, cc, numbers)
      const lastLine = latest.get(cc)
      const written = new Set()

      const emit = async (number, doc) => {
        const pic = files.get(number)
        const current = pic?.current
        if (current) pictures++
        const lead = {
          country: cc,
          number,
          picture_file: current ? `pictures/${locationOf(current)}` : '',
          picture_shared: current?.shared ? 'yes' : '',
          picture_bytes: current?.bytes ?? '',
          picture_md5: current?.md5 ?? '',
          history_files: pic
            ? [...new Set([...pic.history.values()].map((r) => `pictures/${locationOf(r)}`))].join(' ')
            : '',
        }
        const flat = doc ? flattenRecord(doc) : {}
        const cells = columns.map((c) => (c in lead ? lead[c] : flat[c]))
        await out.write(`${cells.map(csvCell).join(',')}\r\n`)
        rows++
        written.add(number)
      }

      // Pass 2: write the newest record of every matched number…
      let index = 0
      for await (const line of readLines(store.recordsFile(cc))) {
        const i = index++
        let doc
        try {
          doc = JSON.parse(line)
        } catch {
          continue
        }
        const number = String(doc?.number ?? '')
        if (lastLine.get(number) !== i) continue
        await emit(number, doc)
      }
      // …and a picture-only row for numbers whose records were not kept.
      for (const number of numbers) if (!written.has(number)) await emit(number, null)
      onProgress?.({ phase: 'write', country: cc, rows })
    }
    await out.close()
  } catch (err) {
    out.stream.destroy()
    await rm(tmp, { force: true })
    throw err
  }
  const file = await publish(tmp, outFile)
  return { rows, columns: columns.length, pictures, file }
}

/**
 * Move a finished export into place. On Windows a file that is open (say, in
 * Excel) cannot be replaced; then the export gets a fresh, dated name instead.
 */
async function publish(tmp, outFile) {
  try {
    await renameRetry(tmp, outFile)
    return outFile
  } catch (err) {
    if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
      await rm(tmp, { force: true })
      throw err
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const alt = outFile.replace(/(\.[a-z]+)$/i, `-${stamp}$1`)
    await renameRetry(tmp, alt)
    return alt
  }
}

/** Every picture file the run references (current, linked and history), once each. */
export async function runPictureFiles(store, slug) {
  const numbersByCountry = await readRunNumbers(store, slug)
  const files = new Set()
  for (const [cc, numbers] of numbersByCountry) {
    const map = await pictureMap(store, cc, numbers)
    for (const entry of map.values()) {
      if (entry.current) files.add(locationOf(entry.current))
      for (const r of entry.history.values()) files.add(locationOf(r))
    }
  }
  return [...files].sort(byCodeUnit)
}

/**
 * Stream a ZIP of the run (CSV + pictures) into `out`.
 * The CSV is (re)built first so it always matches the pictures.
 */
export async function writeRunZip(store, slug, out) {
  const csv = await writeRunCsv(store, slug, path.join(store.exportsDir(), `${slug}.csv`))
  const zipped = await zipRun(store, slug, csv.file, out)
  return { ...zipped, rows: csv.rows, csvFile: csv.file }
}

/**
 * Stream a ZIP of an already written CSV plus every picture of the run. Split
 * from writeRunZip so a server can build the CSV (which may fail) before it
 * commits to a 200 response.
 */
export async function zipRun(store, slug, csvFile, out) {
  const files = await runPictureFiles(store, slug)
  const zip = new yazl.ZipFile()
  let aborted = false
  let failure = null

  const stop = (err) => {
    if (failure || aborted) return
    failure = err
    zip.outputStream.unpipe(out)
    zip.outputStream.destroy()
    out.destroy?.(err)
  }
  const done = new Promise((resolve, reject) => {
    out.on('finish', resolve)
    out.on('close', () => {
      if (failure) return reject(failure)
      if (!out.writableFinished) {
        aborted = true
        zip.outputStream.unpipe(out)
        zip.outputStream.destroy()
      }
      resolve()
    })
    out.on('error', (err) => (aborted ? resolve() : reject(err)))
  })
  done.catch(() => {}) // awaited below; never left unhandled meanwhile
  // yazl reports file read errors on the ZipFile itself, not on its stream.
  zip.on('error', stop)
  zip.outputStream.on('error', (err) => (aborted ? undefined : stop(err)))
  zip.outputStream.pipe(out)

  let added = 0
  try {
    zip.addFile(csvFile, `${slug}/${slug}.csv`, { compress: true })
    for (const rel of files) {
      if (aborted || failure) break
      const full = store.picturePath(rel)
      if (!(await fileExists(full))) continue
      zip.addFile(full, `${slug}/pictures/${rel}`, { compress: false })
      added++
    }
  } finally {
    zip.end()
  }
  await done
  return { pictures: added, aborted }
}
