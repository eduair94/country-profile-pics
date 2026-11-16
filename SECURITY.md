# Security

## Reporting a problem

Please do not open a public issue for a security problem. Report it privately
through GitHub: **Security → Report a vulnerability** on this repository. You
will get an answer within a few days.

Useful to include: the version you downloaded, your system, how you ran the app
(desktop, browser or command line), what you did, and what happened.

## What the app does with your data

- **The API key** is sent only to the API. The desktop app stores it encrypted
  by the operating system (Keychain on macOS, DPAPI on Windows, libsecret on
  Linux) while **Remember this key** is ticked; the browser version and the
  command line keep it in memory, or read it from `.env`. It is never logged or
  shown back, and error messages are scrubbed of anything shaped like a key.
- **Pictures and CSV files** stay in the folder you chose. Nothing is uploaded.
- **No telemetry.** The app sends no usage data and has no account. Its font is
  bundled, so the page asks no other server for anything.

## How the app protects you

The [Security section of the README](README.md#security) describes the local
server's guards (a secret per window, local hosts only, no cross-site requests)
and the packaged app's Electron fuses.
