/**
 * Demo mode: a stand-in for the WP Data API and its picture CDN that runs
 * entirely inside the app, so anyone can try every screen without a key.
 *
 * Nothing here touches the network or a real person:
 *   - every number has a 0 right after the country code, which no real
 *     number has, so none of them can belong to anyone;
 *   - pictures are drawn on the fly: small poster scenes (mountains,
 *     sunsets, flowers, rings) for people, logo shapes for businesses.
 *     Nothing resembles the grey "no photo" avatar, so a demo picture is
 *     never mistaken for a missing one;
 *   - websites and emails use the reserved `.example` domain.
 *
 * It behaves like the real API where the app depends on it: newest-first
 * keyset cursor (`sortBy=id`, `after`), 500 numbers per page at most, the
 * "no results" 404 at the end of a walk, quota headers counted after each
 * call, the 0.5 s minimum gap between calls (429), and pictures that are no
 * longer public (404). Some businesses share one logo, so "identical
 * pictures" get linked exactly as they would be with real data.
 */
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'

export const DEMO_KEY = 'demo'
export const DEMO_CDN = 'https://pictures.demo.invalid'

/** [country, calling code, numbers with a picture] */
const COUNTRIES = [
  ['BR', '55', 4800],
  ['MX', '52', 3700],
  ['AR', '54', 3100],
  ['US', '1', 2600],
  ['ES', '34', 1500],
  ['CO', '57', 1400],
  ['DE', '49', 1100],
  ['UY', '598', 920],
]

const ABOUTS = ['Available', 'Busy', 'At work', 'At the gym', 'Urgent calls only', 'On vacation', 'Text only, please', 'Sleeping', '']
const CATEGORIES = [
  ['Restaurant', 'Family recipes, open every day'],
  ['Bakery', 'Fresh bread every morning'],
  ['Dentist', 'Appointments by message'],
  ['Hair salon', 'Cuts, colour and styling'],
  ['Car repair', 'Mechanics and tyres'],
  ['Real estate agent', 'Homes to buy and rent'],
  ['Clothing store', 'New collection every season'],
  ['Lawyer', 'Free first consultation'],
  ['Gym', 'Classes from 6 am'],
  ['Pharmacy', 'Home delivery'],
]
const STREETS = ['Main Street', 'Harbour Road', 'Station Avenue', 'Market Square', 'Park Lane', 'River Walk']
const TAGS = ['person', 'smile', 'outdoor', 'indoor', 'beach', 'dog', 'car', 'sunglasses', 'mountain', 'flowers']
const LOGO_CHAINS = 3 // businesses that share one logo, per country

const DAY = 86_400_000
const FIRST_DAY = Date.UTC(2025, 0, 1)
const LAST_DAY = Date.UTC(2026, 10, 10)

/** Deterministic pseudo-random numbers in [0, 1) for a given seed string. */
function rng(seed) {
  let h = createHash('sha256').update(seed).digest().readUInt32LE(0) || 1
  return () => {
    h ^= h << 13
    h ^= h >>> 17
    h ^= h << 5
    return (h >>> 0) / 2 ** 32
  }
}

const md5 = (s) => createHash('md5').update(s).digest('hex')
const pick = (r, list) => list[Math.floor(r() * list.length)]

