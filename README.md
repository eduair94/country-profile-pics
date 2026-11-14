# country-profile-pics

Download every stored profile picture that matches your filters from the
**WP Data API**, for one country or all of them, together with a CSV of
every field the API returns. It comes with a local web app and a command line,
and it never downloads the same picture twice.

- **Same filters as the website's database search**: account type, text,
  number prefix, business website, email, address and categories, first/last
  seen dates, and picture content (gender, age, people, glasses, beard, tags).
- **Fewest possible requests.** One search request returns up to 500 numbers,
  and the pictures then download from the public image CDN for free.
- **Resumable and incremental.** Stop at any time and run again to continue
  exactly where it stopped. Run a finished download again and it fetches only
  the numbers added since, usually with a single request.
- **No duplicates.** All runs share one picture store. Identical pictures are
  stored once and linked for every number that uses them.
- **CSV and ZIP export** with every field, flattened to columns, plus where each
  picture is on disk.

```
npm install
cp .env.example .env      # put your key in WA_API_KEY
npm start                 # → http://localhost:4747
```

## Getting a key

Either kind works. The app detects which one you pasted.

| Key | Where | Looks like |
| --- | --- | --- |
| Direct key | [whatsapp.checkleaked.cc/api](https://whatsapp.checkleaked.cc/api) | `wapi_…` |
| RapidAPI key | [WP Data DB Only on RapidAPI](https://rapidapi.com/airaudoeduardo/api/wp-data-db-only) | `…msh…jsn…` |

The key needs access to profile data (`urlImage`), which direct keys and the
**DB Only** listing have.

## Web app

`npm start` serves the app on `http://localhost:4747`, on this computer only.

1. Paste your key and press **Check key**. You'll see its remaining requests
   and how many pictures each country has.
2. Pick a country (or **All countries**) and any filters.
3. Choose **The newest N pictures** or **All of them**, then press
   **Download pictures**.
4. Watch the contact sheet fill (previews are blurred until you untick
   *Blur previews*). Press **Download CSV** or **Download ZIP** when it is done.
5. **Earlier runs** lists everything you have downloaded. **Continue** picks up
   an unfinished run, **Check for new** updates a finished one.

Set `WA_API_KEY` in `.env` to skip pasting the key.

## Command line

```
node src/cli.js --country UY --all --csv
```

Or install it globally with `npm install -g .` and run `country-profile-pics`.

```
# How many pictures does Brazil have, and what would it cost?
country-profile-pics --country BR --estimate

# The newest 5,000 business pictures in Mexico, with a CSV
country-profile-pics --country MX --account business --max 5000 --csv

# Restaurants in Argentina (find category ids first; that lookup costs 1 request)
country-profile-pics --find-categories restaurant
country-profile-pics --country AR --categories "Restaurant,Pizza place" --all --zip

# Pictures showing a woman, last seen in 2026
country-profile-pics --country ES --gender female --from 2026-01-01 --all

# Everything, every country (big!)
country-profile-pics --country ALL --all

# What have I downloaded? Re-export a run without downloading anything.
country-profile-pics --list-runs
country-profile-pics --country MX --account business --export --zip
```

Run `country-profile-pics --help` for every option. Running the same command
again continues the run, so press <kbd>Ctrl</kbd>+<kbd>C</kbd> whenever you like.

### Filters

| What | CLI | API parameter |
| --- | --- | --- |
| Country, or every country | `--country UY` / `--country ALL` | `countryCode` |
| Words in name, about or business | `--search pizza` (needs a country) | `search` |
| Number prefix (6+ digits) | `--number 598991` | `number` |
| Personal or business accounts | `--account personal\|business` | `isBusiness` |
| Website domain | `--domain example.com` | `domain` |
| Address / email contains | `--address Centro` `--email @gmail.com` | `address`, `email` |
| Has website / email / address | `--has-website yes` `--has-email no` `--has-address yes` | `hasWebsite`, `hasEmail`, `hasAddress` |
| Business categories | `--categories a,b --categories-mode any\|all` | `categories`, `categoriesMode` |
| Date range | `--from 2026-01-01 --to 2026-06-30` | `dateFrom`, `dateTo` |
| …measured on | `--date-field last-seen\|first-seen` | `dateField` |
| Picture shows | `--gender male\|female` | `faceGender` |
| Age range (max 18 or more) | `--min-age 25 --max-age 40` | `faceMinAge`, `faceMaxAge` |
| People in the picture | `--min-people 1 --max-people 1` | `facePeopleMin`, `facePeopleMax` |
| Glasses / beard | `--glasses yes` `--beard no` | `faceHasGlasses`, `faceHasBeard` |
| Picture tags | `--tags dog,beach --tags-mode any\|all` | `faceTags`, `faceTagsMode` |

Every request also sends `hasProfilePic=true`, so no request is spent on a
number without a picture.

Two of the website's filters are deliberately left out. There is no
**ethnicity** filter: selecting people by ethnicity for bulk photo collection
is special-category personal data and a profiling risk. There is no **age
ceiling under 18**: this tool will not select pictures of children.

### Other options

| Option | Default | |
| --- | --- | --- |
| `--max N` / `--all` | 1000 | Stop after N pictures. `--all` means no limit. |
| `--history` | off | Also download each number's older pictures (`<number>_2.jpg`, …). |
| `--no-dedupe` | dedupe on | Save identical pictures again for every number instead of linking them. |
| `--refresh` | off | Re-download pictures whose source changed since they were saved. |
| `--no-records` | records on | Keep pictures only. The CSV then has no profile fields. |
| `--restart` | off | Walk from the newest number again. Files already saved are kept and skipped. |
| `-j, --concurrency` | 8 | Parallel picture downloads (1–32). |
| `--page-size` | 500 | Numbers per search request (1–500). |
| `--min-interval` | 550 ms | Minimum gap between API requests. |
| `-o, --out` | `./downloads` | Output folder. |
| `--csv`, `--zip` | | Write exports when the run ends. |

All of these can also be set in the web app, under **More options**.

## What a run costs

| Action | Requests |
| --- | --- |
| One page of up to 500 numbers | 1 |
| Downloading the pictures | 0 (public CDN) |
| Running a finished download again, nothing new | 1 |
| Continuing a stopped run | at most 1 extra: it re-reads only the page it stopped in |
| `--estimate`, or the picture counts in the web app | 1 (the app caches it for 30 minutes) |
| Category lookup | 1 per new word (cached) |
| Checking a direct key's quota | 0 |
| Errors (401, 404 end of results, 429, 5xx) | 0 on a direct key (RapidAPI bills its 4xx answers) |

A whole country costs about one request per 500 pictures. Argentina's 440,000
pictures, for example, take about 880 requests and roughly 23 GB of disk.

Requests are paced at least 550 ms apart, because the API refuses calls closer
together than 0.5 s. Small runs ask for small pages: the newest 100 pictures are
one request of about 115 numbers, not 500.

## How it never downloads twice

- **Cursor walk.** Results come newest first, in the API's `_id` order
  (`sortBy=id` and `after=<cursor>`). After each page the position of the last
  number fully handled is saved, so a resume continues from exactly that number.
- **One store for every run.** A run with different filters reuses every
  picture already on disk, and so does an *All countries* run.
- **Identical pictures** are recognised before download, from the API's source
  hash, and again after download from the file's own hash. They are linked to
  the copy already saved. Two numbers fetching the same picture at the same
  moment wait for each other instead of both downloading it.
- **Crash-safe ledger.** A picture is recorded in the ledger *before* it gets
  its final name. A run killed at any moment therefore never leaves an
  unrecorded picture, and the next run skips everything already saved.
- **Locks.** Two processes cannot run the same filters at once, and a lock left
  by a crashed process is taken over automatically. Runs with *different*
  filters may run side by side: each download writes its own temporary file.
- **Updates continue too.** A "check for new" run that stops early (limit,
  Stop, error) keeps its own position, so the next one carries on instead of
  starting from the newest number again.
- **Failed pictures are retried.** A picture that could not be downloaded
  (CDN error, timeout) is kept in a retry list. The next run downloads it first,
  without any search request, and the run only says *Done* when nothing is left
  to retry.
- **Refresh keeps links right.** When `--refresh` replaces a picture that other
  numbers were linked to, the old picture is first handed to one of them, so
  every number keeps the picture it really has.

## Output

```
downloads/
  pictures/UY/59899123456.jpg       current picture of a number
  pictures/UY/59899123456_2.jpg     an older picture (--history)
  data/UY.jsonl                     every record the API returned (newest line wins)
  data/UY.files.csv                 ledger: every picture, its size, hashes and links
  runs/<run>.json                   cursor, filters and totals of one filter set
  runs/<run>.numbers                numbers that run matched
  runs/<run>.failed.json            pictures to retry on the next run
  exports/<run>.csv / <run>.zip     exports
```

A run is named after its filters: `UY` for a plain country,
`MX-business-1a2b3c4d` with filters, `ALL` for every country.

### The CSV

One row per number, starting with `country`, `number`, `picture_file` (where
the picture is on disk), `picture_shared` (`yes` when that is an identical
picture saved for another number),
`picture_bytes`, `picture_md5` and `history_files`. Every field of the record
follows, flattened: `about`, `isBusiness`, `date`, `businessProfile.email`,
`businessProfile.address`, `faceAnalysis.summary.…` and so on. Lists are
written as JSON.

The file is UTF-8 with a byte-order mark, so Excel opens accents correctly.
Text that a spreadsheet would run as a formula (`=`, `+`, `-`, `@`) is prefixed
with `'` so that opening the file can never execute anything.

## When something goes wrong

| What happens | What the app does |
| --- | --- |
| `429` too many requests | Waits the interval the API names, retries. Not billed. |
| `429` monthly quota exceeded | Stops with progress saved. |
| `401` / `403` | Stops and explains: check the key and whether it is a direct or a RapidAPI key. |
| `5xx`, network errors | Retries with backoff (honours `Retry-After`). |
| `504` timeout on a slow filter | Halves the page size and retries, down to 25, then grows back after three good pages. If even the smallest page times out, it stops with progress saved. |
| A picture fails to download (CDN `5xx`, timeout) | Retried 4 times, then put on the run's retry list for the next run. |
| A picture is gone from the CDN (`404`) | Counted as *no longer public* (deleted, or the owner opted out). Doesn't count towards `--max`. |
| A `404` that is not the API's "no results" (a gateway, a wrong host) | Stops with an error and progress saved. It never ends a walk early. |
| The connection drops while an answer streams | Retried like any network error. |
| Less than 500 MB of free disk | Stops before filling the disk. |
| A corrupted saved position | Tells you to start the run over; the pictures are kept. |
| The export file is open in Excel (Windows) | The new export gets a dated file name instead. |

Very selective filter combinations (for example business accounts with a
website in a large country) can be slow for the API to walk, because matches
are spread thinly across the whole country.

## Security

- The web app listens on `127.0.0.1` only. It refuses requests whose `Host` is
  not local (DNS rebinding) and cross-site requests from other tabs, including
  image and link requests (`Sec-Fetch-Site`).
- Your key is kept in memory and sent only to the API. It is never written to
  disk, logged or shown back. Error messages are scrubbed of anything shaped
  like a key.
- Set `HOST=0.0.0.0` only if you understand that anyone who can reach the port
  can spend the key in `.env`. List the extra host names in `ALLOWED_HOSTS`.
- Prefer `WA_API_KEY` in `.env` over `--key`, which ends up in shell history.

## Responsible use

These are pictures of real people. Collect and keep them only where the law
allows, for a purpose you can justify, and keep them secure. In many places
(the EU's GDPR, for example) bulk collection of personal data needs a lawful
basis and has to respect the rights of the people in it.

Anyone can hide their number at
[whatsapp.checkleaked.cc/opt-out](https://whatsapp.checkleaked.cc/opt-out).
Hidden numbers disappear from the API, and their pictures from the CDN, so they
show up here as *no longer public*.

This project is not affiliated with, endorsed by or sponsored by WhatsApp LLC or
Meta Platforms, Inc.

## Development

```
npm test                  # node:test, no network
```

Node 22 or newer. The only dependency is [yazl](https://github.com/thejoshwolfe/yazl)
for ZIP files. The tests run against an in-memory fake of the API and the CDN.
They cover the cursor walk, resuming, page shrinking, retries, pacing, dedupe
(including concurrent twins and concurrent runs), a process killed
mid-download, refresh hand-over, the retry list, the exports and the web
server's guards.

| File | |
| --- | --- |
| `src/api.js` | API client: transports, pacing, retries, error mapping |
| `src/filters.js` | Filter validation and mapping to API parameters |
| `src/walker.js` | Cursor walk with adaptive page size |
| `src/job.js` | A download run: walk, download, dedupe, checkpoint |
| `src/store.js` | On-disk layout, ledger, run state, locks |
| `src/export.js` | CSV and ZIP exports |
| `src/cli.js`, `src/server.js`, `public/` | Command line and web app |

## License

MIT
