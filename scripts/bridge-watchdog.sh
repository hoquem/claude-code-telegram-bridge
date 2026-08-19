#!/usr/bin/env bash
# External watchdog for the bridge — the outermost recovery layer.
# Runs every 60s under launchd. On 10 consecutive /livez failures (HTTP error,
# timeout, or 503), force-restarts the bridge via launchctl kickstart.
# Consecutive-fail counter is stored in /tmp/bridge-watchdog-fails.txt
# (cheaper than parsing launchd logs).
#
# Threshold is 10 (not 3) to avoid a secondary race during the 30s polling-
# restart window introduced by fix/409-self-race. While bridge.mjs holds
# polling stopped and waits before restarting, /livez may blip momentarily.
# A threshold of 3 (60s × 3 = 3 min) was too eager and could kick off a new
# bridge process mid-recovery, creating a fresh 409 racer.  10 consecutive
# failures = ~10 min of confirmed dead bridge, which is a genuine crash.
#
# Additionally, a 5-minute cooldown between kickstarts (via timestamp file
# /tmp/bridge-watchdog-last-kickstart.txt) prevents the watchdog itself from
# piling on during a slow startup.
#
# Recovery is two-tier:
#   1. launchctl kickstart -k  — restarts an already-loaded service (the common
#      crash case where the launchd job is still loaded).
#   2. launchctl bootstrap     — fallback when the service has been booted out
#      of launchd entirely (kickstart then fails with "Could not find service
#      in domain"). This happened on 2026-06-25: a graceful SIGTERM left the
#      job deregistered, and a kickstart-only watchdog looped for ~2h unable to
#      recover it. bootstrap reloads the plist from scratch.
#
# Telegram notification on restart goes to WATCHDOG_ALERT_CHAT via
# scripts/telegram-send.sh (which reads TELEGRAM_BOT_TOKEN from the bridge's
# .env).
#
# Optional cron-staleness guard: set WATCHDOG_CRON_JOB to a job id and
# WATCHDOG_CRON_STALE_SECS to how long is too long between runs. The watchdog
# then greps the bridge's stdout.log for that job's "cron-start" entries and
# alerts once per 24h if it has gone quiet. A job that silently stops firing
# is otherwise invisible. Leave WATCHDOG_CRON_JOB unset to skip this check.
#
# Install as a launchd agent with StartInterval 60, or a systemd timer.
# Configure via environment, or a .env next to this repo:
#   WATCHDOG_ALERT_CHAT   chat id for alerts (required for notifications)
#   BRIDGE_LABEL          launchd label (default com.claude-telegram-bridge)
#   BRIDGE_API_PORT       port /livez listens on (default 8091)

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"

# Pull watchdog settings from the bridge's .env so there is one place to
# configure both. Explicit environment variables win.
if [ -f "$ENV_FILE" ]; then
  for key in WATCHDOG_ALERT_CHAT WATCHDOG_CRON_JOB WATCHDOG_CRON_STALE_SECS BRIDGE_LABEL BRIDGE_API_PORT; do
    if [ -z "${!key:-}" ]; then
      val=$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
      [ -n "$val" ] && export "${key}=${val}"
    fi
  done
fi

STATE=/tmp/bridge-watchdog-fails.txt
LAST_KICKSTART=/tmp/bridge-watchdog-last-kickstart.txt
CRON_ALERTED=/tmp/bridge-watchdog-cron-alerted.txt
THRESHOLD=10
KICKSTART_COOLDOWN_SECS=300   # 5 minutes between kickstarts
CRON_ALERT_COOLDOWN_SECS=86400  # alert at most once per 24h
CRON_STALE_SECS="${WATCHDOG_CRON_STALE_SECS:-129600}"   # default 36 hours
LIVEZ_URL="http://127.0.0.1:${BRIDGE_API_PORT:-8091}/livez"
LOG="$HOME/.claude-telegram-bridge/logs/watchdog.log"
BRIDGE_LOG="$HOME/.claude-telegram-bridge/logs/stdout.log"
LABEL="${BRIDGE_LABEL:-com.claude-telegram-bridge}"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
ALERT_CHAT="${WATCHDOG_ALERT_CHAT:-}"
TELEGRAM_SEND="${SCRIPT_DIR}/telegram-send.sh"

mkdir -p "$(dirname "$LOG")"

# ---------------------------------------------------------------------------
# Helper: send Telegram message (non-fatal — watchdog continues on failure)
# ---------------------------------------------------------------------------
send_telegram() {
  local chat_id="$1"
  local message="$2"
  if [ -z "$chat_id" ]; then
    echo "$(date -u +%FT%TZ) alert not sent — WATCHDOG_ALERT_CHAT unset: $message" >> "$LOG"
    return
  fi
  if [ -x "$TELEGRAM_SEND" ]; then
    "$TELEGRAM_SEND" "$chat_id" "$message" 2>/dev/null || true
  fi
}

# ---------------------------------------------------------------------------
# 1. Bridge liveness check
# ---------------------------------------------------------------------------
fails=$(cat "$STATE" 2>/dev/null || echo 0)

http_code=$(curl -sS --max-time 10 -o /dev/null -w "%{http_code}" "$LIVEZ_URL" 2>/dev/null || echo "000")

