import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { MARKER, canonical, readPackage, standaloneEnvironment } from '../scripts/standalone-layout.mjs';
import { updateStandalone, executePackageCommand } from '../scripts/standalone-update.mjs';
import { fetchLatestVersion, planUpdate } from '../plugins/tui-tools/update.mjs';
import { schedulerPlist } from '../plugins/triggers/scheduler-service.mjs';
import { CustomStore } from '../plugins/custom/config.mjs';
import { createEmailInbox } from '../plugins/email/inbox.mjs';

test('package commands capture listings larger than the default Node subprocess buffer', () => {
  const listing = executePackageCommand(process.execPath, ['-e', 'process.stdout.write("a".repeat(2 * 1024 * 1024) + "END")']);
  assert.equal(listing.length, 2 * 1024 * 1024 + 3);
  assert(listing.endsWith('END'));
});

test('standalone custom providers and email use private data, preserving explicit email overrides', async t => {
  const home = scratch(t), saved = { ...process.env };
  t.after(() => {
    for (const key of ['DSCODE_STANDALONE_ROOT', 'DSCODE_HOME', 'DSCODE_EMAIL_DIR']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });
  process.env.DSCODE_STANDALONE_ROOT = '/private-app'; process.env.DSCODE_HOME = home;
  delete process.env.DSCODE_EMAIL_DIR;
  const store = new CustomStore();
  assert.equal(store.path, join(home, 'providers.yaml'));
  const initial = await store.read();
  await store.update(initial.revision, () => []);
  assert(existsSync(join(home, 'providers.yaml')));
  assert.equal(createEmailInbox().directory, join(home, 'email'));
  process.env.DSCODE_EMAIL_DIR = join(home, 'explicit');
  assert.equal(createEmailInbox().directory, join(home, 'explicit'));
});

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dscode-standalone-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function put(path, value) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, value); }
function app(root, version = '1.0.0', platform = `${process.platform}-${process.arch}`) {
  put(join(root, 'package.json'), JSON.stringify({ version }));
  put(join(root, MARKER), JSON.stringify({ format: 1, version, platform, node: process.versions.node }));
  for (const file of ['runtime/bin/node', 'scripts/standalone.mjs', 'bin/dscode.mjs', 'node_modules/@deepseek-ai/dsh/lib/bin.js']) put(join(root, file), '');
  put(join(root, 'dscode'), `#!/bin/sh\ncase "$1" in --version) echo ${version} ;; --check) exit 0 ;; esac\n`);
  chmodSync(join(root, 'dscode'), 0o755);
}

test('standalone isolates DSH configuration and node injection while retaining user tool PATH and provider keys', t => {
  const dir = scratch(t), root = join(dir, 'app'), home = join(dir, 'user');
  const env = standaloneEnvironment(root, { PATH: '/other/bin', HOME: home, DSH_HOME: '/existing-dsh', DSH_AGENTS_HOME: '/existing-agents', DSH_TOOLS_MODE: 'foreign', NODE_OPTIONS: '--require /foreign', NODE_PATH: '/foreign', DEEPSEEK_API_KEY: 'fixture', NODE_EXTRA_CA_CERTS: '/corporate.pem' }, home);
  assert.equal(env.DSH_HOME, canonical(join(home, '.local/share/dscode-state')));
  assert.equal(env.DSH_AGENTS_HOME, join(env.DSH_HOME, 'agents'));
  assert.equal(env.DSH_TOOLS_MODE, undefined); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.NODE_PATH, undefined);
  assert.equal(env.DEEPSEEK_API_KEY, 'fixture'); assert.equal(env.NODE_EXTRA_CA_CERTS, '/corporate.pem');
  assert.equal(env.PATH, `${root}/runtime/bin:${root}/bin:/other/bin`);
  assert.throws(() => standaloneEnvironment(root, { DSCODE_HOME: 'relative' }, home), /absolute/);
  for (const target of [join(root, 'state'), join(home, '.dsh')]) assert.throws(() => standaloneEnvironment(root, { DSCODE_HOME: target }, home), /outside/);
  mkdirSync(join(home, '.dsh'), { recursive: true }); symlinkSync(join(home, '.dsh'), join(dir, 'alias'));
  assert.throws(() => standaloneEnvironment(root, { DSCODE_HOME: join(dir, 'alias/new') }, home), /outside/);
});

