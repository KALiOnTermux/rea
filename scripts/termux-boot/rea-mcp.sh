#!/data/data/com.termux/files/usr/bin/sh
set -eu

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
export PREFIX
PATH="$PREFIX/bin:$PATH"
export PATH

SERVICE="rea-mcp"
BOOT_LOG="$PREFIX/var/log/rea-mcp-boot.log"
SERVICE_LOG="$PREFIX/var/log/sv/$SERVICE/current"
WAIT_SECONDS="${REA_MCP_BOOT_WAIT_SECONDS:-30}"
case "$WAIT_SECONDS" in
  '' | *[!0-9]*) WAIT_SECONDS=30 ;;
esac

log_boot() {
  mkdir -p "$PREFIX/var/log" 2>/dev/null || true
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >> "$BOOT_LOG" 2>/dev/null || true
}

log_boot 'boot hook started'

# Keep Android from suspending Termux while the service daemon starts.
termux-wake-lock 2>/dev/null || true

# Termux:Boot runs headlessly, so the interactive profile is not sourced.
# Start termux-services explicitly; it starts every enabled runit unit.
if [ -r "$PREFIX/etc/profile.d/start-services.sh" ]; then
  . "$PREFIX/etc/profile.d/start-services.sh"
elif [ -r "$PREFIX/etc/profile" ]; then
  . "$PREFIX/etc/profile"
else
  log_boot "termux-services startup script is missing under $PREFIX/etc"
  printf 'termux-services startup script is missing under %s/etc\n' "$PREFIX" >&2
  exit 1
fi

if ! command -v sv >/dev/null 2>&1; then
  log_boot 'sv is unavailable after termux-services startup'
  exit 1
fi

log_boot "termux-services started; waiting up to ${WAIT_SECONDS}s for $SERVICE"

attempt=0
while [ "$attempt" -lt "$WAIT_SECONDS" ]; do
  if sv status "$SERVICE" 2>/dev/null | grep -q '^run:'; then
    log_boot "$SERVICE is running"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done

log_boot "$SERVICE did not reach run state within ${WAIT_SECONDS}s; see $SERVICE_LOG"
if [ -r "$SERVICE_LOG" ]; then
  tail -n 20 "$SERVICE_LOG" >> "$BOOT_LOG" 2>/dev/null || true
fi
exit 1
