import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pauseServerForUpdate, readService, readyService, serverService, serviceConfigFile, serviceDefinition, serviceManager, servicePlan } from '../scripts/server-service.mjs';

function fixture(t, platform = 'darwin') {
  const dir = mkdtempSync(join(tmpdir(), 'server-service-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'state'), cwd = join(dir, 'workspace');
  mkdirSync(cwd); mkdirSync(join(home, 'run'), { recursive: true });
  writeFileSync(join(home, 'run', 'server-token'), 'private-fixture-token-123456');
  const state = { live: undefined, registered: false, events: [], output: [], sequence: 100 };
  const options = {
    home, platform, userHome: join(dir, 'user'), unitDirectory: join(dir, 'services'), timeoutMs: 50,
    env: { PATH: '/usr/bin:/bin', DSCODE_CLI_PATH: '/installed app/dscode', SECRET_API_KEY: 'never-persist-this' },
    status: async () => state.live, probe: async () => state.live, log: text => state.output.push(text),
    managerFactory: config => ({
      registered: async () => state.registered,
      install: async () => { state.events.push('install'); },
      start: async () => { state.events.push('start'); state.registered = true; state.live = { serviceId: config.id, pid: ++state.sequence, tcp: { port: config.port, bind: config.bind }, clients: 0, running: 0 }; },
      stop: async () => { state.events.push('stop'); state.registered = false; state.live = undefined; },
      uninstall: async () => { state.events.push('uninstall'); },
      reload: async () => { state.events.push('reload'); },
      logs: async (lines, follow) => { state.events.push(['logs', lines, follow]); },
    }),
  };
  const run = argv => serverService(argv, options);
  const install = () => run(['install', '--port', '8080', '--bind', '127.0.0.1', '--cwd', cwd]);
  return { dir, home, cwd, state, options, run, install };
}

for (const platform of ['darwin', 'linux']) test(`${platform} server install/start/status/restart/stop/uninstall preserves state`, async t => {
  const f = fixture(t, platform);
  assert.equal(await f.install(), 0);
  const config = readService(f.home);
  const definition = readFileSync(config.servicePath, 'utf8');
  assert(!definition.includes('private-fixture-token'));
  assert(!definition.includes('never-persist-this'));
  assert.equal(statSync(serviceConfigFile(f.home)).mode & 0o777, 0o600);
  assert.equal(statSync(config.servicePath).mode & 0o777, 0o600);
  if (platform === 'darwin' && process.platform === 'darwin') assert.equal(spawnSync('/usr/bin/plutil', ['-lint', config.servicePath]).status, 0);
  assert.equal(await f.run(['status', '--json']), 3);
  assert.equal(JSON.parse(f.state.output.at(-1)).installed, true);
  await f.run(['start']);
  assert.match(f.state.output.at(-1), /Server ready/);
  assert.equal(await f.run(['status', '--json']), 0);
  assert.equal(JSON.parse(f.state.output.at(-1)).runtime.pid, 101);
  const first = f.state.live.pid;
  await f.run(['restart']);
  assert(f.state.live.pid > first);
  f.state.live.running = 1;
  await assert.rejects(f.run(['stop']), /running turns/);
  await assert.rejects(f.run(['uninstall']), /running turns/);
  assert(f.state.live);
  await f.run(['stop', '--force']);
  assert.equal(f.state.live, undefined);
  await f.run(['logs', '--lines', '25', '--follow']);
  assert.deepEqual(f.state.events.at(-1), ['logs', 25, true]);
  await f.run(['uninstall']);
  assert(!existsSync(config.servicePath));
  assert.equal(readService(f.home), undefined);
  assert.equal(readFileSync(join(f.home, 'run', 'server-token'), 'utf8'), 'private-fixture-token-123456');
});

test('service definitions quote paths and carry only selected ordinary environment', t => {
  const f = fixture(t);
  for (const platform of ['darwin', 'linux']) {
    const config = servicePlan({ port: 8080, bind: '127.0.0.1', cwd: f.cwd }, { ...f.options, platform,
      env: { PATH: '/bin:/a %$"directory', DSCODE_CLI_PATH: '/a %$"directory/dscode', TOKEN: 'secret' } });
    const definition = serviceDefinition(config);
    assert(!definition.includes('secret'));
    assert(!Object.hasOwn(config.environment, 'TOKEN'));
    if (platform === 'linux') { assert.match(definition, /ExecStart="\/a %%\$\$\\"directory\/dscode"/); assert.match(definition, /Restart=on-failure/); }
    else assert.match(definition, /&quot;directory/);
  }
  assert.throws(() => servicePlan({ port: 8080, bind: '127.0.0.1', cwd: f.cwd }, { ...f.options, env: { PATH: '/bin\nInjected=1' } }), /control characters/);
});

test('failed installation rolls back files and refuses to overwrite an unrelated service', async t => {
  const f = fixture(t);
  const config = servicePlan({ port: 8080, bind: '127.0.0.1', cwd: f.cwd }, f.options);
  f.options.managerFactory = () => ({ install: async () => { throw Error('manager unavailable'); } });
  await assert.rejects(f.install(), /manager unavailable/);
  assert(!existsSync(config.servicePath)); assert(!existsSync(serviceConfigFile(f.home)));
  writeFileSync(config.servicePath, 'unrelated');
  await assert.rejects(f.install(), /unmanaged/);
  assert.equal(readFileSync(config.servicePath, 'utf8'), 'unrelated');
});

test('service commands do not stop an unrelated Host or claim TCP readiness from a socket alone', async t => {
  const f = fixture(t);
  await f.install();
  f.state.live = { pid: 10, clients: 0, running: 0 };
  await assert.rejects(f.run(['start']), /another Host/);
  await assert.rejects(f.run(['stop', '--force']), /another Host/);
  assert(!f.state.events.includes('stop'));
  f.state.live = undefined;
  f.options.probe = async () => { throw Error('TCP not listening'); };
  await assert.rejects(f.run(['start']), /did not become ready/);
  assert.equal(await f.run(['status', '--json']), 1);
  assert.equal(JSON.parse(f.state.output.at(-1)).ready, false);
  assert(!f.state.output.some(line => line.startsWith('Server ready')));
});

test('update pause refuses busy services, resumes after failure, and leaves stopped services stopped', async t => {
  const f = fixture(t);
  await f.install(); await f.run(['start']);
  f.state.live.clients = 1;
  await assert.rejects(pauseServerForUpdate(f.options), /attached terminals/);
  f.state.live.clients = 0;
  f.state.live.running = 1;
  await assert.rejects(pauseServerForUpdate(f.options), /running turns/);
  f.state.live.running = 0;
  const resume = await pauseServerForUpdate(f.options);
  assert.equal(f.state.live, undefined);
  try { throw Error('download failed'); } catch {} finally { await resume(); }
  assert(f.state.live);
  await f.run(['stop']);
  assert.equal(await pauseServerForUpdate(f.options), undefined);
  assert.equal(f.state.live, undefined);
});

test('launchd and systemd commands use argument arrays and surface manager errors', async t => {
  const f = fixture(t);
  for (const platform of ['darwin', 'linux']) {
    const config = servicePlan({ port: 8080, bind: '127.0.0.1', cwd: f.cwd }, { ...f.options, platform });
    const calls = [];
    const exec = async (cmd, args) => { calls.push([cmd, ...args]); return { code: platform === 'darwin' && args[0] === 'print' && args[1].includes('/ai.') ? 113 : 0, output: 'inactive' }; };
    const manager = serviceManager(config, { uid: 501, exec });
    await manager.install(); await manager.start(); await manager.stop(); await manager.uninstall(); await manager.reload();
    assert(calls.some(row => row.includes(platform === 'darwin' ? 'bootstrap' : 'start')));
    assert(calls.every(row => !row.includes('sh')));
    const broken = serviceManager(config, { uid: 501, exec: async () => ({ code: 1, output: 'no user manager' }) });
    await assert.rejects(broken.registered(), /no user manager/);
  }
});
