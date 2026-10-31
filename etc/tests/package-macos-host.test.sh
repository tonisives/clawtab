#!/usr/bin/env bash
set -euo pipefail

repository="$(cd "$(dirname "$0")/../.." && pwd)"
directory="$(mktemp -d)"
trap 'rm -rf "$directory"' EXIT
app="$directory/ClawTab.app"
resources="$app/Contents/Resources"
mkdir -p "$app/Contents/MacOS" "$resources/ClawTab Daemon.app/Contents/MacOS"
printf 'desktop' > "$app/Contents/MacOS/ClawTab"
printf 'daemon' > "$resources/ClawTab Daemon.app/Contents/MacOS/ClawTab Daemon"
printf 'hook' > "$resources/ClawTab Daemon.app/Contents/MacOS/clawtab-hook"
printf 'cli' > "$resources/cwt"
printf 'completion' > "$resources/_cwt"

bash "$repository/etc/package-macos-host.sh" "$app" "$directory/host"
tar -czf "$directory/host.tar.gz" -C "$directory/host" .
mkdir "$directory/unpacked"
tar -xzf "$directory/host.tar.gz" -C "$directory/unpacked"
[[ ! -e "$directory/unpacked/ClawTab.app" ]]
[[ -x "$directory/unpacked/cwt" ]]
for artifact in "ClawTab Daemon.app/Contents/MacOS/ClawTab Daemon" \
  "ClawTab Daemon.app/Contents/MacOS/clawtab-hook" cwt _cwt; do
  cmp "$resources/$artifact" "$directory/unpacked/$artifact"
done

# A missing helper must fail before creating a partial package.
mv "$resources/ClawTab Daemon.app/Contents/MacOS/clawtab-hook" "$directory/helper"
if bash "$repository/etc/package-macos-host.sh" "$app" "$directory/incomplete" 2>/dev/null; then
  echo "Packaging accepted a missing hook helper" >&2
  exit 1
fi
[[ ! -e "$directory/incomplete" ]]
echo "macOS host packaging tests passed"
