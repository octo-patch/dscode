"""Wayland Portal keyboard, stream-local pointer input and latest-frame capture.

Coordinate input requires an authorized stream with logical dimensions.
No uinput/root fallback and no automatic retries after dispatched input.
"""
import json
import os
import re
import stat
import struct
import math
import uuid
from pathlib import Path
from urllib.parse import unquote, urlparse
from gi.repository import Gio, GLib, GdkPixbuf

BUS = "org.freedesktop.portal.Desktop"
ROOT = "/org/freedesktop/portal/desktop"
REMOTE = "org.freedesktop.portal.RemoteDesktop"
SCREENCAST = "org.freedesktop.portal.ScreenCast"


class Portal:
    def __init__(self):
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.session = None
        self.subscription = None
        self.down = []
        self.buttons = []
        self.streams = {}
        self.captures = {}
        self.devices = 0
        state = os.environ.get("DSCODE_LINUX_COMPUTER_STATE")
        self.token_file = Path(state) / "portal.json" if state else Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state"))) / "dscode/computer-use/portal.json"

    def call(self, interface, method, args, path=ROOT):
        return self.bus.call_sync(BUS, path, interface, method, args, None, Gio.DBusCallFlags.NONE, 5000, None).unpack()

    def version(self, interface):
        try:
            return self.call("org.freedesktop.DBus.Properties", "Get", GLib.Variant("(ss)", (interface, "version")))[0]
        except GLib.Error:
            return 0

    def accessibility_status(self):
        try:
            return self.bus.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.freedesktop.DBus.Properties", "GetAll",
                GLib.Variant("(s)", ("org.a11y.Status",)), None, Gio.DBusCallFlags.NONE, 1000, None).unpack()[0]
        except GLib.Error:
            return {}

    def capabilities(self):
        remote = self.version(REMOTE)
        screenshot = self.version("org.freedesktop.portal.Screenshot")
        dimensions = [props.get("logical_size", props.get("size")) for props in self.streams.values()]
        mapped = any(size and len(size) == 2 and all(isinstance(n, (int, float)) and math.isfinite(n) and n > 0 for n in size) for size in dimensions)
        return {"available": bool(remote or screenshot), "input": bool(remote), "screenshot": bool(screenshot),
                "remoteDesktopVersion": remote, "connected": bool(self.session), "coordinateInput": bool(self.session and self.devices & 2 and mapped),
                "streams": [{"id": key, **value} for key, value in self.streams.items()],
                "restoreSupported": remote >= 2}

    def request(self, interface, method, signature, args, options):
        token = "dscode_" + uuid.uuid4().hex
        sender = self.bus.get_unique_name()[1:].replace(".", "_")
        path = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"
        options = {**options, "handle_token": GLib.Variant("s", token)}
        loop, result = GLib.MainLoop(), {}

        def response(_bus, _sender, _path, _interface, _signal, parameters, _data):
            result["value"] = parameters.unpack()
            loop.quit()

        subscription = self.bus.signal_subscribe(BUS, "org.freedesktop.portal.Request", "Response", path, None, Gio.DBusSignalFlags.NONE, response, None)

        def timeout():
            result["timeout"] = True
            loop.quit()
            return False

        timer = GLib.timeout_add_seconds(110, timeout)
        try:
            returned = self.call(interface, method, GLib.Variant(signature, (*args, options)))[0]
            if returned != path:
                raise RuntimeError("Portal returned an unexpected request identity.")
            if "value" not in result:
                loop.run()
            if result.get("timeout"):
                try:
                    self.call("org.freedesktop.portal.Request", "Close", None, path)
                except GLib.Error:
                    pass
                raise RuntimeError("Portal authorization timed out.")
            code, values = result["value"]
            if code != 0:
                raise RuntimeError("Portal authorization was cancelled or refused; no input was sent.")
            return values
        finally:
            self.bus.signal_unsubscribe(subscription)
            if not result.get("timeout"):
                GLib.source_remove(timer)

    def token(self):
        try:
            fd = os.open(self.token_file, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd) as source:
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                    raise RuntimeError("Portal token file must be private and owned by the current user.")
                data = source.read(8193)
                if len(data) > 8192:
                    raise RuntimeError("Portal token file is too large.")
                value = json.loads(data).get("restore_token")
                return value if isinstance(value, str) else None
        except FileNotFoundError:
            return None

    def save_token(self, token):
        self.token_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temp = self.token_file.with_name("portal-" + uuid.uuid4().hex + ".tmp")
        try:
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w") as output:
                json.dump({"restore_token": token}, output)
            os.replace(temp, self.token_file)
        finally:
            temp.unlink(missing_ok=True)

    def close(self):
        self.release_keys()
        self.release_buttons()
        for capture in self.captures.values():
            capture.close()
        self.captures.clear()
        self.streams.clear()
        self.devices = 0
        session, self.session = self.session, None
        if self.subscription:
            self.bus.signal_unsubscribe(self.subscription)
            self.subscription = None
        if session:
            try:
                self.call("org.freedesktop.portal.Session", "Close", None, session)
            except GLib.Error:
                pass

    def release_keys(self):
        down, self.down = self.down, []
        failed = False
        for key in reversed(down):
            if self.session:
                try:
                    self.call(REMOTE, "NotifyKeyboardKeysym", GLib.Variant("(oa{sv}iu)", (self.session, {}, key, 0)))
                except GLib.Error:
                    failed = True
        if failed:
            self.close()  # No keys remain in the local list; revoke the uncertain stream.

    def connect(self, desktop=False):
        if self.session and (not desktop or self.streams):
            return self.capabilities()
        if self.session:
            self.close()
        if self.subscription:
            self.bus.signal_unsubscribe(self.subscription)
            self.subscription = None
        version = self.version(REMOTE)
        if not version:
            raise RuntimeError("This desktop does not expose the RemoteDesktop Portal.")
        session = self.request(REMOTE, "CreateSession", "(a{sv})", (), {"session_handle_token": GLib.Variant("s", "dscode_" + uuid.uuid4().hex)})["session_handle"]
        self.session = session

        def closed(*_args):
            self.session = None
            self.down.clear()
            self.buttons.clear()
            self.close()

        self.subscription = self.bus.signal_subscribe(BUS, "org.freedesktop.portal.Session", "Closed", session, None, Gio.DBusSignalFlags.NONE, closed, None)
        try:
            options = {"types": GLib.Variant("u", 3 if desktop else 1)}
            if version >= 2:
                options["persist_mode"] = GLib.Variant("u", 2)
                token = self.token()
                if token:
                    options["restore_token"] = GLib.Variant("s", token)
                    self.save_token(None)  # Restore tokens are single-use even if Start fails.
            self.request(REMOTE, "SelectDevices", "(oa{sv})", (session,), options)
            if desktop:
                if not self.version(SCREENCAST):
                    raise RuntimeError("This desktop does not expose the ScreenCast Portal.")
                sources = {"types": GLib.Variant("u", 1), "multiple": GLib.Variant("b", True)}
                self.request(SCREENCAST, "SelectSources", "(oa{sv})", (session,), sources)
            result = self.request(REMOTE, "Start", "(osa{sv})", (session, ""), {})
            if not (result.get("devices", 0) & 1) or self.session != session:
                raise RuntimeError("The Portal did not grant a live keyboard session.")
            self.save_token(result.get("restore_token"))
            self.devices = result["devices"]
            self.streams = {str(node): props for node, props in result.get("streams", [])}
            if desktop and not self.streams:
                raise RuntimeError("The Portal granted no screen streams.")
            return self.capabilities()
        except Exception:
            self.close()
            raise

    def press_key(self, action):
        if not self.session:
            raise RuntimeError("Wayland keyboard input needs /computer connect first; system consent still applies in YOLO mode.")
        names = {"enter": 0xff0d, "return": 0xff0d, "tab": 0xff09, "escape": 0xff1b, "backspace": 0xff08, "delete": 0xffff,
                 "left": 0xff51, "up": 0xff52, "right": 0xff53, "down": 0xff54, "home": 0xff50, "end": 0xff57, "space": 0x20}
        key = action["key"]
        if key.lower().startswith("arrow"):
            key = key[5:]
        symbol = names.get(key.lower())
        if symbol is None and len(key) == 1 and ord(key) < 128:
            symbol = ord(key)
        if symbol is None and re.fullmatch(r"F(?:[1-9]|1[0-2])", key):
            symbol = 0xffbd + int(key[1:])
        if symbol is None:
            raise RuntimeError("Unsupported Portal key; use AT-SPI text insertion for Unicode.")
        modifiers = {"control": 0xffe3, "shift": 0xffe1, "option": 0xffe9, "command": 0xffeb}
        keys = [modifiers[m] for m in action.get("modifiers", [])] + [symbol]
        try:
            for key in keys:
                self.down.append(key)
                self.call(REMOTE, "NotifyKeyboardKeysym", GLib.Variant("(oa{sv}iu)", (self.session, {}, key, 1)))
        finally:
            self.release_keys()

    def release_buttons(self):
        buttons, self.buttons = self.buttons, []
        for button in reversed(buttons):
            if self.session:
                try:
                    self.call(REMOTE, "NotifyPointerButton", GLib.Variant("(oa{sv}iu)", (self.session, {}, button, 0)))
                except GLib.Error:
                    self.close()

    def pointer(self, action):
        node = str(action.get("streamId", ""))
        props = self.streams.get(node)
        if not self.session or not self.devices & 2 or props is None or action.get("coordinateSpace") != "stream":
            raise RuntimeError("Pointer input requires a live authorized stream and coordinateSpace=stream.")
        size = props.get("logical_size", props.get("size"))
        if not size or len(size) != 2:
            raise RuntimeError("Portal stream has no logical dimensions; coordinate input is unavailable.")

        def move(x, y):
            if not all(isinstance(n, (int, float)) and math.isfinite(n) for n in [x, y]) or not 0 <= x < size[0] or not 0 <= y < size[1]:
                raise RuntimeError("Pointer coordinates are outside the selected stream's logical bounds.")
            self.call(REMOTE, "NotifyPointerMotionAbsolute", GLib.Variant("(oa{sv}udd)", (self.session, {}, int(node), x, y)))

        def down(button):
            self.buttons.append(button)
            self.call(REMOTE, "NotifyPointerButton", GLib.Variant("(oa{sv}iu)", (self.session, {}, button, 1)))

        kind = action["kind"]
        if kind == "drag":
            # Validate both endpoints before sending any input.
            for x, y in [(action["fromX"], action["fromY"]), (action["toX"], action["toY"])]:
                if not all(isinstance(n, (int, float)) and math.isfinite(n) for n in [x, y]) or not 0 <= x < size[0] or not 0 <= y < size[1]:
                    raise RuntimeError("Drag endpoint is outside the stream.")
            move(action["fromX"], action["fromY"])
            try:
                down(272)
                move(action["toX"], action["toY"])
            finally:
                self.release_buttons()
        elif kind == "click":
            count = action.get("clickCount", 1)
            if count not in [1, 2, 3]:
                raise RuntimeError("clickCount must be 1–3.")
            move(action["x"], action["y"])
            for _ in range(count):
                try:
                    down({"left": 272, "right": 273, "middle": 274}[action.get("button", "left")])
                finally:
                    self.release_buttons()
        elif kind == "scroll":
            move(action["x"], action["y"])
            direction = action["direction"]
            axis, sign = {"up": (0, -1), "down": (0, 1), "left": (1, -1), "right": (1, 1)}[direction]
            steps = sign * max(1, min(30, int(action.get("pages", 1) * 3)))
            self.call(REMOTE, "NotifyPointerAxisDiscrete", GLib.Variant("(oa{sv}ui)", (self.session, {}, axis, steps)))
        else:
            raise RuntimeError("Unsupported Portal pointer action.")

    def capture(self, destination, stream_id=None):
        if not self.session or not self.streams:
            raise RuntimeError("Use /computer connect to authorize screen capture and input first.")
        node = str(stream_id) if stream_id is not None else next(iter(self.streams))
        if node not in self.streams:
            raise RuntimeError("Unknown screen stream; inspect /computer status.")
        if node not in self.captures:
            from capture import StreamCapture
            reply, descriptors = self.bus.call_with_unix_fd_list_sync(BUS, ROOT, SCREENCAST, "OpenPipeWireRemote",
                GLib.Variant("(oa{sv})", (self.session, {})), None, Gio.DBusCallFlags.NONE, 5000, None, None)
            fd = descriptors.get(reply.unpack()[0])
            try:
                self.captures[node] = StreamCapture(fd, node, self.streams[node])
            except Exception:
                os.close(fd)
                raise
        try:
            image = self.captures[node].screenshot(destination)
        except Exception:
            self.captures.pop(node).close()
            raise
        size = self.streams[node].get("logical_size", self.streams[node].get("size"))
        return {**image, "streamId": node, "coordinateFrame": {"space": "stream", "width": size[0], "height": size[1]} if size else None}

    def screenshot(self, destination):
        result = self.request("org.freedesktop.portal.Screenshot", "Screenshot", "(sa{sv})", ("",), {"interactive": GLib.Variant("b", False)})
        uri = urlparse(result["uri"])
        if uri.scheme != "file" or uri.netloc not in ["", "localhost"]:
            raise RuntimeError("Portal screenshot must be a local file.")
        path = unquote(uri.path)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 33554432:
                raise RuntimeError("Portal screenshot is not a bounded regular file.")
            data = source.read(33554433)
        if len(data) > 33554432 or not data.startswith(b"\x89PNG\r\n\x1a\n"):
            raise RuntimeError("Portal screenshot must be a PNG under 32 MiB.")
        if len(data) < 24 or data[12:16] != b"IHDR":
            raise RuntimeError("Portal screenshot has no PNG dimensions.")
        width, height = struct.unpack(">II", data[16:24])
        if not width or not height or width * height > 16777216:
            raise RuntimeError("Portal screenshot exceeds 16 megapixels.")
        loader = GdkPixbuf.PixbufLoader.new_with_type("png")
        loader.write(data)
        loader.close()
        image = loader.get_pixbuf()
        if image.get_width() * image.get_height() > 16777216:
            raise RuntimeError("Portal screenshot exceeds 16 megapixels.")
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(data)
        return {"path": destination, "width": image.get_width(), "height": image.get_height()}
