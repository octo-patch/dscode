// Run inside a graphical Linux session; the reproducible container is documented
// in docs/verification.md. All Host state and screenshots use a temporary home.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { root, provision, environment, dshEntry } from './harness.mjs';
import { hostOverlay } from './host.mjs';
import { socketDirectory } from '../plugins/session-bridge/paths.mjs';

assert.equal(process.platform, 'linux', 'This verifier needs a real Linux graphical session.');
const home = mkdtempSync(join(tmpdir(), 'dscode-linux-host-'));
rmSync('/tmp/dscode-gtk-ready', { force: true });
const app = spawn('/usr/bin/python3', [join(root, 'tests/fixtures/linux-computer-use/app.py')], { stdio: ['ignore', 'ignore', 'pipe'] });
let child;
try {
  for (let i = 0; i < 100 && !existsSync('/tmp/dscode-gtk-ready'); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert(existsSync('/tmp/dscode-gtk-ready'), 'GTK fixture failed to start');
  mkdirSync(join(home, 'workspace')); provision(home);
  const fixture = join(home, 'fixture.patch.yml');
  writeFileSync(fixture, [
    '- id: session-title-llm\n  disabled: true',
    '- id: dscode-session-cards\n  config:\n    enabled: false',
    '- id: dscode-memory\n  config:\n    generate: false',
    '- id: dscode-computer-use\n  config:\n    grants:\n      - bundleId: unused.fixture\n        read: true',
    `- insert:\n    - id: linux-computer-probe\n      name: ${JSON.stringify(join(root, 'scripts/linux-computer-use-probe.mjs'))}`,
  ].join('\n') + '\n');
  child = spawn(process.execPath, [dshEntry, '--profile', 'tui', '--patch', hostOverlay(home, 0), '--patch', fixture], {
    cwd: join(home, 'workspace'), env: { ...environment(home), DSCODE_LINUX_FIXTURE_PID: String(app.pid), DSCODE_LINUX_FIXTURE_HOME: home,
      DSH_AGENTS_HOME: join(home, 'agents'), DSCODE_MEMORY_HOME: join(home, 'memories') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearTimeout(timer); assert.equal(code, 0, output);
  const receipt = output.split('\n').find(line => line.includes('LINUX_COMPUTER_HOST:'));
  assert(receipt, output); console.log(receipt);
} finally {
  child?.kill('SIGTERM'); app.kill('SIGTERM');
  rmSync(socketDirectory(home), { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
}
