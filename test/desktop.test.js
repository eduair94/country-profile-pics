// The server as the desktop app runs it: secret cookie, remembered key, folder switch.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { createApp } from '../src/server.js'
import { fakeFetch, KEY, makeDocs } from './fake.js'

const TOKEN = 'a'.repeat(64)
let server
let base
let out
let app
const saved = { key: null, cleared: 0 }

before(async () => {
  out = await mkdtemp(path.join(tmpdir(), 'cpp-desk-'))
  const { fetch } = fakeFetch({ docs: makeDocs(4) })
  app = createApp({
    outDir: path.join(out, 'a'),
    fetch,
    minIntervalMs: 0,
    token: TOKEN,
    keyStore: {
      save: async (key) => void (saved.key = key),
      clear: async () => void saved.cleared++,
    },
  })
  server = http.createServer((req, res) => app.handle(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  server.closeAllConnections?.()
  await new Promise((r) => server.close(r))
  await rm(out, { recursive: true, force: true })
})

const call = (method, p, { body, cookie = `cpp_token=${TOKEN}` } = {}) =>
  fetch(base + p, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })

test('the API answers only the window holding the launch secret', async () => {
  assert.equal((await call('GET', '/api/config', { cookie: '' })).status, 403)
  assert.equal((await call('GET', '/api/config', { cookie: 'cpp_token=wrong' })).status, 403)
  const ok = await call('GET', '/api/config')
  assert.equal(ok.status, 200)
  const cfg = await ok.json()
  assert.equal(cfg.desktop, true)
  assert.equal(cfg.canRememberKey, true)
  assert.equal(cfg.serverKey, false)
  // The page itself still loads without the cookie (it is set before the window opens anyway).
  assert.equal((await call('GET', '/', { cookie: '' })).status, 200)
})

test('a remembered key is used when the page sends none, and can be forgotten', async () => {
  assert.equal((await call('POST', '/api/key/save', { body: { key: KEY } })).status, 200)
  assert.equal(saved.key, KEY)
  assert.equal((await (await call('GET', '/api/config')).json()).serverKey, true)
  const check = await call('POST', '/api/check', { body: {} })
  assert.equal(check.status, 200, 'works without sending the key')
  assert.ok(!(await check.text()).includes(KEY))

  assert.equal((await call('POST', '/api/key/forget', { body: {} })).status, 200)
  assert.equal(saved.cleared, 1)
  assert.equal((await (await call('GET', '/api/config')).json()).serverKey, false)
  assert.equal((await call('POST', '/api/check', { body: {} })).status, 400)
})

test('changing the folder moves new downloads and the runs list', async () => {
  assert.equal(app.outDir, path.join(out, 'a'))
  app.setOutDir(path.join(out, 'b'))
  const cfg = await (await call('GET', '/api/config')).json()
  assert.equal(cfg.outDir, path.join(out, 'b'))
  assert.deepEqual(await (await call('GET', '/api/runs')).json(), [])
})

test('the web version (no secret) has no key-memory routes', async () => {
  const web = createApp({ outDir: path.join(out, 'web') })
  const res = { headers: {}, statusCode: 0, body: '', writeHead(s) { this.statusCode = s }, end(b) { this.body = b } }
  const req = Object.assign(new (await import('node:stream')).Readable({ read() {} }), {
    method: 'POST',
    url: '/api/key/save',
    headers: { host: 'localhost:4747', 'content-type': 'application/json' },
  })
  const done = web.handle(req, res)
  req.push('{"key":"x"}')
  req.push(null)
  await done
  assert.equal(res.statusCode, 404)
})
