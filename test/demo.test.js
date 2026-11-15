import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { createDemoFetch, DEMO_CDN, DEMO_KEY } from '../src/demo.js'
import { DownloadJob } from '../src/job.js'

const API = 'https://whatsapp-proxy.checkleaked.cc'
const H = { headers: { 'x-rapidapi-key': DEMO_KEY } }
const gap = () => new Promise((r) => setTimeout(r, 520))

let out
let realFetch
beforeEach(async () => {
  out = await mkdtemp(path.join(tmpdir(), 'cpp-demo-'))
  // The demo must never go online: any real request fails the test.
  realFetch = globalThis.fetch
  globalThis.fetch = () => {
    throw new Error('demo mode went online')
  }
})
afterEach(async () => {
  globalThis.fetch = realFetch
  await rm(out, { recursive: true, force: true })
})

test('demo: a whole country downloads, with linked logos and pictures no longer public', async () => {
  const job = new DownloadJob(
    { key: DEMO_KEY, country: 'UY', max: 0, outDir: out, concurrency: 8 },
    { fetch: createDemoFetch({ latency: false }) },
  )
  const r = await job.run()

  assert.equal(r.phase, 'complete')
  assert.equal(r.numbers, 920)
  assert.equal(r.credits, 2, '920 numbers are two pages of 500')
  assert.equal(r.failed, 0)
  assert.ok(r.duplicates > 0, 'businesses of one chain share a logo, which is linked, not downloaded again')
  assert.ok(r.missing > 0, 'some pictures are no longer public')
  assert.equal(r.saved + r.duplicates + r.missing, 920)

  const files = await readdir(path.join(out, 'pictures', 'UY'))
  assert.equal(files.length, r.saved)
  // Invented numbers: a 0 right after the calling code, which no real number has.
  assert.ok(files.every((f) => /^5980\d{8}\.jpg$/.test(f)))
})

test('demo: newest-first keyset cursor, ending with the API’s "no results" 404', async () => {
  const f = createDemoFetch({ latency: false })
  const seen = new Set()
  let after = null
  let last = null
  for (let page = 0; page < 20; page++) {
    if (page) await gap()
    const q = new URLSearchParams({ countryCode: 'UY', hasProfilePic: 'true', sortBy: 'id', sortOrder: 'desc', limit: '400' })
    if (after) q.set('after', after)
    const res = await f(`${API}/phone-numbers/search?${q}`, H)
    const body = await res.json()
    if (res.status === 404) {
      assert.deepEqual(body.data.docs, [])
      break
    }
    for (const d of body.data.docs) {
      assert.ok(last === null || d._id < last, 'ids strictly descend')
      last = d._id
      seen.add(d.number)
    }
    after = body.data.nextCursor
    if (!after) break
  }
  assert.equal(seen.size, 920)
})

test('demo: filters narrow the walk the way the real API does', async () => {
  const f = createDemoFetch({ latency: false })
  const res = await f(`${API}/phone-numbers/search?countryCode=AR&isBusiness=true&hasWebsite=true&categories=Bakery&limit=500`, H)
  const { data } = await res.json()
  assert.ok(data.docs.length > 0)
  for (const d of data.docs) {
    assert.equal(d.countryCode, 'AR')
    assert.equal(d.isBusiness, true)
    assert.equal(d.businessProfile.categories[0].id, 'Bakery')
    assert.match(d.businessProfile.website[0], /^https:\/\/[a-z-]+-\d+\.example$/)
    assert.equal(d._picture, undefined, 'internal fields stay internal')
  }
})

test('demo: quota is counted after the call, only for billed answers', async () => {
  const f = createDemoFetch({ latency: false, quota: 50 })
  const ok = await f(`${API}/phone-numbers/search?countryCode=UY&limit=1`, H)
  assert.equal(ok.headers.get('x-ratelimit-requests-remaining'), '49')
  assert.equal(ok.headers.get('x-ratelimit-requests-limit'), '50')

  const tooSoon = await f(`${API}/phone-numbers/search?countryCode=UY&limit=1`, H)
  assert.equal(tooSoon.status, 429)
  assert.match((await tooSoon.json()).error, /at least 0\.5 seconds apart/)

  await gap()
  const none = await f(`${API}/phone-numbers/search?countryCode=UY&number=59899&limit=1`, H)
  assert.equal(none.status, 404)
  assert.equal(none.headers.get('x-ratelimit-requests-remaining'), '49', 'no results is free')

  const stats = await (await f(`${API}/api-key-stats`, H)).json()
  assert.equal(stats.role, 'demo')
  assert.equal(stats.requestRemaining, 49)

  assert.equal((await f(`${API}/api-key-stats`, { headers: {} })).status, 401)
  assert.equal((await f('https://example.com/anything')).status, 502, 'other hosts are refused, never fetched')
})

test('demo: pictures are drawn PNGs, or JPEGs through the encoder the desktop app passes', async () => {
  const plain = createDemoFetch({ latency: false })
  const page = await (await plain(`${API}/phone-numbers/search?countryCode=DE&limit=3`, H)).json()
  const url = page.data.docs.find((d) => d.urlImage).urlImage
  assert.ok(url.startsWith(`${DEMO_CDN}/DE/`))

  const png = Buffer.from(await (await plain(url)).arrayBuffer())
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(png.readUInt32BE(16), 160, 'width')
  assert.equal(png.readUInt32BE(20), 160, 'height')

  const jpeg = createDemoFetch({ latency: false, toJpeg: (b) => Buffer.concat([Buffer.from('JPEG'), b]) })
  const res = await jpeg(url)
  assert.equal(res.headers.get('content-type'), 'image/jpeg')
  assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString(), 'JPEG')
})