function makeDoc(ci, i) {
  const [cc, dial, total] = COUNTRIES[ci]
  const r = rng(`${cc}:${i}`)
  const number = `${dial}0${String(i).padStart(8, '0')}`
  const lastSeen = FIRST_DAY + Math.floor(((LAST_DAY - FIRST_DAY) * i) / total) + Math.floor(r() * DAY)
  const firstSeen = lastSeen - Math.floor(r() * 300 * DAY)
  const isBusiness = r() < 0.32
  const doc = {
    _id: (i * 16 + ci).toString(16).padStart(24, '0'),
    number,
    countryCode: cc,
    about: pick(r, ABOUTS),
    isBusiness,
    date: new Date(Math.min(lastSeen, LAST_DAY)).toISOString(),
    creation_date: new Date(Math.max(firstSeen, FIRST_DAY - 200 * DAY)).toISOString(),
    hasUrlImage: true,
    urlImage: `${DEMO_CDN}/${cc}/${number}.jpg`,
  }

  let picture = `photo:${number}`
  if (isBusiness) {
    const c = Math.floor(r() * CATEGORIES.length)
    const [category, description] = CATEGORIES[c]
    const domain = `${category.toLowerCase().replace(/[^a-z]+/g, '-')}-${i}.example`
    const hasWebsite = r() < 0.55
    const hasEmail = r() < 0.6
    const hasAddress = r() < 0.7
    doc.businessProfile = {
      description,
      website: hasWebsite ? [`https://${domain}`] : [],
      email: hasEmail ? `hello@${domain}` : '',
      address: hasAddress ? `${1 + Math.floor(r() * 900)} ${pick(r, STREETS)}` : '',
      categories: [{ id: category, localized_display_name: category }],
    }
    if (hasWebsite) doc.businessDomain = domain
    // A few businesses of one chain use the same logo.
    picture = i % 17 === 0 ? `chain:${cc}:${(i / 17) % LOGO_CHAINS}` : `logo:${number}:${c}`
  } else if (r() < 0.7) {
    const people = r() < 0.12 ? 2 : 1
    const list = Array.from({ length: people }, () => {
      const gender = r() < 0.5 ? 'female' : 'male'
      return { gender, age: 18 + Math.floor(r() * 52), glasses: r() < 0.25, beard: gender === 'male' && r() < 0.35 }
    })
    const tags = new Set(['person'])
    for (let k = 0; k < 3; k++) if (r() < 0.45) tags.add(pick(r, TAGS))
    doc.faceAnalysis = { people: list, summary: { peopleCount: people, allTags: [...tags] } }
  }
  doc.md5Image = md5(picture)
  doc._picture = picture

  if (r() < 0.15) {
    doc.pictureHistory = [1, 2].slice(0, 1 + Math.floor(r() * 2)).map((n) => ({
      number: n,
      url: `${DEMO_CDN}/${cc}/${number}_${n}.jpg`,
      md5: md5(`${picture}:old${n}`),
    }))
  }
  // About 2% of pictures are no longer public (deleted, or the owner opted out).
  if (i % 53 === 0) doc._gone = true
  return doc
}

/* ── Drawing the pictures (a tiny PNG encoder, no dependencies) ─────────── */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l)
  const f = (n) => {
    const k = (n + h / 30) % 12
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return [f(0), f(8), f(4)]
}

const SIZE = 160

/**
 * Draws one picture: shapes painted in order over a background of flat bands.
 * Colours are shared arrays, so a pixel whose four corners hold the same one
 * is filled directly; only edge pixels are supersampled (3×3).
 */
