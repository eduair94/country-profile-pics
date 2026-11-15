// Helper for crash.test.js: runs a download whose picture downloads stall after
// a few files, reports "ready", then waits to be killed. Not a test file itself.
import { DownloadJob } from '../src/job.js'
import { CDN, fakeFetch, KEY, makeDocs } from './fake.js'

const out = process.argv[2]
if (!out || !process.send) process.exit(0) // only meaningful when forked by crash.test.js
const base = fakeFetch({ docs: makeDocs(20) })
let downloads = 0
const fetch = async (url, init) => {
  if (String(url).startsWith(CDN) && ++downloads > 7) {
    if (downloads === 8) setTimeout(() => process.send?.('ready'), 50)
    return new Promise(() => {}) // never answers: the parent kills us mid-page
  }
  return base.fetch(url, init)
}
const job = new DownloadJob({ key: KEY, country: 'UY', outDir: out, max: 0, pageSize: 10, concurrency: 3 }, { fetch })
void job.run()
