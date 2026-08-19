#!/usr/bin/env bash
# telegram-send.sh — send a text message to a Telegram chat via bot API.
# Usage: telegram-send.sh <chat_id> <message>
# Reads TELEGRAM_BOT_TOKEN from the bridge .env file.
# Exit 0 on success, 1 on failure. Safe to call from watchdog / shell scripts.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"
CHAT_ID="${1:-}"
MESSAGE="${2:-}"

if [ -z "$CHAT_ID" ] || [ -z "$MESSAGE" ]; then
  echo "Usage: telegram-send.sh <chat_id> <message>" >&2
  exit 1
fi

# Load TELEGRAM_BOT_TOKEN from .env if not already in environment
if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
  if [ -f "$ENV_FILE" ]; then
    TELEGRAM_BOT_TOKEN=$(grep -E "^TELEGRAM_BOT_TOKEN=" "$ENV_FILE" | head -1 | cut -d= -f2-)
  fi
fi

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
  echo "telegram-send.sh: TELEGRAM_BOT_TOKEN not found in env or $ENV_FILE" >&2
  exit 1
fi

http_code=$(curl -sS --max-time 15 -o /dev/null -w "%{http_code}" \
  -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${CHAT_ID}" \
  --data-urlencode "text=${MESSAGE}" \
  -d "parse_mode=Markdown" 2>/dev/null || echo "000")

if [ "$http_code" = "200" ]; then
  exit 0
fi

echo "telegram-send.sh: Telegram API returned HTTP $http_code" >&2
exit 1
