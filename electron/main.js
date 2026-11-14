/**
 * Desktop app. The main process runs the same local server the web version
 * uses, on a random 127.0.0.1 port, and shows it in a window. Every API call
 * must carry a secret cookie handed only to that window, so no other program
 * on the machine can use the port to spend your key.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, session, shell } from 'electron'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/server.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO_URL = 'https://github.com/eduair94/country-profile-pics'
const OPT_OUT_URL = 'https://whatsapp.checkleaked.cc/opt-out'
const KEY_URL = 'https://whatsapp.checkleaked.cc/api'
const smokeFile = process.argv.find((a) => a.startsWith('--smoke='))?.slice('--smoke='.length)

if (!app.requestSingleInstanceLock()) app.quit()

let win = null
let server = null
let local = null
let origin = ''

// ── Settings (output folder, encrypted key) ────────────────────────────────

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json')

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

// ── Window ─────────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 920,
    minWidth: 420,
    minHeight: 560,
    title: 'Country Profile Pictures',
    backgroundColor: '#f3f4f1',
    icon: path.join(here, '..', 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  win.once('ready-to-show', () => win.show())

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

  if (smokeFile) {
    win.webContents.once('did-finish-load', async () => {
      let result
      try {
        result = await win.webContents.executeJavaScript(`(async () => {
          for (let i = 0; i < 50 && !document.querySelector('#country option[value="ALL"]'); i++) await new Promise(r => setTimeout(r, 100))
          const cfg = await fetch('/api/config').then(r => r.json())
          return { title: document.title, desktop: typeof window.desktop, countries: document.querySelectorAll('#country option').length, config: { desktop: cfg.desktop, canRememberKey: cfg.canRememberKey } }
        })()`)
      } catch (err) {
        result = { error: String(err) }
      }
      await writeFile(smokeFile, JSON.stringify(result))
      app.exit(result.error ? 1 : 0)
    })
  }

  win.loadURL(origin)
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
        { label: 'Get an API Key', click: () => shell.openExternal(KEY_URL) },
        { label: 'Source Code and Help', click: () => shell.openExternal(REPO_URL) },
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
  const settings = await loadSettings()
  const outDir = settings.outDir || path.join(app.getPath('documents'), 'Country Profile Pictures')
  const encryption = await safeStorage.isAsyncEncryptionAvailable()
  const keys = encryption ? keyStore(settings) : null
  const token = randomBytes(32).toString('hex')

  local = createApp({ outDir, token, keyStore: keys, serverKey: (await keys?.load()) ?? '' })
  server = http.createServer((req, res) => local.handle(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  await session.defaultSession.cookies.set({ url: origin, name: 'cpp_token', value: token, httpOnly: true, sameSite: 'strict' })

  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitting = false
app.on('before-quit', (event) => {
  if (quitting || !local) return
  const running = [...local.jobs.values()].filter((e) => e.job.stats.phase === 'running')
  if (!running.length) return
  // Stop downloads cleanly so their progress is saved, then quit.
  event.preventDefault()
  quitting = true
  for (const e of running) e.job.cancel()
  Promise.race([Promise.all(running.map((e) => new Promise((r) => e.job.once('done', r)))), new Promise((r) => setTimeout(r, 5000))]).then(() =>
    app.quit(),
  )
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('quit', () => server?.close())
