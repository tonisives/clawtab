#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <signed-desktop-app> <host-package-directory>" >&2
  exit 1
fi

resources="$1/Contents/Resources"
destination="$2"
for artifact in "ClawTab Daemon.app/Contents/MacOS/ClawTab Daemon" \
  "ClawTab Daemon.app/Contents/MacOS/clawtab-hook" cwt _cwt; do
  [[ -s "$resources/$artifact" ]] || { echo "Missing host artifact: $artifact" >&2; exit 1; }
done
[[ ! -e "$destination" ]] || { echo "Package directory already exists: $destination" >&2; exit 1; }

mkdir -p "$destination"
ditto "$resources/ClawTab Daemon.app" "$destination/ClawTab Daemon.app"
cp "$resources/cwt" "$resources/_cwt" "$destination/"
chmod +x "$destination/cwt"
