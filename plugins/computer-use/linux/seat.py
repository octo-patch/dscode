"""Per-user, per-desktop kernel lease. Never unlink an active lock inode."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import re
import time
import uuid


class SeatError(RuntimeError):
    code = "COMPUTER_DESKTOP_BUSY"


class Seat:
    def __init__(self):
        base = Path("/tmp") / f"dscode-computer-{os.getuid()}"
        base.mkdir(mode=0o700, exist_ok=True)
        info = base.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise SeatError("Desktop lease directory must be private and owned by this user.")
        if os.environ.get("WAYLAND_DISPLAY"):
            identity = ["wayland", str((Path(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")) / os.environ["WAYLAND_DISPLAY"]).resolve())]
        else:
            display = re.sub(r"\.\d+$", "", os.environ.get("DISPLAY", ""))
            display = re.sub(r"^(?:unix/|localhost|unix)(?=:)", "", display)
            identity = ["x11", display] if display else ["bus", os.environ.get("DBUS_SESSION_BUS_ADDRESS", "")]
        key = hashlib.sha256(json.dumps(identity).encode()).hexdigest()[:24]
        self.path, self.pause_path = base / f"{key}.lock", base / f"{key}.paused"
        self.fd = None
        self.token = None
        self.owner = None
        self.expires = 0

    def status(self):
        self.expire()
        return {"paused": self.pause_path.exists(), "owned": self.fd is not None,
                "owner": self.owner, "remainingMs": max(0, round((self.expires - time.monotonic()) * 1000)) if self.fd else 0}

    def expire(self):
        if self.fd is not None and (time.monotonic() >= self.expires or self.pause_path.exists()):
            self.release()

    def acquire(self, owner, token=None, ttl_ms=60000):
        self.expire()
        if self.pause_path.exists():
            raise SeatError("Desktop control is paused by a person. Use /computer resume after taking over.")
        if not isinstance(owner, str) or not owner or len(owner) > 200 or not 1000 <= ttl_ms <= 60000:
            raise SeatError("Invalid desktop lease owner or duration (1–60 seconds).")
        if self.fd is not None:
            if token != self.token or owner != self.owner:
                raise SeatError("Another agent holds this desktop. Read-only tools remain available.")
        else:
            fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                os.close(fd)
                raise SeatError("Desktop lock must be a private regular file owned by this user.")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                os.close(fd)
                raise SeatError("Another Host holds this desktop. Read-only tools remain available.")
            self.fd, self.token, self.owner = fd, uuid.uuid4().hex, owner
        self.expires = time.monotonic() + ttl_ms / 1000
        return {**self.status(), "token": self.token}

    def check(self, token):
        self.expire()
        if not token or self.fd is None or token != self.token:
            raise SeatError("Desktop lease expired, was revoked, or belongs to another agent. Reobserve before continuing.")

    def release(self, token=None):
        if self.fd is not None and token is not None and token != self.token:
            raise SeatError("Desktop lease does not belong to this caller.")
        if self.fd is not None:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
        self.fd = self.token = self.owner = None
        self.expires = 0

    def pause(self, enabled):
        if enabled:
            fd = os.open(self.pause_path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            os.close(fd)
            self.release()
        else:
            self.pause_path.unlink(missing_ok=True)
        return self.status()
