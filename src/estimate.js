/**
 * What a full country costs before you start: pictures in the database, search
 * requests needed (one per page of up to 500 numbers) and disk space. The
 * pictures themselves are downloaded from the public image CDN and cost nothing.
 */
import { MAX_PAGE_SIZE } from './walker.js'

/** Average stored picture, measured on a sample of the image CDN. */
export const AVERAGE_PICTURE_BYTES = 52_000

export function estimateCountry(stats, country, max = 0) {
  const row = stats?.countries?.find((c) => c.code === country) ?? null
  if (!row) return { known: false, country }
  const pictures = max > 0 ? Math.min(max, row.pictures) : row.pictures
  return {
    known: true,
    country,
    numbers: row.numbers,
    picturesInDatabase: row.pictures,
    pictures,
    requests: Math.max(1, Math.ceil(pictures / MAX_PAGE_SIZE)),
    bytes: pictures * AVERAGE_PICTURE_BYTES,
  }
}
