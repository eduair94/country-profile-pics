/**
 * An in-memory stand-in for the WP Data API and the image CDN, faithful to the
 * parts this app relies on: `_id`-descending keyset cursor, 404 at the end of
 * a walk, quota headers, and public JPEGs that may 404.
 */
export const KEY = 'wapi_' + 'ab'.repeat(32)
export const CDN = 'https://cdn.test'

export const idFor = (i) => i.toString(16).padStart(24, '0')

/** n documents for `country`, newest (highest _id) first. */
export function makeDocs(n, { country = 'UY', start = 1, history = 0 } = {}) {
  const docs = []
  for (let i = start; i < start + n; i++) {
    const number = `598${String(90000000 + i)}`
    docs.push({
      _id: idFor(i),
      number,
      countryCode: country,
      hasUrlImage: true,
      urlImage: `${CDN}/${number}.jpg`,
      isBusiness: i % 5 === 0,
      date: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      md5Image: undefined,
      pictureHistory: Array.from({ length: history }, (_, k) => ({ number: k + 1, url: `${CDN}/${number}_${k + 1}.jpg` })),
    })
  }
  return docs.sort((a, b) => (a._id < b._id ? 1 : -1))
}

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-ratelimit-requests-remaining': '999', 'x-ratelimit-requests-limit': '1000', ...headers },
  })

/**
 * @param {object} o
 * @param {object[]} o.docs                     database rows (any order)
 * @param {Set<string>} [o.missing]             image URLs that answer 404
 * @param {(url: URL, n: number) => Response|undefined} [o.searchHook]  override a search call
 * @param {(url: string) => Buffer} [o.bytes]   image bytes per URL
 */
export function fakeFetch({ docs = [], missing = new Set(), searchHook, bytes, key = KEY } = {}) {
  const calls = { search: [], images: [], other: [] }
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    init.signal?.throwIfAborted()

    if (url.origin === CDN) {
      calls.images.push(url.href)
      if (missing.has(url.href)) return new Response('not found', { status: 404 })
      const body = bytes ? bytes(url.href) : Buffer.from(`jpeg:${url.pathname}`)
      return new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(body.length) } })
    }

    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    if (headers['x-rapidapi-key'] !== key) return json(401, { error: 'Invalid API key' })

    if (url.pathname === '/phone-numbers/search') {
      calls.search.push(url)
      const hooked = searchHook?.(url, calls.search.length)
      if (hooked) return hooked
      const p = url.searchParams
      const limit = Number(p.get('limit') ?? 10)
      const after = p.get('after')
      let rows = docs
        .filter((d) => (!p.get('countryCode') || d.countryCode === p.get('countryCode')) && d.hasUrlImage)
        .filter((d) => (p.get('isBusiness') === 'true' ? d.isBusiness : p.get('isBusiness') === 'false' ? !d.isBusiness : true))
        .sort((a, b) => (a._id < b._id ? 1 : -1))
      if (after) rows = rows.filter((d) => d._id < after)
      const page = rows.slice(0, limit)
      if (!page.length) return json(404, { success: false, data: { docs: [], nextCursor: null } })
      const nextCursor = page.length === limit ? page[page.length - 1]._id : null
      return json(200, { success: true, data: { docs: page, nextCursor } })
    }
    if (url.pathname === '/phone-numbers/stats') {
      calls.other.push(url)
      const by = {}
      for (const d of docs) {
        by[d.countryCode] ??= { _id: d.countryCode, count: 0, profilePicCount: 0 }
        by[d.countryCode].count++
        if (d.hasUrlImage) by[d.countryCode].profilePicCount++
      }
      return json(200, { success: true, data: { total: docs.length, totalProfilePics: docs.length, topCountries: Object.values(by) } })
    }
    if (url.pathname === '/business-categories/autocomplete') {
      calls.other.push(url)
      const q = (url.searchParams.get('search') ?? '').toLowerCase()
      const all = [
        { title: 'Restaurant', value: 'Restaurant', count: 36936 },
        { title: 'Restaurante', value: '273819889375819', count: 27692 },
        { title: 'Dentist', value: 'Dentist', count: 1200 },
      ]
      return json(200, { success: true, data: { items: all.filter((i) => i.title.toLowerCase().includes(q)), total: 3 } })
    }
    if (url.pathname === '/api-key-stats') {
      calls.other.push(url)
      return json(200, { key, role: 'mega', status: 'active', requestRemaining: 999, requestLimit: 1000, expiresAt: '2030-01-01T00:00:00Z' })
    }
    return json(404, { error: 'no route' })
  }
  return { fetch, calls }
}

export const noSleep = async (_ms, signal) => signal?.throwIfAborted()
