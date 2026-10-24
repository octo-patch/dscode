#!/bin/sh
# Disposable Docker fixture only: writable source/dependencies never touch /work.
set -eu
fixture_root=$(mktemp -d /tmp/dscode-linux-source-XXXXXX)
for part in bin presets plugins scripts packages tests docs package.json package-lock.json README.md README.zh-CN.md; do
  cp -a "/work/$part" "$fixture_root/"
done
mkdir "$fixture_root/config"
for file in /work/config/*; do
  case "$file" in *.local.*) continue ;; esac
  cp -a "$file" "$fixture_root/config/"
done
cd "$fixture_root"
npm ci --cache /tmp/dscode-npm-cache --ignore-scripts --no-audit --no-fund
Xvfb :97 -screen 0 1280x800x24 -nolisten tcp &
xvfb_pid=$!
trap 'kill "$xvfb_pid" 2>/dev/null || true' EXIT
sleep 1
export PYTHONDONTWRITEBYTECODE=1
dbus-run-session -- sh -c 'openbox >/tmp/dscode-openbox.log 2>&1 & node scripts/verify-linux-computer-use.mjs'
node scripts/verify-linux-desktop-server.mjs
