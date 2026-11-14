// Regression tests for defects found in review: each one failed before its fix.
import assert from 'node:assert/strict'
import nodeFs, { createReadStream } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, test } from 'node:test'
import { createClient } from '../src/api.js'
import { writeRunCsv, zipRun } from '../src/export.js'
import { DownloadJob } from '../src/job.js'
import { allowedRequest } from '../src/server.js'
import { parseCsvLine, Store } from '../src/store.js'
import { CDN, fakeFetch, KEY, makeDocs, noSleep } from './fake.js'

let out
beforeEach(async () => {
  out = await mkdtemp(path.join(tmpdir(), 'cpp-review-'))
})
afterEach(async () => {
  await rm(out, { recursive: true, force: true })
})

const job = (options, fake) =>
  new DownloadJob(
    { key: KEY, country: 'UY', outDir: out, pageSize: 5, concurrency: 3, ...options },
    { fetch: fake.fetch, sleep: noSleep },
  )
const jpgs = async () => (await readdir(path.join(out, 'pictures', 'UY'))).filter((f) => f.endsWith('.jpg'))
const ledger = async () => {
  const rows = []
  for await (const r of new Store(out).readFiles('UY')) rows.push(r)
  return rows
}

test('an update cut short by max continues where it stopped instead of restarting from the top', async () => {
  const docs = makeDocs(8)
  const fake = fakeFetch({ docs })
  await job({ max: 0 }, fake).run()
  docs.push(...makeDocs(25, { start: 100 }))

  const saved = []
  for (let i = 0; i < 3; i++) saved.push((await job({ max: 10 }, fake).run()).saved)
  assert.deepEqual(saved, [10, 10, 5])
  assert.equal((await jpgs()).length, 33)
  const before = fake.calls.search.length
  const last = await job({ max: 10 }, fake).run()
  assert.equal(last.saved, 0)
  assert.match(last.message, /Up to date/)
  assert.equal(fake.calls.search.length - before, 1)
})

test('two runs with different filters can download the same pictures at the same time', async () => {
  for (let trial = 0; trial < 5; trial++) {
    const dir = path.join(out, `t${trial}`)
    const docs = makeDocs(40)
    const base = fakeFetch({ docs })
    // A CDN with a little jitter, like a real network, so both runs fetch the same pictures at once.
    const jittery = {
      fetch: async (url, init) => {
        if (String(url).startsWith(CDN)) await new Promise((r) => setTimeout(r, Math.random() * 5))
        return base.fetch(url, init)
      },
    }
    const run = (extra) =>
      new DownloadJob(
        { key: KEY, country: 'UY', outDir: dir, max: 0, pageSize: 40, concurrency: 8, ...extra },
        { fetch: jittery.fetch, sleep: noSleep },
      ).run()
    const [a, b] = await Promise.all([run({}), run({ account: 'business' })])
    assert.equal(a.phase, 'complete', a.message)
    assert.equal(b.phase, 'complete', b.message)
    const files = await readdir(path.join(dir, 'pictures', 'UY'))
    assert.equal(files.filter((f) => f.endsWith('.jpg')).length, 40)
    assert.equal(files.filter((f) => f.endsWith('.part')).length, 0)
  }
})

