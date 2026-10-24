"""Bounded JSON-lines desktop helper. Desktop libraries stay out of the Node Host.

All GUI work runs on one GLib thread. The input reader only schedules requests.
No shell strings, clipboard mutation, implicit Portal consent or action retries.
"""
import copy
import hashlib
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from seat import Seat
from session import SessionMonitor


class DesktopError(Exception):
    def __init__(self, message, code="COMPUTER_PROVIDER_FAILURE"):
        super().__init__(message)
        self.code = code


def attempt(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def bounded(value, length=512):
    return str(value or "")[:length]


active_process = None


def run(*args):
    global active_process
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    active_process = process
    try:
        stdout, stderr = process.communicate(timeout=3)
        if process.returncode:
            raise subprocess.CalledProcessError(process.returncode, args, stdout, stderr)
        return stdout.strip()
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=1)
        if active_process is process:
            active_process = None


class Desktop:
    def __init__(self):
        self.error = None
        self.epoch = 0
        self.cache = {}
        self.instance = uuid.uuid4().hex
        self.down = []
        self.portal = None
        self.seat = Seat()
        self.monitor = SessionMonitor()
        self.session_facts = None
        self.wait_loops = []
        self.A = self.Gdk = self.GLib = None
        self.session = "wayland" if os.environ.get("WAYLAND_DISPLAY") or os.environ.get("XDG_SESSION_TYPE") == "wayland" else "x11" if os.environ.get("DISPLAY") else "headless"
        try:
            import gi
            gi.require_version("Atspi", "2.0")
            gi.require_version("Gdk", "3.0")
            from gi.repository import Atspi, Gdk, GLib
            self.A, self.Gdk, self.GLib = Atspi, Gdk, GLib
            Atspi.init()
            Atspi.set_timeout(1000, 1000)
            Gdk.init_check([])
            self.listener = Atspi.EventListener.new(self.changed, None)
            for event in ["object:children-changed", "object:property-change", "object:state-changed", "object:text-changed", "window"]:
                self.listener.register(event)
            from portal import Portal
            self.portal = Portal()
            GLib.timeout_add(200, self.tick)
        except Exception as error:
            self.error = f"Linux desktop dependencies/session unavailable: {error}. Install Python GI, AT-SPI and GTK3 introspection packages, then restart the Host in the graphical user session."

    def changed(self, *_args):
        self.epoch += 1
        self.cache.clear()
        for loop in self.wait_loops:
            loop.quit()

    def tick(self):
        held = self.seat.fd is not None
        self.seat.expire()
        if held and self.seat.fd is None:
            self.release()
            if self.portal:
                self.portal.release_keys()
                self.portal.release_buttons()
        return True

    def session_state(self):
        value = self.monitor.read()
        facts = [value.get("locked"), value.get("active"), value.get("id"), self.portal.session if self.portal else None]
        if self.session_facts is not None and facts != self.session_facts:
            self.instance = uuid.uuid4().hex
            self.changed()
        self.session_facts = facts
        return value

    def wait_change(self, epoch, timeout_ms):
        if not self.GLib or epoch != self.epoch:
            return {"eventEpoch": self.epoch, "changed": epoch != self.epoch}
        loop = self.GLib.MainLoop()
        self.wait_loops.append(loop)
        fired = []

        def timeout():
            fired.append(True)
            loop.quit()
            return False

        timer = self.GLib.timeout_add(max(1, min(30000, int(timeout_ms))), timeout)
        try:
            loop.run()
        finally:
            self.wait_loops.remove(loop)
            if not fired:
                self.GLib.source_remove(timer)
        return {"eventEpoch": self.epoch, "changed": epoch != self.epoch}

    def close(self):
        for kind, value in reversed(self.down):
            attempt(lambda: run("xdotool", kind, value))
        self.down.clear()
        if self.portal:
            self.portal.close()
        self.seat.release()

    def press(self, down, up, value):
        self.down.append((up, value))
        try:
            run("xdotool", down, value)
        except BaseException:
            attempt(lambda: run("xdotool", up, value))
            self.down.remove((up, value))
            raise

    def release(self):
        for kind, value in reversed(self.down):
            run("xdotool", kind, value)
        self.down.clear()

    def xwindows(self):
        if self.session != "x11" or not shutil.which("xprop"):
            return []
        ids = re.findall(r"0x[0-9a-fA-F]+", attempt(lambda: run("xprop", "-root", "_NET_CLIENT_LIST_STACKING"), ""))[:128]
        active = attempt(lambda: int(run("xdotool", "getactivewindow")), 0)
        windows = []
        for wid in reversed(ids):
            props = attempt(lambda: run("xprop", "-id", wid, "_NET_WM_PID", "_NET_WM_NAME", "WM_NAME"), "")
            pid = re.search(r"_NET_WM_PID\(CARDINAL\) = (\d+)", props)
            title = re.search(r'(?:_NET_WM_NAME|WM_NAME)\([^\n]+?\) = "(.*)"', props)
            if not pid:
                continue
            geometry = attempt(lambda: run("xdotool", "getwindowgeometry", "--shell", wid), "")
            fields = dict(re.findall(r"^(X|Y|WIDTH|HEIGHT)=(-?\d+)$", geometry, re.M))
            if len(fields) != 4:
                continue
            windows.append({"pid": int(pid[1]), "id": int(wid, 16), "title": bounded(title[1] if title else ""),
                            "frame": dict(zip(["x", "y", "width", "height"], [int(fields[k]) for k in ["X", "Y", "WIDTH", "HEIGHT"]])), "frontmost": int(wid, 16) == active})
        return windows

    def app_identity(self, pid, name):
        executable = attempt(lambda: os.readlink(f"/proc/{pid}/exe"))
        if not executable:
            raise DesktopError("Application process is unavailable.", "COMPUTER_APP_UNAVAILABLE")
        return {"bundleId": "linux." + hashlib.sha256(executable.encode()).hexdigest()[:24], "pid": pid, "name": bounded(name or os.path.basename(executable))}

    def roots(self):
        if not self.A:
            return []
        desktop = self.A.get_desktop(0)
        if desktop is None:
            return []
        return [root for i in range(min(desktop.get_child_count(), 128)) if (root := attempt(lambda: desktop.get_child_at_index(i))) is not None]

    def apps(self):
        windows = self.xwindows()
        apps = {}
        for root in self.roots():
            pid = attempt(root.get_process_id, 0)
            if not pid:
                continue
            identity = attempt(lambda: self.app_identity(pid, root.get_name()))
            if identity:
                apps[pid] = {**identity, "frontmost": any(w["pid"] == pid and w["frontmost"] for w in windows), "accessibility": "granted", "screenRecording": "granted" if self.session == "x11" else "unavailable"}
        for window in windows:
            if window["pid"] not in apps:
                identity = attempt(lambda: self.app_identity(window["pid"], window["title"]))
                if identity:
                    apps[window["pid"]] = {**identity, "frontmost": window["frontmost"], "accessibility": "unavailable", "screenRecording": "granted"}
        return list(apps.values())[:128]

    def resolve(self, selector):
        selected = [app for app in self.apps() if all(app.get(key) == value for key, value in selector.items() if key in ["pid", "name", "bundleId"])]
        if len(selected) != 1 or not selector:
            raise DesktopError("Select one exact running application from computer_list_apps; the selector is missing, stale or ambiguous.", "COMPUTER_APP_UNAVAILABLE")
        return {key: selected[0][key] for key in ["bundleId", "pid", "name"]}

    def health(self):
        accessible = bool(attempt(lambda: self.A.get_desktop(0))) if self.A else False
        display = bool(self.Gdk and self.Gdk.Display.get_default())
        portal = self.portal.capabilities() if self.portal else {"available": False}
        return {"session": self.session, "desktop": self.session_state(), "control": self.seat.status(), "accessibility": "granted" if accessible else "unavailable",
                "assistiveTechnology": self.portal.accessibility_status() if self.portal else {},
                "screenshot": "available" if display and self.session == "x11" else "needs-authorization" if portal.get("screenshot") else "unavailable",
                "pointer": "available" if (self.session == "x11" and display and shutil.which("xdotool")) or portal.get("coordinateInput") else "unavailable",
                "keyboard": "available" if (self.session == "x11" and display and shutil.which("xdotool")) or portal.get("connected") else "needs-authorization" if portal.get("input") else "unavailable",
                "portal": portal, "events": bool(self.A and not self.error), "reason": self.error or ("No graphical user session; start DSCODE inside the desktop session." if self.session == "headless" else None)}

    def rect(self, obj):
        ext = obj.get_component_iface().get_extents(self.A.CoordType.SCREEN)
        if ext.width <= 0 or ext.height <= 0 or abs(ext.x) > 100000 or abs(ext.y) > 100000:
            return None
        return {"x": ext.x, "y": ext.y, "width": ext.width, "height": ext.height}

    def snapshot(self, app, limits, fresh=False):
        started = time.monotonic()
        self.session_state()
        pid = app["pid"]
        identity = self.app_identity(pid, app["name"])
        if identity["bundleId"] != app["bundleId"]:
            raise DesktopError("Application identity changed.", "COMPUTER_STALE_OBSERVATION")
        scope = limits.get("scope") or {}
        key = (pid, limits["maxNodes"], limits["maxDepth"], limits["maxTextBytes"], digest(scope))
        cached = self.cache.get(key)
        if not fresh and cached and time.monotonic() - cached[0] < 0.1 and cached[1] == self.epoch:
            result = copy.deepcopy(cached[2])
            result["metrics"]["cacheHit"] = True
            return result
        roots = [root for root in self.roots() if attempt(root.get_process_id) == pid]
        root = roots[0] if len(roots) == 1 else None
        windows = [w for w in self.xwindows() if w["pid"] == pid]
        window = next((w for w in windows if w["frontmost"]), windows[0] if windows else None)
        frontmost = bool(window and window["frontmost"])
        elements, used, truncated = [], 0, False
        base_locator = []
        if root and scope.get("windowTitle"):
            matches = [(child, [i]) for i in range(min(root.get_child_count(), 128))
                       if (child := attempt(lambda: root.get_child_at_index(i))) and attempt(child.get_name) == scope["windowTitle"]]
            if len(matches) != 1:
                raise DesktopError("Select one exact window title; no unique window matched.")
            root, base_locator = matches[0]
        if scope.get("root"):
            target = scope["root"]
            if target["helperInstance"] != self.instance:
                raise DesktopError("Subtree observation belongs to a previous helper.", "COMPUTER_STALE_OBSERVATION")
            root = self.target(app, target["locator"])
            root.clear_cache()
            if root.get_name() != target["title"] or root.get_role_name() != target["role"]:
                raise DesktopError("Subtree root changed; observe the application again.", "COMPUTER_STALE_OBSERVATION")
            base_locator = target["locator"]
        stack = [(root, base_locator, 0)] if root else []
        scan_limit = min(5000, max(10, int(scope.get("maxScanNodes", limits["maxNodes"]))))
        depth_limit = min(limits["maxDepth"], max(0, int(scope.get("maxDepth", limits["maxDepth"]))))
        result_limit = min(limits["maxNodes"], max(1, int(scope.get("limit", limits["maxNodes"]))))
        visited, deadline = 0, time.monotonic() + 4
        while stack:
            obj, locator, depth = stack.pop()
            visited += 1
            if visited > scan_limit or used >= limits["maxTextBytes"] or time.monotonic() > deadline:
                truncated = True
                break
            attempt(obj.clear_cache)
            states = attempt(obj.get_state_set)
            if not states or states.contains(self.A.StateType.DEFUNCT):
                continue
            role = attempt(obj.get_role_name, "unknown")
            title = bounded(attempt(obj.get_name))
            count = min(attempt(obj.get_child_count, 0), scan_limit)
            if depth < depth_limit:
                for index in reversed(range(count)):
                    child = attempt(lambda: obj.get_child_at_index(index))
                    if child:
                        stack.append((child, locator + [index], depth + 1))
            elif count:
                truncated = True
            if (scope.get("role") and role != scope["role"]) or (scope.get("name") and
                    (title != scope["name"] if scope.get("exact", True) else scope["name"].casefold() not in title.casefold())):
                continue
            frame = attempt(lambda: self.rect(obj))
            focused = states.contains(self.A.StateType.FOCUSED)
            frontmost = frontmost or (self.session == "wayland" and (focused or states.contains(self.A.StateType.ACTIVE)))
            if window is None and frame and depth == 1:
                window = {"title": bounded(attempt(obj.get_name)), "frame": frame}
            action_iface = attempt(obj.get_action_iface)
            actions = [bounded(action_iface.get_action_name(i), 80) for i in range(min(action_iface.get_n_actions(), 32))] if action_iface else []
            row = {"index": len(elements), "role": role, "title": title, "enabled": states.contains(self.A.StateType.ENABLED),
                   "focused": focused, "selected": states.contains(self.A.StateType.SELECTED), "actions": actions, "locator": locator}
            if frame:
                row["frame"] = frame
            # Password fields must never return their text through accessibility.
            if "password" not in role.lower():
                text = attempt(obj.get_text_iface)
                if text:
                    row["value"] = bounded(attempt(lambda: text.get_text(0, min(text.get_character_count(), 512))))
            size = len(json.dumps(row, ensure_ascii=False).encode())
            if used + size > limits["maxTextBytes"]:
                truncated = True
                break
            used += size
            elements.append(row)
            if len(elements) >= result_limit:
                truncated = truncated or bool(stack)
                break
        if window:
            window = {key: value for key, value in window.items() if key in ["id", "frame", "title"]}
        birth = attempt(lambda: open(f"/proc/{pid}/stat").read().rsplit(") ", 1)[1].split()[19], "unavailable")
        result = {"app": identity, "helperInstance": self.instance, "scope": scope, "scopeId": digest(scope), "eventEpoch": self.epoch,
                  "metrics": {"visitedNodes": visited, "returnedNodes": len(elements), "elapsedMs": round((time.monotonic() - started) * 1000, 2), "cacheHit": False},
                  "frontmost": frontmost, "elements": elements, "truncated": truncated,
                  "treeText": "\n".join(f'[{e["index"]}] {e["role"]} {json.dumps(e["title"], ensure_ascii=False)}' + (" value=" + json.dumps(e["value"], ensure_ascii=False) if "value" in e else "") for e in elements),
                  "permissions": {"accessibility": "granted" if root else "unavailable", "screenRecording": "granted" if self.session == "x11" else "unavailable"}}
        if window:
            result["window"] = window
        result["stateHash"] = digest([self.instance, birth, window, frontmost, elements])
        self.cache[key] = (time.monotonic(), self.epoch, result)
        while len(self.cache) > 16:
            self.cache.pop(next(iter(self.cache)))
        return copy.deepcopy(result)

    def observe(self, app, options):
        result = self.snapshot(app, options)
        if options.get("screenshot", "none") != "none":
            try:
                if self.session == "wayland":
                    result["screenshot"] = self.portal.capture(options["screenshotPath"], (options.get("scope") or {}).get("streamId")) if self.portal.streams else self.portal.screenshot(options["screenshotPath"])
                    result["permissions"]["screenRecording"] = "granted"
                    return result
                if self.session != "x11":
                    raise DesktopError("No graphical session to capture.")
                frame = result.get("window", {}).get("frame")
                if not frame:
                    raise DesktopError("No observable application window to capture.")
                screen = self.Gdk.get_default_root_window()
                x, y = max(0, frame["x"]), max(0, frame["y"])
                width, height = min(frame["x"] + frame["width"], screen.get_width()) - x, min(frame["y"] + frame["height"], screen.get_height()) - y
                if width <= 0 or height <= 0 or width * height > 16777216:
                    raise DesktopError("Window capture is outside the desktop or exceeds 16 megapixels.")
                pixels = self.Gdk.pixbuf_get_from_window(screen, x, y, width, height)
                if pixels is None:
                    raise DesktopError("Desktop capture returned no pixels.")
                if pixels.get_width() * pixels.get_height() > 16777216:
                    raise DesktopError("Desktop capture exceeds 16 megapixels at this scale.")
                path = options["screenshotPath"]
                ok, data = pixels.save_to_bufferv("png", [], [])
                if not ok or len(data) > 33554432:
                    raise DesktopError("Screenshot encoding failed or exceeds 32 MiB.")
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, "wb") as output:
                    output.write(data)
                result["screenshot"] = {"path": path, "width": pixels.get_width(), "height": pixels.get_height(),
                                        "captureFrame": {"x": x, "y": y, "width": width, "height": height}}
            except Exception:
                if options["screenshot"] == "required":
                    raise
        return result

    def target(self, app, locator):
        matches = [root for root in self.roots() if attempt(root.get_process_id) == app["pid"]]
        if len(matches) != 1:
            raise DesktopError("Accessibility target disappeared.", "COMPUTER_STALE_OBSERVATION")
        obj = matches[0]
        for index in locator:
            obj = obj.get_child_at_index(index)
            if obj is None:
                raise DesktopError("Accessibility locator changed.", "COMPUTER_STALE_OBSERVATION")
        return obj

    def act(self, request, limits):
        action, app = request["action"], request["app"]
        before = self.snapshot(app, limits, fresh=True)
        if before["stateHash"] != request["expectedStateHash"]:
            raise DesktopError("Desktop state changed. Observe again before acting.", "COMPUTER_STALE_OBSERVATION")
        element = request.get("element")
        if element and not any(e == element for e in before["elements"]):
            raise DesktopError("The target no longer matches its observed element.", "COMPUTER_STALE_OBSERVATION")
        obj = self.target(app, element["locator"]) if element else None
        kind = action["kind"]
        if self.session == "wayland" and action.get("coordinateSpace") == "stream" and not request.get("allowDesktopInput"):
            raise DesktopError("Stream coordinates address the desktop and require allowAllApps (server YOLO supplies it).", "COMPUTER_ACTION_BLOCKED")
        outcome = {"channel": "accessibility", "activation": "not-requested", "pointerInput": False, "pointerRouting": "none"}
        if kind == "set-value":
            editable = obj.get_editable_text_iface()
            if not editable or not editable.set_text_contents(action["value"]):
                raise DesktopError("This control does not support editable text.", "COMPUTER_ACTION_BLOCKED")
        elif kind == "perform-action" or (kind == "click" and element and action.get("x") is None and action.get("button", "left") == "left" and action.get("clickCount", 1) == 1):
            wanted = action.get("action") if kind == "perform-action" else next((name for name in element["actions"] if name.lower() in ["click", "press", "activate"]), None)
            if not wanted or wanted not in element["actions"]:
                if kind != "click" or not action.get("allowCoordinateFallback"):
                    raise DesktopError("No matching accessible action. Use an explicit coordinate action only when appropriate.", "COMPUTER_ACTION_BLOCKED")
                self.input_action(before, action, element, request.get("interaction", {}))
                outcome = {"channel": "coordinates", "activation": "not-requested", "pointerInput": True, "pointerRouting": "foreground-desktop"}
            else:
                interface = obj.get_action_iface()
                if not interface.do_action(element["actions"].index(wanted)):
                    raise DesktopError("The accessible action was refused.", "COMPUTER_ACTION_BLOCKED")
        elif kind == "type-text":
            focused = [row for row in before["elements"] if row["focused"]]
            if len(focused) != 1:
                raise DesktopError("No unique observed focused control; select an editable element and use set-value.", "COMPUTER_ACTION_BLOCKED")
            obj = self.target(app, focused[0]["locator"])
            editable, text = obj.get_editable_text_iface(), obj.get_text_iface()
            if not editable or not text:
                raise DesktopError("Focused control does not support AT-SPI text insertion.", "COMPUTER_ACTION_BLOCKED")
            if not editable.insert_text(text.get_caret_offset(), action["text"], len(action["text"].encode())):
                raise DesktopError("Text insertion was refused.", "COMPUTER_ACTION_BLOCKED")
        else:
            self.input_action(before, action, element, request["interaction"])
            outcome.update({"channel": "keyboard" if kind == "press-key" else "coordinates", "pointerInput": kind != "press-key", "pointerRouting": "foreground-desktop" if kind != "press-key" else "none"})
        self.changed()
        return outcome

    def input_action(self, before, action, element, interaction):
        if not before["frontmost"]:
            raise DesktopError("Raw input requires the target application to be foreground. Activate it yourself or use an accessible action.", "COMPUTER_ACTION_BLOCKED")
        window = before.get("window")
        if not window:
            raise DesktopError("Raw input requires a known window.", "COMPUTER_ACTION_BLOCKED")
        if action["kind"] != "press-key" and interaction.get("pointerInputPolicy") == "deny":
            raise DesktopError("Pointer input is disabled.", "COMPUTER_ACTION_BLOCKED")
        if self.session == "wayland":
            return self.portal.press_key(action) if action["kind"] == "press-key" else self.portal.pointer(action)
        if self.session != "x11" or not shutil.which("xdotool"):
            raise DesktopError("X11 input backend is unavailable.", "COMPUTER_ACTION_BLOCKED")
        # Check exact X window identity again at dispatch; never silently focus a
        # different window. XTEST remains global desktop input, not process routing.
        if int(run("xdotool", "getactivewindow")) != window.get("id"):
            raise DesktopError("The foreground window changed.", "COMPUTER_STALE_OBSERVATION")
        frame = window["frame"]

        def point(x, y):
            if action.get("coordinateSpace", "window") == "window":
                x, y = x + frame["x"], y + frame["y"]
            if not all(isinstance(v, (float, int)) and math.isfinite(v) for v in [x, y]) or not (frame["x"] <= x < frame["x"] + frame["width"] and frame["y"] <= y < frame["y"] + frame["height"]):
                raise DesktopError("Pointer target is outside the observed window.", "COMPUTER_ACTION_BLOCKED")
            return str(round(x)), str(round(y))

        kind = action["kind"]
        if kind == "press-key":
            aliases = {"enter": "Return", "escape": "Escape", "tab": "Tab", "backspace": "BackSpace", "delete": "Delete", "space": "space", "arrowup": "Up", "arrowdown": "Down", "arrowleft": "Left", "arrowright": "Right"}
            key = aliases.get(action["key"].lower(), action["key"])
            if not re.fullmatch(r"[A-Za-z0-9_]+", key):
                raise DesktopError("Use a single named key and the modifiers array.")
            modifiers = {"control": "ctrl", "shift": "shift", "option": "alt", "command": "super"}
            chord = "+".join([modifiers[m] for m in action.get("modifiers", [])] + [key])
            try:
                self.press("keydown", "keyup", chord)
            finally:
                self.release()
            return
        if kind == "drag":
            start, end = point(action["fromX"], action["fromY"]), point(action["toX"], action["toY"])
            run("xdotool", "mousemove", "--sync", *start)
            try:
                self.press("mousedown", "mouseup", "1")
                run("xdotool", "mousemove", "--sync", *end)
            finally:
                self.release()
            return
        if "x" in action and "y" in action:
            location = point(action["x"], action["y"])
        elif element and element.get("frame"):
            bounds = element["frame"]
            # Element frames are screen-global; bypass the window-relative offset.
            action = {**action, "coordinateSpace": "screen"}
            location = point(bounds["x"] + bounds["width"] / 2, bounds["y"] + bounds["height"] / 2)
        else:
            raise DesktopError("Pointer action needs coordinates or an observed element.")
        run("xdotool", "mousemove", "--sync", *location)
        if kind == "click":
            count = action.get("clickCount", 1)
            if count not in [1, 2, 3]:
                raise DesktopError("clickCount must be 1, 2 or 3.")
            button = {"left": "1", "middle": "2", "right": "3"}[action.get("button", "left")]
        elif kind == "scroll":
            count = max(1, min(30, int(action.get("pages", 1) * 3)))
            button = {"up": "4", "down": "5", "left": "6", "right": "7"}[action["direction"]]
        else:
            raise DesktopError("Unsupported input action.")
        for _ in range(count):
            try:
                self.press("mousedown", "mouseup", button)
            finally:
                self.release()

    def dispatch(self, request):
        self.session_state()
        if request.get("expectedInstance") and request["expectedInstance"] != self.instance:
            raise DesktopError("Desktop helper restarted. Obtain a new observation before acting or rebinding a target.", "COMPUTER_STALE_OBSERVATION")
        command = request["command"]
        if command == "health":
            return self.health()
        if command == "control-acquire":
            return self.seat.acquire(request["owner"], request.get("token"), request.get("ttlMs", 60000))
        if command == "control-release":
            self.seat.release(request["token"])
            return self.seat.status()
        if command == "control-pause":
            return self.seat.pause(request["paused"])
        if self.error:
            raise DesktopError(self.error)
        if command == "list-apps":
            return self.apps()
        if command == "resolve-app":
            return self.resolve(request["selector"])
        if command == "observe":
            return self.observe(request["app"], request["options"])
        if command == "act":
            self.seat.check(request.get("leaseToken"))
            status = self.session_state()
            if status["locked"] is True or status["active"] is False:
                raise DesktopError("Desktop is locked or inactive. Reobserve after the session becomes available.", "COMPUTER_ACTION_BLOCKED")
            return self.act(request["request"], request["limits"])
        if command == "wait-change":
            return self.wait_change(request["eventEpoch"], request["timeoutMs"])
        if command == "connect-portal":
            if self.session != "wayland":
                raise DesktopError("Portal input setup is only used on Wayland.")
            return self.portal.connect(request.get("desktop", False))
        raise DesktopError("Unknown Linux helper command.")


