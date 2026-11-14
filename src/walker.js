/**
 * Walks every search result that has a stored profile picture, newest first,
 * with the search endpoint's keyset cursor (`sortBy=id` + `after`).
 *
 * Why newest first: pictures are dense among recently seen numbers and sparse
 * among old ones, so the first pages are cheap for the database and a long walk
 * slows down as it goes deeper. When a page times out the walker halves the page
 * size and asks again; after a run of good pages it grows back. The cursor is an
 * `_id`, so changing the page size never skips or repeats a row.
 */
import { backoffMs, sleep } from './util.js'

export const MAX_PAGE_SIZE = 500
export const MIN_PAGE_SIZE = 25
const GROW_AFTER_OK_PAGES = 3
// Each attempt can take the server's full 90 s, so give up after two more at the floor.
const MAX_TIMEOUTS_AT_FLOOR = 2

/**
 * @param {ReturnType<import('./api.js').createClient>} client
 * @param {object} options
 * @param {Record<string, string>} options.query   search filters (see filters.toQuery)
 * @param {string|null} [options.after]            resume after this `_id`
 * @param {number} [options.pageSize]
 * @param {AbortSignal} [options.signal]
 * @param {(event: object) => void} [options.onEvent]
 * @param {typeof sleep} [options.sleepFn]
 */
export async function* walkSearch(client, options) {
  const { query, signal, onEvent, sleepFn = sleep } = options
  const target = clampPage(options.pageSize ?? MAX_PAGE_SIZE)
  // Shrink down to 25 numbers (or a quarter of a smaller starting page).
  const floor = Math.max(1, Math.min(MIN_PAGE_SIZE, Math.floor(target / 4)))
  let limit = target
  let after = options.after ?? null
  let okStreak = 0
  let floorTimeouts = 0

  for (;;) {
    const request = {
      ...query,
      hasProfilePic: 'true',
      sortBy: 'id',
      sortOrder: 'desc',
      limit,
      after: after ?? undefined,
    }

    let page
    try {
      page = await client.search(request, { signal })
    } catch (err) {
      if (err?.code !== 'TIMEOUT' || signal?.aborted) throw err
      okStreak = 0
      if (limit > floor) {
        limit = Math.max(floor, Math.floor(limit / 2))
        onEvent?.({ type: 'page-size', limit, reason: 'timeout' })
        continue
      }
      if (++floorTimeouts > MAX_TIMEOUTS_AT_FLOOR) {
        err.message +=
          ` The server could not return even ${floor} numbers in time. Progress is saved: run again later to ` +
          'resume, or loosen the filters (very selective filter combinations are slow to walk).'
        throw err
      }
      const delayMs = backoffMs(floorTimeouts, 5000, 60_000)
      onEvent?.({ type: 'retry', reason: 'timeout', delayMs })
      await sleepFn(delayMs, signal)
      continue
    }

    floorTimeouts = 0
    yield { docs: page.docs, nextCursor: page.nextCursor, after, limit, quota: page.quota }

    if (!page.nextCursor || page.docs.length === 0) return
    after = page.nextCursor

    if (limit < target && ++okStreak >= GROW_AFTER_OK_PAGES) {
      limit = Math.min(target, limit * 2)
      okStreak = 0
      onEvent?.({ type: 'page-size', limit, reason: 'recovered' })
    }
  }
}

/** Convenience: walk one country with optional account / date filters. */
export function walkCountry(client, { country, isBusiness, dateFrom, dateTo, query, ...rest }) {
  const q = { ...(query ?? {}) }
  if (country) q.countryCode = country
  if (isBusiness) q.isBusiness = isBusiness
  if (dateFrom) q.dateFrom = dateFrom
  if (dateTo) q.dateTo = dateTo
  return walkSearch(client, { ...rest, query: q })
}

function clampPage(n) {
  const v = Math.floor(Number(n))
  if (!Number.isFinite(v)) return MAX_PAGE_SIZE
  return Math.min(MAX_PAGE_SIZE, Math.max(1, v))
}
