/**
 * One download run: walk the matching numbers page by page (cursor), download
 * each page's pictures in parallel, record what was saved, then checkpoint the
 * cursor. Used by both the CLI and the web UI, which listen to its events.
 *
 * Requests are the scarce resource, so:
 *   - pages are as large as the API allows (500), or just big enough for `max`;
 *   - the next page is prefetched only when it will be needed;
 *   - the cursor saved after each page is the `_id` of the last number fully
 *     handled, so resuming re-reads at most one partly handled page;
 *   - a finished run, started again, walks only the numbers added since and
 *     stops at the first one it already knows (usually one request).
 *
 * Downloads are never repeated: a file already on disk is skipped, and with
 * "skip identical pictures" (on by default) a picture already saved for another
 * number is linked instead of downloaded again.
 */
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { copyFile, readFile, statfs } from 'node:fs/promises'
import { createClient } from './api.js'
import { downloadImage, runPool } from './download.js'
import { describeFilters, normaliseFilters, runSlug, toQuery } from './filters.js'
import { fileExists, hashKey, Store } from './store.js'
import { compareIds, docId, isAbort, redact } from './util.js'
import { MAX_PAGE_SIZE, walkSearch } from './walker.js'

export const DEFAULTS = Object.freeze({
  max: 1000,
  concurrency: 8,
  pageSize: MAX_PAGE_SIZE,
  outDir: 'downloads',
  minFreeBytes: 500 * 1024 * 1024,
})

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

const bool = (v, fallback) => (v === undefined || v === null || v === '' ? fallback : v === true || v === 'true' || v === 'on' || v === 1)

/** Validate and normalise options; throws an Error with a readable message. */
export function normaliseOptions(raw = {}) {
  const filters = normaliseFilters({ ...raw, ...(raw.filters ?? {}) })

  const max = raw.max === undefined || raw.max === null || raw.max === '' ? DEFAULTS.max : Number(raw.max)
  if (!Number.isInteger(max) || max < 0) throw new Error('max must be a whole number (0 = no limit).')

  const concurrency = raw.concurrency === undefined || raw.concurrency === '' ? DEFAULTS.concurrency : Number(raw.concurrency)
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error('Parallel downloads must be between 1 and 32.')
  }

  const pageSize = raw.pageSize === undefined || raw.pageSize === '' ? DEFAULTS.pageSize : Number(raw.pageSize)
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error(`Page size must be between 1 and ${MAX_PAGE_SIZE}.`)
  }

  const mode = raw.mode ?? 'continue'
  if (!['continue', 'restart'].includes(mode)) throw new Error('mode must be continue or restart.')

  return {
    key: String(raw.key ?? '').trim(),
    transport: raw.transport || 'auto',
    filters,
    max,
    concurrency,
    pageSize,
    includeHistory: bool(raw.includeHistory, false),
    dedupe: bool(raw.dedupe, true),
    refresh: bool(raw.refresh, false),
    saveRecords: bool(raw.saveRecords, true),
    mode,
    outDir: raw.outDir || DEFAULTS.outDir,
    minIntervalMs: raw.minIntervalMs === undefined ? undefined : Number(raw.minIntervalMs),
  }
}

const countryOf = (doc, fallback) => {
  const cc = String(doc?.countryCode ?? fallback ?? '').toUpperCase()
  return /^[A-Z]{2}$/.test(cc) ? cc : 'XX'
}

