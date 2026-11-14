import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ApiError, createClient, detectTransport, RAPIDAPI_HOST } from '../src/api.js'
import { fakeFetch, KEY, makeDocs } from './fake.js'

const RAPID_KEY = '0123456789msh0123456789abcdep1a2b3cjsn0123456789ab'

test('detectTransport tells a RapidAPI key from a website key', () => {
  assert.equal(detectTransport(RAPID_KEY), 'rapidapi')
  assert.equal(detectTransport(KEY), 'direct')
  assert.equal(detectTransport('wa_' + 'f'.repeat(64)), 'direct')
})

test('RapidAPI transport sends the gateway host header to the DB Only listing', async () => {
  let seen
  const client = createClient({
    key: RAPID_KEY,
    fetch: async (url, init) => {
      seen = { url: String(url), headers: init.headers }
      return new Response('{"data":{"docs":[],"nextCursor":null}}', { status: 200 })
    },
  })
  await client.search({ countryCode: 'UY' })
  assert.equal(client.transport, 'rapidapi')
  assert.ok(seen.url.startsWith(`https://${RAPIDAPI_HOST}/phone-numbers/search?`))
  assert.equal(seen.headers['x-rapidapi-host'], RAPIDAPI_HOST)
  assert.equal(seen.headers['x-rapidapi-key'], RAPID_KEY)
})

test('search drops empty params and returns docs, cursor and quota', async () => {
  const { fetch, calls } = fakeFetch({ docs: makeDocs(3) })
  const client = createClient({ key: KEY, fetch })
  const page = await client.search({ countryCode: 'UY', hasProfilePic: 'true', limit: 2, after: undefined, isBusiness: '' })
  assert.equal(page.docs.length, 2)
  assert.equal(page.nextCursor, page.docs[1]._id)
  assert.equal(page.quota.remaining, 999)
  assert.equal(calls.search[0].searchParams.has('after'), false)
  assert.equal(calls.search[0].searchParams.has('isBusiness'), false)
})

test('a 404 from search is the end of the walk, not an error', async () => {
  const { fetch } = fakeFetch({ docs: [] })
  const page = await createClient({ key: KEY, fetch }).search({ countryCode: 'UY' })
  assert.deepEqual(page.docs, [])
  assert.equal(page.nextCursor, null)
})

test('the proxy interval 429 is retried after the interval it names', async () => {
  const delays = []
  let n = 0
  const client = createClient({
    key: KEY,
    minIntervalMs: 0,
    sleepFn: async (ms) => delays.push(ms),
    fetch: async () =>
      ++n === 1
        ? new Response('{"error":"Requests must be at least 0.5 seconds apart"}', { status: 429 })
        : new Response('{"data":{"docs":[],"nextCursor":null}}', { status: 200 }),
  })
  await client.search({ countryCode: 'UY' })
  assert.equal(n, 2)
  assert.deepEqual(delays, [550])
})

test('an exhausted quota stops immediately', async () => {
  let n = 0
  const client = createClient({
    key: KEY,
    sleepFn: async () => {},
    fetch: async () => {
      n++
      return new Response('{"error":"Monthly quota exceeded"}', { status: 429 })
    },
  })
  await assert.rejects(client.search({ countryCode: 'UY' }), (err) => err instanceof ApiError && err.code === 'QUOTA_EXCEEDED')
  assert.equal(n, 1)
})

test('401 explains the key and transport; the key never appears in the message', async () => {
  const { fetch } = fakeFetch({ key: 'something-else' })
  await assert.rejects(createClient({ key: KEY, fetch }).search({ countryCode: 'UY' }), (err) => {
    assert.equal(err.code, 'UNAUTHORIZED')
    assert.match(err.message, /transport/)
    assert.ok(!err.message.includes(KEY))
    return true
  })
})

test('a 504 is handed to the caller at once (the walker shrinks the page)', async () => {
  let n = 0
  const client = createClient({
    key: KEY,
    sleepFn: async () => {},
    fetch: async () => {
      n++
      return new Response('<html>gateway timeout</html>', { status: 504 })
    },
  })
  await assert.rejects(client.search({}), (err) => err.code === 'TIMEOUT')
  assert.equal(n, 1)
})

test('503 is retried, honouring Retry-After', async () => {
  const delays = []
  let n = 0
  const client = createClient({
    key: KEY,
    minIntervalMs: 0,
    sleepFn: async (ms) => delays.push(ms),
    fetch: async () =>
      ++n < 3
        ? new Response('{"error":"busy"}', { status: 503, headers: { 'retry-after': '2' } })
        : new Response('{"data":{"docs":[],"nextCursor":null}}', { status: 200 }),
  })
  await client.search({})
  assert.equal(n, 3)
  assert.deepEqual(delays, [2000, 2000])
})

test('keyStats and stats are parsed; keyStats is skipped on RapidAPI', async () => {
  const { fetch } = fakeFetch({ docs: makeDocs(4) })
  const client = createClient({ key: KEY, fetch })
  assert.deepEqual(await client.keyStats(), {
    role: 'mega',
    status: 'active',
    remaining: 999,
    limit: 1000,
    expiresAt: '2030-01-01T00:00:00Z',
  })
  const stats = await client.stats()
  assert.deepEqual(stats.countries, [{ code: 'UY', numbers: 4, pictures: 4 }])
  const rapid = createClient({ key: RAPID_KEY, fetch })
  assert.equal(await rapid.keyStats(), null)
})

test('requests are paced so the proxy never sees two within the interval', async () => {
  const starts = []
  let now = 1_000_000
  const realNow = Date.now
  Date.now = () => now
  try {
    const client = createClient({
      key: KEY,
      minIntervalMs: 550,
      sleepFn: async (ms) => {
        now += ms
      },
      fetch: async () => {
        starts.push(now)
        now += 100 // each answer takes 100 ms
        return new Response('{"data":{"docs":[],"nextCursor":null}}', { status: 200 })
      },
    })
    await client.search({})
    await client.search({})
    await Promise.all([client.search({}), client.search({}), client.search({})])
  } finally {
    Date.now = realNow
  }
  assert.equal(starts.length, 5)
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 550, `gap ${i}: ${starts[i] - starts[i - 1]} ms`)
})

test('categories() maps the autocomplete answer', async () => {
  const { fetch } = fakeFetch({ docs: [] })
  const items = await createClient({ key: KEY, fetch, minIntervalMs: 0 }).categories('rest')
  assert.deepEqual(items[0], { id: 'Restaurant', name: 'Restaurant', count: 36936 })
  assert.equal(items.length, 2)
})
