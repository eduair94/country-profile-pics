/**
 * Minimal client for the three WP Data endpoints this app needs:
 *
 *   GET /phone-numbers/search   cursor walk of a country's numbers with a picture
 *   GET /phone-numbers/stats    per-country picture counts (for estimates)
 *   GET /api-key-stats          remaining quota of a direct key (free)
 *
 * Two ways in, same API behind both:
 *   direct    a key from the website (wapi_… / wa_…) sent to the public proxy
 *   rapidapi  a RapidAPI application key subscribed to "WP Data DB Only"
 */
import { backoffMs, isAbort, sleep } from './util.js'

export const RAPIDAPI_HOST = 'wp-data-db-only.p.rapidapi.com'
export const DIRECT_BASE_URL = 'https://whatsapp-proxy.checkleaked.cc'

export const TRANSPORTS = Object.freeze({
  direct: Object.freeze({
    label: 'Direct key',
    baseUrl: DIRECT_BASE_URL,
    headers: (key) => ({ 'x-rapidapi-key': key }),
  }),
  rapidapi: Object.freeze({
    label: 'RapidAPI · WP Data DB Only',
    baseUrl: `https://${RAPIDAPI_HOST}`,
    headers: (key) => ({ 'x-rapidapi-key': key, 'x-rapidapi-host': RAPIDAPI_HOST }),
  }),
})

/** RapidAPI application keys look like `<hex>msh<hex>p<hex>jsn<hex>`. */
/** `text` without trailing `ch` characters. */
function trimEnd(text, ch) {
  let end = text.length
  while (end > 0 && text[end - 1] === ch) end--
  return text.slice(0, end)
}

export function detectTransport(key) {
  return /^[0-9a-f]+msh[0-9a-f]+p[0-9a-f]+jsn[0-9a-f]+$/i.test(String(key ?? '').trim())
    ? 'rapidapi'
    : 'direct'
}

export function resolveTransport(transport, key) {
  const name = !transport || transport === 'auto' ? detectTransport(key) : transport
  if (!TRANSPORTS[name]) {
    throw new ApiError(`Unknown transport "${transport}". Use auto, direct or rapidapi.`, {
      code: 'BAD_TRANSPORT',
    })
  }
  return name
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'ERROR', retryable = false, retryAfterMs, quota } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryable = retryable
    this.retryAfterMs = retryAfterMs
    this.quota = quota
  }
}

const MAX_RETRY_AFTER_MS = 10 * 60_000

export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === '') return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1000))
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - now)) : undefined
}

/** `x-ratelimit-requests-remaining` is sent by both the proxy and RapidAPI. */
export function parseQuota(headers) {
  const remaining = Number(headers.get('x-ratelimit-requests-remaining'))
  const limit = Number(headers.get('x-ratelimit-requests-limit'))
  return {
    remaining: Number.isFinite(remaining) && headers.has('x-ratelimit-requests-remaining') ? remaining : null,
    limit: Number.isFinite(limit) && headers.has('x-ratelimit-requests-limit') ? limit : null,
  }
}

