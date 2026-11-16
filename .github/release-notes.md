Download every stored profile picture that matches your filters from the WP Data API, with a CSV of every field. Desktop app for Windows, macOS and Linux, plus a command line.

**New in 1.1:** a new look, shared with its sibling app [WhatsApp Number Checker](https://github.com/eduair94/whatsapp-scraping-tool): light and dark following your system, each total led by a drawn mark, and a list of earlier runs you can read at a glance. Stop and the exports are now at the top of the run, a finished run shows its results as one bar, picture numbers stay the same after a reload, times use the 24-hour clock, and demo mode is labelled as such. The font now ships inside the app, so the window makes no request to anyone but the API and its picture server.

## Download

| System | File |
| --- | --- |
| Windows (installer) | `country-profile-pics-windows-setup.exe` |
| Windows (portable, no install) | `country-profile-pics-windows-portable.exe` |
| macOS, Apple Silicon (M1–M4) | `country-profile-pics-mac-arm64.dmg` |
| macOS, Intel | `country-profile-pics-mac-x64.dmg` |
| Linux: Ubuntu, Debian, Mint… | `country-profile-pics-linux-x64.deb` |
| Linux: any distribution | `country-profile-pics-linux-x64.AppImage` |

You need an API key: a direct key from https://whatsapp.checkleaked.cc/api or a RapidAPI key subscribed to WP Data DB Only.

The builds are not code-signed yet:
- **Windows** may show "Windows protected your PC": click **More info → Run anyway**.
- **macOS 15 and later**: after the first try, open **System Settings → Privacy & Security** and click **Open Anyway**. On macOS 14 and earlier, right-click the app → **Open**, then **Open** again. If macOS says the app is damaged, run `xattr -dr com.apple.quarantine "/Applications/Country Profile Pictures.app"` once.
- **Linux**: `sudo apt install ./country-profile-pics-linux-x64.deb`, or `chmod +x` the AppImage and run it (it needs FUSE 2: `libfuse2t64` on Ubuntu 24.04).

Verify a download with `SHA256SUMS.txt`.

**New to the app?** The [user guide](https://github.com/eduair94/country-profile-pics/blob/main/docs/GUIDE.md) walks through installing on Windows, macOS or Linux, your key, filters, downloading and exporting, with screenshots. To look around without a key, open **Help → Try the Demo**.

## What it does

- Same filters as the website's database search, every request with `hasProfilePic=true`
- About one search request per 500 pictures; the pictures download from the public CDN for free
- Resumable and incremental: stop at any time, run again to continue or to fetch only what is new
- Never downloads the same picture twice; identical pictures are stored once and linked
- CSV export with every field, and ZIP export
- Your key is stored encrypted by the operating system, and only sent to the API

These are pictures of real people. Use them only where the law allows. Anyone can hide their number at https://whatsapp.checkleaked.cc/opt-out.
