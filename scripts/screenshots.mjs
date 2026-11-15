/**
 * Takes the pictures in docs/GUIDE.md. Run `npm run screenshots`: it opens the
 * desktop app in demo mode (invented numbers, drawn pictures, nothing goes
 * online), clicks through a first run like a new user would, and saves each
 * step to docs/images/. electron/main.js loads this file; it is not part of
 * the packaged app.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Shown instead of the real (temporary, user-specific) folder.
const SHOWN_FOLDER = 'C:\\Users\\you\\Documents\\Country Profile Pictures'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function capture({ win, dir }) {
  await mkdir(dir, { recursive: true })
  const wc = win.webContents
  const js = (code) => wc.executeJavaScript(code)
  const call = (fn, ...args) => js(`(${fn})(...${JSON.stringify(args)})`)

  async function until(expr, what, timeoutMs = 60_000) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (await js(`Boolean(${expr})`)) return
      await sleep(100)
    }
    throw new Error(`Timed out waiting for ${what}`)
  }

  /** Saves the window, or the box around the given elements (scrolled into view first). */
  async function shot(name, selectors = [], pad = 14) {
    await js('document.activeElement?.blur()')
    const scrollTop = (sel, pad) => {
      const top = sel ? document.querySelector(sel).getBoundingClientRect().top + scrollY - pad : 0
      window.scrollTo({ top: Math.max(0, top), behavior: 'instant' })
    }
    await call(scrollTop, selectors[0] ?? null, pad)
    // Every preview in view decoded, transitions over, then a freshly painted frame.
    await js(`Promise.all([...document.querySelectorAll('#sheet img')]
      .filter((img) => { const r = img.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight })
      .map((img) => img.decode().catch(() => { throw new Error('a preview did not load: ' + img.src) })))`)
    await sleep(1000)
    await call(scrollTop, selectors[0] ?? null, pad)
    wc.invalidate()
    await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
    // Measure last, right before the capture, so nothing can move in between.
    const rect = selectors.length
      ? await call(
          (sels, pad) => {
            const rs = sels.map((s) => {
              const el = document.querySelector(s)
              if (!el) throw new Error(`missing ${s}`)
              return el.getBoundingClientRect()
            })
            const x = Math.max(0, Math.min(...rs.map((r) => r.left)) - pad)
            const y = Math.max(0, Math.min(...rs.map((r) => r.top)) - pad)
            const right = Math.min(innerWidth, Math.max(...rs.map((r) => r.right)) + pad)
            const bottom = Math.min(innerHeight, Math.max(...rs.map((r) => r.bottom)) + pad)
            return { x: Math.round(x), y: Math.round(y), width: Math.round(right - x), height: Math.round(bottom - y) }
          },
          selectors,
          pad,
        )
      : undefined
    const image = await wc.capturePage(rect)
    await writeFile(path.join(dir, name), image.toPNG())
    console.log(`saved ${name} ${image.getSize().width}×${image.getSize().height}`)
  }

  const set = (selector, value) =>
    call(
      (selector, value) => {
        const el = document.querySelector(selector)
        if (el.type === 'checkbox' || el.type === 'radio') el.checked = value
        else el.value = value
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      },
      selector,
      value,
    )
  const click = (selector) => call((s) => document.querySelector(s).click(), selector)
  const open = (selector, value = true) => call((s, v) => (document.querySelector(s).open = v), selector, value)

  // ── Ready, with the folder path shown generically ──────────────────────
  await until(`document.querySelector('#country option[value="ALL"]')`, 'the country list')
  await js('document.fonts.ready.then(() => true)')
  await call((shown) => {
    const fix = () => {
      for (const id of ['out-dir', 'folder-path']) {
        const el = document.getElementById(id)
        if (el && el.textContent && el.textContent !== shown) el.textContent = shown
      }
    }
    new MutationObserver(fix).observe(document.body, { subtree: true, childList: true, characterData: true })
    fix()
  }, SHOWN_FOLDER)

  // 1. First launch
  await shot('01-first-launch.png')

  // 2. Key checked, country chosen
  await set('#key', 'wapi_demo')
  await click('#check')
  await until(`!document.getElementById('saved-key').hidden`, 'the key check')
  await set('#country', 'UY')
  await shot('02-key-and-country.png', ['#key-title', '#estimate'])

  // 3. Filters
  await set('input[name="account"][value="business"]', true)
  await open('#f-business')
  await set('select[name="hasWebsite"]', 'true')
  await set('#cat-search', 'bak')
  await click('#cat-find')
  await until(`document.querySelector('#cat-results button')`, 'category results')
  await click('#cat-results button')
  await shot('03-filters.png', ['#filters-title', '#f-business'])
  // Back to no filters for the run.
  await click('#cat-selected button')
  await set('select[name="hasWebsite"]', '')
  await set('#cat-search', '')
  await call(() => document.getElementById('cat-results').replaceChildren())
  await set('input[name="account"][value="all"]', true)
  await open('#f-business', false)

  // 4. How many, and where
  await set('input[name="amount"][value="all"]', true)
  await shot('04-amount-and-folder.png', ['#amount-title', '.actions'])

  // 5. More options
  await open('details.more')
  await shot('05-more-options.png', ['details.more'])
  await open('details.more', false)

  // 6. Downloading (previews blurred, as they are by default)
  await click('#start')
  await until(`Number(document.getElementById('c-saved').textContent.replace(/\\D/g, '')) >= 260`, 'the download')
  await shot('06-downloading.png')

  // 7. Finished, previews unblurred (they are drawn placeholders)
  await until(`document.getElementById('start').textContent === 'Download pictures' && !document.getElementById('start').disabled`, 'the end of the run')
  await sleep(300)
  await set('#blur', false)
  await shot('07-finished.png', ['#run'])

  // 8. Earlier runs: a second, filtered run stopped halfway
  await set('#country', 'MX')
  await set('input[name="account"][value="business"]', true)
  await set('input[name="amount"][value="some"]', true)
  await set('#max', '600')
  await click('#start')
  await until(`Number(document.getElementById('c-saved').textContent.replace(/\\D/g, '')) >= 120`, 'the second download')
  await click('#cancel')
  await until(`document.getElementById('start').textContent === 'Download pictures'`, 'the stop')
  await until(`document.querySelectorAll('#runs li').length >= 2`, 'the runs list')
  await sleep(300)
  await shot('08-earlier-runs.png', ['#runs-title', '#runs'])
}
