import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { root, environment } from './harness.mjs';
import { desktopStatus, desktopMain } from './desktop-session.mjs';
import { callDscode } from '../plugins/local-carrier/client.mjs';
import { socketDirectory } from '../plugins/session-bridge/paths.mjs';

assert.equal(process.platform, 'linux');
const home = mkdtempSync(join(tmpdir(), 'dscode-desktop-server-'));
const port = await new Promise(resolve => {
  const socket = createServer().listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); });
});
const token = 'isolated-desktop-fixture-token';
const child = spawn(process.execPath, [join(root, 'bin/dscode.mjs'), 'server', '--desktop', '--yolo', '--port', String(port), '--bind', '127.0.0.1', '--cwd', home, '--token', token], {
  cwd: root, env: { ...environment(home), DSCODE_SOURCE_HOME: home, DSCODE_HOST_PATCH: '', DSCODE_MEMORY_HOME: join(home, 'memories') }, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '', exited = false;
child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
const done = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
try {
  const deadline = Date.now() + 45000;
  while (!output.includes('YOLO enabled:') && !exited && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.match(output, /YOLO enabled:/);
  assert.equal((await callDscode({ url: `http://127.0.0.1:${port}`, token }, 'host/status', {})).yolo, true);
  const desktop = await desktopStatus(home);
  assert.equal(desktop.state, 'ready'); assert.equal(desktop.alive, true);
  const command = spawn(process.execPath, [join(root, 'bin/dscode.mjs'), 'desktop', 'exec', '--', 'xdpyinfo'], {
    env: { ...process.env, DSCODE_SOURCE_HOME: home }, stdio: 'ignore',
  });
  assert.equal(await new Promise((resolve, reject) => { command.once('error', reject); command.once('exit', resolve); }), 0);
  console.log('LINUX_DESKTOP_SERVER: authenticated YOLO server, private desktop and CLI exec passed');
} finally {
  child.kill('SIGTERM'); await done; clearTimeout(timer);
  await desktopMain(['stop'], { home });
  rmSync(socketDirectory(home), { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
}
