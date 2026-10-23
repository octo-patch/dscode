// Real managed Host lifecycle, with an injected process manager instead of
// registering anything with the developer's launchd/systemd user session.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { callDscode, openStream } from '../plugins/local-carrier/client.mjs';
import { RUNTIME_PROTOCOL } from '../plugins/local-carrier/protocol.mjs';
import { hostStatus } from './host.mjs';
import { pauseServerForUpdate, readService, serverService } from './server-service.mjs';

const root = resolve(import.meta.dirname, '..');
const base = mkdtempSync(join(tmpdir(), 'dscode-service-'));
const home = join(base, 'state'), cwd = join(base, 'workspace'), userHome = join(base, 'user');
for (const dir of [home, cwd, userHome]) mkdirSync(dir);
const patch = join(base, 'fixture.patch.yml');
writeFileSync(patch, '- id: dscode-session-cards\n  config:\n    enabled: false\n- id: dscode-memory\n  config:\n    generate: false\n');
const port = await new Promise(resolvePort => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address(); probe.close(() => resolvePort(port));
  });
});
let child, exited, output = '';
const tick = ms => new Promise(resolveTick => setTimeout(resolveTick, ms));
async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await predicate()) return; await tick(100); }
  throw Error('condition timed out');
}
async function stopChild() {
  if (!child) return;
  const timer = setTimeout(() => child?.kill('SIGKILL'), 15000);
  child.kill('SIGTERM');
  try { await exited; } finally { clearTimeout(timer); child = undefined; }
}
const options = {
  home, userHome, unitDirectory: join(base, 'units'), platform: process.platform,
  env: { PATH: process.env.PATH }, log: () => {},
  managerFactory: config => ({
    install: async () => {}, uninstall: async () => {}, reload: async () => {},
    registered: async () => Boolean(child), stop: stopChild,
    start: async () => {
      if (child) return;
      const env = { ...process.env, ...config.environment, DSCODE_HOST_PATCH: patch,
        DSCODE_MEMORY_HOME: join(home, 'memories'), DSCODE_UPDATE_CHECK: 'off', DSCODE_ACCOUNT_LOGIN: '0', DSCODE_LANGUAGE: 'en', CI: 'false' };
      for (const name of ['DSCODE_RUNTIME', 'DSCODE_RUNTIME_URL', 'DSCODE_RUNTIME_TOKEN', 'DSCODE_RUNTIME_SOCKET', 'DSCODE_CLI_PATH', 'DSCODE_HOST_LAUNCH_ID']) delete env[name];
      child = spawn(config.command[0], config.command.slice(1), { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
      exited = new Promise((done, fail) => { child.once('exit', done); child.once('error', fail); });
    },
  }),
};
const run = args => serverService(args, options);
let stream, abort;
try {
  await run(['install', '--port', String(port), '--bind', '127.0.0.1', '--cwd', cwd]);
  await run(['start']);
  assert.equal(await run(['status', '--json']), 0);
  const config = readService(home);
  const token = readFileSync(join(home, 'run', 'server-token'), 'utf8').trim();
  const target = { url: `http://127.0.0.1:${port}`, token };
  const initial = await callDscode(target, 'host/status', {});
  assert.equal(initial.serviceId, config.id);
  assert.equal(initial.defaultCwd, cwd);
  assert.equal(initial.protocol.revision, RUNTIME_PROTOCOL.revision);
  await until(() => output.includes('dscode server connect'));
  assert(!output.includes(token), 'managed logs must not print the bearer token');

  abort = new AbortController();
  stream = openStream(target, '$events', { args: {} }, abort.signal);
  await stream.next();
  await until(async () => (await hostStatus(home)).clients === 1);
  await assert.rejects(run(['stop']), /attached terminals/);
  await assert.rejects(pauseServerForUpdate(options), /attached terminals/);
  abort.abort(); await stream.return(); stream = undefined;
  await until(async () => (await hostStatus(home)).clients === 0);

  await run(['restart']);
  const restarted = await callDscode(target, 'host/status', {});
  assert.notEqual(restarted.pid, initial.pid);
  assert.equal(readFileSync(join(home, 'run', 'server-token'), 'utf8').trim(), token);
  const resume = await pauseServerForUpdate(options);
  assert.equal(await hostStatus(home), undefined);
  // A failing update must still restore the previous service. Package replacement
  // and rollback are covered separately by standalone-update.test.mjs.
  try { throw Error('simulated update failure'); } catch {} finally { await resume(); }
  assert.equal(await run(['status']), 0);
  await run(['stop']);
  assert.equal(await hostStatus(home), undefined);
  assert.equal(await run(['status']), 3);
  await run(['uninstall']);
  assert.equal(readService(home), undefined);
  assert.equal(readFileSync(join(home, 'run', 'server-token'), 'utf8').trim(), token);
  console.log('SERVER_SERVICE_VERIFIED: authenticated readiness, quiet logs, busy refusal, restart, update recovery, stop and uninstall');
} finally {
  abort?.abort(); await stream?.return();
  await stopChild(); rmSync(base, { recursive: true, force: true });
}
