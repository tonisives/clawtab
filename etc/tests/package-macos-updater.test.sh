#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "$0")" && pwd)"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
mkdir -p "$temporary/bin" "$temporary/signed/ClawTab.app/Contents/MacOS" "$temporary/extracted"
app="$temporary/signed/ClawTab.app"
printf 'final signed executable\n' > "$app/Contents/MacOS/clawtab"
printf 'stapled ticket\n' > "$app/Contents/ticket"
ln -s clawtab "$app/Contents/MacOS/link"
cat > "$temporary/bin/codesign" <<'SH'
#!/usr/bin/env bash
[[ "${SIGNATURE_VALID:-1}" == 1 ]]
SH
cat > "$temporary/bin/xcrun" <<'SH'
#!/usr/bin/env bash
[[ "$1" == stapler && "$2" == validate && "${STAPLE_VALID:-1}" == 1 ]]
SH
chmod +x "$temporary/bin/codesign" "$temporary/bin/xcrun"
export PATH="$temporary/bin:$PATH"
archive="$temporary/ClawTab.app.tar.gz"
package="$script_directory/../package-macos-updater.sh"

if SIGNATURE_VALID=0 bash "$package" "$app" "$archive"; then
  echo 'Unsigned app was accepted' >&2; exit 1
fi
[[ ! -e "$archive" ]]
if STAPLE_VALID=0 bash "$package" "$app" "$archive"; then
  echo 'Unstapled app was accepted' >&2; exit 1
fi
[[ ! -e "$archive" ]]
bash "$package" "$app" "$archive"
tar -xzf "$archive" -C "$temporary/extracted"
cmp "$app/Contents/MacOS/clawtab" "$temporary/extracted/ClawTab.app/Contents/MacOS/clawtab"
cmp "$app/Contents/ticket" "$temporary/extracted/ClawTab.app/Contents/ticket"
[[ "$(readlink "$temporary/extracted/ClawTab.app/Contents/MacOS/link")" == clawtab ]]
before="$(shasum -a 256 "$archive")"
if bash "$package" "$app" "$archive" 2>/dev/null; then
  echo 'Existing archive was overwritten' >&2; exit 1
fi
[[ "$before" == "$(shasum -a 256 "$archive")" ]]
echo 'macOS updater packaging tests passed'
