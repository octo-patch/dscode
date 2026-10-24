import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { root, provision, environment, dshEntry } from './harness.mjs';
import { hostOverlay } from './host.mjs';
import { socketDirectory } from '../plugins/session-bridge/paths.mjs';
import { callDscode } from '../plugins/local-carrier/client.mjs';

const home = mkdtempSync(join(tmpdir(), 'dscode-server-yolo-'));
try {
  mkdirSync(join(home, 'workspace'));
  provision(home);
  const port = await new Promise(resolve => {
    const server = createServer().listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
  const tokenFile = join(home, 'token');
  writeFileSync(tokenFile, 'yolo-fixture-private-token', { mode: 0o600 });
  const fixture = join(home, 'fixture.patch.yml');
  writeFileSync(fixture, [
    '- id: permission\n  config:\n    defaultPreset: workspace-write',
    '- id: session-title-llm\n  disabled: true',
    '- id: dscode-session-cards\n  config:\n    enabled: false',
    '- id: dscode-memory\n  config:\n    generate: false',
    `- insert:\n    - id: yolo-probe\n      name: ${JSON.stringify(join(root, 'scripts/server-yolo-probe.mjs'))}`,
  ].join('\n') + '\n');
  for (const mode of ['prepare', 'yolo', 'restore']) {
    const overlay = hostOverlay(home, 0, { tcp: { port, bind: '127.0.0.1', tokenFile }, yolo: mode === 'yolo' });
    const child = spawn(process.execPath, [dshEntry, '--profile', 'tui', '--patch', overlay, '--patch', fixture], {
      cwd: root, env: { ...environment(home), DSCODE_YOLO_PROBE_HOME: home, DSCODE_YOLO_PROBE_MODE: mode, DSCODE_YOLO_PROBE_PORT: String(port), DSCODE_MEMORY_HOME: join(home, 'memories') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
    clearTimeout(timer);
    assert.equal(code, 0, output);
    const result = output.split('\n').find(line => line.includes(`SERVER_YOLO_${mode.toUpperCase()}:`));
    assert(result, output); console.log(result);
  }
  // Exercise the actual CLI option, readiness gate and foreground shutdown.
  const child = spawn(process.execPath, [join(root, 'bin/dscode.mjs'), 'server', '--port', String(port), '--bind', '127.0.0.1', '--cwd', join(home, 'workspace'), '--yolo', '--token', 'yolo-fixture-private-token'], {
    cwd: root, env: { ...environment(home), DSCODE_SOURCE_HOME: home, DSCODE_HOST_PATCH: '', DSCODE_MEMORY_HOME: join(home, 'memories') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', exited = false;
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const done = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
  const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
  try {
    const deadline = Date.now() + 30000;
    while (!output.includes('YOLO enabled:') && !exited && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.match(output, /YOLO enabled:/);
    const status = await callDscode({ url: `http://127.0.0.1:${port}`, token: 'yolo-fixture-private-token' }, 'host/status', {});
    assert.equal(status.yolo, true);
    console.log('SERVER_YOLO_CLI: authenticated readiness and mode banner passed');
  } finally { child.kill('SIGTERM'); await done; clearTimeout(timer); }
} finally {
  rmSync(socketDirectory(home), { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