export class DownloadJob extends EventEmitter {
  /**
   * @param {object} options   see normaliseOptions
   * @param {object} [deps]    { fetch, sleep, client, userAgent } — injectable for tests
   */
  constructor(options, deps = {}) {
    super()
    this.options = normaliseOptions(options)
    if (!this.options.key && !deps.client) throw new Error('An API key is required.')
    this.filters = this.options.filters
    this.slug = runSlug(this.filters)
    this.store = new Store(this.options.outDir)
    this.deps = deps
    this.controller = new AbortController()
    /** source md5 prefix → Promise<path | null> of a download in flight, so twins wait instead of racing. */
    this.inflight = new Map()
    /** own picture path → download task, for pictures that failed (saved for the next run to retry). */
    this.failed = new Map()
    this._failedLoaded = false
    this._userAgent = deps.userAgent ?? 'country-profile-pics'
    this.stats = {
      phase: 'idle',
      slug: this.slug,
      country: this.filters.country ?? null,
      filters: this.filters,
      description: describeFilters(this.filters),
      outDir: this.store.root,
      max: this.options.max,
      walk: null,
      pages: 0,
      credits: 0,
      pageSize: this.options.pageSize,
      numbers: 0,
      saved: 0,
      existing: 0,
      duplicates: 0,
      refreshed: 0,
      missing: 0,
      failed: 0,
      bytes: 0,
      quotaRemaining: null,
      startedAt: null,
      finishedAt: null,
      message: '',
      error: null,
      totals: null,
    }
  }

  cancel() {
    if (!this.controller.signal.aborted) this.controller.abort()
  }

  snapshot() {
    return { ...this.stats }
  }

  /** Pictures that count towards `max`: new downloads, files already here, and links to identical ones. */
  get kept() {
    return this.stats.saved + this.stats.existing + this.stats.duplicates
  }

  _progress(message) {
    if (message !== undefined) this.stats.message = message
    this.emit('progress', this.snapshot())
  }

  _log(message) {
    this.emit('log', redact(message, this.options.key))
  }

  async run() {
    const o = this.options
    const signal = this.controller.signal
    this.stats.phase = 'running'
    this.stats.startedAt = new Date().toISOString()
    this._progress('Starting…')
    let release = null

    try {
      await this.store.init()
      release = await this.store.lockRun(this.slug)
      await this._checkDisk(true)

      const client =
        this.deps.client ??
        createClient({
          key: o.key,
          transport: o.transport,
          fetch: this.deps.fetch,
          userAgent: this._userAgent,
          sleepFn: this.deps.sleep,
          minIntervalMs: o.minIntervalMs,
          onRetry: ({ attempt, error, delayMs }) =>
            this._log(`Retrying the search (${attempt}) in ${Math.max(1, Math.round(delayMs / 1000))} s: ${error.message}`),
        })

      const previous = await this.store.loadRun(this.slug)
      const state = this._plan(previous)
      this.stats.walk = state.walk
      if (this.filters.country) await this.store.loadCountryIndex(this.filters.country, { refresh: o.refresh })

      // Pictures that failed last time are retried first. Their URLs are known: no search request needed.
      const retry = await this.store.loadFailed(this.slug)
      this._failedLoaded = true
      if (retry.length) {
        for (const t of retry) this.failed.set(`${t.cc}/${t.file}`, t)
        this._log(`Retrying ${retry.length.toLocaleString('en-US')} pictures that failed last time.`)
        await this._retryFailed(retry, signal)
      }

      const where = this.filters.country ?? 'all countries'
      this._log(
        state.walk === 'resume'
          ? `Resuming ${where} (${this.stats.description}).`
          : state.walk === 'update'
            ? `${where} was complete; fetching only numbers added since the last run.`
            : `Walking ${where} from the newest numbers (${this.stats.description}).`,
      )
      this._progress()

      const outcome = await this._walk(client, state, signal)
      this.stats.phase = outcome
      const failed = this.failed.size
      this.stats.message =
        outcome !== 'complete'
          ? `Stopped at the ${o.max.toLocaleString('en-US')}-picture limit. Run again to continue from here.`
          : failed
            ? `Walk complete, but ${failed.toLocaleString('en-US')} picture${failed === 1 ? '' : 's'} could not be downloaded. Run again to retry ${failed === 1 ? 'it' : 'them'} (no search requests needed).`
            : state.walk === 'update' && this.stats.saved === 0
              ? 'Up to date: no new pictures since the last run.'
              : 'Done: every matching picture is saved.'
    } catch (err) {
      if (isAbort(err)) {
        this.stats.phase = 'cancelled'
        this.stats.message = 'Stopped. Run again to continue from here.'
      } else {
        this.stats.phase = 'error'
        let message = err?.message ?? String(err)
        if (err?.code === 'INVALID_CURSOR') {
          message += ' The saved position of this run is not usable; start it over (--restart, or "Start over" in the app). Pictures already saved are kept.'
        }
        this.stats.error = { message: redact(message, o.key), code: err?.code ?? null }
        this.stats.message = this.stats.error.message
      }
    } finally {
      this.stats.failedPending = this.failed.size
      if (this._failedLoaded) await this.store.saveFailed(this.slug, [...this.failed.values()]).catch(() => {})
      await release?.().catch(() => {})
      this.stats.finishedAt = new Date().toISOString()
      this._progress()
      this.emit('done', this.snapshot())
    }
    return this.snapshot()
  }

