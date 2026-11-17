#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
SERVICE="rea-mcp"
PORT="${REA_MCP_PORT:-8765}"

usage() {
  cat <<'EOF'
Usage: scripts/termux-service.sh [options]

Install a termux-services unit that supervises the REA HTTP MCP server and
restarts it whenever the node process exits.

Prerequisites:
  pkg install termux-services
  restart Termux so the service daemon is running
  build REA first: ./scripts/termux-quickstart.sh --build-only

Options:
  --port <port>   HTTP port (default: 8765; also REA_MCP_PORT).
  -h, --help      Show this help.

Service commands after installation:
  sv status rea-mcp
  sv restart rea-mcp
  sv down rea-mcp
  sv-disable rea-mcp
  tail -f $PREFIX/var/log/sv/rea-mcp/current
EOF
}

fail() {
  printf 'REA Termux service installation failed: %s\n' "$1" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --port)
      (($# >= 2)) || fail "--port requires a value"
      PORT="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1 (try --help)"
      ;;
  esac
done

case "$PORT" in
  '' | *[!0-9]*) fail "port must be a decimal integer" ;;
esac
PORT=$((10#$PORT))
if ((PORT < 1 || PORT > 65535)); then
  fail "port must be between 1 and 65535"
fi

if [ -z "${PREFIX:-}" ] || ! command -v pkg >/dev/null 2>&1; then
  fail "run this inside Termux (PREFIX and pkg are required)"
fi
PREFIX="${PREFIX%/}"

command -v sv >/dev/null 2>&1 ||
  fail "termux-services is not installed; run 'pkg install termux-services', restart Termux, then retry"
command -v sv-enable >/dev/null 2>&1 ||
  fail "sv-enable is not installed; run 'pkg install termux-services', restart Termux, then retry"
[ -x "$PREFIX/share/termux-services/svlogger" ] ||
  fail "svlogger is missing; run 'pkg install termux-services', restart Termux, then retry"

cd "$REPO_ROOT"
[ -f package.json ] || fail "package.json not found in $REPO_ROOT"
grep -q '"name": "rea-agents"' package.json ||
  fail "$REPO_ROOT does not look like a REA checkout"
[ -f dist/mcp/main.js ] ||
  fail "compiled runtime is missing; run ./scripts/termux-quickstart.sh --build-only first"

UNIT_DIR="$REPO_ROOT/scripts/termux-service/$SERVICE"
[ -f "$UNIT_DIR/run" ] || fail "service run script is missing: $UNIT_DIR/run"
[ -f "$UNIT_DIR/log/run" ] || fail "service log script is missing: $UNIT_DIR/log/run"

NODE_BIN="$(command -v node)"
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || fail "node is not installed or is not executable"

SVDIR="${SVDIR:-$PREFIX/var/service}"
LOGDIR="${LOGDIR:-$PREFIX/var/log}"
export SVDIR LOGDIR
SERVICE_DIR="$SVDIR/$SERVICE"
SERVICE_LOG="$LOGDIR/sv/$SERVICE/current"

[ ! -L "$SERVICE_DIR" ] ||
  fail "$SERVICE_DIR is a symlink; remove it before installing the service"

port_in_use() {
  node -e '
    const net = require("node:net");
    const socket = net.createConnection({
      host: "127.0.0.1",
      port: Number(process.argv[1]),
    });
    const finish = (inUse) => {
      socket.destroy();
      process.exit(inUse ? 0 : 1);
    };
    socket.setTimeout(750, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  ' "$1" >/dev/null 2>&1
}

was_running=false
if sv status "$SERVICE" 2>/dev/null | grep -q '^run:'; then
  was_running=true
fi
if [ "$was_running" = false ] && port_in_use "$PORT"; then
  fail "port $PORT is already in use; stop the foreground server before installing the service"
fi

mkdir -p "$SERVICE_DIR/log"

install_unit_file() {
  local source="$1"
  local target="$2"
  local temporary="$target.tmp.$$"

  [ ! -d "$target" ] || fail "$target is a directory; remove it before installing the service"
  cp "$source" "$temporary"
  chmod 755 "$temporary"
  if [ -f "$target" ] && ! cmp -s "$temporary" "$target"; then
    cp -p "$target" "$target.bak"
  fi
  mv -f "$temporary" "$target"
}

install_unit_file "$UNIT_DIR/run" "$SERVICE_DIR/run"
install_unit_file "$UNIT_DIR/log/run" "$SERVICE_DIR/log/run"

mkdir -p "$PREFIX/etc"
ENV_FILE="$PREFIX/etc/rea-mcp.env"
ENV_TEMPORARY="$PREFIX/etc/.rea-mcp.env.$$"
{
  printf 'REA_ROOT=%q\n' "$REPO_ROOT"
  printf 'NODE_BIN=%q\n' "$NODE_BIN"
  printf 'REA_MCP_PORT=%q\n' "$PORT"
} > "$ENV_TEMPORARY"
chmod 600 "$ENV_TEMPORARY"
if [ -f "$ENV_FILE" ] && ! cmp -s "$ENV_TEMPORARY" "$ENV_FILE"; then
  cp -p "$ENV_FILE" "$ENV_FILE.bak"
fi
mv -f "$ENV_TEMPORARY" "$ENV_FILE"

# runsvdir polls its service directory; give it a moment to notice a new unit.
if ! sv status "$SERVICE" >/dev/null 2>&1; then
  for _ in 1 2 3 4 5; do
    sleep 1
    sv status "$SERVICE" >/dev/null 2>&1 && break
  done
fi

# Always call sv-enable so a previously disabled unit loses its down file.
sv-enable "$SERVICE" ||
  fail "the unit is installed but could not be enabled; restart Termux and run this installer again"
if [ "$was_running" = true ]; then
  sv restart "$SERVICE" || fail "the unit is installed but could not be restarted"
else
  sv up "$SERVICE" ||
    fail "the unit is installed but could not be started; check $SERVICE_LOG"
fi

started=false
for _ in 1 2 3 4 5; do
  if sv status "$SERVICE" 2>/dev/null | grep -q '^run:'; then
    started=true
    break
  fi
  sleep 1
done

if [ "$started" = false ]; then
  if [ -r "$SERVICE_LOG" ]; then
    tail -n 20 "$SERVICE_LOG" >&2 || true
  fi
  fail "the service did not stay running; inspect $SERVICE_LOG"
fi

printf 'Installed and enabled the REA MCP service.\n'
printf '  Service: %s\n' "$SERVICE"
printf '  Root:    %s\n' "$REPO_ROOT"
printf '  Node:    %s\n' "$NODE_BIN"
printf '  Port:    %s\n' "$PORT"
printf '  Logs:    %s\n' "$SERVICE_LOG"
printf '  Status:  '
sv status "$SERVICE" || true
