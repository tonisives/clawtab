#!/bin/sh

# Shared paths for local ClawTab build artifacts. This file is sourced by the
# Makefile and the Tauri build helper so local binaries and app bundles have a
# single canonical location.

: "${CARGO_TARGET_DIR:=${CARGO_TARGET_ROOT:-/Volumes/sam/build/rust/targets}}"
: "${CLAWTAB_LOCAL_DEV_ROOT:=$HOME/Library/Caches/ClawTab-dev}"
: "${CLAWTAB_LOCAL_DEV_BIN_DIR:=$CLAWTAB_LOCAL_DEV_ROOT/bin}"
: "${CLAWTAB_LOCAL_CWTCTL:=$CLAWTAB_LOCAL_DEV_BIN_DIR/cwtctl}"
: "${CLAWTAB_LOCAL_CWTCTL_LINK:=/usr/local/bin/cwtctl}"
: "${CLAWTAB_LOCAL_DAEMON_APP:=${CLAWTAB_ENGINE_APP:-$CLAWTAB_LOCAL_DEV_ROOT/ClawTab Daemon.app}}"
: "${CLAWTAB_LOCAL_DAEMON_LINK:=/usr/local/ClawTab Daemon.app}"
: "${CLAWTAB_LOCAL_DESKTOP_APP:=${CLAWTAB_DEV_APP:-$CLAWTAB_LOCAL_DEV_ROOT/ClawTab.app}}"

export CARGO_TARGET_DIR
export CLAWTAB_LOCAL_DEV_ROOT
export CLAWTAB_LOCAL_DEV_BIN_DIR
export CLAWTAB_LOCAL_CWTCTL
export CLAWTAB_LOCAL_CWTCTL_LINK
export CLAWTAB_LOCAL_DAEMON_APP
export CLAWTAB_LOCAL_DAEMON_LINK
export CLAWTAB_LOCAL_DESKTOP_APP
