"""Portal lifecycle fixtures; these do not qualify a real Wayland compositor."""
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "plugins/computer-use/linux"))
from portal import Portal, REMOTE  # noqa: E402
from gi.repository import GLib  # noqa: E402


class FixturePortal(Portal):
    def __init__(self, directory):
        self.bus = Mock()
        self.session = self.subscription = None
        self.down = []
        self.buttons = []
        self.streams = {}
        self.captures = {}
        self.devices = 0
        self.token_file = Path(directory) / "portal.json"
        self.requests = []
        self.notifications = []
        self.refuse = None

    def version(self, _interface):
        return 2

    def request(self, interface, method, signature, args, options):
        self.requests.append((method, {key: value.unpack() for key, value in options.items()}))
        GLib.Variant(signature, (*args, options))  # Validate actual wire signatures.
        if method == self.refuse:
            raise RuntimeError("fixture refusal")
        return {"CreateSession": {"session_handle": "/fixture/session"}, "SelectDevices": {},
                "Start": {"devices": 1, "restore_token": "rotated"}}[method]

    def call(self, interface, method, args, path=None):
        self.notifications.append((interface, method, args.unpack() if args else None))
        return ()


class PortalTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.portal = FixturePortal(self.directory.name)

    def test_restore_token_rotates_and_keyboard_only(self):
        self.portal.save_token("old")
        self.assertTrue(self.portal.connect()["connected"])
        options = next(options for method, options in self.portal.requests if method == "SelectDevices")
        self.assertEqual(options, {"types": 1, "persist_mode": 2, "restore_token": "old"})
        self.assertEqual(self.portal.token(), "rotated")
        self.assertEqual(self.portal.token_file.stat().st_mode & 0o777, 0o600)
        self.assertFalse(self.portal.capabilities()["coordinateInput"])

    def test_refusal_does_not_reuse_consumed_restore_token(self):
        self.portal.save_token("old")
        self.portal.refuse = "Start"
        with self.assertRaisesRegex(RuntimeError, "refusal"):
            self.portal.connect()
        self.assertIsNone(self.portal.token())
        self.assertIsNone(self.portal.session)
        self.assertTrue(any(method == "Close" for _, method, _ in self.portal.notifications))

    def test_key_release_order_and_revocation(self):
        with self.assertRaisesRegex(RuntimeError, "connect"):
            self.portal.press_key({"key": "Tab"})
        self.portal.connect()
        self.portal.press_key({"key": "ArrowLeft", "modifiers": ["control", "shift"]})
        messages = [args for interface, method, args in self.portal.notifications if interface == REMOTE and method == "NotifyKeyboardKeysym"]
        self.assertEqual([args[3] for args in messages], [1, 1, 1, 0, 0, 0])
        self.assertEqual([args[2] for args in messages[:3]], list(reversed([args[2] for args in messages[3:]])))
        self.portal.bus.signal_subscribe.call_args.args[-2]()  # Compositor Session.Closed.
        with self.assertRaisesRegex(RuntimeError, "connect"):
            self.portal.press_key({"key": "Tab"})

    def test_private_token_and_oversized_png(self):
        self.portal.save_token("private")
        os.chmod(self.portal.token_file, 0o644)
        with self.assertRaisesRegex(RuntimeError, "private"):
            self.portal.token()
        image = Path(self.directory.name) / "oversized.png"
        image.write_bytes(b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", 20000, 20000))
        self.portal.request = lambda *_args: {"uri": image.as_uri()}
        destination = Path(self.directory.name) / "copy.png"
        with self.assertRaisesRegex(RuntimeError, "megapixels"):
            self.portal.screenshot(str(destination))
        self.assertFalse(destination.exists())

    def test_stream_coordinates_scaling_and_release(self):
        self.portal.connect()
        self.portal.devices = 3
        self.portal.streams = {"42": {"size": [800, 600], "position": [1200, 0]}}
        self.portal.pointer({"kind": "click", "coordinateSpace": "stream", "streamId": "42", "x": 400, "y": 300})
        motion = next(args for _, method, args in self.portal.notifications if method == "NotifyPointerMotionAbsolute")
        self.assertEqual(motion[2:], (42, 400.0, 300.0))  # No monitor-origin or AT-SPI offset.
        buttons = [args[3] for _, method, args in self.portal.notifications if method == "NotifyPointerButton"]
        self.assertEqual(buttons, [1, 0])
        count = len(self.portal.notifications)
        with self.assertRaisesRegex(RuntimeError, "outside"):
            self.portal.pointer({"kind": "drag", "coordinateSpace": "stream", "streamId": "42", "fromX": 10, "fromY": 10, "toX": 999, "toY": 100})
        self.assertEqual(len(self.portal.notifications), count)
        with self.assertRaisesRegex(RuntimeError, "live authorized"):
            self.portal.pointer({"kind": "click", "coordinateSpace": "screen", "streamId": "42", "x": 20, "y": 20})
        self.portal.close()
        self.assertFalse(self.portal.capabilities()["coordinateInput"])


if __name__ == "__main__":
    unittest.main()
