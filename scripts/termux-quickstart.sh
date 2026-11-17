#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODE="http"
PORT="${REA_MCP_PORT:-8765}"
WITH_BROWSER="${REA_TERMUX_BROWSER:-0}"

usage() {
  cat <<'EOF'
Usage: scripts/termux-quickstart.sh [options]

Install the Termux build prerequisites, build REA, and start its MCP server.

Options:
  --http            Start MCP over streamable HTTP (default).
  --stdio           Start MCP over stdio for a client that launches it.
  --build-only      Build REA and exit; do not start MCP.
  --port <port>     HTTP port (default: 8765; also REA_MCP_PORT).
  --browser         Also install x11-repo and Chromium for browser scenarios.
  --no-browser      Do not install Chromium (default).
  -h, --help        Show this help.

Environment:
  REA_MCP_PORT             Default HTTP port.
  REA_TERMUX_BROWSER=1     Same as --browser.
  REA_TERMUX_SKIP_PACKAGES=1
                           Skip pkg update/install; reuse installed packages.
  REA_TERMUX_SKIP_INSTALL=1
                           Skip npm ci; reuse node_modules.
  REA_TERMUX_SKIP_BUILD=1  Skip build:termux; reuse dist.

Run this from the REA checkout inside Termux. The HTTP endpoint binds to
127.0.0.1 so it is reachable by apps on the same Android device, not the LAN.
EOF
}

fail() {
  printf 'REA Termux quick-start failed: %s\n' "$1" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --http)
      MODE="http"
      shift
      ;;
    --stdio)
      MODE="stdio"
      shift
      ;;
    --build-only)
      MODE="build-only"
      shift
      ;;
    --port)
      (($# >= 2)) || fail "--port requires a value"
      PORT="$2"
      shift 2
      ;;
    --browser)
      WITH_BROWSER="1"
      shift
      ;;
    --no-browser)
      WITH_BROWSER="0"
      shift
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

cd "$REPO_ROOT"
[ -f package.json ] || fail "package.json not found in $REPO_ROOT"
grep -q '"name": "rea-agents"' package.json ||
  fail "$REPO_ROOT does not look like a REA checkout"

if [ "${REA_TERMUX_SKIP_PACKAGES:-0}" != "1" ]; then
  printf 'Installing Termux packages (nodejs-lts, npm, git, termux-exec)...\n'
  pkg update -y
  pkg install -y nodejs-lts npm git termux-exec
fi

if [ "$WITH_BROWSER" = "1" ]; then
  printf 'Installing Chromium for REA browser scenarios...\n'
  pkg install -y x11-repo
  pkg update -y
  pkg install -y chromium
  printf 'Chromium executable: %s/bin/chromium\n' "$PREFIX"
fi

command -v node >/dev/null 2>&1 || fail "node is not installed"

# Source builds need Node's TypeScript transform. Node 26 removed the
# transform mode that this checkout's source loader uses.
if ! node -e '
  const module = require("node:module");
  if (typeof module.stripTypeScriptTypes !== "function") process.exit(1);
  module.stripTypeScriptTypes("class P { constructor(readonly value: number) {} }", {
    mode: "transform",
    sourceMap: false,
  });
'; then
  fail "Node $(node --version) cannot transform TypeScript source; install Termux nodejs-lts (Node 24)"
fi

PINNED_NODE="$(tr -d '[:space:]' < .nvmrc | sed 's/^v//')"
ACTUAL_NODE="$(node -p 'process.versions.node')"
if [ "$ACTUAL_NODE" != "$PINNED_NODE" ]; then
  printf 'Note: Termux Node is %s; this checkout pins %s. The build may still work, but the repository CI uses the pinned release.\n' \
    "$ACTUAL_NODE" "$PINNED_NODE" >&2
fi

