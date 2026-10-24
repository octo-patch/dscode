#!/bin/sh
set -eu
if [ "${DSCODE_PIPEWIRE_SESSION:-}" != 1 ]; then
  export XDG_RUNTIME_DIR
  XDG_RUNTIME_DIR=$(mktemp -d /tmp/dscode-pipewire-XXXXXX)
  chmod 700 "$XDG_RUNTIME_DIR"
  export PYTHONDONTWRITEBYTECODE=1 DSCODE_PIPEWIRE_SESSION=1
  exec dbus-run-session -- sh "$0"
fi
pipewire >/tmp/dscode-pipewire.log 2>&1 & pipewire_pid=$!
wireplumber >/tmp/dscode-wireplumber.log 2>&1 & wireplumber_pid=$!
trap 'kill "$wireplumber_pid" "$pipewire_pid" 2>/dev/null || true' EXIT
sleep 1
/usr/bin/python3 /work/tests/fixtures/linux-computer-use/pipewire_test.py
