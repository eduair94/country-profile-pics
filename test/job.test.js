import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { DownloadJob, normaliseOptions } from '../src/job.js'
import { Store } from '../src/store.js'
import { CDN, fakeFetch, KEY, makeDocs, noSleep } from './fake.js'

let out
beforeEach(async () => {
  out = await mkdtemp(path.join(tmpdir(), 'cpp-test-'))
})
afterEach(async () => {
  await rm(out, { recursive: true, force: true })
})

const jpgs = async (cc = 'UY') =>
  (await readdir(path.join(out, 'pictures', cc)).catch(() => [])).filter((f) => f.endsWith('.jpg')).sort()
const fileRows = async (cc = 'UY') => {
  const rows = []
  for await (const r of new Store(out).readFiles(cc)) rows.push(r)
  return rows
}
const lines = async (file) => (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean)
const loadRun = (slug) => new Store(out).loadRun(slug)

function job(options, fake) {
  return new DownloadJob(
    { key: KEY, country: 'UY', outDir: out, pageSize: 5, concurrency: 3, ...options },
    { fetch: fake.fetch, sleep: noSleep },
  )
}

test('downloads every match into the shared store, with records and a ledger', async () => {
  const docs = makeDocs(12)
  const fake = fakeFetch({ docs })
  const j = job({ max: 0 }, fake)
  const r = await j.run()

  assert.equal(r.phase, 'complete')
  assert.equal(r.saved, 12)
  assert.equal(r.numbers, 12)
  assert.equal(r.credits, 3)
  assert.equal(j.slug, 'UY')
  assert.deepEqual(await jpgs(), docs.map((d) => `${d.number}.jpg`).sort())
  assert.equal((await fileRows()).length, 12)
  assert.equal((await lines(path.join(out, 'data', 'UY.jsonl'))).length, 12)
  assert.equal((await lines(path.join(out, 'runs', 'UY.numbers'))).length, 12)

  const state = await loadRun('UY')
  assert.equal(state.complete, true)
  assert.equal(state.cursor, null)
  assert.equal(state.newestId, docs[0]._id)
  assert.equal(state.totals.saved, 12)
})

test('every request asks only for numbers with a picture, newest first, by cursor', async () => {
  const fake = fakeFetch({ docs: makeDocs(7) })
  await job({ max: 0 }, fake).run()
  for (const url of fake.calls.search) {
    assert.equal(url.searchParams.get('hasProfilePic'), 'true')
    assert.equal(url.searchParams.get('sortBy'), 'id')
    assert.equal(url.searchParams.get('sortOrder'), 'desc')
    assert.equal(url.searchParams.has('page'), false)
  }
})

test('a max cut mid-page resumes from the exact number where it stopped', async () => {
  const docs = makeDocs(12)
  const fake = fakeFetch({ docs })

  const first = await job({ max: 7 }, fake).run()
  assert.equal(first.phase, 'limit')
  assert.equal(first.saved, 7)
  assert.equal((await loadRun('UY')).cursor, docs[6]._id)

  const before = fake.calls.search.length
  const second = await job({ max: 0 }, fake).run()
  assert.equal(second.phase, 'complete')
  assert.equal(second.saved, 5)
  assert.equal(second.existing, 0, 'no picture is fetched twice')
  assert.equal(fake.calls.search[before].searchParams.get('after'), docs[6]._id)
  assert.equal((await jpgs()).length, 12)
  assert.equal(fake.calls.images.length, 12, 'twelve downloads in total')
  assert.equal((await loadRun('UY')).totals.saved, 12, 'totals add up across sessions')
})

test('a small max asks for a small page (same single request, faster answer)', async () => {
  const fake = fakeFetch({ docs: makeDocs(40) })
  await new DownloadJob({ key: KEY, country: 'UY', outDir: out, max: 10 }, { fetch: fake.fetch, sleep: noSleep }).run()
  assert.equal(fake.calls.search.length, 1)
  assert.equal(fake.calls.search[0].searchParams.get('limit'), '16')
})

