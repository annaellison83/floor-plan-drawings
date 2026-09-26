#!/bin/sh
set -eu

CONFIG="${FPD_BRIDGE_CONFIG:-$HOME/.config/floorplandrawings/mac-bridge.env}"
if [ ! -f "$CONFIG" ]; then
  echo "FPD bridge is not configured: $CONFIG is missing" >&2
  exit 78
fi

# shellcheck disable=SC1090
. "$CONFIG"
: "${FPD_INGEST_URL:?FPD_INGEST_URL is required}"
: "${FPD_INGEST_TOKEN:?FPD_INGEST_TOKEN is required}"

# Values loaded from a shell config are not exported automatically. The
# Python process must receive the URL/token (and the line identity) through
# its environment when launchd starts this wrapper.
: "${BUSINESS_PHONE_NUMBER:=+12134357223}"
export BUSINESS_PHONE_NUMBER FPD_INGEST_URL FPD_INGEST_TOKEN

[ -z "${FPD_HEARTBEAT_URL:-}" ] || export FPD_HEARTBEAT_URL
[ -z "${FPD_BRIDGE_ID:-}" ] || export FPD_BRIDGE_ID
[ -z "${FPD_BRIDGE_INTERVAL_SECONDS:-}" ] || export FPD_BRIDGE_INTERVAL_SECONDS
[ -z "${FPD_MESSAGES_DB:-}" ] || export FPD_MESSAGES_DB
[ -z "${FPD_BRIDGE_STATE_PATH:-}" ] || export FPD_BRIDGE_STATE_PATH

exec /usr/bin/python3 "$HOME/fpd-bridge/fpd_bridge.py" --watch --apply
