import json
import os
import struct
import subprocess
import time

for path in ["/tmp/dscode-gtk-ready", "/tmp/dscode-gtk-shot.png"]:
    if os.path.exists(path):
        os.unlink(path)
app = subprocess.Popen(["/usr/bin/python3", "/work/tests/fixtures/linux-computer-use/app.py"])
helper = subprocess.Popen(["/usr/bin/python3", "-u", "/work/plugins/computer-use/linux/helper.py"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
sequence = 0


def call(command, **args):
    global sequence
    sequence += 1
    helper.stdin.write(json.dumps({"id": sequence, "command": command, **args}) + "\n")
    helper.stdin.flush()
    line = helper.stdout.readline()
    assert line, "helper exited"
    result = json.loads(line)
    assert result["id"] == sequence
    if "error" in result:
        raise RuntimeError(json.dumps(result["error"]))
    return result["result"]


limits = {"maxNodes": 100, "maxDepth": 10, "maxTextBytes": 20000}
try:
    for _ in range(100):
        if os.path.exists("/tmp/dscode-gtk-ready"):
            break
        time.sleep(0.1)
    health = call("health")
    assert health["accessibility"] == "granted", health
    assert health["pointer"] == "available", health
    identity = call("resolve-app", selector={"pid": app.pid})
    lease = call("control-acquire", owner="helper-fixture", ttlMs=60000)

    def observe(screenshot="none"):
        return call("observe", app=identity, options={**limits, "screenshot": screenshot, "screenshotPath": "/tmp/dscode-gtk-shot.png"})

    def act(snapshot, action, element=None):
        return call("act", request={"app": identity, "action": action, "expectedStateHash": snapshot["stateHash"], "window": snapshot.get("window"),
                                    "interaction": {"pointerInputPolicy": "targeted", "keyboardPolicy": "activate"}, **({"element": element} if element else {})}, limits=limits, leaseToken=lease["token"])

    time.sleep(0.5)
    first = observe()
    assert "fixture-secret-must-not-appear" not in json.dumps(first), first
    entry = next(row for row in first["elements"] if row["title"] == "Fixture input")
    assert entry["role"] in ["text", "entry"], entry
    result = act(first, {"kind": "set-value", "value": "Linux 中文 ✓"}, entry)
    assert result["channel"] == "accessibility"
    updated = observe()
    assert "Linux 中文 ✓" in json.dumps(updated, ensure_ascii=False), updated
    try:
        act(first, {"kind": "set-value", "value": "stale"}, entry)
        raise AssertionError("stale action was admitted")
    except RuntimeError as error:
        assert "COMPUTER_STALE_OBSERVATION" in str(error)
    button = next(row for row in updated["elements"] if row["title"] == "Apply fixture")
    assert button["actions"], button
    act(updated, {"kind": "click"}, button)
    changed = observe()
    assert "Applied: Linux 中文 ✓" in json.dumps(changed, ensure_ascii=False), changed
    # Explicit screenshot is an actual X server image, not a placeholder.
    captured = observe("required")
    path = captured["screenshot"]["path"]
    with open(path, "rb") as image:
        header = image.read(24)
    assert header[:8] == b"\x89PNG\r\n\x1a\n"
    assert struct.unpack(">II", header[16:24]) == (captured["screenshot"]["width"], captured["screenshot"]["height"])
    assert os.stat(path).st_mode & 0o777 == 0o600
    # XTEST dispatch requires the observed foreground window and reports its route honestly.
    current = observe()
    result = act(current, {"kind": "press-key", "key": "Tab"})
    assert result["channel"] == "keyboard"
    current = observe()
    target = next(row for row in current["elements"] if row["title"] == "Apply fixture")
    frame = target["frame"]
    result = act(current, {"kind": "click", "coordinateSpace": "screen", "x": frame["x"] + frame["width"] / 2, "y": frame["y"] + frame["height"] / 2})
    assert result["pointerRouting"] == "foreground-desktop"
    # Restart must invalidate the old observation even if the UI is unchanged.
    previous = observe()
    helper.terminate()
    helper.wait(timeout=5)
    helper = subprocess.Popen(["/usr/bin/python3", "-u", "/work/plugins/computer-use/linux/helper.py"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    restarted = observe()
    lease = call("control-acquire", owner="helper-fixture", ttlMs=60000)
    assert restarted["stateHash"] != previous["stateHash"]
    try:
        act(previous, {"kind": "press-key", "key": "Tab"})
        raise AssertionError("pre-restart observation was admitted")
    except RuntimeError as error:
        assert "COMPUTER_STALE_OBSERVATION" in str(error)
    helper.stdin.close()
    assert helper.wait(timeout=5) == 0, "helper did not exit after Host pipe closure"
    print(json.dumps({"health": health, "atspiUnicodeEdit": True, "atspiClick": True, "staleRejected": True, "passwordOmitted": True,
                      "screenshot": captured["screenshot"], "x11Keyboard": True, "x11Pointer": True, "restartInvalidation": True, "hostExitCleanup": True, "elements": len(first["elements"])}))
finally:
    helper.terminate()
    app.terminate()
    helper.wait(timeout=5)
    app.wait(timeout=5)
