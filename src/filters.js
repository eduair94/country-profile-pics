/**
 * The search filters, mirroring the website's database search, validated once
 * here for the CLI, the web UI and the API request alike.
 *
 * Every run adds `hasProfilePic=true`: only numbers with a stored picture are
 * walked, so no request is spent on rows without one.
 *
 * Two of the website's filters are deliberately not offered:
 *   - ethnicity: selecting people by ethnicity for bulk photo collection is a
 *     special category of personal data (GDPR art. 9) and a profiling risk;
 *   - an age ceiling under 18: a filter that singles out children is refused.
 */
import { createHash } from 'node:crypto'
import { byCodeUnit, trimChar } from './util.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_TEXT = 200
const MAX_LIST = 25
export const ADULT_AGE = 18

/** Accepts true/false, yes/no, 1/0, with/without. Returns 'true' | 'false' | undefined. */
export function triState(value, name) {
  if (value === undefined || value === null || value === '' || value === 'any') return undefined
  const v = String(value).trim().toLowerCase()
  if (['true', 'yes', '1', 'with', 'y'].includes(v)) return 'true'
  if (['false', 'no', '0', 'without', 'n'].includes(v)) return 'false'
  throw new Error(`${name} must be yes or no.`)
}

function text(value, name, max = MAX_TEXT) {
  if (value === undefined || value === null) return undefined
  const v = String(value).trim()
  if (!v) return undefined
  if (v.length > max) throw new Error(`${name} is too long (at most ${max} characters).`)
  return v
}

function list(value, name, maxItemLength) {
  if (value === undefined || value === null || value === '') return undefined
  const items = (Array.isArray(value) ? value : String(value).split(','))
    .map((s) => String(s).trim())
    .filter(Boolean)
  if (!items.length) return undefined
  const unique = [...new Set(items)]
  if (unique.length > MAX_LIST) throw new Error(`${name}: at most ${MAX_LIST} values.`)
  for (const item of unique) {
    if (item.length > maxItemLength) throw new Error(`${name}: "${item.slice(0, 20)}…" is too long.`)
  }
  return unique
}