function draw(picture) {
  const r = rng(picture)
  const [kind] = picture.split(':')
  const hue = Math.floor(r() * 360)
  const shapes = []
  const add = (color, test) => shapes.push({ color, test })
  // `count` horizontal bands blending from one colour to another.
  const bands = (from, to, count) =>
    Array.from({ length: count }, (_, k) => from.map((v, c) => Math.round(v + ((to[c] - v) * k) / Math.max(1, count - 1))))
  let sky = [hsl(hue, 0.5, 0.62)]
  let skyEnd = SIZE

  if (kind === 'logo' || kind === 'chain') {
    const shape = Math.floor(r() * 4)
    add([255, 255, 255], [
      (x, y) => (x - 80) ** 2 + (y - 80) ** 2 < 52 ** 2,
      (x, y) => Math.abs(x - 80) < 48 && Math.abs(y - 80) < 48,
      (x, y) => Math.abs(x - 80) + Math.abs(y - 80) < 62,
      (x, y) => y < 128 && y > 30 && Math.abs(x - 80) < (y - 30) * 0.58,
    ][shape])
    add(hsl((hue + 180) % 360, 0.55, 0.5), (x, y) => (x - 80) ** 2 + (y - 88) ** 2 < 18 ** 2)
  } else {
    const scene = ['mountains', 'sunset', 'flower', 'rings'][Math.floor(r() * 4)]
    if (scene === 'mountains') {
      sky = bands(hsl(205 + r() * 20, 0.65, 0.6), hsl(195, 0.6, 0.86), 12)
      skyEnd = 130
      const sun = 30 + r() * 100
      add(hsl(45, 0.95, 0.62), (x, y) => (x - sun) ** 2 + (y - 40) ** 2 < 15 ** 2)
      const far = 30 + r() * 50
      const near = 90 + r() * 50
      add(hsl(220, 0.18, 0.5), (x, y) => y > 62 + Math.abs(x - far) * 0.95)
      add([245, 248, 252], (x, y) => y > 62 + Math.abs(x - far) * 0.95 && y < 77)
      add(hsl(215, 0.2, 0.36), (x, y) => y > 84 + Math.abs(x - near) * 0.8)
      add(hsl(100 + r() * 40, 0.4, 0.38), (x, y) => y > 128 + Math.sin(x / 18) * 3)
    } else if (scene === 'sunset') {
      sky = bands(hsl(265 + r() * 30, 0.45, 0.45), hsl(25 + r() * 20, 0.9, 0.7), 10)
      skyEnd = 104
      const sun = 50 + r() * 60
      add(hsl(45, 1, 0.72), (x, y) => y < 104 && (x - sun) ** 2 + (y - 104) ** 2 < 30 ** 2)
      const sea = bands(hsl(210, 0.55, 0.42), hsl(215, 0.6, 0.24), 6)
      sea.forEach((color, k) => add(color, (x, y) => y >= 104 + k * 10))
      add(hsl(45, 0.95, 0.75), (x, y) => y > 108 && Math.floor((y - 108) / 6) % 2 === 0 && Math.abs(x - sun) < 24 - (y - 108) * 0.35)
    } else if (scene === 'flower') {
      sky = bands(hsl(hue, 0.4, 0.88), hsl(hue, 0.4, 0.76), 8)
      const petal = hsl((hue + 180) % 360, 0.65, 0.6)
      add(hsl(120, 0.4, 0.4), (x, y) => y > 80 && Math.abs(x - 80 - (y - 80) * 0.08) < 3.5)
      add(hsl(120, 0.4, 0.45), (x, y) => ((x - 100) / 18) ** 2 + ((y - 128) / 8) ** 2 < 1)
      for (let k = 0; k < 6; k++) {
        const a = (k * Math.PI) / 3 + r() * 0.2
        const px = 80 + Math.cos(a) * 25
        const py = 68 + Math.sin(a) * 25
        add(petal, (x, y) => (x - px) ** 2 + (y - py) ** 2 < 17 ** 2)
      }
      add(hsl(45, 0.95, 0.55), (x, y) => (x - 80) ** 2 + (y - 68) ** 2 < 14 ** 2)
    } else {
      sky = [hsl(hue, 0.55, 0.3)]
      const cx = 40 + r() * 80
      const cy = 40 + r() * 80
      const colors = [0, 40, 80, 120].map((d, k) => hsl((hue + d) % 360, 0.6 - k * 0.03, 0.55 + k * 0.1))
      for (let k = 0; k < 8; k++) {
        const radius = 120 - k * 15
        add(colors[k % 4], (x, y) => (x - cx) ** 2 + (y - cy) ** 2 < radius ** 2)
      }
    }
  }

  const bandHeight = skyEnd / sky.length
  const colorAt = (px, py) => {
    let c = sky[Math.min(sky.length - 1, Math.floor(py / bandHeight))]
    for (const s of shapes) if (s.test(px, py)) c = s.color
    return c
  }
  // Colour at every pixel corner; only pixels whose corners differ (edges) are supersampled.
  const W = SIZE + 1
  const corners = new Array(W * W)
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) corners[y * W + x] = colorAt(x, y)

  const rgb = Buffer.alloc(SIZE * SIZE * 3)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const o = (y * SIZE + x) * 3
      const c = corners[y * W + x]
      if (c === corners[y * W + x + 1] && c === corners[(y + 1) * W + x] && c === corners[(y + 1) * W + x + 1]) {
        rgb[o] = c[0]
        rgb[o + 1] = c[1]
        rgb[o + 2] = c[2]
        continue
      }
      let R = 0
      let G = 0
      let B = 0
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          const s = colorAt(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3)
          R += s[0]
          G += s[1]
          B += s[2]
        }
      }
      rgb[o] = R / 9
      rgb[o + 1] = G / 9
      rgb[o + 2] = B / 9
    }
  }
  return encodePng(SIZE, SIZE, rgb)
}

