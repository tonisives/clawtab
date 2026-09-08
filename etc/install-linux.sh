#!/bin/sh
set -eu
# Run from the checksum-verified extracted Linux release package.
package_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
config_dir="$HOME/.config/clawtab"
case "$(uname -s)" in Linux) ;; *) echo 'This package requires Linux.' >&2; exit 1;; esac
for dependency in tmux git python3 systemctl; do
  command -v "$dependency" >/dev/null 2>&1 || { echo "Install $dependency before setup." >&2; exit 1; }
done
mkdir -p "$install_dir" "$config_dir/agent-plugins"
for binary in clawtab-daemon cwtctl clawtab-hook; do
  install -m 755 "$package_dir/bin/$binary" "$install_dir/$binary.new"
  mv "$install_dir/$binary.new" "$install_dir/$binary"
done
if [ -d "$package_dir/plugins/local.session-shortcuts" ] && [ ! -d "$config_dir/agent-plugins/local.session-shortcuts" ]; then
  cp -R "$package_dir/plugins/local.session-shortcuts" "$config_dir/agent-plugins/"
fi
printf 'Installed. Run %s/cwtctl setup to pair this host.\n' "$install_dir"
printf 'For an existing installation, run cwtctl daemon restart when ready to load the update.\n'
