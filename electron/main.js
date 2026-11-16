/**
 * Desktop app. The main process runs the same local server the web version
 * uses, on a random 127.0.0.1 port, and shows it in a window. Every API call
 * must carry a secret cookie handed only to that window, so no other program
 * on the machine can use the port to spend your key.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, safeStorage, session, shell } from 'electron'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createDemoFetch } from '../src/demo.js'
import { createApp } from '../src/server.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO_URL = 'https://github.com/eduair94/country-profile-pics'
const GUIDE_URL = `${REPO_URL}/blob/main/docs/GUIDE.md`
const OPT_OUT_URL = 'https://whatsapp.checkleaked.cc/opt-out'
const KEY_URL = 'https://whatsapp.checkleaked.cc/api'
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const smokeFile = arg('smoke')
// Development only: `npm run screenshots` drives the demo and saves the guide's pictures.
const screenshotsDir = app.isPackaged ? undefined : arg('screenshots')
if (screenshotsDir) {
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  app.commandLine.appendSwitch('lang', 'en-US')
  // Keep painting while other windows cover this one, or captures come back stale.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
}

// Demo mode: a built-in stand-in for the API with invented numbers and drawn
// pictures. It has its own settings and folder, so it never touches the real
// key or downloads. Switched on and off in place (Help menu), never by
// restarting: the portable .exe deletes its unpacked copy when it exits.
let demo = process.argv.includes('--demo') || Boolean(screenshotsDir)
const DEMO_ROOT = path.join(app.getPath('temp'), 'country-profile-pics-demo')
const windowTitle = () => (demo ? 'Country Profile Pictures (demo)' : 'Country Profile Pictures')

if (!app.requestSingleInstanceLock()) app.quit()

let win = null
let server = null
let local = null
let origin = ''

// ── Settings (output folder, encrypted key) ────────────────────────────────

const settingsPath = () => (demo ? path.join(DEMO_ROOT, 'settings.json') : path.join(app.getPath('userData'), 'settings.json'))

async function loadSettings() {
  try {
    return JSON.parse(await readFile(settingsPath(), 'utf8'))
  } catch {
    return {}
  }
}

async function saveSettings(settings) {
  await mkdir(path.dirname(settingsPath()), { recursive: true })
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2))
}

/** The key is kept encrypted by the operating system (Keychain, DPAPI, libsecret). */
function keyStore(settings) {
  return {
    async load() {
      if (!settings.key) return ''
      try {
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(settings.key, 'base64'))
        if (shouldReEncrypt) await this.save(result)
        return result
      } catch {
        return ''
      }
    },
    async save(key) {
      settings.key = (await safeStorage.encryptStringAsync(key)).toString('base64')
      await saveSettings(settings)
    },
    async clear() {
      delete settings.key
      await saveSettings(settings)
    },
  }
}

/**
 * Whether the system can really protect a saved key. On Linux without a
 * keyring (GNOME Keyring, KWallet), Electron falls back to a password built
 * into every copy of Chromium, which protects nothing, so the app doesn't
 * offer to remember the key there.
 */
async function keyProtection() {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return null
  if (process.platform !== 'linux') return 'system'
  const backend = safeStorage.getSelectedStorageBackend?.() ?? 'unknown'
  return ['basic_text', 'unknown'].includes(backend) ? null : backend
}

// ── The local server ───────────────────────────────────────────────────────

/** Starts the local server for the current mode (real or demo) and hands its window the secret. */
async function startLocal() {
  const settings = await loadSettings()
  const outDir =
    screenshotsDir || (smokeFile && demo)
      ? await mkdtemp(path.join(os.tmpdir(), 'cpp-check-'))
      : settings.outDir || (demo ? path.join(DEMO_ROOT, 'downloads') : path.join(app.getPath('documents'), 'Country Profile Pictures'))
  const keys = (await keyProtection()) ? keyStore(settings) : null
  if (!keys && settings.key) {
    // Saved by an earlier version without real protection: don't keep it on disk.
    delete settings.key
    await saveSettings(settings)
  }
  const token = randomBytes(32).toString('hex')

  local = createApp({
    outDir,
    token,
    keyStore: keys,
    serverKey: screenshotsDir ? '' : ((await keys?.load()) ?? ''),
    fetch: demo ? createDemoFetch({ toJpeg: (png) => nativeImage.createFromBuffer(png).toJPEG(90) }) : undefined,
    demo,
  })
  server = http.createServer((req, res) => local.handle(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  await session.defaultSession.cookies.set({ url: origin, name: 'cpp_token', value: token, httpOnly: true, sameSite: 'strict' })
}

const runningJobs = () => (local ? [...local.jobs.values()].filter((e) => e.job.stats.phase === 'running') : [])

/** Stops running downloads cleanly (their progress is saved), waiting at most 5 s. */
function stopDownloads() {
  const running = runningJobs()
  for (const e of running) e.job.cancel()
  return Promise.race([
    Promise.all(running.map((e) => new Promise((r) => e.job.once('done', r)))),
    new Promise((r) => setTimeout(r, 5000)),
  ])
}

let switching = false
/** Turns demo mode on or off without restarting the app. */
async function setDemo(on) {
  if (on === demo || switching || !win) return
  if (runningJobs().length && !smokeFile) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [on ? 'Stop and open the demo' : 'Stop and leave the demo', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'A download is running.',
      detail: 'It stops here with its progress saved. Continue it later from Earlier runs.',
    })
    if (response !== 0) return
  }
  switching = true
  try {
    await stopDownloads()
    const old = server
    demo = on
    await startLocal()
    old.close()
    old.closeAllConnections()
    buildMenu()
    win.setTitle(windowTitle())
    await win.loadURL(origin)
  } finally {
    switching = false
  }
}

