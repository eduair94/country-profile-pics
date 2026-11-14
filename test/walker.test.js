import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClient } from '../src/api.js'
import { walkCountry } from '../src/walker.js'
import { fakeFetch, KEY, makeDocs, noSleep } from './fake.js'

async function collect(gen) {
  const pages = []
  for await (const p of gen) pages.push(p)
  return pages
}

test('walks every page newest-first through the cursor', async () => {
  const docs = makeDocs(23)
  const { fetch, calls } = fakeFetch({ docs })
  const pages = await collect(walkCountry(createClient({ key: KEY, fetch, minIntervalMs: 0 }), { country: 'UY', pageSize: 10 }))
  assert.deepEqual(
    pages.map((p) => p.docs.length),
    [10, 10, 3],
  )
  const ids = pages.flatMap((p) => p.docs.map((d) => d._id))
  assert.deepEqual(
    ids,
    docs.map((d) => d._id),
  )
  const q = calls.search[0].searchParams
  assert.equal(q.get('hasProfilePic'), 'true')
  assert.equal(q.get('sortBy'), 'id')
  assert.equal(q.get('sortOrder'), 'desc')
  assert.equal(calls.search[1].searchParams.get('after'), docs[9]._id)
})

test('resumes after a given cursor', async () => {
  const docs = makeDocs(12)
  const { fetch } = fakeFetch({ docs })
  const pages = await collect(
    walkCountry(createClient({ key: KEY, fetch, minIntervalMs: 0 }), { country: 'UY', pageSize: 5, after: docs[6]._id }),
  )
  assert.deepEqual(
    pages.flatMap((p) => p.docs.map((d) => d._id)),
    docs.slice(7).map((d) => d._id),
  )
})

test('a timeout halves the page; good pages grow it back; no row is skipped', async () => {
  const docs = makeDocs(60)
  const limits = []
  const { fetch } = fakeFetch({
    docs,
    searchHook: (url, n) => {
      limits.push(Number(url.searchParams.get('limit')))
      if (n === 2) return new Response('timeout', { status: 504 })
      return undefined
    },
  })
  const events = []
  const pages = await collect(
    walkCountry(createClient({ key: KEY, fetch, minIntervalMs: 0 }), {
      country: 'UY',
      pageSize: 8,
      onEvent: (e) => events.push(e),
      sleepFn: noSleep,
    }),
  )
  assert.deepEqual(
    pages.flatMap((p) => p.docs.map((d) => d._id)),
    docs.map((d) => d._id),
  )
  // page 1 at 8, timeout at 8, then 4 x3 good pages, then back to 8
  assert.deepEqual(limits.slice(0, 6), [8, 8, 4, 4, 4, 8])
  assert.deepEqual(
    events.filter((e) => e.type === 'page-size').map((e) => e.limit),
    [4, 8],
  )
})

test('gives up with a resumable message when even the smallest page times out', async () => {
  const { fetch } = fakeFetch({ docs: makeDocs(5), searchHook: () => new Response('x', { status: 504 }) })
  await assert.rejects(
    collect(walkCountry(createClient({ key: KEY, fetch, minIntervalMs: 0 }), { country: 'UY', pageSize: 4, sleepFn: noSleep })),
    /run again later to resume/,
  )
})
