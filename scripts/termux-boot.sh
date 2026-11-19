#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
SERVICE="rea-mcp"

usage() {
  cat <<'EOF'
Usage: scripts/termux-boot.sh

Install ~/.termux/boot/rea-mcp.sh so Termux:Boot starts termux-services and
the enabled REA MCP service after Android boots.

Prerequisites:
  Install the Termux:Boot app, open it once, and disable battery optimization
  for Termux and Termux:Boot in Android settings.
  Install and enable the service first: ./scripts/termux-service.sh
EOF
}

fail() {
  printf 'REA Termux boot installation failed: %s\n' "$1" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1 (try --help)"
      ;;
  esac
done

if [ -z "${PREFIX:-}" ] || ! command -v pkg >/dev/null 2>&1; then
  fail "run this inside Termux (PREFIX and pkg are required)"
fi
PREFIX="${PREFIX%/}"

[ -r "$PREFIX/etc/profile.d/start-services.sh" ] ||
  [ -r "$PREFIX/etc/profile" ] ||
  fail "termux-services is not installed; run 'pkg install termux-services' first"

SERVICE_DIR="$PREFIX/var/service/$SERVICE"
[ -f "$SERVICE_DIR/run" ] ||
  fail "the REA MCP service is not installed; run ./scripts/termux-service.sh first"
[ ! -f "$SERVICE_DIR/down" ] ||
  fail "the REA MCP service is disabled; run 'sv-enable $SERVICE' first"

SOURCE="$REPO_ROOT/scripts/termux-boot/$SERVICE.sh"
[ -f "$SOURCE" ] || fail "boot script is missing: $SOURCE"

BOOT_DIR="${HOME%/}/.termux/boot"
BOOT_SCRIPT="$BOOT_DIR/$SERVICE.sh"
mkdir -p "$BOOT_DIR"

TEMPORARY="$BOOT_SCRIPT.tmp.$$"
cp "$SOURCE" "$TEMPORARY"
chmod 755 "$TEMPORARY"
if [ -f "$BOOT_SCRIPT" ] && ! cmp -s "$TEMPORARY" "$BOOT_SCRIPT"; then
  cp -p "$BOOT_SCRIPT" "$BOOT_SCRIPT.bak"
fi
mv -f "$TEMPORARY" "$BOOT_SCRIPT"

printf 'Installed the REA MCP Termux:Boot script.\n'
printf '  Script: %s\n' "$BOOT_SCRIPT"
printf '  Starts: termux-services, then the enabled %s unit\n' "$SERVICE"
printf '  Logs:   %s/var/log/sv/%s/current\n' "$PREFIX" "$SERVICE"
printf '  Boot:   %s/var/log/rea-mcp-boot.log\n' "$PREFIX"
printf '\nInstall Termux:Boot, open it once, and disable battery optimization for\n'
printf 'Termux and Termux:Boot. Android must be unlocked once after a reboot\n'
printf 'before the Termux environment can start.\n'
