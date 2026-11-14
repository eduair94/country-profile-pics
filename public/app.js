const $ = (id) => document.getElementById(id)
const form = () => $('setup')
const fmt = new Intl.NumberFormat('en-US')
const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' })
  } catch {
    return null
  }
})()
const SHEET_SIZE = 48
const PAGE = 500

const state = {
  config: null,
  stats: null,
  jobId: null,
  events: null,
  frame: 0,
  categories: new Map(), // id → name
}

const countryName = (code) => (!code ? 'All countries' : code === 'XK' ? 'Kosovo' : regionNames?.of(code) ?? code)
const flag = (code) => (code ? String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '🌐')

function formatBytes(n) {
  if (!n) return '0 MB'
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`
  return `${(n / 1024 ** 3).toFixed(n < 10 * 1024 ** 3 ? 1 : 0)} GB`
}

function formatDuration(ms) {
  const m = Math.round(ms / 60000)
  if (m < 1) return 'under a minute'
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}

async function api(method, path, body) {
  // Every POST is JSON, even an empty one: the server refuses non-JSON posts (cross-site guard).
  const post = method === 'POST'
  const res = await fetch(path, {
    method,
    headers: post ? { 'content-type': 'application/json' } : {},
    body: post ? JSON.stringify(body ?? {}) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`)
  return data
}

function show(el, text, kind) {
  el.textContent = text
  el.hidden = !text
  el.classList.toggle('ok', kind === 'ok')
  el.classList.toggle('error', kind === 'error')
}

const keyBody = () => ({ key: $('key').value, transport: $('transport').value })

/* ── Countries and estimate ────────────────────────────────── */

