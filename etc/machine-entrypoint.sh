#!/bin/sh
set -eu
umask 077
mkdir -p /home/clawtab/.config/clawtab /home/clawtab/workspace /home/clawtab/.local/bin
# Local IPC works before pairing. Setup connects this daemon after saving credentials.
exec clawtab-daemon