def main():
    desktop = Desktop()

    def shutdown(*_args):
        if active_process and active_process.poll() is None:
            active_process.kill()
            active_process.wait(timeout=1)
        desktop.close()
        os._exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    def handle(line):
        request = {}
        try:
            request = json.loads(line)
            response = {"id": request["id"], "result": desktop.dispatch(request)}
        except Exception as error:
            response = {"id": request.get("id"), "error": {"code": getattr(error, "code", "COMPUTER_PROVIDER_FAILURE"), "message": str(error)}}
        print(json.dumps(response, ensure_ascii=False), flush=True)
        return False

    if desktop.GLib:
        loop = desktop.GLib.MainLoop()

        def reader():
            while True:
                line = sys.stdin.buffer.readline(4 * 1024 * 1024 + 1)
                if not line:
                    # Also exits a nested Portal consent loop after Host death.
                    desktop.GLib.idle_add(shutdown)
                    break
                if len(line) > 4 * 1024 * 1024:
                    desktop.GLib.idle_add(shutdown)
                    break
                desktop.GLib.idle_add(handle, line)
        threading.Thread(target=reader, daemon=True).start()
        loop.run()
    else:
        for line in sys.stdin.buffer:
            if len(line) > 4 * 1024 * 1024:
                break
            handle(line)
    desktop.close()


if __name__ == "__main__":
    main()