/* ── The fake API ───────────────────────────────────────────────────────── */

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

const yes = (v) => v === 'true'
const has = (v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)

function matches(doc, p) {
  const get = (k) => p.get(k) ?? undefined
  if (get('countryCode') && doc.countryCode !== get('countryCode')) return false
  if (get('isBusiness') && doc.isBusiness !== yes(get('isBusiness'))) return false
  if (get('number') && !doc.number.startsWith(get('number'))) return false
  const b = doc.businessProfile
  if (get('search')) {
    const text = [doc.about, b?.description, ...(b?.categories ?? []).map((c) => c.localized_display_name)].join(' ').toLowerCase()
    if (!get('search').toLowerCase().split(/\s+/).every((w) => text.includes(w))) return false
  }
  if (get('domain') && doc.businessDomain !== get('domain').toLowerCase().replace(/^https?:\/\/|^www\.|\/.*$/g, '')) return false
  if (get('address') && !b?.address.toLowerCase().includes(get('address').toLowerCase())) return false
  if (get('email') && !b?.email.toLowerCase().includes(get('email').toLowerCase())) return false
  for (const [param, field] of [
    ['hasWebsite', 'website'],
    ['hasEmail', 'email'],
    ['hasAddress', 'address'],
  ]) {
    if (!get(param)) continue
    if (!b || has(b[field]) !== yes(get(param))) return false
  }
  if (get('categories')) {
    const wanted = get('categories').split(',').map(decodeURIComponent)
    const mine = new Set((b?.categories ?? []).map((c) => c.id))
    const ok = get('categoriesMode') === 'all' ? wanted.every((c) => mine.has(c)) : wanted.some((c) => mine.has(c))
    if (!ok) return false
  }
  const day = (get('dateField') === 'creation_date' ? doc.creation_date : doc.date).slice(0, 10)
  if (get('dateFrom') && day < get('dateFrom')) return false
  if (get('dateTo') && day > get('dateTo')) return false

  const face = ['faceGender', 'faceMinAge', 'faceMaxAge', 'facePeopleMin', 'facePeopleMax', 'faceHasGlasses', 'faceHasBeard', 'faceTags']
  if (face.some((k) => get(k))) {
    const fa = doc.faceAnalysis
    if (!fa) return false
    const count = fa.summary.peopleCount
    if (get('facePeopleMin') && count < Number(get('facePeopleMin'))) return false
    if (get('facePeopleMax') && count > Number(get('facePeopleMax'))) return false
    const someone = fa.people.some(
      (person) =>
        (!get('faceGender') || person.gender === get('faceGender')) &&
        (!get('faceMinAge') || person.age >= Number(get('faceMinAge'))) &&
        (!get('faceMaxAge') || person.age <= Number(get('faceMaxAge'))) &&
        (!get('faceHasGlasses') || person.glasses === yes(get('faceHasGlasses'))) &&
        (!get('faceHasBeard') || person.beard === yes(get('faceHasBeard'))),
    )
    if (!someone) return false
    if (get('faceTags')) {
      const tags = get('faceTags').split(',').map((t) => t.trim().toLowerCase())
      const mine = new Set(fa.summary.allTags)
      if (!(get('faceTagsMode') === 'all' ? tags.every((t) => mine.has(t)) : tags.some((t) => mine.has(t)))) return false
    }
  }
  return true
}

/**
 * A `fetch` that answers the WP Data API (direct and RapidAPI hosts) and the
 * demo picture CDN from memory. Any other URL is refused, never fetched.
 *
 * @param {object} [options]
 * @param {number} [options.quota]            requests on the demo key
 * @param {boolean} [options.latency]         answer at a realistic pace (default on)
 * @param {(png: Buffer) => Buffer} [options.toJpeg]  re-encode pictures as JPEG
 *                                            (the desktop app passes Electron's encoder)
 */