// ── Window ─────────────────────────────────────────────────────────────────

function createWindow() {
  // The guide shows the light look; SCREENSHOT_THEME=dark takes the dark one.
  if (screenshotsDir) nativeTheme.themeSource = process.env.SCREENSHOT_THEME === 'dark' ? 'dark' : 'light'
  win = new BrowserWindow({
    width: screenshotsDir ? 1280 : 1320,
    height: screenshotsDir ? 860 : 920,
    minWidth: 420,
    minHeight: 560,
    title: windowTitle(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1826' : '#eef5f1',
    icon: path.join(here, '..', 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: !screenshotsDir,
    },
  })
  win.once('ready-to-show', () => win.show())
  // The window keeps the app's name (and "(demo)"), not the page's title.
  win.on('page-title-updated', (event) => {
    event.preventDefault()
    win.setTitle(windowTitle())
  })

  // Links to other sites open in the default browser; the window never leaves the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(origin)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) {
      event.preventDefault()
      if (/^https?:\/\//.test(url)) shell.openExternal(url)
    }
  })

  if (smokeFile) win.webContents.once('did-finish-load', smokeTest)

  if (screenshotsDir) {
    win.webContents.once('did-finish-load', async () => {
      try {
        const { capture } = await import(pathToFileURL(path.join(here, '..', 'scripts', 'screenshots.mjs')).href)
        await capture({ win, dir: path.resolve(screenshotsDir) })
        app.exit(0)
      } catch (err) {
        console.error(err)
        app.exit(1)
      }
    })
  }

  win.loadURL(origin)
}

/**
 * `--smoke=<file>`: checks that the window shows the app, then switches to demo
 * mode in place and uses it like a person would (check a key, download three
 * pictures, read one back), writes what it saw to <file> and quits. Release
 * builds run this on every system before they are published.
 */
async function smokeTest() {
  let result
  try {
    result = await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 50 && !document.querySelector('#country option[value="ALL"]'); i++) await new Promise(r => setTimeout(r, 100))
      const cfg = await fetch('/api/config').then(r => r.json())
      return { title: document.title, desktop: typeof window.desktop, countries: document.querySelectorAll('#country option').length, config: { desktop: cfg.desktop, canRememberKey: cfg.canRememberKey } }
    })()`)
    result.windowTitle = win.getTitle()
    result.keyProtection = await keyProtection()
    if (!demo) {
      await setDemo(true)
      result.demoTitle = win.getTitle()
      result.demo = await win.webContents.executeJavaScript(`(async () => {
        const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json())
        const check = await post('/api/check', { key: 'demo' })
        const { id } = await post('/api/jobs', { key: 'demo', country: 'UY', max: 3 })
        let job
        for (let i = 0; i < 300; i++) {
          job = await fetch('/api/jobs/' + id).then(r => r.json())
          if (job.snapshot.phase !== 'running') break
          await new Promise(r => setTimeout(r, 200))
        }
        const first = job.images[0]
        const bytes = first ? new Uint8Array(await fetch('/api/pictures/' + first.file).then(r => r.arrayBuffer())) : []
        return { role: check.key?.role ?? null, countries: check.stats?.countries?.length ?? 0, phase: job.snapshot.phase, saved: job.snapshot.saved, jpeg: bytes[0] === 0xff && bytes[1] === 0xd8 }
      })()`)
    }
  } catch (err) {
    result = { ...result, error: String(err) }
  }
  await writeFile(smokeFile, JSON.stringify(result))
  app.exit(result.error ? 1 : 0)
}

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Download Folder', click: () => shell.openPath(local.outDir) },
        { label: 'Change Download Folder…', click: () => chooseFolder() },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    {
      role: 'help',
      submenu: [
        { label: 'User Guide', click: () => shell.openExternal(GUIDE_URL) },
        { label: 'Get an API Key', click: () => shell.openExternal(KEY_URL) },
        demo
          ? { label: 'Leave Demo Mode', click: () => setDemo(false) }
          : { label: 'Try the Demo (No Key Needed)', click: () => setDemo(true) },
        { type: 'separator' },
        { label: 'Source Code', click: () => shell.openExternal(REPO_URL) },
        { label: 'Privacy Opt-out Page', click: () => shell.openExternal(OPT_OUT_URL) },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function chooseFolder() {
  const result = await dialog.showOpenDialog(win, {
    title: 'Where should pictures be saved?',
    defaultPath: local.outDir,
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || !result.filePaths[0]) return null
  const dir = local.setOutDir(result.filePaths[0])
  const settings = await loadSettings()
  settings.outDir = dir
  await saveSettings(settings)
  win?.webContents.send('folder-changed', dir)
  return dir
}

// ── IPC: only the app's own page may ask ───────────────────────────────────

function fromOurPage(event) {
  return event.senderFrame?.url?.startsWith(origin)
}

ipcMain.handle('choose-folder', (event) => (fromOurPage(event) ? chooseFolder() : null))
ipcMain.handle('open-folder', async (event) => {
  if (!fromOurPage(event)) return false
  await mkdir(local.outDir, { recursive: true })
  return (await shell.openPath(local.outDir)) === ''
})
ipcMain.handle('app-info', (event) => (fromOurPage(event) ? { version: app.getVersion(), platform: process.platform } : null))

// ── Start-up and shut-down ─────────────────────────────────────────────────

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(async () => {
  await startLocal()
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitting = false
app.on('before-quit', (event) => {
  if (quitting || !runningJobs().length) return
  // Stop downloads cleanly so their progress is saved, then quit.
  event.preventDefault()
  quitting = true
  void stopDownloads().then(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('quit', () => server?.close())
