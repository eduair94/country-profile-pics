import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { allowedRequest, createApp } from '../src/server.js'
import { fakeFetch, KEY, makeDocs } from './fake.js'

test('only same-origin requests to a local host name are served', () => {
  const req = (headers, method = 'GET') => ({ method, headers })
  assert.equal(allowedRequest(req({ host: 'localhost:4747' })), true)
  assert.equal(allowedRequest(req({ host: '127.0.0.1:4747' })), true)
  assert.equal(allowedRequest(req({ host: '[::1]:4747' })), true)
  assert.equal(allowedRequest(req({ host: 'evil.example:4747' })), false, 'DNS rebinding')
  assert.equal(allowedRequest(req({ host: 'localhost:4747', origin: 'https://evil.example' })), false, 'cross-site')
  assert.equal(allowedRequest(req({ host: 'localhost:4747', origin: 'http://localhost:4747' })), true)
  assert.equal(
    allowedRequest(req({ host: 'localhost:4747', 'content-type': 'text/plain' }, 'POST')),
    false,
    'form posts without CORS preflight',
  )
  assert.equal(allowedRequest(req({ host: 'localhost:4747', 'content-type': 'application/json' }, 'POST')), true)
})

let server
let base
let out
let fake
const responses = []

before(async () => {
  out = await mkdtemp(path.join(tmpdir(), 'cpp-srv-'))
  fake = fakeFetch({ docs: makeDocs(12) })
  const app = createApp({ outDir: out, fetch: fake.fetch, minIntervalMs: 0 })
  server = http.createServer((req, res) => app.handle(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  server.closeAllConnections?.()
  await new Promise((r) => server.close(r))
  await rm(out, { recursive: true, force: true })
})

async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const buf = Buffer.from(await res.arrayBuffer())
  responses.push(buf.toString('latin1'))
  return { status: res.status, headers: res.headers, buf, json: () => JSON.parse(buf.toString('utf8')) }
}

async function waitFor(id) {
  for (let i = 0; i < 200; i++) {
    const snap = (await call('GET', `/api/jobs/${id}`)).json()
    if (!['running', 'idle'].includes(snap.snapshot.phase)) return snap
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('job did not finish')
}

test('check, download, preview, list runs and export through the HTTP API', async () => {
  const cfg = (await call('GET', '/api/config')).json()
  assert.equal(cfg.serverKey, false)
  assert.ok(cfg.countries.includes('UY'))
  assert.equal(cfg.adultAge, 18)

  assert.equal((await call('POST', '/api/check', {})).status, 400)

  const check = await call('POST', '/api/check', { key: KEY })
  assert.equal(check.status, 200)
  assert.equal(check.json().key.role, 'mega')
  assert.deepEqual(check.json().stats.countries, [{ code: 'UY', numbers: 12, pictures: 12 }])
  const statsCalls = fake.calls.other.filter((u) => u.pathname === '/phone-numbers/stats').length
  assert.equal((await call('POST', '/api/check', { key: KEY })).json().statsCached, true)
  assert.equal(
    fake.calls.other.filter((u) => u.pathname === '/phone-numbers/stats').length,
    statsCalls,
    'stats cost a request, so they are cached',
  )

  const cats = await call('POST', '/api/categories', { key: KEY, search: 'Rest' })
  assert.equal(cats.json().items.length, 2)
  assert.equal((await call('POST', '/api/categories', { key: KEY, search: 'rest' })).json().cached, true)

  const bad = await call('POST', '/api/jobs', { key: KEY, country: 'Uruguay' })
  assert.equal(bad.status, 400)
  assert.match(bad.json().error, /two-letter/)
  const child = await call('POST', '/api/jobs', { key: KEY, country: 'UY', faceMaxAge: 12 })
  assert.equal(child.status, 400)

  const started = await call('POST', '/api/jobs', { key: KEY, country: 'UY', max: 0, pageSize: 5 })
  assert.equal(started.status, 200)
  const snap = await waitFor(started.json().id)
  assert.equal(snap.snapshot.phase, 'complete')
  assert.equal(snap.snapshot.saved, 12)
  assert.equal(snap.images.length, 12)

  // The Stop button posts an empty JSON body; it must get through the cross-site guard.
  const cancel = await call('POST', `/api/jobs/${started.json().id}/cancel`, {})
  assert.equal(cancel.status, 200)
  assert.deepEqual(cancel.json(), { ok: true })

  const [cc, file] = snap.images[0].file.split('/')
  const pic = await call('GET', `/api/pictures/${cc}/${file}`)
  assert.equal(pic.status, 200)
  assert.equal(pic.headers.get('content-type'), 'image/jpeg')
  assert.equal((await call('GET', `/api/pictures/UY/${encodeURIComponent('../../runs/UY.json')}`)).status, 400)

  const runs = (await call('GET', '/api/runs')).json()
  assert.equal(runs.length, 1)
  assert.equal(runs[0].slug, 'UY')
  assert.equal(runs[0].complete, true)

  const csv = await call('GET', '/api/runs/UY/csv')
  assert.equal(csv.status, 200)
  assert.match(csv.headers.get('content-disposition'), /UY\.csv/)
  assert.equal(csv.buf.toString('utf8').replace(/^﻿/, '').trim().split('\r\n').length, 13)

  const zip = await call('GET', '/api/runs/UY/zip')
  assert.equal(zip.status, 200)
  assert.equal(zip.headers.get('content-type'), 'application/zip')
  assert.equal(zip.buf.readUInt32LE(0), 0x04034b50)

  assert.equal((await call('GET', '/api/runs/..%2f..%2fx/csv')).status, 400)
  assert.equal((await call('GET', '/api/runs/NOPE/csv')).status, 404)

  const page = await call('GET', '/')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/)
  assert.equal((await call('GET', '/..%2f..%2fpackage.json')).status, 404)

  assert.ok(!responses.some((r) => r.includes(KEY)), 'the key never comes back in a response')
})

test('progress streams over server-sent events', async () => {
  const started = (await call('POST', '/api/jobs', { key: KEY, country: 'UY', max: 3, mode: 'restart' })).json()
  const res = await fetch(`${base}/api/jobs/${started.id}/events`)
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  const reader = res.body.getReader()
  let text = ''
  const decoder = new TextDecoder()
  const deadline = Date.now() + 5000
  while (!/"phase":"(complete|limit)"/.test(text) && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value)
  }
  await reader.cancel()
  assert.match(text, /event: hello/)
  assert.ok(!text.includes(KEY))
})
