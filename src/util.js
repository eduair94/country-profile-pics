/** Small helpers shared by the CLI, the server and the download job. */

/** An Error that looks like the one `AbortController.abort()` produces. */
export function abortError(message = 'Cancelled') {
  const err = new Error(message)
  err.name = 'AbortError'
  return err
}

export const isAbort = (err) => err?.name === 'AbortError'

/** `setTimeout` as a promise that rejects as soon as `signal` aborts. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? abortError())
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Exponential backoff with jitter: ~base, ~2·base, ~4·base … capped. */
export function backoffMs(attempt, base = 1000, cap = 60_000) {
  const ceiling = Math.min(cap, base * 2 ** attempt)
  return Math.round(ceiling / 2 + (Math.random() * ceiling) / 2)
}

/** The 24-hex id of an API document, whichever way it was serialised. */
export function docId(doc) {
  const id = doc?._id
  if (typeof id === 'string') return id
  if (id && typeof id.$oid === 'string') return id.$oid
  return null
}

/**
 * Compare two Mongo ObjectId hex strings. ObjectIds are fixed-width and start
 * with a big-endian timestamp, so lowercase string order is creation order.
 */
export function compareIds(a, b) {
  const x = String(a).toLowerCase()
  const y = String(b).toLowerCase()
  return x < y ? -1 : x > y ? 1 : 0
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`
}

export const formatInt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US')

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`
  return `${sec}s`
}

/** Strip anything that looks like an API key from a string before it is shown. */
/**
 * Sort comparator for strings by UTF-16 code unit: exactly what a bare
 * `.sort()` does, written out. Locale-independent on purpose, because run
 * names and column orders must not change with the computer's language.
 */
export const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** Removes every leading and trailing `ch` (a linear scan, no regular expression). */
export function trimChar(text, ch) {
  let start = 0
  let end = text.length
  while (start < end && text[start] === ch) start++
  while (end > start && text[end - 1] === ch) end--
  return text.slice(start, end)
}

export function redact(text, key) {
  let out = String(text ?? '')
  if (key) out = out.split(key).join('<key>')
  return out
    .replace(/\b(wapi|wa)_[0-9a-f]{8,}\b/gi, '<key>')
    .replace(/\b[0-9a-f]{6,}msh[0-9a-f]+p[0-9a-f]+jsn[0-9a-f]+\b/gi, '<key>')
}
