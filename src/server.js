#!/usr/bin/env node
/**
 * Local web UI. Runs on your machine only (127.0.0.1 by default): the API key
 * you paste stays in this process's memory, is never written to disk, and is
 * only ever sent to the WP Data API.
 *
 *   npm start            → http://localhost:4747
 *   npm run demo:web     → the same, with the built-in demo data (no key needed)
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, TRANSPORTS } from './api.js'
import { COUNTRY_CODES } from './countries.js'
import { createDemoFetch } from './demo.js'
import { loadEnv } from './env.js'
import { AVERAGE_PICTURE_BYTES } from './estimate.js'
import { writeRunCsv, zipRun } from './export.js'
import { ADULT_AGE } from './filters.js'
import { DEFAULTS, DownloadJob } from './job.js'
import { Store } from './store.js'
import { redact } from './util.js'

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url))
const PICTURE_RE = /^\d+(?:_\d+)?\.jpg$/
const SLUG_RE = /^[A-Za-z0-9_-]{1,120}$/
const MAX_BODY = 64 * 1024
const RECENT_IMAGES = 48
const RECENT_LOGS = 200
const STATS_TTL = 30 * 60_000
const CATEGORY_TTL = 6 * 60 * 60_000

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

const keyId = (key, transport) => createHash('sha256').update(`${transport}:${key}`).digest('hex').slice(0, 16)

/**
 * @param {object} [config]
 * @param {string} [config.serverKey]   key used when the browser sends none
 * @param {string} [config.outDir]
 * @param {typeof fetch} [config.fetch] injectable for tests
 * @param {boolean} [config.demo]       the data is invented: the page says so
 * @param {number} [config.minIntervalMs]
 * @param {string} [config.token]       desktop app: every /api request must carry this
 *                                      secret in the `cpp_token` cookie
 * @param {{ save(key: string): Promise<void>, clear(): Promise<void> }} [config.keyStore]
 *                                      desktop app: remembers the key (OS-encrypted)
 */
