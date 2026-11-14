/**
 * Picture downloads. The images themselves are public files on the image CDN
 * (the `urlImage` of each search result), so downloading them costs no API
 * requests. Each file is written to `<name>.part` first and renamed when it is
 * complete, so an interrupted run never leaves a truncated picture behind.
 */
import { createHash, randomBytes } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { renameRetry } from './store.js'
import { backoffMs, isAbort, sleep } from './util.js'

const MAX_IMAGE_BYTES = 15 * 1024 * 1024

/**
 * `options.commit({ bytes, md5 })` runs after the bytes are on disk as
 * `<name>.part` and before the rename; return false to discard them.
 *
 * @returns {Promise<{status: 'saved' | 'skipped', bytes: number, md5: string}
 *   | {status: 'missing', httpStatus: number}
 *   | {status: 'failed', reason: string}>}
 */
export async function downloadImage(url, dest, options = {}) {
  const {
    fetch: fetchImpl = globalThis.fetch,
    signal,
    timeoutMs = 30_000,
    retries = 4,
    userAgent = 'country-profile-pics',
    sleepFn = sleep,
    commit,
  } = options
  // A name of its own, so two runs fetching the same picture never trip over each other.
  const tmp = `${dest}.${process.pid}-${randomBytes(4).toString('hex')}.part`
  let reason = 'unknown error'
  let fetched = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleepFn(backoffMs(attempt - 1, 1000, 30_000), signal)
    try {
      const timeout = AbortSignal.timeout(timeoutMs)
      const res = await fetchImpl(url, {
        headers: { 'user-agent': userAgent, accept: 'image/*' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: 'follow',
      })
      // Gone from the public bucket (picture removed, or the owner opted out).
      if (res.status === 404 || res.status === 410) {
        await res.body?.cancel().catch(() => {})
        return { status: 'missing', httpStatus: res.status }
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        reason = `HTTP ${res.status}`
        if (res.status === 429 || res.status >= 500 || res.status === 403) continue
        return { status: 'failed', reason }
      }
      const type = res.headers.get('content-type') ?? ''
      if (!type.startsWith('image/')) {
        await res.body?.cancel().catch(() => {})
        reason = `not an image (${type || 'no content-type'})`
        continue
      }
      const declared = Number(res.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
        await res.body?.cancel().catch(() => {})
        return { status: 'failed', reason: `too large (${declared} bytes)` }
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length === 0) {
        reason = 'empty body'
        continue
      }
      await writeFile(tmp, buf)
      fetched = { bytes: buf.length, md5: createHash('md5').update(buf).digest('hex') }
      break
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      if (signal?.aborted) throw signal.reason ?? err
      reason = err?.name === 'TimeoutError' || isAbort(err) ? 'timed out' : String(err?.message ?? err)
    }
  }
  if (!fetched) return { status: 'failed', reason }

  // The caller records the file (or decides it is a duplicate) BEFORE it appears
  // under its final name, so a crash can never leave a picture nobody recorded.
  try {
    const keep = commit ? await commit(fetched) : true
    if (!keep) {
      await rm(tmp, { force: true })
      return { status: 'skipped', ...fetched }
    }
    await renameRetry(tmp, dest)
    return { status: 'saved', ...fetched }
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight. Stops taking
 * new items once `signal` aborts or a worker throws, waits for the workers that
 * are still running, then rethrows the first error. Waiting matters: the caller
 * records finished downloads after this returns, so none may still be in flight.
 */
export async function runPool(items, concurrency, worker, signal) {
  let next = 0
  let failure = null
  const lanes = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (next < items.length && !failure && !signal?.aborted) {
        const index = next++
        try {
          await worker(items[index], index)
        } catch (err) {
          failure ??= err
        }
      }
    }),
  )
  if (failure) throw failure
  if (signal?.aborted) throw signal.reason ?? new Error('Cancelled')
}