test('package metadata refuses a mismatched version, platform or incomplete runtime', t => {
  const dir = scratch(t); app(dir); assert.equal(readPackage(dir).version, '1.0.0');
  assert.throws(() => readPackage(dir, 'other'), /platform/);
  put(join(dir, 'package.json'), '{"version":"9.0.0"}'); assert.throws(() => readPackage(dir), /version/);
  put(join(dir, 'package.json'), '{"version":"1.0.0"}'); rmSync(join(dir, 'runtime/bin/node'));
  assert.throws(() => readPackage(dir), /Incomplete/);
});

for (const failure of [undefined, 'digest', 'version', 'check', 'swap', 'relocated-check']) {
  test(`whole-package update preserves state and old runtime on ${failure ?? 'success'}`, async t => {
    const dir = scratch(t), root = join(dir, 'app'), next = join(dir, 'next'), state = join(dir, 'state');
    app(root); app(next, failure === 'version' ? '2.0.1' : '2.0.0');
    put(join(root, 'old-only'), 'old'); put(join(state, 'sessions/keep'), 'session'); put(join(state, 'credentials.yaml'), 'secret');
    const archive = join(dir, 'next.tgz'); assert.equal(spawnSync('tar', ['-czf', archive, '-C', next, '.']).status, 0);
    const bytes = readFileSync(archive);
    const release = { tag_name: 'v2.0.0', assets: [{ name: `dscode-2.0.0-${process.platform}-${process.arch}-standalone.tar.gz`, browser_download_url: 'https://fixture/asset', digest: `sha256:${failure === 'digest' ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex')}` }] };
    const fetchImpl = async url => url === 'https://fixture/asset' ? { ok: true, arrayBuffer: async () => bytes } : { ok: true, json: async () => release };
    const exec = (command, args) => {
      if (args[0] === '--check' && (failure === 'check' || failure === 'relocated-check' && command === join(root, 'dscode'))) throw Error('check failed');
      const result = spawnSync(command, args, { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout;
    };
    const swap = (from, to) => { if (failure === 'swap' && from.endsWith('/app') && from !== root && to === root) throw Error('swap failed'); renameSync(from, to); };
    const operation = updateStandalone([], { root, env: { ...process.env, DSCODE_HOME: state }, fetchImpl, exec, swap });
    if (failure) await assert.rejects(operation); else assert.equal((await operation).status, 'updated');
    assert.equal(readPackage(root).version, failure ? '1.0.0' : '2.0.0');
    assert.equal(existsSync(join(root, 'old-only')), !!failure);
    assert.equal(readFileSync(join(state, 'sessions/keep'), 'utf8'), 'session');
    assert.equal(readFileSync(join(state, 'credentials.yaml'), 'utf8'), 'secret');
  });
}

test('standalone update has no npm fallback and never implicitly downgrades', async t => {
  const root = scratch(t); app(root, '2.0.0');
  const options = { root, fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: 'v1.0.0', assets: [] }) }) };
  assert.equal((await updateStandalone([], options)).status, 'current');
  await assert.rejects(updateStandalone(['1.0.0'], options), /verified/);
  await assert.rejects(updateStandalone(['bad'], options), /Usage/);
});