  async _checkDisk(atStart) {
    if (typeof statfs !== 'function') return
    const s = await statfs(this.store.root).catch(() => null)
    if (!s) return
    const free = Number(s.bavail) * Number(s.bsize)
    if (free < DEFAULTS.minFreeBytes) {
      throw Object.assign(
        new Error(
          `Only ${Math.round(free / 1024 / 1024)} MB free on the output disk. ` +
            `${atStart ? 'Free some space' : 'Stopped to avoid filling it; free some space'} and run again.`,
        ),
        { code: 'DISK_FULL' },
      )
    }
  }

  /** Where this run starts, from what the last run with the same filters left behind. */
  _plan(previous) {
    const totals = previous?.totals ?? { pages: 0, credits: 0, numbers: 0, saved: 0, existing: 0, duplicates: 0, refreshed: 0, missing: 0, failed: 0, bytes: 0 }
    const base = {
      filters: this.filters,
      description: this.stats.description,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
      totals,
      newestId: previous?.newestId ?? null,
      cursor: null,
      stopAt: null,
      complete: false,
      walk: 'fresh',
    }
    if (!previous || this.options.mode === 'restart') return { ...base, newestId: null }
    if (previous.complete && previous.newestId) {
      // An update that was cut short continues where it stopped, not from the top again.
      return {
        ...base,
        walk: 'update',
        stopAt: previous.newestId,
        cursor: previous.update?.cursor ?? null,
        updateTop: previous.update?.top ?? null,
      }
    }
    if (previous.cursor) return { ...base, walk: 'resume', cursor: previous.cursor }
    return base
  }

