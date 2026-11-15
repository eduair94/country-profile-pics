// Launch a packaged app once and check that its window came up with the app in it.
//   node scripts/smoke.mjs "<path to the app executable>"
// On Linux it runs under xvfb-run. Exits non-zero, with the reason, on any failure.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

const exe = process.argv[2]
if (!exe || !existsSync(exe)) {
  console.error(`smoke: app not found: ${exe}`)
  process.exit(1)
}
const out = path.resolve('smoke.json')
rmSync(out, { force: true })

const linux = process.platform === 'linux'
const [cmd, args] = linux
  ? ['xvfb-run', ['--auto-servernum', exe, '--no-sandbox', `--smoke=${out}`]]
  : [exe, [`--smoke=${out}`]]

const child = spawn(cmd, args, { stdio: 'inherit' })
const timer = setTimeout(() => {
  console.error('smoke: no answer within 120 s')
  child.kill('SIGKILL')
}, 120_000)

child.on('error', (err) => {
  clearTimeout(timer)
  console.error(`smoke: could not start the app: ${err.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  clearTimeout(timer)
  if (!existsSync(out)) {
    console.error(`smoke: the app exited (code ${code}, signal ${signal}) without writing ${out}`)
    process.exit(1)
  }
  const result = JSON.parse(readFileSync(out, 'utf8'))
  console.log('smoke:', JSON.stringify(result))
  const ok =
    result.title === 'Country profile pictures' &&
    result.windowTitle === 'Country Profile Pictures' &&
    result.desktop === 'object' &&
    result.countries > 200 &&
    result.config?.desktop === true
  if (!ok) {
    console.error('smoke: the window did not show the app as expected')
    process.exit(1)
  }
  // Help → Try the Demo, switched in place: a key check, three pictures, one read back as a JPEG.
  const d = result.demo
  const demoOk =
    result.demoTitle === 'Country Profile Pictures (demo)' &&
    d?.role === 'demo' &&
    d.countries === 8 &&
    ['limit', 'complete'].includes(d.phase) &&
    d.saved === 3 &&
    d.jpeg === true
  if (!demoOk) {
    console.error('smoke: demo mode did not work as expected')
    process.exit(1)
  }
  console.log('smoke: ok')
})