test('refreshing a picture that others link to hands the old picture over first', async () => {
  const docs = makeDocs(3)
  for (const d of docs) d.md5Image = 'a'.repeat(32)
  const bytes = new Map(docs.map((d) => [d.urlImage, Buffer.from('shared-logo')]))
  const fake = fakeFetch({ docs, bytes: (u) => bytes.get(u) })
  await job({ max: 0, concurrency: 1 }, fake).run()
  const [A, B, C] = docs
  assert.deepEqual((await jpgs()).sort(), [`${A.number}.jpg`])

  // A changes picture; B and C still show the old logo.
  A.md5Image = 'b'.repeat(32)
  bytes.set(A.urlImage, Buffer.from('a-new-selfie'))
  const r = await job({ max: 0, refresh: true, mode: 'restart', concurrency: 1 }, fake).run()
  assert.equal(r.refreshed, 1)
  const dir = path.join(out, 'pictures', 'UY')
  assert.equal(await readFile(path.join(dir, `${A.number}.jpg`), 'utf8'), 'a-new-selfie')
  assert.equal(await readFile(path.join(dir, `${B.number}.jpg`), 'utf8'), 'shared-logo', 'the old picture moved to B')

  const csvFile = path.join(out, 'exports', 'UY.csv')
  await writeRunCsv(new Store(out), 'UY', csvFile)
  const [header, ...rows] = (await readFile(csvFile, 'utf8')).slice(1).trim().split('\r\n').map(parseCsvLine)
  const pic = Object.fromEntries(rows.map((r) => [r[header.indexOf('number')], r[header.indexOf('picture_file')]]))
  assert.equal(pic[A.number], `pictures/UY/${A.number}.jpg`)
  assert.equal(pic[B.number], `pictures/UY/${B.number}.jpg`)
  assert.equal(pic[C.number], `pictures/UY/${B.number}.jpg`, 'C still shows the old logo, now at B')

  // A linked number whose own picture changed is refreshed too.
  C.md5Image = 'c'.repeat(32)
  bytes.set(C.urlImage, Buffer.from('c-new'))
  const r2 = await job({ max: 0, refresh: true, mode: 'restart', concurrency: 1 }, fake).run()
  assert.equal(r2.saved, 1)
  assert.equal(await readFile(path.join(dir, `${C.number}.jpg`), 'utf8'), 'c-new')
})

test('a current picture and a history picture are linked separately', async () => {
  const docs = makeDocs(2, { history: 1 })
  const [first, second] = docs
  // Second number: current and history are both identical to pictures of the first.
  const fake = fakeFetch({
    docs,
    bytes: (u) => Buffer.from(u.includes(second.number) ? u.replace(second.number, first.number) : u),
  })
  const r = await job({ max: 0, includeHistory: true, concurrency: 1 }, fake).run()
  assert.equal(r.duplicates, 2)
  const links = (await ledger()).filter((row) => row.shared && row.number === second.number)
  assert.deepEqual(links.map((l) => l.kind).sort(), ['current', 'history'])
})

test('a failed current picture is downloaded later even when its history picture was linked', async () => {
  const docs = makeDocs(2, { history: 1 })
  const [first, second] = docs
  let failCurrent = true
  const base = fakeFetch({
    docs,
    bytes: (u) => Buffer.from(u.includes(second.number) && u.includes('_1') ? u.replace(second.number, first.number) : u),
  })
  const fake = { fetch: async (url, init) => {
    if (failCurrent && String(url) === second.urlImage) return new Response('busy', { status: 500 })
    return base.fetch(url, init)
  } }
  const r1 = await job({ max: 0, includeHistory: true, concurrency: 1 }, fake).run()
  assert.equal(r1.failed, 1)
  assert.match(r1.message, /could not be downloaded/)
  failCurrent = false
  const r2 = await job({ max: 0, includeHistory: true, concurrency: 1 }, fake).run()
  assert.equal(r2.saved, 1)
  assert.ok((await jpgs()).includes(`${second.number}.jpg`))
})

test('failed downloads are retried by the next run without any search request', async () => {
  const docs = makeDocs(6)
  let broken = true
  const base = fakeFetch({ docs })
  const fake = { fetch: async (url, init) => {
    if (broken && String(url) === docs[2].urlImage) return new Response('busy', { status: 503 })
    return base.fetch(url, init)
  } }
  const r1 = await job({ max: 0 }, fake).run()
  assert.equal(r1.phase, 'complete')
  assert.equal(r1.failed, 1)
  assert.equal(r1.failedPending, 1)
  assert.match(r1.message, /1 picture could not be downloaded/)

  broken = false
  const searches = base.calls.search.length
  const r2 = await job({ max: 0 }, fake).run()
  assert.equal(r2.saved, 1)
  assert.equal(r2.failedPending, 0)
  assert.match(r2.message, /every matching picture is saved/)
  assert.equal(base.calls.search.length - searches, 1, 'only the usual "anything new?" request')
  assert.equal((await jpgs()).length, 6)
  await assert.rejects(stat(path.join(out, 'runs', 'UY.failed.json')), { code: 'ENOENT' })
})

