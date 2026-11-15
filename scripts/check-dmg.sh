#!/usr/bin/env bash
# Install a macOS disk image the way the user guide says (copy the app to
# /Applications), check its signature and architecture, and launch it once.
#   scripts/check-dmg.sh <file.dmg> <arm64|x86_64>
set -euo pipefail
dmg="$1"
want="$2"
app="/Applications/Country Profile Pictures.app"
mnt="$(mktemp -d)"
hdiutil attach -nobrowse -mountpoint "$mnt" "$dmg" > /dev/null
rm -rf "$app"
cp -R "$mnt/Country Profile Pictures.app" /Applications/
hdiutil detach "$mnt" > /dev/null
codesign --verify --deep --strict "$app"
archs="$(lipo -archs "$app/Contents/MacOS/Country Profile Pictures")"
echo "$dmg: $archs"
[ "$archs" = "$want" ] || { echo "expected $want"; exit 1; }
node scripts/smoke.mjs "$app/Contents/MacOS/Country Profile Pictures"
