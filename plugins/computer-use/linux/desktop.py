"""Supervise a private authenticated Xvfb desktop inside its own session bus.

Display/WM failures create a new generation. No task or application action is
replayed. This separates desktops, not OS accounts or filesystem permissions.
"""
import fcntl
import json
import os
from pathlib import Path
import secrets
import signal
import stat
import struct
import subprocess
import sys
import time
import uuid


def birth(pid):
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def state(directory):
    try:
        info = (directory / "state.json").lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise RuntimeError("Desktop state must be a private regular file owned by this user.")
        value = json.loads((directory / "state.json").read_text())
        value["alive"] = birth(value["pid"]) == value["birth"] and value["birth"] is not None
        return value
    except FileNotFoundError:
        return {"alive": False, "state": "stopped"}


def write_state(directory, value):
    temp = directory / f"state-{uuid.uuid4().hex}.tmp"
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(value, output)
    os.replace(temp, directory / "state.json")


def supervise(directory):
    lock = os.open(directory / "supervisor.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    running = True
    children = []

    def stop(*_args):
        nonlocal running
        running = False

    def cleanup():
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
        children.clear()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    candidates = [number for number in range(100, 900)
                  if not Path(f"/tmp/.X11-unix/X{number}").exists() and not Path(f"/tmp/.X{number}-lock").exists()]
    if not candidates:
        raise RuntimeError("No unused private display number is available.")
    display = secrets.choice(candidates)
    authority = directory / "Xauthority"
    cookie = secrets.token_bytes(16)
    fields = [b"", str(display).encode(), b"MIT-MAGIC-COOKIE-1", cookie]
    data = struct.pack(">H", 65535) + b"".join(struct.pack(">H", len(part)) + part for part in fields)
    fd = os.open(authority, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(data)
    environment = {**os.environ, "DISPLAY": f":{display}", "XAUTHORITY": str(authority), "XDG_SESSION_TYPE": "x11",
                   "NO_AT_BRIDGE": "0", "GTK_MODULES": "gail:atk-bridge", "DSCODE_DESKTOP_STATE": str(directory / "state.json"),
                   "DSCODE_DESKTOP_SESSION": str(directory), "WAYLAND_DISPLAY": "", "QT_LINUX_ACCESSIBILITY_ALWAYS_ON": "1",
                   "XDG_CONFIG_HOME": str(directory / "config"), "XDG_CACHE_HOME": str(directory / "cache")}
    base = {"pid": os.getpid(), "birth": birth(os.getpid()), "display": f":{display}",
            "env": {key: environment[key] for key in ["DISPLAY", "XAUTHORITY", "XDG_SESSION_TYPE", "DBUS_SESSION_BUS_ADDRESS", "DSCODE_DESKTOP_STATE", "DSCODE_DESKTOP_SESSION", "NO_AT_BRIDGE", "GTK_MODULES", "WAYLAND_DISPLAY", "QT_LINUX_ACCESSIBILITY_ALWAYS_ON", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]}}
    # This is the dedicated bus/configuration, never the person's desktop bus.
    try:
        from gi.repository import Gio, GLib
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        for key in ["IsEnabled", "ScreenReaderEnabled"]:
            bus.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.freedesktop.DBus.Properties", "Set",
                GLib.Variant("(ssv)", ("org.a11y.Status", key, GLib.Variant("b", True))), None, Gio.DBusCallFlags.NONE, 3000, None)
    except Exception as error:
        print(f"Dedicated accessibility setup unavailable: {error}", file=sys.stderr, flush=True)
    failures = 0
    try:
        while running:
            generation = uuid.uuid4().hex
            write_state(directory, {**base, "state": "starting", "generation": generation})
            try:
                xvfb = subprocess.Popen(["Xvfb", f":{display}", "-screen", "0", "1600x1000x24", "-nolisten", "tcp", "-auth", str(authority)], env=environment)
                children.append(xvfb)
                for _ in range(50):
                    if not running or xvfb.poll() is not None:
                        raise RuntimeError("Private X server did not start.")
                    check = subprocess.run(["xdpyinfo"], env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
                    if check.returncode == 0:
                        break
                    time.sleep(0.1)
                else:
                    raise RuntimeError("Private X server failed its authenticated readiness check.")
                wm = subprocess.Popen(["openbox"], env=environment)
                children.append(wm)
                while running and all(child.poll() is None for child in children):
                    write_state(directory, {**base, "state": "ready", "generation": generation, "updatedAt": time.time(), "xvfbPid": xvfb.pid, "wmPid": wm.pid})
                    time.sleep(0.5)
                if not running:
                    break
                raise RuntimeError("Display or window manager exited; applications must be reobserved.")
            except Exception as error:
                failures += 1
                write_state(directory, {**base, "state": "recovering", "generation": generation, "error": str(error)})
                cleanup()
                for _ in range(min(100, 5 * failures)):
                    if not running:
                        break
                    time.sleep(0.1)
    finally:
        cleanup()
        write_state(directory, {**base, "state": "stopped", "generation": uuid.uuid4().hex})
        os.close(lock)


def main():
    command, directory = sys.argv[1], Path(sys.argv[2]).resolve()
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError("Desktop directory must be private and owned by this user.")
    if command == "run":
        supervise(directory)
    elif command == "status":
        print(json.dumps(state(directory)))
    elif command == "stop":
        value = state(directory)
        if value.get("alive"):
            os.kill(value["pid"], signal.SIGTERM)
        print(json.dumps({"stopping": bool(value.get("alive"))}))
    else:
        raise RuntimeError("Unknown desktop supervisor command.")


if __name__ == "__main__":
    main()
