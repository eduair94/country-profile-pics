import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { csvCell, flattenRecord, writeRunCsv, writeRunZip } from '../src/export.js'
import { DownloadJob } from '../src/job.js'
import { parseCsvLine, Store } from '../src/store.js'
import { fakeFetch, KEY, makeDocs, noSleep } from './fake.js'

/** Names in a ZIP's central directory. */
export function zipEntries(buf) {
  let eocd = buf.length - 22
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--
  assert.ok(eocd >= 0, 'end of central directory found')
  const count = buf.readUInt16LE(eocd + 10)
  let at = buf.readUInt32LE(eocd + 16)
  const names = []
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50, 'central directory header')
    const nameLen = buf.readUInt16LE(at + 28)
    const extraLen = buf.readUInt16LE(at + 30)
    const commentLen = buf.readUInt16LE(at + 32)
    names.push(buf.subarray(at + 46, at + 46 + nameLen).toString('utf8'))
    at += 46 + nameLen + extraLen + commentLen
  }
  return names.sort()
}

test('flattenRecord turns nested fields into dot paths and arrays into JSON', () => {
  const flat = flattenRecord({
    _id: { $oid: 'abc' },
    about: 'hi',
    businessProfile: { email: 'a@b.c', categories: [{ id: '1', localized_display_name: 'Pizza' }], address: null },
    date: { $date: '2026-01-01T00:00:00Z' },
    tags: [],
  })
  assert.deepEqual(flat, {
    _id: 'abc',
    about: 'hi',
    'businessProfile.email': 'a@b.c',
    'businessProfile.categories': '[{"id":"1","localized_display_name":"Pizza"}]',
    'businessProfile.address': '',
    date: '2026-01-01T00:00:00Z',
    tags: '',
  })
})

test('csvCell quotes what needs quoting and defuses spreadsheet formulas', () => {
  assert.equal(csvCell('plain'), 'plain')
  assert.equal(csvCell('a,b'), '"a,b"')
  assert.equal(csvCell('say "hi"'), '"say ""hi"""')
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`)
  assert.equal(csvCell('+5'), "'+5")
  assert.equal(csvCell(-34.5), '-34.5', 'real numbers are left alone')
  assert.equal(csvCell(null), '')
})

test('the CSV has one row per number with every field and its picture path', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'cpp-export-'))
  try {
    const docs = makeDocs(4)
    docs[0].about = '=cmd|calc'
    docs[1].businessProfile = { email: 'shop@example.com', address: 'Av. 18 de Julio, Montevideo' }
    docs[2].md5Image = docs[3].md5Image = 'b'.repeat(32) // identical pictures: one is linked
    const fake = fakeFetch({ docs, missing: new Set() })
    const job = new DownloadJob({ key: KEY, country: 'UY', outDir: out, max: 0, pageSize: 2 }, { fetch: fake.fetch, sleep: noSleep })
    await job.run()

    // The same number seen again later: its newest record must win, once.
    const store = new Store(out)
    await appendFile(store.recordsFile('UY'), `${JSON.stringify({ ...docs[1], about: 'newer about' })}\n`)
    await appendFile(store.runNumbersFile('UY'), `UY,${docs[1].number}\n`)

    const csvFile = path.join(out, 'exports', 'UY.csv')
    const res = await writeRunCsv(store, 'UY', csvFile)
    assert.equal(res.rows, 4)
    const text = await readFile(csvFile, 'utf8')
    assert.equal(text.charCodeAt(0), 0xfeff, 'starts with a UTF-8 byte-order mark')
    const [header, ...rows] = text.slice(1).trim().split('\r\n').map(parseCsvLine)
    assert.deepEqual(header.slice(0, 7), ['country', 'number', 'picture_file', 'picture_shared', 'picture_bytes', 'picture_md5', 'history_files'])
    assert.ok(header.includes('businessProfile.email'))
    assert.ok(header.includes('about'))
    assert.ok(!header.includes('countryCode'), 'country is not repeated')
    const col = (name) => header.indexOf(name)
    const byNumber = Object.fromEntries(rows.map((r) => [r[col('number')], r]))
    assert.equal(byNumber[docs[1].number][col('about')], 'newer about')
    assert.equal(byNumber[docs[1].number][col('businessProfile.address')], 'Av. 18 de Julio, Montevideo')
    assert.equal(byNumber[docs[0].number][col('about')], "'=cmd|calc")
    assert.equal(byNumber[docs[0].number][col('picture_file')], `pictures/UY/${docs[0].number}.jpg`)
    const linked = [byNumber[docs[2].number], byNumber[docs[3].number]]
    assert.equal(linked[0][col('picture_file')], linked[1][col('picture_file')], 'identical pictures share one file')
    assert.deepEqual(linked.map((r) => r[col('picture_shared')]).sort(), ['', 'yes'])

    const zip = new PassThrough()
    const chunks = []
    zip.on('data', (c) => chunks.push(c))
    const z = await writeRunZip(store, 'UY', zip)
    assert.equal(z.pictures, 3, 'the shared picture is stored once')
    const names = zipEntries(Buffer.concat(chunks))
    assert.equal(names.length, 4)
    assert.ok(names.includes('UY/UY.csv'))
    assert.ok(names.includes(`UY/pictures/UY/${docs[0].number}.jpg`))
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})