function populateCountries() {
  const select = $('country')
  const selected = select.value
  const known = [...(state.stats?.countries ?? [])].sort((a, b) => b.pictures - a.pictures)
  const knownCodes = new Set(known.map((c) => c.code))

  select.replaceChildren(new Option('Choose a country…', ''), new Option('🌐  All countries', 'ALL'))
  if (known.length) {
    const group = document.createElement('optgroup')
    group.label = 'Most pictures'
    for (const c of known) group.append(new Option(`${flag(c.code)}  ${countryName(c.code)} (${fmt.format(c.pictures)} pictures)`, c.code))
    select.append(group)
  }
  const group = document.createElement('optgroup')
  group.label = known.length ? 'Other countries' : 'All countries'
  state.config.countries
    .filter((code) => !knownCodes.has(code))
    .map((code) => ({ code, name: countryName(code) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((c) => group.append(new Option(`${flag(c.code)}  ${c.name}`, c.code)))
  select.append(group)
  select.value = selected
}

function selectedMax() {
  const all = document.querySelector('input[name="amount"]:checked')?.value === 'all'
  return all ? 0 : Math.max(1, Math.floor(Number($('max').value) || 0))
}

function hasFilters() {
  const f = readFilters()
  return Object.keys(f).some((k) => !['country', 'categoriesMode', 'faceTagsMode', 'dateField'].includes(k) && f[k] !== undefined && f[k] !== '' && f[k] !== 'all')
}

function updateEstimate() {
  const el = $('estimate')
  const code = $('country').value
  el.replaceChildren()
  if (!code) {
    el.textContent = state.stats ? 'Choose a country to see how many pictures it has.' : 'Check your key to see how many pictures each country has.'
    return
  }
  const max = selectedMax()
  const strong = document.createElement('strong')
  if (!state.stats) {
    el.textContent = `Check your key to see how many pictures ${countryName(code === 'ALL' ? '' : code)} has.`
    return
  }
  const row = code === 'ALL' ? { pictures: state.stats.totalPictures } : state.stats.countries.find((c) => c.code === code)
  if (!row) {
    el.textContent = `${countryName(code)} isn't in the API's list of top countries, so its picture count is unknown. Downloading still works.`
    return
  }
  const pictures = max ? Math.min(max, row.pictures) : row.pictures
  const requests = Math.max(1, Math.ceil(pictures / PAGE))
  strong.textContent = `${fmt.format(row.pictures)} pictures`
  el.append(
    strong,
    ` in the database${hasFilters() ? ' before your filters' : ''}. `,
    max && max < row.pictures ? `This run takes the newest ${fmt.format(max)}: ` : 'All of them take ',
    `at most ${fmt.format(requests)} search request${requests === 1 ? '' : 's'} (pictures download free), about ${formatBytes(pictures * state.config.averagePictureBytes)} on disk.`,
  )
}

/* ── Key ───────────────────────────────────────────────────── */

async function checkKey({ quiet = false } = {}) {
  const status = $('key-status')
  $('check').disabled = true
  if (!quiet) show(status, 'Checking the key…')
  try {
    const res = await api('POST', '/api/check', keyBody())
    state.stats = res.stats
    let text
    if (res.key) {
      const role = res.key.role ? `${res.key.role[0].toUpperCase()}${res.key.role.slice(1)} key` : 'Key'
      const left = res.key.remaining != null ? `${fmt.format(res.key.remaining)} requests left` : 'quota unknown'
      const expires = res.key.expiresAt ? `, valid until ${new Date(res.key.expiresAt).toLocaleDateString()}` : ''
      text = `${role} accepted: ${left}${expires}.`
    } else {
      text = 'RapidAPI key accepted.'
    }
    if (res.statsError) text += ` Picture counts are unavailable (${res.statsError}).`
    show(status, text, 'ok')
    populateCountries()
    updateEstimate()
    // Desktop app: keep a key that works, encrypted by the operating system.
    const typed = $('key').value.trim()
    if (typed && state.config.canRememberKey && $('remember').checked) {
      await api('POST', '/api/key/save', { key: typed })
      state.config.serverKey = true
      $('key').value = ''
      renderKeyState()
    }
  } catch (err) {
    show(status, err.message, 'error')
  } finally {
    $('check').disabled = false
  }
}

/* ── Categories ────────────────────────────────────────────── */

function renderCategories() {
  const list = $('cat-selected')
  list.replaceChildren()
  for (const [id, name] of state.categories) {
    const li = document.createElement('li')
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = `${name} ✕`
    b.setAttribute('aria-label', `Remove ${name}`)
    b.addEventListener('click', () => {
      state.categories.delete(id)
      renderCategories()
    })
    li.append(b)
    list.append(li)
  }
  $('cat-mode').hidden = state.categories.size < 2
  updateCounts()
}

async function findCategories() {
  const word = $('cat-search').value.trim()
  const results = $('cat-results')
  if (word.length < 2) return
  $('cat-find').disabled = true
  try {
    const { items } = await api('POST', '/api/categories', { ...keyBody(), search: word })
    results.replaceChildren()
    if (!items.length) {
      const li = document.createElement('li')
      li.className = 'hint'
      li.textContent = `No categories match "${word}".`
      results.append(li)
    }
    for (const c of items) {
      const li = document.createElement('li')
      const b = document.createElement('button')
      b.type = 'button'
      b.append(c.name)
      const small = document.createElement('small')
      small.textContent = fmt.format(c.count)
      b.append(small)
      b.addEventListener('click', () => {
        state.categories.set(c.id, c.name)
        renderCategories()
      })
      li.append(b)
      results.append(li)
    }
  } catch (err) {
    show($('form-error'), err.message, 'error')
  } finally {
    $('cat-find').disabled = false
  }
}

/* ── Filters ───────────────────────────────────────────────── */

function readFilters() {
  const f = new FormData(form())
  const get = (k) => {
    const v = f.get(k)
    return v === null || v === '' ? undefined : String(v)
  }
  return {
    country: get('country'),
    account: get('account'),
    search: get('search'),
    number: get('number'),
    domain: get('domain'),
    address: get('address'),
    email: get('email'),
    hasWebsite: get('hasWebsite'),
    hasEmail: get('hasEmail'),
    hasAddress: get('hasAddress'),
    categories: state.categories.size ? [...state.categories.keys()] : undefined,
    categoriesMode: get('categoriesMode'),
    dateField: get('dateField'),
    dateFrom: get('dateFrom'),
    dateTo: get('dateTo'),
    faceGender: get('faceGender'),
    faceMinAge: get('faceMinAge'),
    faceMaxAge: get('faceMaxAge'),
    facePeopleMin: get('facePeopleMin'),
    facePeopleMax: get('facePeopleMax'),
    faceHasGlasses: get('faceHasGlasses'),
    faceHasBeard: get('faceHasBeard'),
    faceTags: get('faceTags'),
    faceTagsMode: get('faceTagsMode'),
  }
}

const GROUPS = {
  'f-text': ['search', 'number'],
  'f-business': ['domain', 'address', 'email', 'hasWebsite', 'hasEmail', 'hasAddress', 'categories'],
  'f-dates': ['dateFrom', 'dateTo'],
  'f-face': ['faceGender', 'faceMinAge', 'faceMaxAge', 'facePeopleMin', 'facePeopleMax', 'faceHasGlasses', 'faceHasBeard', 'faceTags'],
}

function updateCounts() {
  const f = readFilters()
  for (const [id, keys] of Object.entries(GROUPS)) {
    const n = keys.filter((k) => f[k] !== undefined).length
    document.querySelector(`.count[data-for="${id}"]`).textContent = n ? String(n) : ''
  }
}

/** Put a saved run's filters back into the form. */
function applyFilters(filters = {}) {
  const el = form().elements
  const set = (name, value) => {
    const field = el.namedItem(name)
    if (!field) return
    if (field instanceof RadioNodeList) {
      for (const r of field) r.checked = r.value === String(value ?? r.value)
      if (value === undefined) field[0].checked = true
    } else field.value = value ?? ''
  }
  $('country').value = filters.country ?? 'ALL'
  set('account', filters.account ?? 'all')
  for (const k of ['search', 'number', 'domain', 'address', 'email', 'hasWebsite', 'hasEmail', 'hasAddress', 'dateFrom', 'dateTo', 'faceGender', 'faceMinAge', 'faceMaxAge', 'facePeopleMin', 'facePeopleMax', 'faceHasGlasses', 'faceHasBeard']) {
    set(k, filters[k])
  }
  set('dateField', filters.dateField ?? 'last-seen')
  set('faceTags', filters.faceTags ? filters.faceTags.join(', ') : '')
  set('categoriesMode', filters.categoriesMode ?? 'any')
  set('faceTagsMode', filters.faceTagsMode ?? 'any')
  state.categories = new Map((filters.categories ?? []).map((c) => [c, c]))
  renderCategories()
  updateCounts()
  updateEstimate()
}

/* ── Running a download ────────────────────────────────────── */

function requestBody() {
  const f = new FormData(form())
  return {
    ...keyBody(),
    ...readFilters(),
    max: selectedMax(),
    includeHistory: f.get('includeHistory') === 'on',
    dedupe: f.get('dedupe') === 'on',
    refresh: f.get('refresh') === 'on',
    saveRecords: f.get('saveRecords') === 'on',
    mode: f.get('restart') === 'on' ? 'restart' : 'continue',
    concurrency: Number(f.get('concurrency')),
    pageSize: Number(f.get('pageSize')) || undefined,
    minIntervalMs: f.get('minIntervalMs') === '' ? undefined : Number(f.get('minIntervalMs')),
  }
}

async function start(event) {
  event?.preventDefault()
  const error = $('form-error')
  show(error, '')
  if (!$('country').value) return show(error, 'Choose a country first (or All countries).', 'error')
  if (!state.config.serverKey && !$('key').value.trim()) return show(error, 'Paste your API key first.', 'error')
  $('start').disabled = true
  try {
    const res = await api('POST', '/api/jobs', requestBody())
    attach(res.id)
  } catch (err) {
    show(error, err.message, 'error')
    $('start').disabled = false
  }
}

function attach(id) {
  state.events?.close()
  state.jobId = id
  state.frame = 0
  $('sheet').replaceChildren()
  $('log').replaceChildren()

  const es = new EventSource(`/api/jobs/${id}/events`)
  state.events = es
  es.addEventListener('hello', (e) => {
    const data = JSON.parse(e.data)
    for (const img of data.images) addFrame(img, false)
    for (const item of data.logs) addLog(item)
    render(data.snapshot)
  })
  es.addEventListener('progress', (e) => render(JSON.parse(e.data)))
  es.addEventListener('image', (e) => addFrame(JSON.parse(e.data), true))
  es.addEventListener('log', (e) => addLog(JSON.parse(e.data)))
  es.addEventListener('done', (e) => {
    render(JSON.parse(e.data))
    es.close()
    loadRuns()
  })
}

function setExport(el, slug, kind, enabled) {
  el.href = enabled ? `/api/runs/${encodeURIComponent(slug)}/${kind}` : '#'
  el.setAttribute('aria-disabled', enabled ? 'false' : 'true')
}

function render(s) {
  const running = s.phase === 'running'
  $('run-flag').textContent = flag(s.country)
  $('run-title').textContent = countryName(s.country)
  $('run-filters').textContent = s.description === 'no filters' ? '' : s.description
  $('run-message').textContent = s.message || (running ? 'Starting…' : '')

  $('c-saved').textContent = fmt.format(s.saved + (s.refreshed ?? 0))
  $('c-existing').textContent = fmt.format(s.existing)
  $('c-duplicates').textContent = fmt.format(s.duplicates)
  $('c-missing').textContent = fmt.format(s.missing)
  $('c-failed').textContent = fmt.format(s.failed)
  $('c-credits').textContent = fmt.format(s.credits)
  $('c-quota').textContent = s.quotaRemaining == null ? '—' : fmt.format(s.quotaRemaining)
  $('c-bytes').textContent = formatBytes(s.bytes)

  $('start').disabled = running
  $('start').textContent = running ? 'Downloading…' : 'Download pictures'
  $('cancel').hidden = !running
  const ready = !running && (s.numbers > 0 || (s.totals?.numbers ?? 0) > 0)
  setExport($('csv'), s.slug, 'csv', ready)
  setExport($('zip'), s.slug, 'zip', ready)
  $('folder').hidden = false
  $('folder-path').textContent = s.outDir

  renderProgress(s, running)
}

function renderProgress(s, running) {
  const box = $('progress')
  const kept = s.saved + s.existing + s.duplicates
  const row = s.country ? state.stats?.countries.find((c) => c.code === s.country) : null
  const filtered = s.description !== 'no filters'
  const known = !filtered && row ? row.pictures : null
  const target = s.max > 0 ? (known ? Math.min(s.max, known) : s.max) : known
  const elapsed = Date.now() - Date.parse(s.startedAt ?? new Date().toISOString())
  const rate = (s.saved + s.duplicates + s.existing) / Math.max(1, elapsed / 1000)
  box.hidden = false

  if (target && target > 0) {
    box.classList.remove('indeterminate')
    $('bar-fill').style.width = `${s.phase === 'complete' ? 100 : Math.min(100, (kept / target) * 100)}%`
    let text = `${fmt.format(kept)} of ${s.max > 0 ? 'up to ' : 'about '}${fmt.format(target)} pictures`
    if (running && rate > 0.2 && kept < target) text += `, ${rate.toFixed(rate < 10 ? 1 : 0)} per second, about ${formatDuration(((target - kept) / rate) * 1000)} left`
    $('progress-text').textContent = `${text}. ${fmt.format(s.numbers)} numbers checked, ${s.pageSize} per request.`
  } else {
    box.classList.toggle('indeterminate', running)
    $('bar-fill').style.width = running ? '' : '100%'
    $('progress-text').textContent = `${fmt.format(kept)} pictures, ${fmt.format(s.numbers)} numbers checked${running && rate > 0.2 ? `, ${rate.toFixed(1)} per second` : ''}.`
  }
}

function addFrame(img, fresh) {
  state.frame++
  const [cc, file] = img.file.split('/')
  const li = document.createElement('li')
  li.className = fresh ? 'frame new' : 'frame'
  const figure = document.createElement('figure')
  const pic = document.createElement('img')
  pic.src = `/api/pictures/${cc}/${encodeURIComponent(file)}`
  pic.alt = `Profile picture of +${img.number}`
  pic.loading = 'lazy'
  pic.decoding = 'async'
  const caption = document.createElement('figcaption')
  const no = document.createElement('span')
  no.textContent = String(state.frame)
  const tail = document.createElement('span')
  tail.textContent = `${cc} …${img.number.slice(-4)}${img.kind === 'history' ? ' old' : ''}`
  caption.append(no, tail)
  figure.append(pic, caption)
  li.append(figure)
  const sheet = $('sheet')
  sheet.prepend(li)
  while (sheet.children.length > SHEET_SIZE) sheet.lastElementChild.remove()
}

function addLog({ at, line }) {
  const li = document.createElement('li')
  const time = document.createElement('time')
  time.dateTime = at
  time.textContent = new Date(at).toLocaleTimeString()
  li.append(time, line)
  const log = $('log')
  log.prepend(li)
  while (log.children.length > 200) log.lastElementChild.remove()
}

/* ── Earlier runs ──────────────────────────────────────────── */

async function loadRuns() {
  let runs = []
  try {
    runs = await api('GET', '/api/runs')
  } catch {
    return
  }
  const list = $('runs')
  list.replaceChildren()
  $('runs-empty').hidden = runs.length > 0
  for (const r of runs) {
    const t = r.totals ?? {}
    const li = document.createElement('li')
    li.className = 'run-item'
    const info = document.createElement('div')
    const h = document.createElement('h3')
    h.textContent = `${flag(r.filters?.country)} ${countryName(r.filters?.country)}`
    const desc = document.createElement('p')
    desc.textContent = r.description === 'no filters' ? 'No filters' : r.description
    const meta = document.createElement('p')
    const st = document.createElement('span')
    st.className = `state${r.complete ? ' done' : ''}`
    st.textContent = r.running ? 'Running' : r.complete ? 'Complete' : 'Can continue'
    const n = (v, word) => `${fmt.format(v ?? 0)} ${word}${v === 1 ? '' : 's'}`
    meta.append(
      st,
      `: ${n(t.numbers, 'number')} checked, ${fmt.format((t.saved ?? 0) + (t.refreshed ?? 0))} new downloads, ` +
        `${fmt.format(t.duplicates ?? 0)} linked, ${n(t.credits, 'request')}. Updated ${new Date(r.updatedAt).toLocaleString()}`,
    )
    info.append(h, desc, meta)

    const buttons = document.createElement('div')
    buttons.className = 'run-buttons'
    const go = document.createElement('button')
    go.type = 'button'
    go.className = 'btn quiet'
    go.textContent = r.complete ? 'Check for new' : 'Continue'
    go.disabled = r.running
    go.addEventListener('click', () => {
      applyFilters(r.filters)
      start()
    })
    const csv = document.createElement('a')
    csv.className = 'btn quiet'
    csv.textContent = 'CSV'
    csv.href = `/api/runs/${encodeURIComponent(r.slug)}/csv`
    const zip = document.createElement('a')
    zip.className = 'btn quiet'
    zip.textContent = 'ZIP'
    zip.href = `/api/runs/${encodeURIComponent(r.slug)}/zip`
    buttons.append(go, csv, zip)
    li.append(info, buttons)
    list.append(li)
  }
}

/* ── Wiring ────────────────────────────────────────────────── */

/** Key field, hint and "saved key" notice, for the web and the desktop app. */
function renderKeyState() {
  const { serverKey, canRememberKey } = state.config
  $('saved-key').hidden = !(serverKey && canRememberKey)
  $('remember-wrap').hidden = !canRememberKey || serverKey
  if (serverKey) {
    $('key').placeholder = canRememberKey ? 'Using your saved key' : 'Using the server’s key'
    $('key-hint').textContent = canRememberKey
      ? 'Paste a different key to use it instead.'
      : 'WA_API_KEY is set where this app runs. Paste a different key to use that one instead.'
  } else {
    $('key').placeholder = 'wapi_… or your RapidAPI key'
    $('key-hint').textContent =
      'A website key, or a RapidAPI key subscribed to WP Data DB Only. It stays on this computer.'
  }
}

function renderFolder(dir) {
  state.config.outDir = dir
  $('out-dir').textContent = dir
}

async function init() {
  state.config = await api('GET', '/api/config')
  populateCountries()
  renderKeyState()
  renderFolder(state.config.outDir)
  if (state.config.serverKey) checkKey({ quiet: true })

  const desktop = window.desktop
  if (desktop) {
    $('folder-buttons').hidden = false
    $('open-folder').hidden = false
    $('choose-folder').addEventListener('click', async () => {
      const dir = await desktop.chooseFolder()
      if (dir) renderFolder(dir)
    })
    for (const id of ['open-out-dir', 'open-folder']) $(id).addEventListener('click', () => desktop.openFolder())
    desktop.onFolderChanged((dir) => {
      renderFolder(dir)
      loadRuns()
    })
  }
  $('forget').addEventListener('click', async () => {
    await api('POST', '/api/key/forget')
    state.config.serverKey = false
    show($('key-status'), '')
    renderKeyState()
  })

  $('check').addEventListener('click', () => checkKey())
  $('key').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      checkKey()
    }
  })
  $('country').addEventListener('change', updateEstimate)
  $('max').addEventListener('input', () => {
    document.querySelector('input[name="amount"][value="some"]').checked = true
    updateEstimate()
  })
  for (const r of document.querySelectorAll('input[name="amount"]')) r.addEventListener('change', updateEstimate)
  form().addEventListener('input', () => {
    updateCounts()
    updateEstimate()
  })
  $('concurrency').addEventListener('input', (e) => ($('concurrency-out').textContent = e.target.value))
  $('blur').addEventListener('change', (e) => $('sheet').classList.toggle('blurred', e.target.checked))
  $('cat-find').addEventListener('click', findCategories)
  $('cat-search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const v = $('cat-search').value.trim()
    if (v) {
      state.categories.set(v, v)
      $('cat-search').value = ''
      renderCategories()
    }
  })
  form().addEventListener('submit', start)
  $('cancel').addEventListener('click', async () => {
    $('cancel').disabled = true
    try {
      await api('POST', `/api/jobs/${state.jobId}/cancel`)
    } finally {
      $('cancel').disabled = false
    }
  })
  for (const id of ['csv', 'zip']) {
    $(id).addEventListener('click', (e) => {
      if ($(id).getAttribute('aria-disabled') === 'true') e.preventDefault()
    })
  }

  loadRuns()
  const jobs = await api('GET', '/api/jobs')
  const current = jobs.find((j) => j.phase === 'running') ?? jobs.at(-1)
  if (current) attach(current.id)
}

init().catch((err) => show($('form-error'), `Could not start the app: ${err.message}`, 'error'))
