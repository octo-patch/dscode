import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLock, activeRuns, registerRun } from '../packages/launcher/locks.mjs';
import { installationLockHome, MARKER } from '../scripts/standalone-layout.mjs';

function start(command, args, env) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const record = { child, output: '', error: '' };
  child.stdout.on('data', chunk => { record.output += chunk; }); child.stderr.on('data', chunk => { record.error += chunk; });
  record.done = new Promise((done, fail) => { child.on('error', fail); child.on('exit', code => done(code)); });
  return record;
}
async function until(predicate) {
  for (let n = 0; n < 500; n++) { if (await predicate()) return; await new Promise(done => setTimeout(done, 10)); }
  throw Error('Timed out waiting for fixture');
}

test('normal launcher release keeps an inherited runtime lease discoverable', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dscode-inherited-lease-'));
  const unlock = await acquireLock(home);
  const lease = await registerRun(home);
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: ['ignore', 'ignore', 'ignore', lease.fd] });
  const exited = new Promise(done => child.once('exit', done));
  t.after(async () => { child.kill('SIGKILL'); await exited; unlock(); rmSync(home, { recursive: true, force: true }); });
  await new Promise((done, fail) => { child.once('spawn', done); child.once('error', fail); });
  lease.release();
  assert.equal((await activeRuns(home)).length, 1);
  child.kill('SIGKILL'); await exited;
  assert.equal((await activeRuns(home)).length, 0);
});

test('standalone update resumes services after releasing gates and preserves update/restart failures', async t => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'dscode-update-service-')));
  const root = join(work, 'app'), home = join(work, 'user'), state = join(home, 'state');
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const put = (path, value) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, value); };
  put(join(root, 'package.json'), '{"version":"1.0.0","type":"module"}');
  put(join(root, MARKER), JSON.stringify({ format: 1, version: '1.0.0', platform: `${process.platform}-${process.arch}`, node: process.versions.node }));
  mkdirSync(join(root, 'runtime/bin'), { recursive: true });
  symlinkSync(process.execPath, join(root, 'runtime/bin/node'));
  symlinkSync(new URL('../node_modules', import.meta.url), join(root, 'node_modules'));
  for (const name of ['scripts/standalone.mjs', 'scripts/standalone-layout.mjs', 'packages/launcher/locks.mjs']) {
    mkdirSync(join(root, name, '..'), { recursive: true }); cpSync(new URL(`../${name}`, import.meta.url), join(root, name));
  }
  cpSync(new URL('../packages/standalone/dscode', import.meta.url), join(root, 'dscode')); chmodSync(join(root, 'dscode'), 0o755);
  put(join(root, 'bin/dscode.mjs'), '');
  put(join(root, 'scripts/host.mjs'), 'export async function hostStatus() {}');
  put(join(root, 'scripts/server-service.mjs'), `
    import { appendFileSync } from 'node:fs';
    import { acquireLock } from '../packages/launcher/locks.mjs';
    import { installationLockHome } from './standalone-layout.mjs';
    export async function pauseServerForUpdate({ home }) {
      if (process.env.UPDATE_SCENARIO === 'busy') throw Error('service busy');
      appendFileSync(home + '/trace', 'pause\\n');
      return async () => {
        for (const path of [installationLockHome(process.env.DSCODE_STANDALONE_ROOT), home]) {
          const unlock = await acquireLock(path); unlock();
        }
        appendFileSync(home + '/trace', 'resume\\n');
        if (process.env.UPDATE_SCENARIO === 'both-fail') throw Error('restart failed');
      };
    }
  `);
  put(join(root, 'scripts/standalone-update.mjs'), `
    import { appendFileSync } from 'node:fs';
    export async function updateStandalone(args, { env }) {
      appendFileSync(env.DSCODE_HOME + '/trace', 'update\\n');
      if (process.env.UPDATE_SCENARIO !== 'success') throw Error('download failed');
    }
  `);
  for (const scenario of ['success', 'download-fail', 'both-fail', 'busy']) {
    mkdirSync(state, { recursive: true }); writeFileSync(join(state, 'trace'), '');
    const record = start(join(root, 'dscode'), ['update'], { HOME: home, PATH: '/usr/bin:/bin', DSCODE_HOME: state, UPDATE_SCENARIO: scenario });
    const timer = setTimeout(() => record.child.kill('SIGKILL'), 15000);
    let code;
    try { code = await record.done; } finally { clearTimeout(timer); }
    assert.equal(code, scenario === 'success' ? 0 : 1, record.error);
    assert.equal(readFileSync(join(state, 'trace'), 'utf8'), scenario === 'busy' ? '' : 'pause\nupdate\nresume\n');
    if (scenario === 'download-fail' || scenario === 'both-fail') assert.match(record.error, /download failed/);
    if (scenario === 'both-fail') assert.match(record.error, /restart failed/);
    if (scenario === 'busy') assert.match(record.error, /service busy/);
  }
});

