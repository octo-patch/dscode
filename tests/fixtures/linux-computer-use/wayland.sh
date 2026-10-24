#!/bin/sh
# Disposable headless KDE session. No host display/socket or input devices.
set -eu
if [ ! -d /dev/dri ]; then
  echo 'Wayland compositor qualification needs a DRM render device (/dev/dri). Use the PipeWire source fixture without a GPU.' >&2
  exit 77
fi
if [ "${DSCODE_WAYLAND_SESSION:-}" != 1 ]; then
  export XDG_RUNTIME_DIR
  XDG_RUNTIME_DIR=$(mktemp -d /tmp/dscode-wayland-XXXXXX)
  chmod 700 "$XDG_RUNTIME_DIR"
  export XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=KDE WAYLAND_DISPLAY=wayland-dscode
  export QT_QPA_PLATFORM=wayland GDK_BACKEND=wayland QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1
  export LIBGL_ALWAYS_SOFTWARE=1 PYTHONDONTWRITEBYTECODE=1 DSCODE_WAYLAND_SESSION=1 DSCODE_WAYLAND_FIXTURE=1
  unset DISPLAY
  exec dbus-run-session -- sh "$0"
fi
pipewire >/tmp/dscode-pipewire.log 2>&1 & pipewire_pid=$!
wireplumber >/tmp/dscode-wireplumber.log 2>&1 & wireplumber_pid=$!
kwin_wayland --virtual --width 1280 --height 800 --socket "$WAYLAND_DISPLAY" --no-lockscreen >/tmp/dscode-kwin.log 2>&1 & kwin_pid=$!
trap 'kill "$kwin_pid" "$wireplumber_pid" "$pipewire_pid" 2>/dev/null || true' EXIT
i=0
while [ ! -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]; do
  i=$((i + 1)); [ "$i" -lt 100 ] || { cat /tmp/dscode-kwin.log; exit 1; }
  sleep 0.1
done
dbus-update-activation-environment WAYLAND_DISPLAY XDG_CURRENT_DESKTOP XDG_SESSION_TYPE XDG_RUNTIME_DIR QT_QPA_PLATFORM
/usr/libexec/xdg-desktop-portal >/tmp/dscode-portal.log 2>&1 &
sleep 2
/usr/bin/python3 /work/tests/fixtures/linux-computer-use/wayland_probe.py || {
  cat /tmp/dscode-kwin.log /tmp/dscode-portal.log
  exit 1
}
