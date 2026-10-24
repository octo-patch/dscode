import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "plugins/computer-use/linux"))
from seat import Seat, SeatError


class SeatTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        old = os.environ.get("DISPLAY")
        os.environ["DISPLAY"] = self.directory.name
        self.addCleanup(lambda: os.environ.pop("DISPLAY", None) if old is None else os.environ.__setitem__("DISPLAY", old))
        self.first, self.second = Seat(), Seat()
        self.addCleanup(self.first.release)
        self.addCleanup(self.second.release)

    def test_exclusion_owner_expiry_and_pause(self):
        lease = self.first.acquire("one", ttl_ms=1000)
        with self.assertRaises(SeatError):
            self.second.acquire("two")
        with self.assertRaises(SeatError):
            self.first.check("wrong")
        self.second.pause(True)
        with self.assertRaises(SeatError):
            self.first.check(lease["token"])
        self.second.pause(False)
        lease = self.second.acquire("two", ttl_ms=1000)
        time.sleep(1.05)
        with self.assertRaises(SeatError):
            self.second.check(lease["token"])
        self.first.acquire("three")

    def test_kernel_releases_lease_after_process_crash(self):
        code = 'import sys,time; sys.path.insert(0,sys.argv[1]); from seat import Seat; s=Seat(); s.acquire("child"); print("ready",flush=True); time.sleep(30)'
        child = subprocess.Popen([sys.executable, "-c", code, sys.path[0]], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "ready")
            with self.assertRaises(SeatError):
                self.first.acquire("parent")
        finally:
            child.kill()
            child.wait(timeout=5)
            child.stdout.close()
        self.first.acquire("parent")


if __name__ == "__main__":
    unittest.main()