/** Turn a non-2xx answer into an ApiError that says what to do about it. */
export function toApiError(status, headers, body) {
  const said =
    typeof body?.error === 'string' ? body.error : typeof body?.message === 'string' ? body.message : ''
  const suffix = said ? `: ${said}` : ''
  const retryAfterMs = parseRetryAfter(headers.get('retry-after'))
  const quota = parseQuota(headers)

  if (status === 401) {
    return new ApiError(
      `The API key was rejected (401)${suffix}. Check the key, and that the transport matches it ` +
        '(a website key goes to "direct", a RapidAPI key to "rapidapi").',
      { status, code: 'UNAUTHORIZED', quota },
    )
  }
  if (status === 403) {
    return new ApiError(
      `This key may not read profile data (403)${suffix}. Use a direct key from the website or a ` +
        'RapidAPI subscription to "WP Data DB Only".',
      { status, code: 'FORBIDDEN', quota },
    )
  }
  if (status === 429) {
    if (/quota|monthly/i.test(said)) {
      return new ApiError(`The key has no requests left (429)${suffix}.`, {
        status,
        code: 'QUOTA_EXCEEDED',
        quota,
      })
    }
    // The direct proxy answers "Requests must be at least N seconds apart".
    const apart = said.match(/at least ([\d.]+) seconds/i)
    return new ApiError(`Rate limited (429)${suffix}`, {
      status,
      code: 'RATE_LIMITED',
      retryable: true,
      retryAfterMs: retryAfterMs ?? (apart ? Number(apart[1]) * 1000 + 50 : undefined),
      quota,
    })
  }
  if (status === 504 || status === 524) {
    return new ApiError(`The search timed out on the server (${status}).`, {
      status,
      code: 'TIMEOUT',
      retryable: true,
      retryAfterMs,
      quota,
    })
  }
  if (status >= 500) {
    return new ApiError(`Server error (${status})${suffix}`, {
      status,
      code: 'SERVER',
      retryable: true,
      retryAfterMs,
      quota,
    })
  }
  if (status === 404) return new ApiError(`Not found (404)${suffix}`, { status, code: 'NOT_FOUND', quota })
  return new ApiError(`Request refused (${status})${suffix}`, {
    status,
    code: typeof body?.code === 'string' ? body.code : `HTTP_${status}`,
    quota,
  })
}