# Keep npm at the repository's pinned version without changing the global
# Termux installation.
PINNED_NPM="$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).packageManager')"
[ -n "$PINNED_NPM" ] || fail "packageManager is missing from package.json"
TOOLCHAIN="${XDG_CACHE_HOME:-$HOME/.cache}/rea-termux-toolchain"
PINNED_NPM_VERSION="${PINNED_NPM#npm@}"
INSTALLED_NPM_VERSION="$("$TOOLCHAIN/node_modules/.bin/npm" --version 2>/dev/null || true)"
if [ "$INSTALLED_NPM_VERSION" != "$PINNED_NPM_VERSION" ]; then
  printf 'Installing pinned npm (%s) into %s...\n' "$PINNED_NPM" "$TOOLCHAIN"
  npm install \
    --prefix "$TOOLCHAIN" \
    --no-package-lock \
    --no-audit \
    --no-fund \
    --ignore-scripts \
    "$PINNED_NPM"
fi
export PATH="$TOOLCHAIN/node_modules/.bin:$PATH"
[ "$(npm --version)" = "$PINNED_NPM_VERSION" ] ||
  fail "pinned npm installation did not produce npm $PINNED_NPM_VERSION"

# npm can omit optional native packages on Android. The runtime bundler imports
# rolldown, so install its exact Android binding when npm ci left it behind.
ensure_rolldown_android_binding() {
  [ "$(node -p 'process.platform')" = "android" ] || return 0

  local arch binding_package binding_file binding_dir rolldown_version termux_npm
  arch="$(node -p 'process.arch')"
  case "$arch" in
    arm64)
      binding_package="@rolldown/binding-android-arm64"
      binding_file="rolldown-binding.android-arm64.node"
      ;;
    arm)
      binding_package="@rolldown/binding-android-arm-eabi"
      binding_file="rolldown-binding.android-arm-eabi.node"
      ;;
    *)
      fail "unsupported Android architecture for rolldown: $arch"
      ;;
  esac

  binding_dir="node_modules/@rolldown/${binding_package##*/}"
  [ -f "$binding_dir/$binding_file" ] && return 0

  rolldown_version="$(node -p 'require("./node_modules/rolldown/package.json").version')" ||
    fail "could not read the installed rolldown version"

  # Use Termux's npm for this repair; the pinned npm can skip the optional
  # package during npm ci, which is the omission being repaired here.
  termux_npm="${PREFIX%/}/bin/npm"
  [ -x "$termux_npm" ] || fail "Termux npm is missing: $termux_npm"

  # Remove a partial install so npm reifies the package instead of assuming
  # the missing binary is already present.
  rm -rf -- "$binding_dir"
  printf 'Installing %s@%s (missing Android binding)...\n' \
    "$binding_package" "$rolldown_version"
  "$termux_npm" install \
    --no-save \
    --package-lock=false \
    --ignore-scripts \
    --include=optional \
    "${binding_package}@${rolldown_version}" ||
    fail "could not install $binding_package@$rolldown_version"

  [ -f "$binding_dir/$binding_file" ] ||
    fail "npm completed without installing $binding_dir/$binding_file"
}

if [ "${REA_TERMUX_SKIP_INSTALL:-0}" != "1" ]; then
  HUSKY=0 npm ci
fi

if [ "${REA_TERMUX_SKIP_BUILD:-0}" != "1" ]; then
  ensure_rolldown_android_binding
  npm run build:termux
fi

if [ "$MODE" = "build-only" ]; then
  printf 'Build complete. Install the supervised MCP service with:\n  %s/scripts/termux-service.sh\n' "$REPO_ROOT"
  exit 0
fi

if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock 2>/dev/null || true
  trap 'termux-wake-unlock 2>/dev/null || true' EXIT
fi

if [ "$MODE" = "stdio" ]; then
  printf 'Starting REA MCP over stdio...\n' >&2
  node scripts/rea.mjs mcp
else
  printf 'Starting REA MCP over HTTP at http://127.0.0.1:%s/mcp\n' "$PORT"
  node scripts/rea.mjs mcp --http --port "$PORT"
fi
