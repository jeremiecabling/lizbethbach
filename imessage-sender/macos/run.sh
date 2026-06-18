#!/bin/bash
# Wrapper invoked by launchd every 5 minutes (and once at load).
# launchd does NOT load your login shell, so we set PATH explicitly and find node.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || exit 1

# Optional overrides (e.g. SCHEDULE_TZ, SCHEDULE_CSV, SOURCE/TRANSPORT). See env.sh.example.
[ -f "$DIR/macos/env.sh" ] && . "$DIR/macos/env.sh"

NODE="$(command -v node)"
if [ -z "$NODE" ]; then
  echo "$(date '+%Y-%m-%dT%H:%M:%S%z') ERROR: node not found in PATH" >&2
  exit 127
fi

echo "----- $(date '+%Y-%m-%dT%H:%M:%S%z') run -----"
exec "$NODE" send.mjs