if [ "$http_code" = "200" ]; then
  echo "$(date -u +%FT%TZ) ok (http=$http_code)" >> "$LOG"
  echo 0 > "$STATE"
else
  fails=$((fails + 1))
  echo "$(date -u +%FT%TZ) fail count=$fails (http=$http_code)" >> "$LOG"
  echo "$fails" > "$STATE"

  if [ "$fails" -ge "$THRESHOLD" ]; then
    # Cooldown guard: don't kickstart more than once per 5 minutes.
    now=$(date +%s)
    last_kickstart=$(cat "$LAST_KICKSTART" 2>/dev/null || echo 0)
    elapsed=$(( now - last_kickstart ))
    if [ "$elapsed" -lt "$KICKSTART_COOLDOWN_SECS" ]; then
      echo "$(date -u +%FT%TZ) RESTART suppressed — cooldown (${elapsed}s < ${KICKSTART_COOLDOWN_SECS}s since last kickstart)" >> "$LOG"
    else
      echo "$(date -u +%FT%TZ) RESTART triggered (consecutive fails=$fails)" >> "$LOG"
      echo "$now" > "$LAST_KICKSTART"
      echo 0 > "$STATE"

      # Tier 1: kickstart an already-loaded service (the common crash case).
      if /bin/launchctl kickstart -k "gui/$(id -u)/${LABEL}" >> "$LOG" 2>&1; then
        echo "$(date -u +%FT%TZ) kickstart ok" >> "$LOG"
        send_telegram "$ALERT_CHAT" "⚠️ *Bridge watchdog*: Telegram bridge restarted after ${fails} consecutive /livez failures (HTTP ${http_code}). Check \`~/.claude-telegram-bridge/logs/watchdog.log\` for details."
      else
        # Tier 2: kickstart failed — the service is likely booted out of launchd
        # entirely. Reload the plist from scratch.
        echo "$(date -u +%FT%TZ) kickstart failed — service likely unloaded, bootstrapping from $PLIST" >> "$LOG"
        if /bin/launchctl bootstrap "gui/$(id -u)" "$PLIST" >> "$LOG" 2>&1; then
          echo "$(date -u +%FT%TZ) bootstrap ok" >> "$LOG"
          send_telegram "$ALERT_CHAT" "⚠️ *Bridge watchdog*: bridge was DOWN and unloaded from launchd — re-bootstrapped after ${fails} consecutive /livez failures. Should be back online shortly."
        else
          echo "$(date -u +%FT%TZ) bootstrap FAILED — manual intervention needed" >> "$LOG"
          send_telegram "$ALERT_CHAT" "🚨 *Bridge watchdog*: bridge is DOWN and BOTH kickstart and bootstrap failed after ${fails} /livez failures. Needs manual intervention — check \`~/.claude-telegram-bridge/logs/watchdog.log\`."
        fi
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 2. Cron staleness guard (opt-in)
# ---------------------------------------------------------------------------
# Parse the bridge stdout.log (last 5000 lines, to stay fast) for the most
# recent "cron-start: $WATCHDOG_CRON_JOB". If nothing within CRON_STALE_SECS,
# alert at most once per 24h. Skipped entirely when WATCHDOG_CRON_JOB is unset.

if [ -n "${WATCHDOG_CRON_JOB:-}" ]; then
  now=$(date +%s)

  last_line=$(tail -5000 "$BRIDGE_LOG" 2>/dev/null \
    | grep "\"cron-start: ${WATCHDOG_CRON_JOB}\"" \
    | tail -1)

  last_ts=""
  if [ -n "$last_line" ]; then
    # Extract the ISO timestamp from {"ts":"2026-06-21T02:45:00.158Z",...}
    last_ts=$(echo "$last_line" | grep -o '"ts":"[^"]*"' | head -1 | cut -d'"' -f4)
  fi

  if [ -n "$last_ts" ]; then
    # macOS date; GNU date needs -d instead.
    last_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${last_ts%.*}" "+%s" 2>/dev/null \
      || date -d "$last_ts" "+%s" 2>/dev/null || echo 0)
    age=$(( now - last_epoch ))
  else
    # No entry at all — treat as maximally stale.
    age=$CRON_STALE_SECS
  fi

  if [ "$age" -ge "$CRON_STALE_SECS" ]; then
    last_alerted=$(cat "$CRON_ALERTED" 2>/dev/null || echo 0)
    if [ $(( now - last_alerted )) -ge "$CRON_ALERT_COOLDOWN_SECS" ]; then
      hours=$(( age / 3600 ))
      echo "$(date -u +%FT%TZ) ALERT: ${WATCHDOG_CRON_JOB} stale (${hours}h)" >> "$LOG"
      echo "$now" > "$CRON_ALERTED"
      if [ -n "$last_ts" ]; then
        last_run_msg="Last run: ${last_ts}"
      else
        last_run_msg="No run found in the last 5000 log lines"
      fi
      send_telegram "$ALERT_CHAT" "⚠️ *Cron staleness*: \`${WATCHDOG_CRON_JOB}\` has not run in ${hours}+ hours. ${last_run_msg}."
    fi
  fi
fi

exit 0
