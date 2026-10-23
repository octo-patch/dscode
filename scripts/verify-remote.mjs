// Acceptance for remote runtimes (docs/remote-runtime.md), with the server and
// the terminal in separate state directories so nothing works by sharing one:
//  1. `dscode server` refuses requests without its token on every route;
//  2. `dscode config` records the server and reports that it answers;
//  3. bare `dscode` attaches to the default runtime and runs the full terminal
//     scenario over TCP, starting no local Host; sessions live in the server's folder;
//  4. /export and the git branch use the server's folder, and the
//     terminal survives a server restart mid-session;
//  5. a local file can be attached as content (both machines are one here, so
//     tests/remote-runtime.test.mjs covers which paths a terminal sends);
//  6. a wrong token and an unknown alias are refused with a clear message.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { call, callDscode, openStream } from '../plugins/local-carrier/client.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const base = mkdtempSync(join(tmpdir(), 'dscode-remote-'));
const serverHome = join(base, 'server'), clientHome = join(base, 'client');
const serverWorkspace = join(serverHome, 'workspace'), clientFolder = join(clientHome, 'folder');
for (const dir of [serverWorkspace, clientFolder, join(serverHome, 'user'), join(clientHome, 'user')]) mkdirSync(dir, { recursive: true });
writeFileSync(join(serverWorkspace, 'notes-for-probe.txt'), 'probe notes\n');
execFileSync('git', ['init', '-q', '-b', 'remote-probe-branch'], { cwd: serverWorkspace });
// A 1x1 PNG that exists only on the terminal's side.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
writeFileSync(join(clientFolder, 'local-shot.png'), png);
const outside = join(homedir(), `.dscode-remote-probe-${randomUUID()}`);
const patch = join(base, 'server-fixture.patch.yml');
writeFileSync(patch, [
  '- id: agent-default-model\n  config:\n    provider: fixture\n    model: fixture',
  '- id: permission\n  config:\n    defaultPreset: workspace-write',
  '- id: dscode-session-cards\n  config:\n    enabled: false', '- id: dscode-memory\n  config:\n    generate: false',
  `- insert:\n    - id: fixture-model\n      name: ${JSON.stringify(join(root, 'scripts/fixture-model.mjs'))}`,
].join('\n') + '\n');

const tick = ms => new Promise(r => setTimeout(r, ms));
const until = async (label, predicate, ms = 60000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await tick(100); }
  throw Error(`timed out waiting for ${label}`);
};
const quiet = { CI: 'false', DSCODE_LANGUAGE: 'en', DSCODE_UPDATE_CHECK: 'off', DSCODE_ACCOUNT_LOGIN: '0' };
const serverEnv = { ...process.env, ...quiet, HOME: join(serverHome, 'user'), DSCODE_SOURCE_HOME: serverHome, DSCODE_HOST_PATCH: patch, DSCODE_MEMORY_HOME: join(serverHome, 'memories'), FIXTURE_OUTSIDE_PATH: outside };
const clientEnv = { ...process.env, ...quiet, HOME: join(clientHome, 'user'), DSCODE_SOURCE_HOME: clientHome, DSCODE_MEMORY_HOME: join(clientHome, 'memories'),
  DSCODE_TERMINAL_CLIENT: join(root, 'scripts/tui-client-probe.mjs'), FIXTURE_OUTSIDE_PATH: outside };
for (const key of ['DSCODE_RUNTIME_SOCKET', 'DSCODE_RUNTIME_URL', 'DSCODE_RUNTIME_TOKEN', 'DSCODE_RUNTIME']) { delete serverEnv[key]; delete clientEnv[key]; }

const port = await new Promise(resolveport => { const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolveport(port)); }); });