export function createDemoFetch({ quota = 10_000, latency = true, toJpeg } = {}) {
  const docs = []
  for (let ci = 0; ci < COUNTRIES.length; ci++) {
    for (let i = 1; i <= COUNTRIES[ci][2]; i++) docs.push(makeDoc(ci, i))
  }
  docs.sort((a, b) => (a._id < b._id ? 1 : a._id > b._id ? -1 : 0))
  const byPicture = new Map()
  for (const d of docs) {
    byPicture.set(d.urlImage, { picture: d._picture, gone: d._gone })
    for (const old of d.pictureHistory ?? []) byPicture.set(old.url, { picture: `${d._picture}:old${old.number}` })
  }
  const publicDoc = ({ _picture, _gone, ...doc }) => doc

  let remaining = quota
  let lastCall = 0
  const wait = (min, max, signal) => (latency ? sleep(min + Math.random() * (max - min), signal) : signal?.throwIfAborted())

  const json = (status, body, extra = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-requests-limit': String(quota),
        'x-ratelimit-requests-remaining': String(remaining),
        ...extra,
      },
    })

  return async function demoFetch(input, init = {}) {
    const url = new URL(String(input))
    const signal = init.signal

    if (url.origin === DEMO_CDN) {
      await wait(25, 110, signal)
      const entry = byPicture.get(url.href)
      if (!entry || entry.gone) return new Response('Not found', { status: 404 })
      const png = draw(entry.picture)
      const body = toJpeg ? toJpeg(png) : png
      return new Response(body, {
        status: 200,
        headers: { 'content-type': toJpeg ? 'image/jpeg' : 'image/png', 'content-length': String(body.length) },
      })
    }

    const apiHost = url.hostname === 'whatsapp-proxy.checkleaked.cc' || url.hostname === 'wp-data-db-only.p.rapidapi.com'
    if (!apiHost) return new Response('Demo mode never goes online.', { status: 502 })

    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    if (!String(headers['x-rapidapi-key'] ?? '').trim()) return json(401, { error: 'Missing API key' })

    await wait(120, 380, signal)
    if (url.pathname === '/api-key-stats') {
      return json(200, {
        role: 'demo',
        status: 'active',
        requestRemaining: remaining,
        requestLimit: quota,
        expiresAt: new Date(Date.now() + 365 * DAY).toISOString(),
      })
    }

    // The real API refuses calls closer together than half a second.
    const now = Date.now()
    if (now - lastCall < 500) return json(429, { error: 'Requests must be at least 0.5 seconds apart' })
    lastCall = now
    if (remaining <= 0) return json(429, { error: 'Monthly quota exceeded' })

    const p = url.searchParams
    if (url.pathname === '/phone-numbers/search') {
      const limit = Math.min(500, Math.max(1, Number(p.get('limit')) || 10))
      const after = p.get('after')
      const page = []
      for (const d of docs) {
        if (after && d._id >= after) continue
        if (!matches(d, p)) continue
        page.push(publicDoc(d))
        if (page.length === limit) break
      }
      if (!page.length) return json(404, { success: false, error: 'No results found', data: { docs: [], nextCursor: null } })
      remaining--
      return json(200, {
        success: true,
        data: { docs: page, nextCursor: page.length === limit ? page.at(-1)._id : null },
      })
    }
    if (url.pathname === '/phone-numbers/stats') {
      remaining--
      const topCountries = COUNTRIES.map(([cc, , n]) => ({ _id: cc, count: Math.round(n * 2.6), profilePicCount: n }))
      return json(200, {
        success: true,
        data: {
          total: topCountries.reduce((s, c) => s + c.count, 0),
          totalProfilePics: docs.length,
          topCountries,
        },
      })
    }
    if (url.pathname === '/business-categories/autocomplete') {
      remaining--
      const q = String(p.get('search') ?? '').toLowerCase()
      const items = CATEGORIES.filter(([name]) => name.toLowerCase().includes(q)).map(([name]) => ({
        title: name,
        value: name,
        count: docs.filter((d) => d.businessProfile?.categories[0].id === name).length,
      }))
      return json(200, { success: true, data: { items, total: items.length } })
    }
    return json(404, { error: 'Not found' })
  }
}
