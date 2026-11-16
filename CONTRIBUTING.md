# Contributing

Thanks for helping. Bug reports, fixes and ideas are all welcome; open an
[issue](https://github.com/eduair94/country-profile-pics/issues) first for
anything larger than a small fix, so we can agree on the approach.

## Set up

You need Node.js 22 or later and Git.

```
git clone https://github.com/eduair94/country-profile-pics.git
cd country-profile-pics
npm install
npm run demo        # the desktop app in demo mode (no key, no network)
```

| Command | What it does |
| --- | --- |
| `npm run app` | Open the desktop app with your own key. |
| `npm run demo` | Open the desktop app in demo mode. |
| `npm start` | Serve the same app to your browser on `http://localhost:4747`. |
| `npm run demo:web` | The browser version in demo mode. |
| `npm run cli -- --help` | The command line. |
| `npm test` | Run the tests (`node:test`, no network). |
| `npm run smoke` | Open the desktop app once and write what it saw to `smoke.json`. |
| `npm run screenshots` | Retake the pictures in `docs/images/` from demo mode. |
| `npm run icons` | Render `build/icon.svg` to `build/icon.png`. |
| `npm run dist` | Build the installers for your system into `dist/`. |

## How the code is organised

| File | |
| --- | --- |
| `src/api.js` | API client: transports, pacing, retries, error mapping |
| `src/filters.js` | Filter validation and mapping to API parameters |
| `src/walker.js` | Cursor walk with adaptive page size |
| `src/job.js` | A download run: walk, download, dedupe, checkpoint |
| `src/store.js` | On-disk layout, ledger, run state, locks |
| `src/export.js` | CSV and ZIP exports |
| `src/demo.js` | Demo mode: the API and picture CDN, simulated in memory |
| `src/cli.js`, `src/server.js`, `public/` | Command line, local server and the app's page |
| `electron/` | Desktop app: window, encrypted key, folder picker |

The page in `public/` is plain HTML, CSS and JavaScript with no build step. The
tests run against an in-memory fake of the API and the picture CDN
(`test/fake.js`), so they need no key and no network.

## Rules of the house

- **Tests for behaviour.** A change to `src/` comes with a test that fails
  without it, and `npm test` must pass.
- **Never download a picture twice, never spend a request the person did not
  ask for.** Anything that touches the walk, the ledger or the saved position
  keeps those two promises, also when the app is killed halfway.
- **The key is a secret.** It is never logged, never shown back, and sent only
  to the API.
- **Two filters stay out.** There is no ethnicity filter, and an age range never
  ends below 18. Changes that add either will not be merged.
- **Plain words on screen.** Buttons say what they do; errors say what went
  wrong and what to do next.
- **The design** is described in [DESIGN.md](DESIGN.md) and shared with
  [WhatsApp Number Checker](https://github.com/eduair94/whatsapp-scraping-tool):
  drawn marks, ink on a pale tint, one red margin rule. No badges or pills, no
  icons from fonts or emoji.
- **Demo mode stays fictional.** Demo pictures are drawings that never show a
  person, and demo numbers are made up.

## Sending a change

1. Fork the repository and create a branch.
2. Make the change, with tests.
3. Run `npm test`, and `npm run smoke` if you touched `electron/` or `public/`.
4. Open a pull request that says what changed and why.

## Releases

Pushing a tag such as `v1.1.1` tests and builds every system, installs and
starts each file, and uploads them to a draft release with checksums. The draft
is published by hand.
