#!/usr/bin/env bash
# uninstall.sh — Hermes Zalo plugin uninstaller for macOS / Linux.
# Thin wrapper: verifies Node is present, then hands off to uninstall.mjs
# (stops + removes the background service, removes the Hermes adapter).
#
#   ./uninstall.sh                          # remove service + adapter, keep the Zalo login
#   ./uninstall.sh --purge                  # also delete the saved Zalo login (credentials)
#   ./uninstall.sh --hermes-home <path>     # remove the adapter from that Hermes profile
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js is required but not found."
  echo "  Install Node >= 18 from https://nodejs.org (or your package manager), then re-run."
  exit 1
fi

exec node uninstall.mjs "$@"
