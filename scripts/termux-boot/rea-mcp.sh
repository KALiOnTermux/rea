#!/data/data/com.termux/files/usr/bin/sh
set -e

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
export PREFIX
PATH="$PREFIX/bin:$PATH"
export PATH

# Keep Android from suspending Termux while the service daemon starts.
termux-wake-lock 2>/dev/null || true

# Termux:Boot runs headlessly, so the interactive profile is not sourced.
# Start termux-services explicitly; it starts every enabled runit unit.
if [ -r "$PREFIX/etc/profile.d/start-services.sh" ]; then
  . "$PREFIX/etc/profile.d/start-services.sh"
elif [ -r "$PREFIX/etc/profile" ]; then
  . "$PREFIX/etc/profile"
else
  printf 'termux-services startup script is missing under %s/etc\n' "$PREFIX" >&2
  exit 1
fi