test('TUI checks GitHub and schedules the exact package; launchd runs its shell entry directly', async t => {
  const root = scratch(t); app(root);
  assert.deepEqual(planUpdate({ moduleUrl: new URL(`file://${root}/plugins/tui-tools/update.mjs`).href }), { label: `self-contained ${root}`, command: join(root, 'dscode'), args: ['update', 'latest'] });
  let queried;
  assert.equal(await fetchLatestVersion({ standalone: true, fetchImpl: async url => { queried = url; return { ok: true, json: async () => ({ tag_name: 'v2.0.0' }) }; } }), '2.0.0');
  assert.match(queried, /api.github.com/);
  const plist = schedulerPlist('/state', '/app/dscode');
  assert.match(plist, /<array><string>\/app\/dscode<\/string><string>trigger/);
});

test('standalone language and UI preferences never read or write the global DSH home', async t => {
  const { saveLanguage, readLanguage, terminalStateDirectory } = await import('../plugins/i18n/messages.mjs');
  const home = scratch(t), state = join(home, 'state');
  const env = { DSCODE_STANDALONE_ROOT: '/app', DSCODE_HOME: state };
  put(join(home, '.dsh/dsh-code/language.json'), '{"language":"ja"}');
  assert.equal(readLanguage({ home, env }), 'en');
  saveLanguage('zh-CN', { home, env });
  assert.equal(readLanguage({ home, env }), 'zh-CN');
  assert.equal(terminalStateDirectory(home, env), join(state, 'tui'));
  assert.equal(readFileSync(join(home, '.dsh/dsh-code/language.json'), 'utf8'), '{"language":"ja"}');
});

test('home-directory launches exclude global DSH hooks and native skill roots while preserving project skills', async t => {
  const { resolveHookSources } = await import('../plugins/tui-tools/hook-sources.mjs');
  const { isolatedDshPath } = await import('../plugins/tui-tools/workspace-discovery.mjs');
  const { standaloneSkillsSource } = await import('../scripts/patch-standalone-skills.mjs');
  const { pathToFileURL } = await import('node:url');
  const home = scratch(t), state = join(home, 'state'), code = join(home, 'test-code');
  const env = { HOME: home, DSCODE_HOME: state, DSCODE_STANDALONE_ROOT: '/app' };
  put(join(state, 'config/hooks.local.json'), '{"hooks":{}}');
  put(join(home, '.dsh/hooks.json'), '{not valid json');
  const hooks = resolveHookSources({ root: state, cwd: home, env });
  assert.equal(hooks.sources.length, 1); assert.equal(hooks.skipped.length, 0);
  assert(isolatedDshPath(join(home, '.dsh/hooks.json'), env));
  mkdirSync(code); symlinkSync(new URL('../node_modules', import.meta.url), join(code, 'node_modules'));
  const original = readFileSync(new URL('../node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js', import.meta.url), 'utf8');
  const patched = standaloneSkillsSource(original);
  assert.equal(standaloneSkillsSource(patched), patched);
  assert.throws(() => standaloneSkillsSource('upstream changed'), /drift/);
  put(join(code, 'skills.mjs'), patched.replace('../../../../plugins/tui-tools/workspace-discovery.mjs', new URL('../plugins/tui-tools/workspace-discovery.mjs', import.meta.url).href));
  const entry = `import {FileSystemSkillProvider} from './skills.mjs';
    const provider = new FileSystemSkillProvider({get(){}}, {signal: new AbortController().signal, invalidate(){}}, {dshHome: process.env.DSCODE_HOME, agentsHome: process.env.DSCODE_HOME+'/agents', watch:false});
    console.log(JSON.stringify({home:await provider.roots(process.env.HOME), project:await provider.roots(process.env.HOME+'/project')}));
    await provider.dispose();`;
  mkdirSync(join(home, 'project/.git'), { recursive: true });
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', entry], { cwd: code, env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const roots = JSON.parse(result.stdout);
  assert(!roots.home.some(row => row.path === join(home, '.dsh/skills')));
  assert(roots.project.some(row => row.path === join(home, 'project/.dsh/skills')));
});
