#!/bin/sh
set -eu
umask 077
mkdir -p /home/clawtab/.config/clawtab /home/clawtab/workspace /home/clawtab/.local/bin
if [ -f /run/clawtab-enrollment/enrollment.json ]; then
    cwtctl setup --enrollment-file /run/clawtab-enrollment/enrollment.json --no-service
fi
# Local IPC works before pairing. Setup connects this daemon after saving credentials.
exec clawtab-daemon