test('a 404 that is not the API\'s "no results" is an error, not the end of the walk', async () => {
  const fake = fakeFetch({
    docs: makeDocs(12),
    searchHook: (_url, n) => (n === 2 ? new Response('{"message":"Endpoint does not exist"}', { status: 404 }) : undefined),
  })
  const r = await job({ max: 0 }, fake).run()
  assert.equal(r.phase, 'error')
  const state = await new Store(out).loadRun('UY')
  assert.equal(state.complete, false)
  assert.ok(state.cursor, 'resumable from where it stopped')
})

test('a connection dropped while the body streams is retried, not fatal', async () => {
  let n = 0
  const client = createClient({
    key: KEY,
    minIntervalMs: 0,
    sleepFn: noSleep,
    fetch: async () => {
      if (++n === 1) {
        const body = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"data":{"docs":['))
            c.error(new TypeError('terminated'))
          },
        })
        return new Response(body, { status: 200 })
      }
      return new Response('{"data":{"docs":[],"nextCursor":null}}', { status: 200 })
    },
  })
  const page = await client.search({})
  assert.equal(n, 2)
  assert.deepEqual(page.docs, [])
})

test('stopping while a body streams ends as cancelled, not as an error', async () => {
  const docs = makeDocs(3)
  let j
  const base = fakeFetch({ docs })
  const fake = { fetch: async (url, init) => {
    if (String(url).includes('/phone-numbers/search')) {
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"data":'))
          init.signal.addEventListener('abort', () => c.error(init.signal.reason))
          setTimeout(() => j.cancel(), 10)
        },
      })
      return new Response(body, { status: 200 })
    }
    return base.fetch(url, init)
  } }
  j = job({ max: 0 }, fake)
  const r = await j.run()
  assert.equal(r.phase, 'cancelled')
})

test('a picture that cannot be read while zipping fails the ZIP without crashing the process', async () => {
  const docs = makeDocs(5)
  await job({ max: 0 }, fakeFetch({ docs })).run()
  const store = new Store(out)
  const csv = await writeRunCsv(store, 'UY', path.join(out, 'exports', 'UY.csv'))
  // yazl stats each file itself; make one look locked, as antivirus or a deletion would.
  const locked = `${docs[2].number}.jpg`
  const realStat = nodeFs.stat
  nodeFs.stat = (p, ...rest) =>
    String(p).endsWith(locked)
      ? setImmediate(() => rest.at(-1)(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })))
      : realStat(p, ...rest)
  try {
    const sink = new PassThrough()
    sink.resume()
    await assert.rejects(zipRun(store, 'UY', csv.file, sink), /EBUSY/)
  } finally {
    nodeFs.stat = realStat
  }
})

test('an export whose file is open elsewhere still succeeds (Windows locks)', async () => {
  const fake = fakeFetch({ docs: makeDocs(3) })
  await job({ max: 0 }, fake).run()
  const store = new Store(out)
  const target = path.join(out, 'exports', 'UY.csv')
  await writeFile(target, Buffer.alloc(2_000_000, 65))
  const reader = createReadStream(target)
  await new Promise((r) => reader.once('data', r))
  reader.pause()
  try {
    const res = await writeRunCsv(store, 'UY', target)
    assert.equal(res.rows, 3)
    assert.match(await readFile(res.file, 'utf8'), /picture_file/)
  } finally {
    reader.destroy()
  }
})

test('cross-site GETs without an Origin header are refused', () => {
  const req = (headers) => ({ method: 'GET', headers: { host: 'localhost:4747', ...headers } })
  assert.equal(allowedRequest(req({ 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(allowedRequest(req({ 'sec-fetch-site': 'same-site' })), false)
  assert.equal(allowedRequest(req({ 'sec-fetch-site': 'same-origin' })), true)
  assert.equal(allowedRequest(req({ 'sec-fetch-site': 'none' })), true, 'typed into the address bar')
  assert.equal(allowedRequest(req({})), true, 'non-browser clients')
})
