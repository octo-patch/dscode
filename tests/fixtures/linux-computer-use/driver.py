import json
import os
from pathlib import Path
import select
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]


class Helper:
    def __init__(self):
        self.log = open(f"/tmp/dscode-helper-{uuid.uuid4().hex}.log", "w")
        self.process = subprocess.Popen(["/usr/bin/python3", "-u", str(ROOT / "plugins/computer-use/linux/helper.py")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, text=True)
        self.seq = 0
        self.lease = None
        self.calls = []

    def call(self, command, **args):
        self.seq += 1
        started = time.perf_counter()
        self.process.stdin.write(json.dumps({"id": self.seq, "command": command, **args}) + "\n")
        self.process.stdin.flush()
        if not select.select([self.process.stdout], [], [], 120 if command == "connect-portal" else 40)[0]:
            raise RuntimeError(f"Helper timed out: {command}")
        result = json.loads(self.process.stdout.readline())
        self.calls.append({"command": command, "elapsedMs": (time.perf_counter() - started) * 1000})
        if "error" in result:
            raise RuntimeError(json.dumps(result["error"]))
        return result["result"]

    def observe(self, app, scope=None, screenshot="none"):
        return self.call("observe", app=app, options={"maxNodes": 1000, "maxDepth": 20, "maxTextBytes": 128000,
            "scope": scope, "screenshot": screenshot, "screenshotPath": f"/tmp/dscode-bench-{uuid.uuid4().hex}.png"})

    def act(self, observation, action, element=None, allow_desktop=False):
        if not self.lease:
            self.lease = self.call("control-acquire", owner=f"fixture-{os.getpid()}", ttlMs=60000)
        return self.call("act", expectedInstance=observation["helperInstance"], leaseToken=self.lease["token"],
            request={"app": observation["app"], "action": action, "element": element, "allowDesktopInput": allow_desktop,
                "expectedStateHash": observation["stateHash"], "interaction": {"pointerInputPolicy": "targeted", "keyboardPolicy": "activate"}},
            limits={"maxNodes": 1000, "maxDepth": 20, "maxTextBytes": 128000, "scope": observation.get("scope")})

    def close(self):
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.process.stdin.close()
        self.process.stdout.close()
        self.log.close()
