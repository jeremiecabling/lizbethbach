#!/bin/bash
# Stop and remove the launchd agent.
set -euo pipefail
LABEL="com.lizbeth.imessage-sender"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "Removed $LABEL. The sender will no longer run on a schedule."
