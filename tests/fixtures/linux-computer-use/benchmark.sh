#!/bin/sh
set -eu
export PYTHONDONTWRITEBYTECODE=1
Xvfb :97 -screen 0 1600x1000x24 -nolisten tcp &
xvfb_pid=$!
trap 'kill "$xvfb_pid" 2>/dev/null || true' EXIT
sleep 1
dbus-run-session -- sh -c 'openbox >/tmp/dscode-openbox.log 2>&1 & /usr/bin/python3 /work/tests/fixtures/linux-computer-use/benchmark.py'
