#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <signed-and-stapled-app> <output.app.tar.gz>" >&2
  exit 1
fi

app="$1"
archive="$2"
[[ -d "$app" && "$app" == *.app ]] || { echo "Missing app bundle: $app" >&2; exit 1; }
[[ "$archive" == *.app.tar.gz && ! -e "$archive" ]] || {
  echo "Updater archive must be a new .app.tar.gz path: $archive" >&2
  exit 1
}
codesign --verify --deep --strict "$app"
xcrun stapler validate "$app"

temporary="$(mktemp "${archive}.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
tar -czf "$temporary" -C "$(dirname "$app")" "$(basename "$app")"
mv "$temporary" "$archive"
