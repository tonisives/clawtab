#!/bin/sh
set -eu
version="${1:-}"
case "$version" in v[0-9]* ) ;; *) printf 'Usage: sh download-linux.sh vX.Y.Z\n' >&2; exit 1;; esac
case "$version" in *[!a-zA-Z0-9._-]*) printf 'Invalid release version\n' >&2; exit 1;; esac
[ "$(uname -s)" = Linux ] || { printf 'Linux is required\n' >&2; exit 1; }
case "$(uname -m)" in x86_64) arch=x86_64;; aarch64|arm64) arch=aarch64;; *) printf 'Supported architectures: x86_64, arm64\n' >&2; exit 1;; esac
for tool in curl sha256sum tar; do command -v "$tool" >/dev/null 2>&1 || { printf 'Install %s first\n' "$tool" >&2; exit 1; }; done
package="clawtab-linux-$arch.tar.gz"
release_url="https://github.com/tonisives/clawtab/releases/download/$version"
transfer_dir=$(mktemp -d)
trap 'rm -rf "$transfer_dir"' EXIT HUP INT TERM
cd "$transfer_dir"
curl --fail --location --proto '=https' --tlsv1.2 "$release_url/$package" -o "$package"
curl --fail --location --proto '=https' --tlsv1.2 "$release_url/$package.sha256" -o "$package.sha256"
# Accept exactly the expected filename; a checksum file cannot select another path.
expected=$(awk -v file="$package" '$2 == file && length($1) == 64 {print $1}' "$package.sha256")
case "$expected" in ''|*[!a-fA-F0-9]*) printf 'Invalid release checksum\n' >&2; exit 1;; esac
printf '%s  %s\n' "$expected" "$package" | sha256sum --check --status
mkdir package
tar -xzf "$package" -C package
sh package/install.sh
