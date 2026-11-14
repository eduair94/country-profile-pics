#!/usr/bin/env node
/**
 * country-profile-pics: command-line front end.
 *
 *   WA_API_KEY=wapi_… country-profile-pics --country UY --all --csv
 */
import { createWriteStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { createClient } from './api.js'
import { countryName, flag } from './countries.js'
import { loadEnv } from './env.js'
import { estimateCountry } from './estimate.js'
import { writeRunCsv, writeRunZip } from './export.js'
import { describeFilters, runSlug } from './filters.js'
import { DEFAULTS, DownloadJob, normaliseOptions } from './job.js'
import { Store } from './store.js'
import { formatBytes, formatDuration, formatInt, redact } from './util.js'

const HELP = `
Download every stored profile picture matching your filters from the WP Data
API, without ever downloading the same picture twice.

Usage
  country-profile-pics --country <CC> [filters] [options]

Key
  -k, --key <key>             API key. Prefer WA_API_KEY in the environment or a
                              .env file: a key on the command line ends up in
                              your shell history.
  -t, --transport <name>      auto | direct | rapidapi              (default: auto)

Where
  -c, --country <CC>          ISO country code (UY, BR, IN …) or ALL

Filters (the same as the website's database search)
      --search <text>         words in the name, about text or business details
      --number <digits>       numbers starting with these digits (6 or more)
      --account <type>        all | personal | business             (default: all)
      --domain <host>         business website domain, e.g. example.com
      --address <text>        business address contains
      --email <text>          business email contains
      --has-website yes|no    --has-email yes|no    --has-address yes|no
      --categories <a,b>      business category names or ids (see --find-categories)
      --categories-mode any|all
      --date-field <field>    last-seen | first-seen               (default: last-seen)
      --from <YYYY-MM-DD>     --to <YYYY-MM-DD>
      --gender male|female    picture shows someone of this gender
      --min-age <n>           --max-age <n>   (18 or more)
      --min-people <n>        --max-people <n>   people in the picture
      --glasses yes|no        --beard yes|no
      --tags <a,b>            picture tags, e.g. dog,beach
      --tags-mode any|all

How much
  -n, --max <n>               stop after n pictures, 0 = no limit  (default: ${DEFAULTS.max})
      --all                   same as --max 0
      --history               also download each number's older pictures
      --no-dedupe             download identical pictures again for each number
      --refresh               re-download pictures that changed since they were saved
      --no-records            keep pictures only (the CSV then has no profile fields)
      --restart               walk from the newest number again (files on disk are kept)

Output
  -o, --out <dir>             output folder                     (default: ./${DEFAULTS.outDir})
      --csv                   write exports/<run>.csv with every field when done
      --zip                   write exports/<run>.zip (pictures + CSV) when done

Tuning
  -j, --concurrency <n>       parallel picture downloads, 1-32   (default: ${DEFAULTS.concurrency})
      --page-size <n>         numbers per search request, 1-500  (default: ${DEFAULTS.pageSize})
      --min-interval <ms>     gap between API requests           (default: 550)

Other modes
      --estimate              show the picture count and request cost; download nothing
      --export                only write the CSV / ZIP of these filters' earlier runs
      --list-runs             list earlier runs in the output folder
      --find-categories <w>   look up business category ids (costs 1 request)
  -q, --quiet                 only print the final summary
  -h, --help                  -v, --version

Running the same command again resumes an interrupted run, or, once a run is
complete, fetches only the numbers added since (usually a single request).
`

const OPTIONS = {
  key: { type: 'string', short: 'k' },
  transport: { type: 'string', short: 't' },
  country: { type: 'string', short: 'c' },
  search: { type: 'string' },
  number: { type: 'string' },
  account: { type: 'string' },
  domain: { type: 'string' },
  address: { type: 'string' },
  email: { type: 'string' },
  'has-website': { type: 'string' },
  'has-email': { type: 'string' },
  'has-address': { type: 'string' },
  categories: { type: 'string' },
  'categories-mode': { type: 'string' },
  'date-field': { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  gender: { type: 'string' },
  'min-age': { type: 'string' },
  'max-age': { type: 'string' },
  'min-people': { type: 'string' },
  'max-people': { type: 'string' },
  glasses: { type: 'string' },
  beard: { type: 'string' },
  tags: { type: 'string' },
  'tags-mode': { type: 'string' },
  max: { type: 'string', short: 'n' },
  all: { type: 'boolean' },
  history: { type: 'boolean' },
  'no-dedupe': { type: 'boolean' },
  refresh: { type: 'boolean' },
  'no-records': { type: 'boolean' },
  restart: { type: 'boolean' },
  out: { type: 'string', short: 'o' },
  csv: { type: 'boolean' },
  zip: { type: 'boolean' },
  concurrency: { type: 'string', short: 'j' },
  'page-size': { type: 'string' },
  'min-interval': { type: 'string' },
  estimate: { type: 'boolean' },
  export: { type: 'boolean' },
  'list-runs': { type: 'boolean' },
  'find-categories': { type: 'string' },
  quiet: { type: 'boolean', short: 'q' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
}

let KEY = ''
const say = (text) => process.stdout.write(text)

function fail(message, code = 1) {
  process.stderr.write(`\nError: ${redact(message, KEY)}\n`)
  process.exit(code)
}

function optionsFrom(args) {
  return normaliseOptions({
    key: KEY,
    transport: args.transport ?? process.env.WA_TRANSPORT,
    country: args.country,
    search: args.search,
    number: args.number,
    account: args.account,
    domain: args.domain,
    address: args.address,
    email: args.email,
    hasWebsite: args['has-website'],
    hasEmail: args['has-email'],
    hasAddress: args['has-address'],
    categories: args.categories,
    categoriesMode: args['categories-mode'],
    dateField: args['date-field'],
    dateFrom: args.from,
    dateTo: args.to,
    faceGender: args.gender,
    faceMinAge: args['min-age'],
    faceMaxAge: args['max-age'],
    facePeopleMin: args['min-people'],
    facePeopleMax: args['max-people'],
    faceHasGlasses: args.glasses,
    faceHasBeard: args.beard,
    faceTags: args.tags,
    faceTagsMode: args['tags-mode'],
    max: args.all ? 0 : args.max,
    includeHistory: args.history,
    dedupe: !args['no-dedupe'],
    refresh: args.refresh,
    saveRecords: !args['no-records'],
    mode: args.restart ? 'restart' : 'continue',
    outDir: args.out ?? process.env.OUT_DIR,
    concurrency: args.concurrency,
    pageSize: args['page-size'],
    minIntervalMs: args['min-interval'] ?? process.env.MIN_INTERVAL_MS,
  })
}

const where = (f) => (f.country ? `${flag(f.country)} ${countryName(f.country)} (${f.country})` : 'All countries')

async function main() {
  loadEnv()
  let args
  try {
    args = parseArgs({ options: OPTIONS, allowPositionals: false }).values
  } catch (err) {
    fail(`${err.message}\nRun with --help for usage.`)
  }
  if (args.help) return void say(HELP)
  if (args.version) {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    return void say(`${pkg.version}\n`)
  }

  KEY = String(args.key ?? process.env.WA_API_KEY ?? '').trim()
  const outDir = args.out ?? process.env.OUT_DIR ?? DEFAULTS.outDir

  if (args['list-runs']) return listRuns(outDir)
  if (args['find-categories'] !== undefined) return findCategories(args)

  let options
  try {
    options = optionsFrom(args)
  } catch (err) {
    fail(`${err.message}\nRun with --help for usage.`)
  }
  if (!args.country && !args.export) fail('Choose a country with --country (or --country ALL).')

  if (args.export) return exportOnly(options, args)
  if (!options.key) fail('No API key. Set WA_API_KEY (or put it in .env), or pass --key.')
  if (args.estimate) return estimate(options)
  return download(options, args)
}

async function download(options, args) {
  const job = new DownloadJob(options)
  const quiet = !!args.quiet
  const tty = process.stdout.isTTY && !quiet
  const startedAt = Date.now()
  let last = 0

  const line = (s) => {
    const elapsed = Date.now() - startedAt
    const rate = (s.saved + s.refreshed) / Math.max(1, elapsed / 1000)
    return [
      `${formatInt(s.saved)} new`,
      s.existing ? `${formatInt(s.existing)} already here` : null,
      s.duplicates ? `${formatInt(s.duplicates)} identical (linked)` : null,
      s.refreshed ? `${formatInt(s.refreshed)} refreshed` : null,
      s.missing ? `${formatInt(s.missing)} gone` : null,
      s.failed ? `${formatInt(s.failed)} failed` : null,
      formatBytes(s.bytes),
      `${rate.toFixed(1)}/s`,
      `${formatInt(s.credits)} request${s.credits === 1 ? '' : 's'}`,
      s.quotaRemaining != null ? `${formatInt(s.quotaRemaining)} left` : null,
      formatDuration(elapsed),
    ]
      .filter(Boolean)
      .join(' | ')
  }

  if (!quiet) {
    say(`\n${where(options.filters)}: ${describeFilters(options.filters)}\n`)
    say(`Run "${job.slug}" in ${path.resolve(options.outDir)}\n`)
    say(options.max === 0 ? 'Limit: none\n\n' : `Limit: ${formatInt(options.max)} pictures (--all for everything)\n\n`)
  }

  job.on('progress', (s) => {
    if (quiet) return
    if (tty) {
      const now = Date.now()
      if (now - last < 200 && s.phase === 'running') return
      last = now
      say(`\r\x1b[2K${line(s)}`)
    }
  })
  let pages = 0
  if (!tty && !quiet) {
    job.on('progress', (s) => {
      if (s.pages !== pages) {
        pages = s.pages
        say(`page ${s.pages}: ${line(s)}\n`)
      }
    })
  }
  job.on('log', (text) => {
    if (!quiet) say(`${tty ? '\r\x1b[2K' : ''}${text}\n`)
  })

  let interrupts = 0
  process.on('SIGINT', () => {
    if (++interrupts > 1) process.exit(130)
    say('\n\nStopping after the downloads in flight… (Ctrl+C again to quit now)\n')
    job.cancel()
  })

  const result = await job.run()
  if (!quiet) say(`${tty ? '\r\x1b[2K' : ''}${line(result)}\n`)
  say(`\n${result.message}\n`)
  // process.exitCode, not process.exit(): exiting while fetch sockets close can abort Node on Windows.
  if (result.phase === 'error') {
    process.exitCode = 1
    return
  }
  if (result.totals && !quiet) {
    const t = result.totals
    say(
      `Run totals: ${formatInt(t.numbers)} numbers, ${formatInt(t.saved)} pictures downloaded, ` +
        `${formatInt(t.duplicates)} linked, ${plural(t.credits, 'request')}.\n`,
    )
  }
  if (args.csv || args.zip) await writeExports(job.store, job.slug, args)
  process.exitCode = result.phase === 'cancelled' ? 130 : 0
}

const plural = (n, word) => `${formatInt(n)} ${word}${n === 1 ? '' : 's'}`

async function writeExports(store, slug, args) {
  await store.init()
  if (args.csv && !args.zip) {
    const file = path.join(store.exportsDir(), `${slug}.csv`)
    const r = await writeRunCsv(store, slug, file)
    say(`CSV: ${formatInt(r.rows)} rows, ${r.columns} columns → ${file}\n`)
  }
  if (args.zip) {
    const file = path.join(store.exportsDir(), `${slug}.zip`)
    const r = await writeRunZip(store, slug, createWriteStream(file))
    say(`ZIP: ${formatInt(r.pictures)} pictures + CSV (${formatInt(r.rows)} rows) → ${file}\n`)
    say(`CSV: ${path.join(store.exportsDir(), `${slug}.csv`)}\n`)
  }
}

async function exportOnly(options, args) {
  const store = new Store(options.outDir)
  const slug = runSlug(options.filters)
  const state = await store.loadRun(slug)
  if (!state) fail(`No earlier run with these filters in ${store.root}. Run --list-runs to see what is there.`)
  if (!args.csv && !args.zip) args.csv = true
  await writeExports(store, slug, args)
}

async function listRuns(outDir) {
  const runs = await new Store(outDir).listRuns()
  if (!runs.length) return void say(`No runs in ${path.resolve(outDir)} yet.\n`)
  say(`\nRuns in ${path.resolve(outDir)}\n\n`)
  for (const r of runs) {
    const t = r.totals ?? {}
    const status = r.complete ? 'complete' : r.cursor ? 'can continue' : r.lastOutcome ?? ''
    say(
      `  ${r.slug}\n    ${where(r.filters ?? {})}: ${r.description}\n` +
        `    ${status}, ${formatInt(t.numbers)} numbers, ${formatInt((t.saved ?? 0) + (t.duplicates ?? 0))} pictures, ` +
        `${plural(t.credits ?? 0, 'request')}, updated ${r.updatedAt}\n\n`,
    )
  }
}

async function findCategories(args) {
  if (!KEY) fail('No API key. Set WA_API_KEY (or put it in .env), or pass --key.')
  const word = String(args['find-categories']).trim()
  if (word.length < 2) fail('Give at least two letters, e.g. --find-categories restaurant')
  const client = createClient({ key: KEY, transport: args.transport ?? process.env.WA_TRANSPORT })
  const items = await client.categories(word, { limit: 20 })
  if (!items.length) return void say(`No categories match "${word}".\n`)
  say(`\nCategories matching "${word}" (pass the id to --categories):\n\n`)
  for (const c of items) say(`  ${c.id.padEnd(24)} ${c.name}  (${formatInt(c.count)} businesses)\n`)
  say('\n')
}

async function estimate(options) {
  const client = createClient({ key: options.key, transport: options.transport })
  const [stats, key] = await Promise.allSettled([client.stats(), client.keyStats()])
  say(`\n${where(options.filters)}: ${describeFilters(options.filters)}\n`)
  if (stats.status === 'rejected') fail(`Could not read database stats: ${stats.reason?.message}`)
  const e = options.filters.country ? estimateCountry(stats.value, options.filters.country, options.max) : null
  const filtered = Object.keys(options.filters).some((k) => k !== 'country')
  if (!options.filters.country) {
    say(`  Pictures in the database   ${formatInt(stats.value.totalPictures)}\n`)
  } else if (!e?.known) {
    say("  This country is not in the API's top-country list, so its picture count is unknown.\n")
  } else {
    say(
      `  Numbers in database        ${formatInt(e.numbers)}\n` +
        `  With a picture             ${formatInt(e.picturesInDatabase)}${filtered ? ' (before your filters)' : ''}\n` +
        (options.max ? `  This run (max)             ${formatInt(e.pictures)}\n` : '') +
        `  Search requests            at most ${formatInt(e.requests)} (1 per 500 pictures; downloads are free)\n` +
        `  Disk space                 about ${formatBytes(e.bytes)}\n`,
    )
  }
  if (key.status === 'fulfilled' && key.value) {
    const k = key.value
    say(`  Key                        ${k.role ?? 'unknown'}, ${k.remaining != null ? `${formatInt(k.remaining)} requests left` : 'quota unknown'}\n`)
  } else if (key.status === 'rejected') {
    fail(key.reason?.message)
  }
  say(`  This estimate used 1 request (database stats).\n\n`)
}

main().catch((err) => fail(err?.stack ?? String(err)))