  async _walk(client, state, signal) {
    const o = this.options
    let topOfThisWalk = state.updateTop ?? null
    const query = toQuery(this.filters)
    // A small run needs a small page: still one request, a much faster answer.
    const pageSize = o.max > 0 ? Math.min(o.pageSize, Math.ceil(o.max * 1.1) + 5) : o.pageSize
    this.stats.pageSize = pageSize

    const pages = walkSearch(client, {
      query,
      after: state.cursor,
      pageSize,
      signal,
      sleepFn: this.deps.sleep,
      onEvent: (e) => {
        if (e.type === 'page-size') {
          this.stats.pageSize = e.limit
          this._log(
            e.reason === 'timeout'
              ? `The server was slow; asking for ${e.limit} numbers per page.`
              : `Back to ${e.limit} numbers per page.`,
          )
        } else if (e.type === 'retry') {
          this._log(`Still slow at the smallest page; waiting ${Math.round(e.delayMs / 1000)} s.`)
        }
        this._progress()
      },
    })

    // Fetch the next page while this one downloads. A rejection is kept until awaited.
    const pull = () => {
      const p = pages.next()
      p.catch(() => {})
      return p
    }
    let pending = pull()

    try {
      for (;;) {
        const step = await pending
        pending = null
        if (step.done) return await this._finish(state, topOfThisWalk, 'complete')
        const page = step.value

        this.stats.pages++
        if (page.docs.length) this.stats.credits++
        if (page.quota?.remaining != null) this.stats.quotaRemaining = page.quota.remaining
        if (topOfThisWalk === null && page.docs.length && state.walk !== 'resume') topOfThisWalk = docId(page.docs[0])

        const handled = []
        let reachedKnown = false
        for (const doc of page.docs) {
          const id = docId(doc)
          if (state.stopAt && id && compareIds(id, state.stopAt) <= 0) {
            reachedKnown = true
            break
          }
          handled.push(doc)
        }

        const room = o.max === 0 ? Infinity : o.max - this.kept
        const mayFinishHere = room !== Infinity && this._countFiles(handled) >= room
        if (!reachedKnown && !mayFinishHere && page.nextCursor) pending = pull()

        const { lastDocId, cut } = await this._downloadPage(handled, signal)
        if (lastDocId) state.cursor = lastDocId
        await this._checkpoint(state, topOfThisWalk)
        this._progress(`Page ${this.stats.pages}: ${this.kept.toLocaleString('en-US')} pictures so far.`)

        const exhausted = reachedKnown || !page.nextCursor || page.docs.length === 0
        if (exhausted && !cut) return await this._finish(state, topOfThisWalk, 'complete')
        if (cut || (o.max !== 0 && this.kept >= o.max)) return await this._finish(state, topOfThisWalk, 'limit')
        await this._checkDisk(false)
        pending ??= pull()
      }
    } catch (err) {
      await this._finish(state, topOfThisWalk, 'interrupted').catch(() => {})
      throw err
    } finally {
      await pages.return?.().catch(() => {})
    }
  }

  _countFiles(docs) {
    if (!this.options.includeHistory) return docs.length
    return docs.reduce((n, d) => n + 1 + (Array.isArray(d.pictureHistory) ? d.pictureHistory.length : 0), 0)
  }

  _totals(state) {
    const t = { ...state.totals }
    for (const k of Object.keys(t)) t[k] = (state.totals[k] ?? 0) + (this.stats[k] ?? 0)
    return t
  }

  async _checkpoint(state, topOfThisWalk, outcome = 'running') {
    const totals = this._totals(state)
    this.stats.totals = totals
    const base = { filters: state.filters, description: state.description, createdAt: state.createdAt, totals, lastOutcome: outcome }
    if (state.walk === 'update') {
      // The finished walk stays finished; the update keeps its own position.
      await this.store.saveRun(this.slug, {
        ...base,
        cursor: null,
        newestId: state.newestId,
        complete: true,
        update: { cursor: state.cursor, top: topOfThisWalk },
      })
    } else {
      await this.store.saveRun(this.slug, {
        ...base,
        cursor: state.cursor,
        newestId: state.newestId ?? topOfThisWalk,
        complete: false,
        update: null,
      })
    }
  }

  async _finish(state, topOfThisWalk, outcome) {
    if (outcome !== 'complete') {
      await this._checkpoint(state, topOfThisWalk, outcome)
      return outcome
    }
    const totals = this._totals(state)
    this.stats.totals = totals
    // Never move the "newest seen" mark down: that number may since have been hidden.
    const candidates = [state.newestId, topOfThisWalk].filter(Boolean)
    const newestId = candidates.length ? candidates.reduce((a, b) => (compareIds(a, b) >= 0 ? a : b)) : null
    await this.store.saveRun(this.slug, {
      filters: state.filters,
      description: state.description,
      createdAt: state.createdAt,
      cursor: null,
      newestId,
      complete: true,
      update: null,
      totals,
      lastOutcome: 'complete',
    })
    return outcome
  }

  async _retryFailed(tasks, signal) {
    const o = this.options
    for (const cc of new Set(tasks.map((t) => t.cc))) {
      await this.store.ensureCountry(cc)
      await this.store.loadCountryIndex(cc, { refresh: o.refresh })
    }
    await runPool(tasks, o.concurrency, (task) => this._handleFile(task, signal), signal)
  }