test('pictures that are no longer public do not count towards max', async () => {
  const docs = makeDocs(10)
  const fake = fakeFetch({ docs, missing: new Set([docs[0].urlImage, docs[2].urlImage]) })
  const r = await job({ max: 5 }, fake).run()
  assert.equal(r.phase, 'limit')
  assert.equal(r.saved, 5)
  assert.equal(r.missing, 2)
  assert.equal((await loadRun('UY')).cursor, docs[6]._id)
})

test('after a complete walk, the next run fetches only numbers added since', async () => {
  const docs = makeDocs(8)
  const fake = fakeFetch({ docs })
  await job({ max: 0 }, fake).run()

  const added = makeDocs(3, { start: 100 })
  docs.push(...added)
  const before = fake.calls.search.length
  const r = await job({ max: 0 }, fake).run()
  assert.equal(r.walk, 'update')
  assert.equal(r.phase, 'complete')
  assert.equal(r.saved, 3)
  assert.equal(fake.calls.search.length - before, 1, 'one request: it stops at the first known number')
  assert.equal((await loadRun('UY')).newestId, added[0]._id)

  const again = await job({ max: 0 }, fake).run()
  assert.equal(again.saved, 0)
  assert.match(again.message, /Up to date/)
})

test('a second run with different filters reuses pictures already saved', async () => {
  const docs = makeDocs(10)
  const fake = fakeFetch({ docs })
  await job({ max: 0 }, fake).run()
  const downloads = fake.calls.images.length

  const j = job({ max: 0, account: 'business' }, fake)
  const r = await j.run()
  assert.notEqual(j.slug, 'UY')
  assert.match(j.slug, /^UY-business-[0-9a-f]{8}$/)
  assert.equal(fake.calls.search.at(-1).searchParams.get('isBusiness'), 'true')
  assert.equal(r.existing, docs.filter((d) => d.isBusiness).length)
  assert.equal(r.saved, 0)
  assert.equal(fake.calls.images.length, downloads, 'no new downloads')
})

test('identical pictures are downloaded once and linked for the other numbers', async () => {
  const docs = makeDocs(6)
  const same = Buffer.from('the-same-default-logo')
  // Two numbers share bytes (detected after download); two share the API's source hash (detected before).
  docs[0].md5Image = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  docs[1].md5Image = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const fake = fakeFetch({
    docs,
    bytes: (url) => (url.includes(docs[3].number) || url.includes(docs[4].number) ? same : Buffer.from(url)),
  })
  const r = await job({ max: 0, concurrency: 1 }, fake).run()
  assert.equal(r.duplicates, 2)
  assert.equal(r.saved, 4)
  assert.equal(fake.calls.images.length, 5, 'the source-hash twin was never downloaded')
  assert.equal((await jpgs()).length, 4)
  const shared = (await fileRows()).filter((row) => row.shared)
  assert.equal(shared.length, 2)
  const link = shared.find((s) => s.number === docs[1].number)
  assert.equal(link.file, `UY/${docs[1].number}.jpg`, 'own path')
  assert.equal(link.shared, `UY/${docs[0].number}.jpg`, 'points at the saved copy')

  // Running again neither downloads nor writes a second link row.
  const downloads = fake.calls.images.length
  const again = await job({ max: 0, mode: 'restart' }, fake).run()
  assert.equal(again.saved, 0)
  assert.equal(fake.calls.images.length, downloads, 'nothing is downloaded again')
  assert.equal((await fileRows()).filter((row) => row.shared).length, 2)
})

test('twins downloading at the same moment still produce one file', async () => {
  const docs = makeDocs(8)
  for (const d of docs) d.md5Image = 'c'.repeat(32)
  const fake = fakeFetch({ docs })
  const r = await job({ max: 0, concurrency: 8, pageSize: 8 }, fake).run()
  assert.equal(fake.calls.images.length, 1)
  assert.equal(r.saved, 1)
  assert.equal(r.duplicates, 7)
  assert.equal((await jpgs()).length, 1)
})

test('with dedupe off, identical pictures are saved per number', async () => {
  const docs = makeDocs(3)
  const fake = fakeFetch({ docs, bytes: () => Buffer.from('same') })
  const r = await job({ max: 0, dedupe: false }, fake).run()
  assert.equal(r.saved, 3)
  assert.equal(r.duplicates, 0)
})