/** Start `dscode server`; resolves once it answers with its token. */
async function startServer() {
  const child = spawn(process.execPath, [join(root, 'bin/dscode.mjs'), 'server', '--port', String(port), '--bind', '127.0.0.1', '--cwd', serverWorkspace], { cwd: serverHome, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { output: '', code: undefined };
  child.stdout.on('data', b => { state.output += b; }); child.stderr.on('data', b => { state.output += b; });
  child.once('exit', code => { state.code = code; });
  const token = await until('server banner', () => state.output.match(/--token (\S+)/)?.[1] ?? (state.code !== undefined ? Promise.reject(Error(`server exited ${state.code}:\n${state.output}`)) : undefined));
  const target = { url: `http://127.0.0.1:${port}`, token };
  await until('server answers', async () => { if (state.code !== undefined) throw Error(`server exited ${state.code}:\n${state.output}`); return callDscode(target, 'host/status', {}).catch(() => undefined); }, 120000);
  return { child, state, target };
}

/** Run the launcher as the terminal machine; resolves its exit code and output. */
function launch(args, scenario, { onOutput } = {}) {
  const child = spawn(process.execPath, [join(root, 'bin/dscode.mjs'), ...args], { cwd: clientFolder, env: { ...clientEnv, ...(scenario ? { TUI_PROBE_SCENARIO: scenario } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { output: '', stdout: '' };
  const feed = b => { state.output += b; onOutput?.(state.output); };
  child.stdout.on('data', b => { state.stdout += b; feed(b); }); child.stderr.on('data', feed);
  const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
  return new Promise(resolveRun => child.once('close', code => { clearTimeout(timer); resolveRun({ code, ...state }); }));
}

const report = {};
let server;
try {
  server = await startServer();
  const status = await callDscode(server.target, 'host/status', {});
  assert.equal(status.version, version);
  assert.equal(status.defaultCwd, serverWorkspace);
  assert.equal(statSync(join(serverHome, 'run', 'server-token')).mode & 0o777, 0o600);

  // 1. Every route refuses a wrong token.
  const wrong = { ...server.target, token: 'dsk_wrong-token-for-the-probe' };
  await assert.rejects(callDscode(wrong, 'host/status', {}), error => error.code === 'dscode/unauthorized');
  await assert.rejects(call(wrong, 'session/list', { _request: {} }), error => error.code === 'dscode/unauthorized');
  await assert.rejects((async () => { for await (const _ of openStream(wrong, '$events', { args: {} })) { /* refused before any item */ } })(), error => error.remote?.code === 'dscode/unauthorized');
  report.tokenRequired = true;

  // 2. Record the server on the terminal machine.
  const configured = await launch(['config', '--runtime', `127.0.0.1:${port}`, '--token', server.target.token, '--alias', 'probe-server', '--set-default']);
  assert.equal(configured.code, 0, configured.output);
  assert.match(configured.output, new RegExp(`Connected: DSCODE ${version.replaceAll('.', '\\.')}`));
  assert.equal(statSync(join(clientHome, 'runtimes.json')).mode & 0o777, 0o600);
  const listed = await launch(['config', '--list']);
  assert.match(listed.output, /\* probe-server\s+127\.0\.0\.1:\d+/);
  assert(!listed.output.includes(server.target.token), 'the listing never prints the token');
  report.configured = true;

  const inspected = await launch(['runtime', 'status', 'probe-server', '--json']);
  assert.equal(inspected.code, 0, inspected.output);
  // Node 22 emits SQLite's experimental warning on stderr; JSON belongs to stdout.
  assert.equal(JSON.parse(inspected.stdout).status.version, version);
  const diagnosed = await launch(['runtime', 'doctor', 'probe-server', '--json']);
  assert.equal(diagnosed.code, 0, diagnosed.output);
  assert(JSON.parse(diagnosed.stdout).checks.some(check => check.name === 'workspace' && check.ok));
  assert(!diagnosed.output.includes(server.target.token));
  const edited = await launch(['config', '--alias', 'probe-server', '--cwd', serverWorkspace]);
  assert.equal(edited.code, 0, edited.output);
  report.diagnostics = true;
  report.partialConfig = true;

  // 3. The full terminal scenario over TCP through bare `dscode`.
  const full = await launch([], 'session');
  assert(full.code === 0 && full.output.includes('TUI_RUNNER_PROBE_PASSED session'), full.output.slice(-6000));
  assert(!existsSync(join(clientHome, 'run', 'host.log')), 'a remote launch must not start a local Host');
  const sessions = (await call(server.target, 'session/list', { _request: {} })).value.items;
  assert(sessions.length >= 1 && sessions.every(item => item.cwd === serverWorkspace), JSON.stringify(sessions));
  report.fullScenario = true;

  // 4. Server folder, export and a server restart mid-session.
  let restarted;
  const remote = await launch(['runtime', 'probe-server'], 'remote', {
    onOutput: output => {
      if (restarted !== undefined || !output.includes('TUI_PROBE_READY_FOR_RESTART')) return;
      restarted = (async () => {
        server.child.kill('SIGTERM');
        await until('server stopped', () => server.state.code !== undefined, 60000);
        await tick(1000);
        server = await startServer();
      })();
    },
  });
  await restarted;
  assert(remote.code === 0 && remote.output.includes('TUI_RUNNER_PROBE_PASSED remote'), remote.output.slice(-6000));
  assert(existsSync(join(serverWorkspace, 'remote-export.md')), '/export writes into the server folder');
  assert(!existsSync(join(clientFolder, 'remote-export.md')), '/export must not write on the terminal machine');
  // The status-line branch (an opt-in item) and /diff read the server's repository.
  assert.equal(await callDscode(server.target, 'workspace/gitBranch', { cwd: serverWorkspace }), 'remote-probe-branch');
  report.serverFolder = true;
  report.reconnect = true;

  // 5. Content attachments: the Host cannot read the terminal's file, so it is sent.
  const local = join(clientFolder, 'local-shot.png');
  const [inspection] = await callDscode(server.target, 'attachments/inspectImageData', { items: [{ path: local, name: 'local-shot.png', bytes: png.length, signature: png.subarray(0, 16).toString('base64') }] });
  assert.equal(inspection.mediaType, 'image/png');
  const [block] = await callDscode(server.target, 'attachments/saveImageData', { items: [{ name: 'local-shot.png', data: png.toString('base64') }] });
  assert.equal(block.type, 'image');
  report.contentAttachments = true;

  // 6. Refusals with a clear message, and no fallback to this machine.
  const bad = await launch(['config', '--runtime', `127.0.0.1:${port}`, '--token', 'dsk_not-the-server-token', '--alias', 'bad-token']);
  assert.match(bad.output, /Saved, but not reachable now: .*refused the token/);
  const refused = await launch(['runtime', 'bad-token'], 'session');
  assert(refused.code !== 0 && /refused the token/.test(refused.output), refused.output.slice(-2000));
  const unknown = await launch(['runtime', 'nowhere'], 'session');
  assert(unknown.code !== 0 && /no runtime named nowhere/.test(unknown.output), unknown.output.slice(-2000));
  assert(!existsSync(join(clientHome, 'run', 'host.log')), 'a refused remote launch must not fall back to a local Host');
  report.refusals = true;

  console.log('REMOTE_RUNTIME_VERIFIED ' + JSON.stringify(report));
} finally {
  server?.child.kill('SIGTERM');
  await until('server stopped', () => server?.state.code !== undefined, 30000).catch(() => {});
  rmSync(outside, { force: true });
  if (!process.env.KEEP) rmSync(base, { recursive: true, force: true });
}