function parseJson(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** The API's own "nothing (more) matches" answer, as opposed to a 404 from a gateway or proxy. */
export function isNoResults(body) {
  return Boolean(body && (Array.isArray(body?.data?.docs) || /no results/i.test(String(body?.error ?? ''))))
}

/**
 * @param {object} options
 * @param {string} options.key                    API key (never logged)
 * @param {'auto'|'direct'|'rapidapi'} [options.transport]
 * @param {string} [options.baseUrl]              override, mostly for tests
 * @param {typeof fetch} [options.fetch]
 * @param {number} [options.timeoutMs]            per request; Cloudflare cuts at 100 s
 * @param {number} [options.maxRetries]           for 429 / 5xx / network errors
 * @param {(info: {attempt: number, error: ApiError, delayMs: number}) => void} [options.onRetry]
 * @param {string} [options.userAgent]
 * @param {number} [options.minIntervalMs]        spacing between requests; the direct
 *                                                proxy refuses calls < 0.5 s apart
 */
export function createClient({
  key,
  transport = 'auto',
  baseUrl,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 100_000,
  maxRetries = 6,
  onRetry,
  userAgent = 'country-profile-pics',
  sleepFn = sleep,
  minIntervalMs = 550,
} = {}) {
  const apiKey = String(key ?? '').trim()
  if (!apiKey) throw new ApiError('An API key is required.', { code: 'NO_KEY' })
  const name = resolveTransport(transport, apiKey)
  const spec = TRANSPORTS[name]
  const root = trimEnd(baseUrl ?? spec.baseUrl, '/')
  const headers = { accept: 'application/json', 'user-agent': userAgent, ...spec.headers(apiKey) }
  const spacing = Number.isFinite(Number(minIntervalMs)) ? Math.max(0, Number(minIntervalMs)) : 550

  // Requests leave one at a time, at least `spacing` ms apart, so the
  // "Requests must be at least 0.5 seconds apart" 429 never has to be retried.
  let gate = Promise.resolve()
  let lastStart = 0
  function pace(signal) {
    const turn = gate.then(async () => {
      const wait = lastStart + spacing - Date.now()
      if (wait > 0) await sleepFn(wait, signal)
      lastStart = Date.now()
    })
    gate = turn.catch(() => {})
    return turn
  }

  async function get(path, query, signal) {
    const url = new URL(root + path)
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }
    for (let attempt = 0; ; attempt++) {
      let res
      let body
      await pace(signal)
      try {
        const timeout = AbortSignal.timeout(timeoutMs)
        res = await fetchImpl(url, {
          headers,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        })
        // The body is read inside the same try: a timeout, a cancel or a dropped
        // connection while it streams is handled exactly like one before it.
        body = parseJson(await res.text())
      } catch (cause) {
        if (signal?.aborted) throw signal.reason ?? cause
        const timedOut = cause?.name === 'TimeoutError' || (isAbort(cause) && !signal?.aborted)
        const err = timedOut
          ? new ApiError(`No answer within ${Math.round(timeoutMs / 1000)} s.`, {
              code: 'TIMEOUT',
              retryable: true,
            })
          : new ApiError(`Network error: ${cause?.message ?? cause}`, { code: 'NETWORK', retryable: true })
        // A timeout is the caller's to handle: the walker answers it with a smaller page.
        if (timedOut || attempt >= maxRetries) throw err
        const delayMs = backoffMs(attempt)
        onRetry?.({ attempt: attempt + 1, error: err, delayMs })
        await sleepFn(delayMs, signal)
        continue
      }

      if (res.ok) {
        if (body === null) {
          throw new ApiError(`Expected JSON from ${path} but got something else.`, {
            status: res.status,
            code: 'BAD_RESPONSE',
            retryable: false,
          })
        }
        return { body, quota: parseQuota(res.headers) }
      }

      const err = toApiError(res.status, res.headers, body)
      err.body = body
      if (err.code === 'TIMEOUT' || !err.retryable || attempt >= maxRetries) throw err
      const delayMs = err.retryAfterMs ?? backoffMs(attempt)
      onRetry?.({ attempt: attempt + 1, error: err, delayMs })
      await sleepFn(delayMs, signal)
    }
  }

  return {
    transport: name,
    baseUrl: root,

    /**
     * One page of numbers that have a stored profile picture. The API's 404
     * "No results found" comes back as an empty last page; any other 404 (a
     * gateway, a wrong host) is an error, so it can never end a walk early.
     */
    async search(query, { signal } = {}) {
      try {
        const { body, quota } = await get('/phone-numbers/search', query, signal)
        const data = body?.data ?? {}
        return {
          docs: Array.isArray(data.docs) ? data.docs : [],
          nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : null,
          quota,
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 404 && isNoResults(err.body)) {
          return { docs: [], nextCursor: null, quota: err.quota ?? { remaining: null, limit: null } }
        }
        throw err
      }
    },

    /** Database-wide counts, including pictures per country (top countries only). */
    async stats({ signal } = {}) {
      const { body } = await get('/phone-numbers/stats', undefined, signal)
      const data = body?.data ?? {}
      const countries = (Array.isArray(data.topCountries) ? data.topCountries : [])
        .filter((c) => typeof c?._id === 'string' && /^[A-Z]{2}$/.test(c._id))
        .map((c) => ({
          code: c._id,
          numbers: Number(c.count) || 0,
          pictures: Number(c.profilePicCount) || 0,
        }))
      return {
        totalNumbers: Number(data.total) || 0,
        totalPictures: Number(data.totalProfilePics) || 0,
        countries,
      }
    },

    /**
     * Business categories matching a word, for the category filter. Each call
     * costs one request, so callers should cache and debounce.
     */
    async categories(search, { signal, limit = 15 } = {}) {
      const { body } = await get('/business-categories/autocomplete', { search, limit }, signal)
      const items = body?.data?.items ?? []
      return items
        .filter((i) => i && typeof i.value === 'string')
        .map((i) => ({ id: i.value, name: String(i.title ?? i.value), count: Number(i.count) || 0 }))
    },

    /** Role, quota and expiry of a direct key. Costs nothing. Not available on RapidAPI. */
    async keyStats({ signal } = {}) {
      if (name !== 'direct') return null
      const { body } = await get('/api-key-stats', undefined, signal)
      return {
        role: body?.role ?? null,
        status: body?.status ?? null,
        remaining: Number.isFinite(body?.requestRemaining) ? body.requestRemaining : null,
        limit: Number.isFinite(body?.requestLimit) ? body.requestLimit : null,
        expiresAt: body?.expiresAt ?? null,
      }
    },
  }
}