test('refresh re-downloads a picture whose source changed, and only that one', async () => {
  const docs = makeDocs(3)
  docs.forEach((d, i) => (d.md5Image = String(i).repeat(32)))
  const fake = fakeFetch({ docs })
  await job({ max: 0 }, fake).run()
  const before = fake.calls.images.length

  docs[1].md5Image = 'f'.repeat(32)
  const r = await job({ max: 0, refresh: true, mode: 'restart' }, fake).run()
  assert.equal(r.refreshed, 1)
  assert.equal(r.existing, 2)
  assert.equal(fake.calls.images.length - before, 1)
})

test('stopping keeps progress; running again finishes without refetching', async () => {
  const docs = makeDocs(15)
  let j
  let downloads = 0
  const base = fakeFetch({ docs })
  const fake = {
    fetch: async (url, init) => {
      if (String(url).startsWith(CDN) && ++downloads === 7) j.cancel()
      return base.fetch(url, init)
    },
  }
  j = job({ max: 0, concurrency: 1 }, fake)
  const r = await j.run()
  assert.equal(r.phase, 'cancelled')
  const saved = (await jpgs()).length
  assert.equal(saved, 6)
  assert.equal((await fileRows()).length, saved, 'every saved file is in the ledger')

  const r2 = await job({ max: 0 }, base).run()
  assert.equal(r2.phase, 'complete')
  assert.equal((await jpgs()).length, 15)
  assert.equal(r2.existing, 1, 'only the interrupted page is re-read')
  assert.equal(r2.saved, 9)
})

test('two processes cannot run the same filters at once', async () => {
  const docs = makeDocs(3)
  const fake = fakeFetch({ docs })
  const store = new Store(out)
  await store.init()
  await writeFile(path.join(out, 'runs', 'UY.lock'), String(process.pid))
  const r = await job({ max: 0 }, fake).run()
  assert.equal(r.phase, 'error')
  assert.equal(r.error.code, 'RUN_LOCKED')
  // A lock left by a dead process is taken over.
  await writeFile(path.join(out, 'runs', 'UY.lock'), '999999')
  assert.equal((await job({ max: 0 }, fake).run()).phase, 'complete')
})

test('older pictures are saved next to the current one when asked', async () => {
  const docs = makeDocs(3, { history: 2 })
  const r = await job({ max: 0, includeHistory: true }, fakeFetch({ docs })).run()
  assert.equal(r.saved, 9)
  const files = await jpgs()
  assert.ok(files.includes(`${docs[0].number}_1.jpg`))
  assert.ok(files.includes(`${docs[0].number}_2.jpg`))
})

test('all countries: pictures land in each number\'s own country folder', async () => {
  const docs = [...makeDocs(2, { country: 'UY' }), ...makeDocs(2, { country: 'AR', start: 50 })]
  const r = await job({ country: 'ALL', max: 0 }, fakeFetch({ docs })).run()
  assert.equal(r.saved, 4)
  assert.equal((await jpgs('UY')).length, 2)
  assert.equal((await jpgs('AR')).length, 2)
})

test('a rejected key ends in an error that never contains the key', async () => {
  const r = await job({ max: 0 }, fakeFetch({ key: 'other' })).run()
  assert.equal(r.phase, 'error')
  assert.equal(r.error.code, 'UNAUTHORIZED')
  assert.ok(!JSON.stringify(r).includes(KEY))
})

test('options are validated with readable messages', () => {
  assert.throws(() => normaliseOptions({ country: 'Uruguay' }), /two-letter/)
  assert.throws(() => normaliseOptions({ country: 'UY', max: -1 }), /whole number/)
  assert.throws(() => normaliseOptions({ country: 'UY', concurrency: 99 }), /between 1 and 32/)
  assert.throws(() => normaliseOptions({ country: 'UY', pageSize: 501 }), /between 1 and 500/)
  assert.equal(normaliseOptions({ country: 'uy' }).filters.country, 'UY')
  assert.equal(normaliseOptions({ country: 'UY' }).max, 1000)
  assert.equal(normaliseOptions({ country: 'UY' }).dedupe, true)
})
