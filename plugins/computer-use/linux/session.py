"""Read-only login/session liveness; unknown is distinct from unlocked."""
import os
import time
import json
from pathlib import Path


class SessionMonitor:
    def __init__(self):
        self.last = 0
        self.value = {"locked": None, "active": None, "source": "unavailable"}

    def read(self):
        if os.environ.get("DSCODE_DESKTOP_SESSION"):
            try:
                state = json.loads(Path(os.environ["DSCODE_DESKTOP_STATE"]).read_text())
                process = Path(f'/proc/{state["pid"]}/stat').read_text().rsplit(") ", 1)[1].split()[19]
                active = state["state"] == "ready" and process == state["birth"]
                return {"locked": False, "active": active, "source": "dedicated-desktop", "id": state["generation"]}
            except Exception:
                return {"locked": None, "active": False, "source": "dedicated-desktop-unavailable"}
        if time.monotonic() - self.last < 1:
            return self.value
        self.last = time.monotonic()
        try:
            from gi.repository import Gio, GLib
            bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
            path = bus.call_sync("org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager",
                                 "GetSessionByPID", GLib.Variant("(u)", (os.getpid(),)), None, Gio.DBusCallFlags.NONE, 250, None).unpack()[0]
            props = bus.call_sync("org.freedesktop.login1", path, "org.freedesktop.DBus.Properties", "GetAll",
                                  GLib.Variant("(s)", ("org.freedesktop.login1.Session",)), None, Gio.DBusCallFlags.NONE, 250, None).unpack()[0]
            self.value = {"locked": props.get("LockedHint"), "active": props.get("Active"), "source": "logind", "id": props.get("Id")}
        except Exception:
            self.value = {"locked": None, "active": None, "source": "unavailable"}
        return self.value