test('standalone uses private Node, preserves exit status, admits parallel sessions and protects orphaned Hosts', async t => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'dscode-private-launch-')));
  const root = join(work, 'app with spaces'), home = join(work, 'user'), state = join(home, 'state');
  const put = (path, value) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, value); };
  put(join(root, 'package.json'), '{"version":"1.0.0","type":"module"}');
  put(join(root, MARKER), JSON.stringify({ format: 1, version: '1.0.0', platform: `${process.platform}-${process.arch}`, node: process.versions.node }));
  mkdirSync(join(root, 'runtime/bin'), { recursive: true });
  symlinkSync(process.execPath, join(root, 'runtime/bin/node'));
  symlinkSync(new URL('../node_modules', import.meta.url), join(root, 'node_modules'));
  for (const name of ['standalone.mjs', 'standalone-layout.mjs']) {
    mkdirSync(join(root, 'scripts'), { recursive: true }); cpSync(new URL(`../scripts/${name}`, import.meta.url), join(root, 'scripts', name));
  }
  put(join(root, 'scripts/server-service.mjs'), 'export async function pauseServerForUpdate() {}');
  mkdirSync(join(root, 'packages/launcher'), { recursive: true });
  cpSync(new URL('../packages/launcher/locks.mjs', import.meta.url), join(root, 'packages/launcher/locks.mjs'));
  cpSync(new URL('../packages/standalone/dscode', import.meta.url), join(root, 'dscode')); chmodSync(join(root, 'dscode'), 0o755);
  put(join(root, 'bin/dscode.mjs'), `
    import { spawn } from 'node:child_process';
    if (process.argv.includes('exit-seven')) process.exit(7);
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: ['ignore','ignore','ignore',3,4] });
    console.log(JSON.stringify({ pid: process.pid, host: child.pid, home: process.env.DSH_HOME,
      agents: process.env.DSH_AGENTS_HOME, nodeOptions: process.env.NODE_OPTIONS, nodePath: process.env.NODE_PATH,
      cli: process.env.DSCODE_CLI_PATH, path: process.env.PATH }));
    setInterval(()=>{},1000);
  `);
  const env = { HOME: home, PATH: '/usr/bin:/bin', DSCODE_HOME: state, DSH_HOME: '/foreign', DSH_AGENTS_HOME: '/foreign-agents', NODE_OPTIONS: '--require /missing', NODE_PATH: '/foreign' };
  const processes = [], pids = [];
  t.after(async () => {
    for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch {}
    for (const record of processes) record.child.kill('SIGKILL');
    await Promise.allSettled(processes.map(record => record.done)); rmSync(work, { recursive: true, force: true });
  });
  const exited = start(join(root, 'dscode'), ['exit-seven'], env); processes.push(exited);
  assert.equal(await exited.done, 7, exited.error);
  for (let n = 0; n < 2; n++) {
    const record = start(join(root, 'dscode'), [], env); processes.push(record);
    await until(() => record.output.includes('\n'));
    const data = JSON.parse(record.output); pids.push(data.pid, data.host);
    assert.equal(data.home, state); assert.equal(data.agents, join(state, 'agents'));
    assert.equal(data.nodeOptions, undefined); assert.equal(data.nodePath, undefined);
    assert(data.path.startsWith(join(root, 'runtime/bin') + ':'));
  }
  const lockHome = installationLockHome(root, home);
  assert.equal((await activeRuns(lockHome)).length, 2);
  const clone = join(work, 'other-package'); cpSync(root, clone, { recursive: true });
  const conflict = start(join(clone, 'dscode'), [], env); processes.push(conflict);
  assert.equal(await conflict.done, 1); assert.match(conflict.error, /Another DSCODE package/);
  const rejected = start(join(root, 'dscode'), ['update'], env); processes.push(rejected);
  assert.equal(await rejected.done, 1); assert.match(rejected.error, /Exit running/);
  const repair = start(join(clone, 'dscode'), ['--update-installation', root], env); processes.push(repair);
  assert.equal(await repair.done, 1); assert.match(repair.error, /Exit running/);
  // Simulate both launcher layers dying while their real Host children survive.
  for (const record of processes.slice(1, 3)) { record.child.kill('SIGKILL'); await record.done; }
  for (const pid of [pids[0], pids[2]]) process.kill(pid, 'SIGKILL');
  assert.equal((await activeRuns(lockHome)).length, 2);
  const blocked = start(join(root, 'dscode'), ['update'], env); processes.push(blocked);
  assert.equal(await blocked.done, 1); assert.match(blocked.error, /Exit running/);
  for (const pid of [pids[1], pids[3]]) process.kill(pid, 'SIGKILL');
  await until(async () => (await activeRuns(lockHome)).length === 0);
  const relocated = start(join(clone, 'dscode'), ['exit-seven'], env); processes.push(relocated);
  assert.equal(await relocated.done, 7, relocated.error);
  put(join(root, '.dscode-brew'), '');
  const brewRepair = start(join(clone, 'dscode'), ['--update-installation', root], env); processes.push(brewRepair);
  assert.equal(await brewRepair.done, 1); assert.match(brewRepair.error, /brew upgrade dscode/);
});