  /**
   * Handle `docs` until `max` pictures are kept. Pictures that are no longer
   * public or fail do not count, so a chunk that falls short is followed by
   * another from the same page. Returns the `_id` of the last number fully
   * handled and whether the limit cut the page short.
   */
  async _downloadPage(docs, signal) {
    const o = this.options
    let offset = 0
    let lastIndex = -1

    while (offset < docs.length) {
      const room = o.max === 0 ? Infinity : o.max - this.kept
      if (room <= 0) break
      const chunk = []
      let planned = 0
      let i = offset
      for (; i < docs.length; i++) {
        const n = this._filesFor(docs[i]).length
        // Never split one number's pictures across runs.
        if (n && planned > 0 && planned + n > room) break
        planned += n
        chunk.push(docs[i])
        if (planned >= room) {
          i++
          break
        }
      }
      await this._handleDocs(chunk, signal)
      lastIndex = i - 1
      offset = i
    }

    const cut = lastIndex < docs.length - 1
    return { lastDocId: lastIndex >= 0 ? docId(docs[lastIndex]) : null, cut }
  }

  async _handleDocs(docs, signal) {
    const o = this.options
    const byCountry = new Map()
    const tasks = []
    for (const doc of docs) {
      const cc = countryOf(doc, this.filters.country)
      if (!byCountry.has(cc)) byCountry.set(cc, [])
      byCountry.get(cc).push(doc)
      for (const f of this._filesFor(doc)) tasks.push({ ...f, cc })
    }
    for (const cc of byCountry.keys()) {
      await this.store.ensureCountry(cc)
      await this.store.loadCountryIndex(cc, { refresh: o.refresh })
    }

    await runPool(tasks, o.concurrency, (task) => this._handleFile(task, signal), signal)

    // The chunk is fully handled: record its numbers and their full records.
    for (const [cc, list] of byCountry) {
      if (o.saveRecords) await this.store.appendRecords(cc, list)
      await this.store.appendRunNumbers(this.slug, list.map((d) => `${cc},${d.number}`))
    }
    this.stats.numbers += docs.length
  }

  async _handleFile(task, signal) {
    const o = this.options
    const { cc, number, kind, file, sourceMd5 } = task
    const relPath = `${cc}/${file}`
    const dest = this.store.picturePath(relPath)
    const row = { country: cc, number, kind, file: relPath, source_md5: sourceMd5 ?? '', shared: '' }

    // With "refresh changed", a number whose source picture differs from the saved one is fetched again.
    const known = o.refresh && kind === 'current' ? this.store.savedSource(cc, number) : null
    const changed = Boolean(known && sourceMd5 && known !== hashKey(sourceMd5))

    let refreshing = false
    if (await fileExists(dest)) {
      if (!changed) {
        this.stats.existing++
        this.failed.delete(relPath)
        return
      }
      refreshing = true
    } else if (o.dedupe && this.store.isLinked(relPath) && !changed) {
      // Already linked to an identical picture by an earlier run: nothing to fetch.
      this.stats.duplicates++
      this.failed.delete(relPath)
      return
    }

    const sourceKey = o.dedupe && !refreshing && sourceMd5 ? hashKey(sourceMd5) : null
    if (sourceKey) {
      // An identical picture may be downloading right now for another number: wait for it.
      const pending = this.inflight.get(sourceKey)
      if (pending) await pending
      const same = this.store.findBySource(sourceMd5)
      if (same && same !== relPath) return this._link(row, same)
    }

    let settle = null
    if (sourceKey) this.inflight.set(sourceKey, new Promise((resolve) => (settle = resolve)))
    try {
      await this._download(task, row, dest, relPath, refreshing, signal)
    } finally {
      if (sourceKey) {
        this.inflight.delete(sourceKey)
        settle()
      }
    }
  }

