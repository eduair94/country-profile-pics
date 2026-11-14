import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeFilters, normaliseFilters, runSlug, toQuery } from '../src/filters.js'

test('defaults collapse to just the country', () => {
  const f = normaliseFilters({ country: 'uy', account: 'all', dateField: 'last-seen', categoriesMode: 'any', faceTagsMode: 'any', faceGender: '' })
  assert.deepEqual(f, { country: 'UY' })
  assert.equal(runSlug(f), 'UY')
  assert.deepEqual(toQuery(f), { hasProfilePic: 'true', countryCode: 'UY' })
})

test('every website filter maps to the API parameter it should', () => {
  const f = normaliseFilters({
    country: 'AR',
    search: 'pizza',
    number: '+54 9 11 4',
    account: 'business',
    domain: 'example.com',
    address: 'Palermo',
    email: '@gmail.com',
    hasWebsite: 'yes',
    hasEmail: 'no',
    hasAddress: 'true',
    categories: 'Restaurant, Pizza place',
    categoriesMode: 'all',
    dateField: 'first-seen',
    dateFrom: '2026-01-01',
    dateTo: '2026-06-30',
    faceGender: 'female',
    faceMinAge: '20',
    faceMaxAge: '40',
    facePeopleMin: 1,
    facePeopleMax: 2,
    faceHasGlasses: 'no',
    faceHasBeard: 'false',
    faceTags: 'dog,beach',
    faceTagsMode: 'any',
  })
  assert.deepEqual(toQuery(f), {
    hasProfilePic: 'true',
    countryCode: 'AR',
    search: 'pizza',
    number: '549114',
    isBusiness: 'true',
    domain: 'example.com',
    address: 'Palermo',
    email: '@gmail.com',
    hasWebsite: 'true',
    hasEmail: 'false',
    hasAddress: 'true',
    categories: 'Restaurant,Pizza%20place',
    categoriesMode: 'all',
    dateFrom: '2026-01-01',
    dateTo: '2026-06-30',
    dateField: 'creation_date',
    faceGender: 'female',
    faceMinAge: '20',
    faceMaxAge: '40',
    facePeopleMin: '1',
    facePeopleMax: '2',
    faceHasGlasses: 'false',
    faceHasBeard: 'false',
    faceTags: 'dog,beach',
    faceTagsMode: 'any',
  })
  assert.match(describeFilters(f), /^business accounts; text "pizza"; numbers starting 549114; .*female; age 20–40/)
})

test('ethnicity is not a filter; children cannot be selected', () => {
  const f = normaliseFilters({ country: 'UY', faceEthnicity: 'caucasian' })
  assert.deepEqual(f, { country: 'UY' })
  assert.throws(() => normaliseFilters({ country: 'UY', faceMaxAge: 17 }), /18 or more/)
  assert.doesNotThrow(() => normaliseFilters({ country: 'UY', faceMaxAge: 18 }))
})

test('contradictions and API limits are caught before any request', () => {
  assert.throws(() => normaliseFilters({ country: 'UY', account: 'personal', hasWebsite: 'yes' }), /business accounts/)
  assert.throws(() => normaliseFilters({ search: 'pizza' }), /needs a country/)
  assert.throws(() => normaliseFilters({ country: 'UY', number: '59899' }), /6 to 15 digits/)
  assert.throws(() => normaliseFilters({ country: 'UY', dateFrom: '2026-02-01', dateTo: '2026-01-01' }), /after the To/)
  assert.throws(() => normaliseFilters({ country: 'UY', faceMinAge: 40, faceMaxAge: 30 }), /above maximum/)
  assert.throws(() => normaliseFilters({ country: 'UY', hasEmail: 'maybe' }), /yes or no/)
  assert.throws(() => normaliseFilters({ country: 'Uruguay' }), /two-letter/)
})

test('the run name is stable whatever the key order, and differs per filter set', () => {
  const a = normaliseFilters({ country: 'BR', account: 'business', faceGender: 'male' })
  const b = normaliseFilters({ faceGender: 'male', account: 'business', country: 'BR' })
  const c = normaliseFilters({ country: 'BR', account: 'business', faceGender: 'female' })
  assert.equal(runSlug(a), runSlug(b))
  assert.notEqual(runSlug(a), runSlug(c))
  assert.match(runSlug(a), /^BR-business-male-[0-9a-f]{8}$/)
  assert.equal(runSlug(normaliseFilters({})), 'ALL')
})
