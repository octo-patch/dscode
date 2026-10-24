import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
from driver import ROOT

directory = Path(tempfile.mkdtemp(prefix="dscode-dedicated-test-"))
script = ROOT / "plugins/computer-use/linux/desktop.py"
log = open(directory / "supervisor.log", "w")
process = subprocess.Popen(["dbus-run-session", "--", "/usr/bin/python3", str(script), "run", str(directory)], stdout=log, stderr=log)


def ready(previous=None):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            value = json.loads((directory / "state.json").read_text())
            if value["state"] == "ready" and value["generation"] != previous:
                return value
        except (OSError, json.JSONDecodeError):
            pass
        time.sleep(0.1)
    raise AssertionError("Dedicated desktop readiness timed out: " + (directory / "supervisor.log").read_text()[-4000:])


try:
    first = ready()
    env = {**os.environ, **first["env"]}
    assert subprocess.run(["xdpyinfo"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    assert subprocess.run(["xdpyinfo"], env={**env, "XAUTHORITY": "/tmp/nonexistent-dscode-auth"}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0
    os.kill(first["wmPid"], signal.SIGKILL)
    second = ready(first["generation"])
    assert second["display"] == first["display"] and second["generation"] != first["generation"]
    subprocess.run(["/usr/bin/python3", str(script), "stop", str(directory)], check=True, stdout=subprocess.DEVNULL)
    assert process.wait(timeout=10) == 0
    final = json.loads(subprocess.check_output(["/usr/bin/python3", str(script), "status", str(directory)]))
    assert not final["alive"] and final["state"] == "stopped"
    print('DEDICATED_DESKTOP: authenticated display, refused unauthenticated access, recovered WM crash, changed generation, clean stop')
finally:
    if process.poll() is None:
        subprocess.run(["/usr/bin/python3", str(script), "stop", str(directory)], stdout=subprocess.DEVNULL)
        process.wait(timeout=10)
    log.close()
