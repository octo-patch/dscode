"""Actual KWin/Portal/PipeWire/GTK round trip; one fullscreen 1x virtual output."""
import json
import os
from pathlib import Path
import subprocess
import time
from driver import Helper, ROOT
from gi.repository import GdkPixbuf

app_process = subprocess.Popen(['/usr/bin/python3', str(ROOT / 'tests/fixtures/linux-computer-use/app.py')], stdout=subprocess.DEVNULL)
helper = Helper()
try:
    for _ in range(100):
        apps = [app for app in helper.call('list-apps') if app['pid'] == app_process.pid and app['accessibility'] == 'granted']
        if apps:
            break
        time.sleep(.1)
    assert apps, 'GTK application did not appear'
    app = apps[0]
    portal = helper.call('connect-portal', desktop=True)
    assert portal['connected'] and portal['coordinateInput'], portal
    observation = helper.observe(app, screenshot='required')
    image = observation['screenshot']
    assert (image['width'], image['height']) == (1280, 800), image
    assert image['coordinateFrame'] == {'space': 'stream', 'width': 1280, 'height': 800}
    assert Path(image['path']).read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
    assert Path(image['path']).stat().st_mode & 0o777 == 0o600
    assert len(set(GdkPixbuf.Pixbuf.new_from_file(image['path']).get_pixels())) > 20, 'Blank or corrupt desktop capture'
    entry = next(row for row in observation['elements'] if row['title'] == 'Fixture input')
    helper.act(observation, {'kind': 'set-value', 'value': 'Wayland 中文 ✓'}, entry)
    observation = helper.observe(app)
    button = next(row for row in observation['elements'] if row['title'] == 'Apply fixture')
    # Fixture is fullscreen on a single 1x output. Its local GTK frame is therefore
    # also the stream coordinate here; this is NOT a general AT-SPI mapping.
    frame = button['frame']
    pointer = {'coordinateSpace': 'stream', 'streamId': image['streamId']}
    helper.act(observation, {'kind': 'click', **pointer, 'x': frame['x'] + frame['width']/2, 'y': frame['y'] + frame['height']/2}, allow_desktop=True)
    for _ in range(30):
        observation = helper.observe(app)
        if any(row['title'] == 'Applied: Wayland 中文 ✓' for row in observation['elements']):
            break
        time.sleep(.1)
    else:
        raise AssertionError('Stream-coordinate click did not reach the real GTK button')
    helper.act(observation, {'kind': 'press-key', 'key': 'tab'})
    observation = helper.observe(app)
    helper.act(observation, {'kind': 'scroll', **pointer, 'x': 20, 'y': 150, 'direction': 'down', 'pages': 1}, allow_desktop=True)
    observation = helper.observe(app)
    helper.act(observation, {'kind': 'drag', **pointer, 'fromX': 30, 'fromY': 15, 'toX': 100, 'toY': 15}, allow_desktop=True)
    helper.call('control-release', token=helper.lease['token'])
    print('LINUX_WAYLAND: ' + json.dumps({'portal': True, 'pipeWirePng': True, 'streamCoordinateClickVerified': True,
        'unicodeEdit': True, 'keyboardDispatched': True, 'scrollDispatched': True, 'dragDispatched': True,
        'width': image['width'], 'height': image['height'], 'scale': 1}))
finally:
    helper.close()
    app_process.terminate(); app_process.wait(timeout=5)