  async _download(task, row, dest, relPath, refreshing, signal) {
    const o = this.options
    const { cc, number, kind, url } = task
    let linkedTo = null
    const result = await downloadImage(url, dest, {
      fetch: this.deps.fetch,
      signal,
      userAgent: this._userAgent,
      sleepFn: this.deps.sleep,
      // Runs before the picture gets its final name: the ledger always knows every file on disk.
      commit: async ({ bytes, md5 }) => {
        if (o.dedupe && !refreshing) {
          const same = this.store.findByHash(md5)
          if (same && same !== relPath) {
            linkedTo = same
            return false
          }
        }
        if (refreshing) {
          // Numbers linked to the old picture keep it: it moves to one of them first.
          await this._handOver(relPath)
          this.store.dropHashesFor(relPath)
        }
        const saved = { ...row, bytes, md5, saved_at: new Date().toISOString() }
        this.store.remember(cc, saved)
        await this.store.appendFiles(cc, [saved])
        return true
      },
    })

    if (result.status === 'skipped' && linkedTo) {
      this.failed.delete(relPath)
      await this._link({ ...row, md5: result.md5 }, linkedTo)
    } else if (result.status === 'saved') {
      this.failed.delete(relPath)
      if (refreshing) this.stats.refreshed++
      else this.stats.saved++
      this.stats.bytes += result.bytes
      this.emit('image', { file: relPath, number, kind })
    } else if (result.status === 'missing') {
      this.failed.delete(relPath)
      this.stats.missing++
    } else {
      this.stats.failed++
      this.failed.set(relPath, { cc, number, kind, file: task.file, url, sourceMd5: task.sourceMd5 ?? null })
      this._log(`Could not download ${relPath}: ${result.reason}`)
    }
    if ((this.stats.saved + this.stats.missing + this.stats.failed) % 25 === 0) this._progress()
  }

  /**
   * Before a refreshed picture overwrites `relPath`, copy the old picture to
   * the first number linked to it and point the other links there, so every
   * linked number keeps the picture it really has.
   */
  async _handOver(relPath) {
    const links = this.store.linksToPath(relPath)
    if (!links.length) return
    const [heir, ...others] = links
    const from = this.store.picturePath(relPath)
    const buf = await readFile(from)
    const md5 = createHash('md5').update(buf).digest('hex')
    await this.store.ensureCountry(heir.country)
    await copyFile(from, this.store.picturePath(heir.file))
    const now = new Date().toISOString()
    const heirRow = { ...heir, bytes: buf.length, md5, shared: '', saved_at: now }
    this.store.remember(heir.country, heirRow)
    this.store.moveHashes(relPath, heir.file)
    await this.store.appendFiles(heir.country, [heirRow])
    for (const link of others) {
      const moved = { ...link, shared: heir.file, saved_at: now }
      this.store.remember(link.country, moved)
      await this.store.appendFiles(link.country, [moved])
    }
  }

  /** Point a number's picture at an identical one that is already saved. */
  async _link(row, existingPath) {
    this.stats.duplicates++
    this.failed.delete(row.file)
    if (this.store.isLinked(row.file) && this.store.linksToPath(existingPath).some((r) => r.file === row.file)) return
    const shared = { ...row, shared: existingPath, saved_at: new Date().toISOString() }
    this.store.remember(row.country, shared)
    await this.store.appendFiles(row.country, [shared])
  }

  /** The picture files one search result turns into. */
  _filesFor(doc) {
    const number = String(doc?.number ?? '').replace(/\D/g, '')
    if (!number || !isHttpsUrl(doc.urlImage) || doc.hasUrlImage === false) return []
    const files = [{ number, kind: 'current', file: `${number}.jpg`, url: doc.urlImage, sourceMd5: doc.md5Image }]
    if (this.options.includeHistory && Array.isArray(doc.pictureHistory)) {
      for (const pic of doc.pictureHistory) {
        const n = Number(pic?.number)
        if (!isHttpsUrl(pic?.url) || !Number.isInteger(n) || n <= 0) continue
        files.push({ number, kind: 'history', file: `${number}_${n}.jpg`, url: pic.url, sourceMd5: pic.md5 })
      }
    }
    return files
  }
}
