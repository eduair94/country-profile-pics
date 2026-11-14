import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DownloadJob } from '../src/job.js'
import { Store } from '../src/store.js'
import { fakeFetch, KEY, makeDocs, noSleep } from './fake.js'

const child = fileURLToPath(new URL('./crash-child.mjs', import.meta.url))

test('a process killed mid-download leaves no picture unrecorded, and the next run completes', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'cpp-crash-'))
  try {
    const proc = fork(child, [out], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    await new Promise((resolve, reject) => {
      proc.once('message', resolve)
      proc.once('exit', (code) => reject(new Error(`child exited early (${code})`)))
    })
    proc.kill('SIGKILL')
    await new Promise((r) => proc.once('exit', r))

    const onDisk = (await readdir(path.join(out, 'pictures', 'UY'))).filter((f) => f.endsWith('.jpg'))
    const ledger = []
    for await (const row of new Store(out).readFiles('UY')) ledger.push(row.file.split('/')[1])
    assert.ok(onDisk.length >= 5, `some pictures were saved before the kill (${onDisk.length})`)
    for (const f of onDisk) assert.ok(ledger.includes(f), `${f} is on disk but not in the ledger`)

    // A stale lock was left behind; the next run takes it over and finishes the job.
    const fake = fakeFetch({ docs: makeDocs(20) })
    const r = await new DownloadJob({ key: KEY, country: 'UY', outDir: out, max: 0, pageSize: 10 }, { fetch: fake.fetch, sleep: noSleep }).run()
    assert.equal(r.phase, 'complete')
    assert.equal(r.saved + r.existing, 20)
    assert.equal(fake.calls.images.length, 20 - onDisk.length, 'only missing pictures are downloaded')
    assert.equal((await readdir(path.join(out, 'pictures', 'UY'))).filter((f) => f.endsWith('.jpg')).length, 20)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})
