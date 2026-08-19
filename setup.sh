#!/bin/bash
#
# Install the bridge as a launchd user agent on macOS.
#
# Not required to run the bridge — `npm start` works fine for trying it out.
# This is for keeping it running across logouts, crashes, and reboots.
#
# On Linux, write an equivalent systemd user unit; the bridge itself has no
# macOS dependency beyond this script.
set -euo pipefail

BRIDGE_DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="${BRIDGE_LABEL:-com.claude-telegram-bridge}"
PLIST_SRC="$BRIDGE_DIR/com.claude-telegram-bridge.plist.template"
PLIST_DST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/.claude-telegram-bridge/logs"

echo "=== Claude Telegram Bridge setup ==="
echo ""

# 1. Node — resolved now so the plist gets an absolute path. launchd starts
#    with a minimal PATH and will not find a version-manager shim.
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "error: node not found on PATH. Install Node 20 or newer first." >&2
  exit 1
fi
# 20.12 specifically: --env-file-if-exists, which npm start relies on, landed
# there. A bare major-version check passes on 20.0 and then fails at runtime
# with an unknown-flag error.
if ! "$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=12)?0:1)'; then
  echo "error: Node 20.12+ required (found $("$NODE_BIN" --version))." >&2
  exit 1
fi
echo "[ok] node: $NODE_BIN ($("$NODE_BIN" --version))"

# 2. Log directory
mkdir -p "$LOG_DIR"
echo "[ok] log directory: $LOG_DIR"

# 3. Dependencies
cd "$BRIDGE_DIR"
npm install
echo "[ok] dependencies installed"

# 4. Configuration
if [ ! -f "$BRIDGE_DIR/.env" ]; then
  cp "$BRIDGE_DIR/.env.example" "$BRIDGE_DIR/.env"
  chmod 600 "$BRIDGE_DIR/.env"
  echo ""
  echo "Created .env from .env.example."
  echo "Fill in TELEGRAM_BOT_TOKEN and ALLOWED_TELEGRAM_USERS, then run this again."
  exit 0
fi
echo "[ok] .env present"

# 5. Stop an existing instance
if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
  echo "Stopping existing service..."
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
fi

# 6. Render and install the plist
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|__LABEL__|${LABEL}|g" \
    -e "s|__NODE_BIN__|${NODE_BIN}|g" \
    -e "s|__BRIDGE_DIR__|${BRIDGE_DIR}|g" \
    -e "s|__HOME__|${HOME}|g" \
    -e "s|__PATH__|$(dirname "$NODE_BIN"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin|g" \
    "$PLIST_SRC" > "$PLIST_DST"
echo "[ok] installed $PLIST_DST"

# 7. Start
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
echo "[ok] service started"

cat <<EOF

=== Done ===

  status:  launchctl print gui/$(id -u)/${LABEL}
  logs:    tail -f $LOG_DIR/stdout.log
  stop:    launchctl bootout gui/$(id -u)/${LABEL}
  start:   launchctl bootstrap gui/$(id -u) $PLIST_DST

Only one process may poll a given bot token. If the bot goes quiet, check
that nothing else is running against the same token.
EOF
