"""Real PipeWire/GStreamer frames; source is synthetic, not a desktop compositor."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
import gi
gi.require_version('Gst', '1.0')
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import Gst, GdkPixbuf
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'plugins/computer-use/linux'))
from capture import StreamCapture

provider = subprocess.Popen(['gst-launch-1.0', '-q', 'videotestsrc', 'is-live=true', 'pattern=smpte', '!',
    'video/x-raw,format=RGBA,width=320,height=200,framerate=10/1', '!', 'pipewiresink', 'mode=provide', 'sync=false', 'async=false',
    'stream-properties=props,node.name=dscode-fixture,media.class=Video/Source'], stdout=subprocess.DEVNULL)
capture = None
try:
    for _ in range(50):
        nodes = json.loads(subprocess.check_output(['pw-dump']))
        found = [node for node in nodes if node.get('info', {}).get('props', {}).get('node.name') == 'dscode-fixture']
        if found:
            break
        time.sleep(.1)
    assert found, 'Test source did not register with PipeWire'
    remote = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    remote.connect(os.path.join(os.environ['XDG_RUNTIME_DIR'], 'pipewire-0'))
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(StreamCapture, remote.detach(), found[0]['id'], {})
        for _ in range(50):
            outputs = subprocess.check_output(['pw-link', '-o'], text=True).splitlines()
            inputs = subprocess.check_output(['pw-link', '-i'], text=True).splitlines()
            source = next((port for port in outputs if port.startswith('dscode-fixture:')), None)
            target = next((port for port in inputs if port.startswith('python')), None)
            if source and target:
                subprocess.run(['pw-link', source, target], check=True)
                break
            time.sleep(.1)
        capture = pending.result(timeout=10)
    with tempfile.TemporaryDirectory() as directory:
        image = capture.screenshot(str(Path(directory) / 'first.png'))
        assert (image['width'], image['height']) == (320, 200), image
        pixels = GdkPixbuf.Pixbuf.new_from_file(image['path']).get_pixels()
        assert len(set(pixels)) > 20, 'Blank or corrupt capture'
        assert Path(image['path']).stat().st_mode & 0o777 == 0o600
        second = capture.screenshot(str(Path(directory) / 'second.png'))
        assert second['frameAgeMs'] >= 0
        provider.terminate(); provider.wait(timeout=5)
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            time.sleep(.3)
            try:
                capture.screenshot(str(Path(directory) / f'closed-{time.monotonic_ns()}.png'))
            except RuntimeError:
                break
        else:
            raise AssertionError('Ended stream continued returning cached frames')
    print('LINUX_PIPEWIRE: real 320x200 nonblank PNG, private file, latest frame and ended-stream rejection passed')
finally:
    if capture:
        capture.close()
    if provider.poll() is None:
        provider.terminate(); provider.wait(timeout=5)
