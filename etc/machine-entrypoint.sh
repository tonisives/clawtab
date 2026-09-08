#!/bin/sh
set -eu
umask 077
mkdir -p /home/clawtab/.config/clawtab /home/clawtab/workspace /home/clawtab/.local/bin
# Setup writes this marker only after both credentials and settings are saved.
while [ ! -f /home/clawtab/.config/clawtab/machine-paired ]; do
    sleep 2
done
exec clawtab-daemon