function int(value, name, min, max) {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}.`)
  return n
}

function oneOf(value, name, allowed, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const v = String(value).trim().toLowerCase()
  if (!allowed.includes(v)) throw new Error(`${name} must be one of: ${allowed.join(', ')}.`)
  return v
}

/**
 * Normalise user-facing filter input into a canonical object.
 * Unknown keys are ignored. Throws an Error with a readable message.
 */
export function normaliseFilters(raw = {}) {
  const f = {}

  const country = String(raw.country ?? '').trim().toUpperCase()
  if (country && country !== 'ALL') {
    if (!/^[A-Z]{2}$/.test(country)) throw new Error('Country must be a two-letter ISO code such as UY, BR or IN (or ALL).')
    f.country = country
  }

  f.search = text(raw.search, 'Text search')
  const number = raw.number === undefined || raw.number === null ? '' : String(raw.number).replace(/[\s+()-]/g, '')
  if (number) {
    if (!/^\d{6,15}$/.test(number)) throw new Error('Number prefix must be 6 to 15 digits.')
    f.number = number
  }

  f.account = oneOf(raw.account, 'Account type', ['all', 'personal', 'business'], 'all')

  f.domain = text(raw.domain, 'Website domain')
  f.address = text(raw.address, 'Address')
  f.email = text(raw.email, 'Email')
  f.hasWebsite = triState(raw.hasWebsite, 'Has website')
  f.hasEmail = triState(raw.hasEmail, 'Has email')
  f.hasAddress = triState(raw.hasAddress, 'Has address')
  f.categories = list(raw.categories, 'Categories', 120)
  f.categoriesMode = oneOf(raw.categoriesMode, 'Category match', ['any', 'all'], 'any')

  f.dateField = oneOf(raw.dateField, 'Date field', ['last-seen', 'first-seen', 'date', 'creation_date'], 'last-seen')
  if (f.dateField === 'date') f.dateField = 'last-seen'
  if (f.dateField === 'creation_date') f.dateField = 'first-seen'
  for (const k of ['dateFrom', 'dateTo']) {
    const v = text(raw[k], k)
    if (v && !DATE_RE.test(v)) throw new Error(`${k === 'dateFrom' ? 'From' : 'To'} date must look like YYYY-MM-DD.`)
    f[k] = v
  }
  if (f.dateFrom && f.dateTo && f.dateFrom > f.dateTo) throw new Error('The From date is after the To date.')

  f.faceGender = oneOf(raw.faceGender, 'Gender', ['any', 'male', 'female'], 'any')
  f.faceMinAge = int(raw.faceMinAge, 'Minimum age', 0, 120)
  f.faceMaxAge = int(raw.faceMaxAge, 'Maximum age', 0, 120)
  if (f.faceMaxAge !== undefined && f.faceMaxAge < ADULT_AGE) {
    throw new Error(`Maximum age must be ${ADULT_AGE} or more: this tool does not select pictures of children.`)
  }
  if (f.faceMinAge !== undefined && f.faceMaxAge !== undefined && f.faceMinAge > f.faceMaxAge) {
    throw new Error('Minimum age is above maximum age.')
  }
  f.facePeopleMin = int(raw.facePeopleMin, 'Minimum people in picture', 0, 50)
  f.facePeopleMax = int(raw.facePeopleMax, 'Maximum people in picture', 0, 50)
  if (f.facePeopleMin !== undefined && f.facePeopleMax !== undefined && f.facePeopleMin > f.facePeopleMax) {
    throw new Error('Minimum people is above maximum people.')
  }
  f.faceHasGlasses = triState(raw.faceHasGlasses, 'Glasses')
  f.faceHasBeard = triState(raw.faceHasBeard, 'Beard')
  f.faceTags = list(raw.faceTags, 'Picture tags', 40)
  f.faceTagsMode = oneOf(raw.faceTagsMode, 'Tag match', ['any', 'all'], 'any')

  const business = f.domain || f.address || f.email || f.hasWebsite || f.hasEmail || f.hasAddress || f.categories
  if (business && f.account === 'personal') {
    throw new Error('Business filters (website, email, address, categories) only match business accounts.')
  }
  if (f.search && !f.country) {
    throw new Error('A text search needs a country: the API can only walk a text search country by country.')
  }

  for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k]
  if (!f.categories) delete f.categoriesMode
  if (!f.faceTags) delete f.faceTagsMode
  if (f.faceGender === 'any') delete f.faceGender
  if (f.account === 'all') delete f.account
  // "last seen" is the default meaning of a date; only "first seen" is stored.
  if (f.dateField === 'last-seen' || (!f.dateFrom && !f.dateTo)) delete f.dateField
  return f
}

/** The search query for these filters (cursor and limit are added by the walker). */
export function toQuery(f) {
  const q = { hasProfilePic: 'true' }
  if (f.country) q.countryCode = f.country
  if (f.search) q.search = f.search
  if (f.number) q.number = f.number
  if (f.account === 'business') q.isBusiness = 'true'
  if (f.account === 'personal') q.isBusiness = 'false'
  for (const k of ['domain', 'address', 'email', 'hasWebsite', 'hasEmail', 'hasAddress']) if (f[k]) q[k] = f[k]
  if (f.categories) {
    q.categories = f.categories.map(encodeURIComponent).join(',')
    q.categoriesMode = f.categoriesMode ?? 'any'
  }
  if (f.dateFrom) q.dateFrom = f.dateFrom
  if (f.dateTo) q.dateTo = f.dateTo
  if (f.dateField === 'first-seen') q.dateField = 'creation_date'
  if (f.faceGender) q.faceGender = f.faceGender
  for (const k of ['faceMinAge', 'faceMaxAge', 'facePeopleMin', 'facePeopleMax', 'faceHasGlasses', 'faceHasBeard']) {
    if (f[k] !== undefined) q[k] = String(f[k])
  }
  if (f.faceTags) {
    q.faceTags = f.faceTags.join(',')
    q.faceTagsMode = f.faceTagsMode ?? 'any'
  }
  return q
}

/** Stable identity of a filter set, independent of key order. */
export function filtersHash(f) {
  const canonical = JSON.stringify(Object.keys(f).sort(byCodeUnit).map((k) => [k, f[k]]))
  return createHash('sha256').update(canonical).digest('hex').slice(0, 8)
}

/** Folder-safe run name: "UY", or "AR-business-pizza-1a2b3c4d" when filtered. */
export function runSlug(f) {
  const base = f.country ?? 'ALL'
  const rest = Object.keys(f).filter((k) => k !== 'country')
  if (!rest.length) return base
  const tokens = []
  if (f.account) tokens.push(f.account)
  if (f.search) tokens.push(f.search)
  if (f.categories) tokens.push(f.categories[0])
  if (f.faceGender) tokens.push(f.faceGender)
  if (f.dateFrom || f.dateTo) tokens.push(`${f.dateFrom ?? 'start'}_${f.dateTo ?? 'now'}`)
  const joined = tokens
    .join('-')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9_]+/g, '-')
  // Trim the dashes, cut to 40, trim again (the cut may end on a dash).
  const words = trimChar(trimChar(joined, '-').slice(0, 40), '-')
  return [base, words, filtersHash(f)].filter(Boolean).join('-')
}

/** One line describing the filters, for logs and the UI. */
export function describeFilters(f) {
  const parts = []
  if (f.account) parts.push(`${f.account} accounts`)
  if (f.search) parts.push(`text "${f.search}"`)
  if (f.number) parts.push(`numbers starting ${f.number}`)
  if (f.domain) parts.push(`domain ${f.domain}`)
  if (f.address) parts.push(`address contains "${f.address}"`)
  if (f.email) parts.push(`email contains "${f.email}"`)
  for (const [k, label] of [['hasWebsite', 'website'], ['hasEmail', 'email'], ['hasAddress', 'address']]) {
    if (f[k]) parts.push(`${f[k] === 'true' ? 'with' : 'without'} ${label}`)
  }
  if (f.categories) parts.push(`categories ${f.categoriesMode === 'all' ? 'all of' : 'any of'} ${f.categories.join(', ')}`)
  if (f.dateFrom || f.dateTo) {
    parts.push(`${f.dateField === 'first-seen' ? 'first seen' : 'last seen'} ${f.dateFrom ?? '…'} to ${f.dateTo ?? 'now'}`)
  }
  if (f.faceGender) parts.push(f.faceGender)
  if (f.faceMinAge !== undefined || f.faceMaxAge !== undefined) parts.push(`age ${f.faceMinAge ?? 0}–${f.faceMaxAge ?? 120}`)
  if (f.facePeopleMin !== undefined || f.facePeopleMax !== undefined) {
    parts.push(`${f.facePeopleMin ?? 0}–${f.facePeopleMax ?? 50} people`)
  }
  if (f.faceHasGlasses) parts.push(f.faceHasGlasses === 'true' ? 'glasses' : 'no glasses')
  if (f.faceHasBeard) parts.push(f.faceHasBeard === 'true' ? 'beard' : 'no beard')
  if (f.faceTags) parts.push(`tags ${f.faceTagsMode === 'all' ? 'all of' : 'any of'} ${f.faceTags.join(', ')}`)
  return parts.length ? parts.join('; ') : 'no filters'
}