export function createApp(config = {}) {
  let serverKey = config.serverKey ?? ''
  let outDir = path.resolve(config.outDir ?? DEFAULTS.outDir)
  let store = new Store(outDir)
  const token = config.token ?? ''
  const keyStore = config.keyStore ?? null
  const jobs = new Map()
  const statsCache = new Map()
  const categoryCache = new Map()
  let seq = 0

  const keyFrom = (body) => String(body?.key ?? '').trim() || serverKey
  const clientFor = (body) => {
    const key = keyFrom(body)
    if (!key) throw httpError(400, 'Paste an API key first.')
    return {
      key,
      client: createClient({
        key,
        transport: body?.transport,
        fetch: config.fetch,
        maxRetries: 2,
        minIntervalMs: config.minIntervalMs,
      }),
    }
  }

  function startJob(body) {
    const key = keyFrom(body)
    if (!key) throw httpError(400, 'Paste an API key first.')
    let job
    try {
      job = new DownloadJob(
        { ...body, key, outDir, minIntervalMs: body?.minIntervalMs ?? config.minIntervalMs },
        { fetch: config.fetch },
      )
    } catch (err) {
      throw httpError(400, err.message)
    }
    for (const entry of jobs.values()) {
      if (entry.job.slug === job.slug && entry.job.stats.phase === 'running') {
        throw httpError(409, 'A download with these filters is already running.')
      }
    }
    const id = `${Date.now().toString(36)}${(++seq).toString(36)}`
    const entry = { id, job, clients: new Set(), images: [], logs: [], frames: 0 }
    jobs.set(id, entry)

    const broadcast = (event, data) => {
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
      for (const res of entry.clients) res.write(frame)
    }
    job.on('progress', (s) => broadcast('progress', s))
    job.on('log', (line) => {
      const item = { at: new Date().toISOString(), line }
      entry.logs.push(item)
      if (entry.logs.length > RECENT_LOGS) entry.logs.shift()
      broadcast('log', item)
    })
    job.on('image', (img) => {
      // `n` is the picture's place in this run, so a page that reloads shows the same numbers.
      const item = { ...img, n: ++entry.frames }
      entry.images.push(item)
      if (entry.images.length > RECENT_IMAGES) entry.images.shift()
      broadcast('image', item)
    })
    job.on('done', (s) => broadcast('done', s))
    // run() records its own failures in the job; anything escaping it is a bug worth logging.
    job.run().catch((err) => console.error(redact(String(err?.stack ?? err), key)))
    return entry
  }

  async function check(body) {
    const { key, client } = clientFor(body)
    const id = keyId(key, client.transport)
    const cached = statsCache.get(id)
    const fresh = cached && Date.now() - cached.at < STATS_TTL && !body?.refresh
    const [stats, keyStats] = await Promise.allSettled([fresh ? cached.stats : client.stats(), client.keyStats()])
    const failed = [stats, keyStats].find(
      (r) => r.status === 'rejected' && ['UNAUTHORIZED', 'FORBIDDEN'].includes(r.reason?.code),
    )
    if (failed) throw httpError(failed.reason.status || 401, redact(failed.reason.message, key))
    if (stats.status === 'fulfilled' && !fresh) statsCache.set(id, { at: Date.now(), stats: stats.value })
    return {
      transport: client.transport,
      key: keyStats.status === 'fulfilled' ? keyStats.value : null,
      stats: stats.status === 'fulfilled' ? stats.value : null,
      statsCached: Boolean(fresh),
      statsError: stats.status === 'rejected' ? redact(stats.reason?.message, key) : null,
    }
  }

  async function categories(body) {
    const search = String(body?.search ?? '').trim().toLowerCase()
    if (search.length < 2) throw httpError(400, 'Type at least two letters.')
    if (search.length > 60) throw httpError(400, 'That search is too long.')
    const cached = categoryCache.get(search)
    if (cached && Date.now() - cached.at < CATEGORY_TTL) return { items: cached.items, cached: true }
    const { key, client } = clientFor(body)
    try {
      const items = await client.categories(search, { limit: 15 })
      categoryCache.set(search, { at: Date.now(), items })
      return { items, cached: false }
    } catch (err) {
      throw httpError(err.status && err.status < 500 ? err.status : 502, redact(err.message, key))
    }
  }

  const routes = [
    [
      'GET',
      /^\/api\/config$/,
      () => ({
        serverKey: Boolean(serverKey),
        desktop: Boolean(token),
        demo: Boolean(config.demo),
        canRememberKey: Boolean(keyStore),
        outDir,
        defaults: { max: DEFAULTS.max, concurrency: DEFAULTS.concurrency, pageSize: DEFAULTS.pageSize },
        adultAge: ADULT_AGE,
        averagePictureBytes: AVERAGE_PICTURE_BYTES,
        transports: Object.fromEntries(Object.entries(TRANSPORTS).map(([k, v]) => [k, v.label])),
        countries: COUNTRY_CODES,
      }),
    ],
    ['POST', /^\/api\/check$/, (_req, _m, body) => check(body)],
    [
      'POST',
      /^\/api\/key\/save$/,
      async (_req, _m, body) => {
        if (!keyStore) throw httpError(404, 'Remembering the key is only available in the desktop app.')
        const key = String(body?.key ?? '').trim()
        if (!key) throw httpError(400, 'Paste an API key first.')
        await keyStore.save(key)
        serverKey = key
        return { ok: true }
      },
    ],
    [
      'POST',
      /^\/api\/key\/forget$/,
      async () => {
        if (!keyStore) throw httpError(404, 'Remembering the key is only available in the desktop app.')
        await keyStore.clear()
        serverKey = ''
        return { ok: true }
      },
    ],
    ['POST', /^\/api\/categories$/, (_req, _m, body) => categories(body)],
    [
      'POST',
      /^\/api\/jobs$/,
      (_req, _m, body) => {
        const entry = startJob(body)
        return { id: entry.id, snapshot: entry.job.snapshot() }
      },
    ],
    ['GET', /^\/api\/jobs$/, () => [...jobs.values()].map((e) => ({ id: e.id, ...e.job.snapshot() }))],
    [
      'GET',
      /^\/api\/jobs\/(\w+)$/,
      (_req, m) => {
        const e = getJob(m[1])
        return { id: e.id, snapshot: e.job.snapshot(), images: e.images, logs: e.logs }
      },
    ],
    [
      'POST',
      /^\/api\/jobs\/(\w+)\/cancel$/,
      (_req, m) => {
        getJob(m[1]).job.cancel()
        return { ok: true }
      },
    ],
    [
      'GET',
      /^\/api\/runs$/,
      async () => {
        const running = new Set(
          [...jobs.values()].filter((e) => e.job.stats.phase === 'running').map((e) => e.job.slug),
        )
        return (await store.listRuns()).map((r) => ({ ...r, running: running.has(r.slug) }))
      },
    ],
  ]

  function getJob(id) {
    const entry = jobs.get(id)
    if (!entry) throw httpError(404, 'No such download.')
    return entry
  }

  async function getRun(slug) {
    if (!SLUG_RE.test(slug)) throw httpError(400, 'Bad run name.')
    const run = await store.loadRun(slug)
    if (!run) throw httpError(404, 'No such run.')
    return run
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const { pathname } = url
    if (!allowedRequest(req)) return sendJson(res, 403, { error: 'Cross-site requests are not allowed.' })
    // Desktop app: the port is reachable by any local program, so the API also
    // wants the secret the app's own window was given at launch.
    if (token && pathname.startsWith('/api/') && cookieValue(req, 'cpp_token') !== token) {
      return sendJson(res, 403, { error: 'This app only answers its own window.' })
    }

    try {
      let m = pathname.match(/^\/api\/jobs\/(\w+)\/events$/)
      if (m && req.method === 'GET') return streamEvents(getJob(m[1]), req, res)

      m = pathname.match(/^\/api\/pictures\/([A-Z]{2})\/([^/]+)$/)
      if (m && req.method === 'GET') return await sendPicture(m[1], decodeURIComponent(m[2]), res)

      m = pathname.match(/^\/api\/runs\/([^/]+)\/(csv|zip)$/)
      if (m && req.method === 'GET') return await sendExport(decodeURIComponent(m[1]), m[2], res)

      for (const [method, re, fn] of routes) {
        const match = pathname.match(re)
        if (!match || req.method !== method) continue
        const body = method === 'POST' ? await readJsonBody(req) : null
        return sendJson(res, 200, await fn(req, match, body))
      }

      if (req.method === 'GET' && !pathname.startsWith('/api/')) return await sendStatic(pathname, res)
      return sendJson(res, 404, { error: 'Not found.' })
    } catch (err) {
      // An ApiError without an HTTP status is a bad request (no key, unknown
      // transport); one with a status is the upstream API failing.
      const status =
        err.httpStatus ?? (err instanceof URIError ? 400 : err.name === 'ApiError' ? (err.status ? 502 : 400) : 500)
      const message = redact(err.message ?? String(err), serverKey)
      if (status >= 500) console.error(message)
      if (!res.headersSent) sendJson(res, status, { error: message })
      else res.end()
    }
  }

  function streamEvents(entry, req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    const hello = { id: entry.id, snapshot: entry.job.snapshot(), images: entry.images, logs: entry.logs }
    res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`)
    entry.clients.add(res)
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000)
    req.on('close', () => {
      clearInterval(ping)
      entry.clients.delete(res)
    })
  }

  async function sendExport(slug, kind, res) {
    await getRun(slug)
    await store.init()
    // Build the CSV before answering: if it fails, the browser gets an error, not an empty "download".
    const csv = await writeRunCsv(store, slug, path.join(store.exportsDir(), `${slug}.csv`))
    if (kind === 'csv') {
      const file = csv.file
      const { size } = await stat(file)
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-length': size,
        'content-disposition': `attachment; filename="${slug}.csv"`,
        'cache-control': 'no-store',
      })
      createReadStream(file).pipe(res)
      return
    }
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${slug}.zip"`,
      'cache-control': 'no-store',
    })
    await zipRun(store, slug, csv.file, res)
  }

  async function sendPicture(cc, name, res) {
    if (!PICTURE_RE.test(name)) throw httpError(400, 'Bad file name.')
    // The current folder first, then the folders of downloads started before a folder change.
    const stores = [store, ...[...jobs.values()].map((e) => e.job.store)]
    let file = null
    for (const s of stores) {
      const candidate = s.picturePath(`${cc}/${name}`)
      if (await stat(candidate).then(() => true, () => false)) {
        file = candidate
        break
      }
    }
    if (!file) throw httpError(404, 'No such picture.')
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' })
    createReadStream(file).pipe(res)
  }

  async function sendStatic(pathname, res) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    const file = path.resolve(PUBLIC_DIR, rel)
    if (!file.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) return sendJson(res, 404, { error: 'Not found.' })
    try {
      const data = await readFile(file)
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        ...(file.endsWith('.html')
          ? {
              'content-security-policy':
                "default-src 'self'; img-src 'self' data:; style-src 'self'; " +
                "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
              'referrer-policy': 'no-referrer',
            }
          : {}),
      })
      res.end(data)
    } catch {
      sendJson(res, 404, { error: 'Not found.' })
    }
  }

  return {
    handle,
    jobs,
    get store() {
      return store
    },
    get outDir() {
      return outDir
    },
    /** Desktop app: save new downloads somewhere else. Running downloads keep their folder. */
    setOutDir(dir) {
      outDir = path.resolve(dir)
      store = new Store(outDir)
      return outDir
    },
  }
}

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return null
}

