#!/usr/bin/env bash

# Keep the animation ASCII-only so it works consistently across tmux clients.
case $(( $(date +%s) % 4 )) in
    0) printf '|' ;;
    1) printf '/' ;;
    2) printf '-' ;;
    3) printf '\\' ;;
esac