/**
 * Only answer requests that come from this app's own page. The Host check stops
 * DNS rebinding; the Origin check stops another website from driving the API
 * (and spending your key) from a tab in the same browser; requiring JSON on
 * POST rules out plain cross-site form posts; Sec-Fetch-Site catches the
 * cross-site GETs (an <img> or a link) that carry no Origin at all.
 */
export function allowedRequest(req) {
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return false
  const host = String(req.headers.host ?? '').toLowerCase()
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  const extra = (process.env.ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
  if (!['localhost', '127.0.0.1', '::1', ...extra].includes(hostname)) return false
  const origin = req.headers.origin
  if (origin && origin !== `http://${host}` && origin !== `https://${host}`) return false
  if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) return false
  return true
}

function httpError(status, message) {
  const err = new Error(message)
  err.httpStatus = status
  return err
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(data))
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(httpError(413, 'Request too large.'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(httpError(400, 'Body must be JSON.'))
      }
    })
    req.on('error', reject)
  })
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  loadEnv()
  const host = process.env.HOST || '127.0.0.1'
  const port = Number(process.env.PORT) || 4747
  const demo = process.argv.includes('--demo')
  const app = createApp({
    serverKey: demo ? undefined : process.env.WA_API_KEY,
    outDir: demo ? path.join(os.tmpdir(), 'country-profile-pics-demo', 'downloads') : process.env.OUT_DIR,
    minIntervalMs: process.env.MIN_INTERVAL_MS ? Number(process.env.MIN_INTERVAL_MS) : undefined,
    fetch: demo ? createDemoFetch() : undefined,
    demo,
  })
  const server = http.createServer((req, res) => app.handle(req, res))
  server.listen(port, host, () => {
    const shown = ['127.0.0.1', '::1'].includes(host) ? 'localhost' : host
    console.log(`\n  country-profile-pics is running → http://${shown}:${port}`)
    console.log(`  Saving to ${app.store.root}\n`)
    if (demo) console.log('  Demo mode: invented numbers and drawn pictures, nothing goes online. Type any key.\n')
    else if (process.env.WA_API_KEY) console.log('  Using WA_API_KEY from the environment.\n')
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
      console.log('  ⚠  Listening beyond this machine: anyone who can reach this port can spend the server key.\n')
    }
  })
  const stop = () => {
    for (const { job } of app.jobs.values()) job.cancel()
    setTimeout(() => process.exit(0), 1500).unref()
    server.close()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
