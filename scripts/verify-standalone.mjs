import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const archive = resolve(process.argv[2] ?? join(root, 'artifacts', `dscode-${version}-${process.platform}-${process.arch}-standalone.tar.gz`));
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
assert.equal(readFileSync(`${archive}.sha256`, 'utf8').split(/\s+/)[0], digest);
const work = mkdtempSync(join(tmpdir(), 'dscode-qualified-'));
const app = join(work, 'application with spaces'), user = join(work, 'user'), state = join(user, 'state');
const bin = join(work, 'foreign-bin');
for (const dir of [app, user, bin, join(user, '.dsh'), join(user, '.dscode')]) mkdirSync(dir, { recursive: true });
const sentinel = 'existing-user-data\n';
writeFileSync(join(user, '.dsh', 'untouched'), sentinel);
writeFileSync(join(user, '.dscode', 'credentials.yaml'), 'DO_NOT_IMPORT: sentinel\n');
for (const name of ['dsh', 'node', 'npm', 'npx', 'pnpm']) {
  const path = join(bin, name); writeFileSync(path, '#!/bin/sh\necho FOREIGN_RUNTIME_EXECUTED >&2\nexit 99\n'); chmodSync(path, 0o755);
}
const env = { HOME: user, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: work, TERM: 'dumb',
  DSCODE_HOME: state, DSH_HOME: join(user, '.dsh'), DSH_AGENTS_HOME: join(user, '.dsh/agents'),
  NODE_OPTIONS: '--require /does-not-exist', NODE_PATH: '/foreign/modules', DSCODE_ACCOUNT_LOGIN: '0' };
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: work, env, encoding: 'utf8', timeout: 60000, ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.error ?? ''}\n${result.stderr}\n${result.stdout}`);
  assert(!`${result.stderr}${result.stdout}`.includes('FOREIGN_RUNTIME_EXECUTED'));
  return result.stdout;
}
try {
  run('/usr/bin/tar', ['-xzf', archive, '-C', app]);
  const cli = join(app, 'dscode');
  assert.equal(run(cli, ['--version']).trim(), version);
  run(cli, ['--check']);
  const installation = JSON.parse(run(cli, ['--installation']));
  assert.equal(installation.home, state.startsWith('/var/') ? '/private' + state : state);
  assert.equal(installation.node, realpathSync(join(app, 'runtime/bin/node')));
  // Real cold-start composition resolves the bundled dependency tree and writes only state.
  const config = run(cli, ['--dump-config']);
  assert(config.includes('dscode')); assert(!config.includes(join(user, '.dsh')));
  const settings = join(state, 'profiles/dscode-app/cordis.patch.yml');
  const saved = '# retained user settings\n- id: session-title-llm\n  config:\n    targetWords: 17\n';
  writeFileSync(settings, saved);
  assert.match(run(cli, ['--dump-config']), /targetWords: 17/);
  const doctor = run(cli, ['doctor', '--local']);
  assert(!/failed to activate|row\(s\) did not activate/i.test(doctor), doctor);
  // Instantiate a real native PTY using the private Node, even with no usable system Node.
  const pty = `import { createRequire } from 'node:module';
    const require = createRequire(${JSON.stringify(join(app, 'package.json'))});
    const terminal = require('node-pty').spawn('/bin/sh', ['-c', 'echo PRIVATE_PTY_OK'], { env: process.env });
    terminal.onData(data => process.stdout.write(data)); terminal.onExit(({exitCode}) => process.exit(exitCode));`;
  const cleanEnv = { ...env }; delete cleanEnv.NODE_OPTIONS; delete cleanEnv.NODE_PATH;
  assert.match(run(join(app, 'runtime/bin/node'), ['--input-type=module', '-e', pty], { env: cleanEnv }), /PRIVATE_PTY_OK/);
  const skillProbe = `import assert from 'node:assert/strict'; import {createRequire} from 'node:module';
    const require = createRequire(${JSON.stringify(join(app, 'package.json'))});
    const {FileSystemSkillProvider} = await import(require.resolve('@deepseek-ai/dsh-skill-filesystem'));
    const provider = new FileSystemSkillProvider({get(){}}, {signal:new AbortController().signal,invalidate(){}}, {dshHome:process.env.DSCODE_HOME,agentsHome:process.env.DSCODE_HOME+'/agents',watch:false});
    assert(!(await provider.roots(process.env.HOME)).some(root => root.path === process.env.HOME+'/.dsh/skills'));
    await provider.dispose();
    const {CustomStore} = await import(${JSON.stringify(join(app, 'plugins/custom/config.mjs'))});
    const {createEmailInbox} = await import(${JSON.stringify(join(app, 'plugins/email/inbox.mjs'))});
    assert.equal(new CustomStore().path, process.env.DSCODE_HOME+'/providers.yaml');
    assert.equal(createEmailInbox().directory, process.env.DSCODE_HOME+'/email');
    console.log('PRIVATE_SKILLS_OK');`;
  assert.match(run(join(app, 'runtime/bin/node'), ['--input-type=module', '-e', skillProbe], { env: { ...cleanEnv, DSCODE_STANDALONE_ROOT: app } }), /PRIVATE_SKILLS_OK/);
  // The local installer must also operate with only system shell tools.
  const destination = join(work, 'installed'), commands = join(work, 'commands');
  run('/bin/sh', [join(app, 'install.sh')], { env: { ...env, DSCODE_INSTALL_DIR: destination, DSCODE_BIN_DIR: commands } });
  assert.equal(run(join(commands, 'dscode'), ['--version']).trim(), version);
  assert.match(run(join(commands, 'dscode'), ['--dump-config']), /targetWords: 17/);
  // Exercise the real updater against the entire candidate archive. Small unit
  // fixtures missed 0.7.41's tar-listing ENOBUFS failure before publication.
  const updateProbe = `import assert from 'node:assert/strict';
    import {readFileSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {updateStandalone} from ${JSON.stringify(join(destination, 'scripts/standalone-update.mjs'))};
    import {standaloneEnvironment} from ${JSON.stringify(join(destination, 'scripts/standalone-layout.mjs'))};
    const root=${JSON.stringify(destination)}, version=${JSON.stringify(version)};
    for (const name of ['package.json','.dscode-standalone.json']) {
      const path=join(root,name), data=JSON.parse(readFileSync(path,'utf8'));
      data.version='0.0.0'; writeFileSync(path,JSON.stringify(data));
    }
    const bytes=readFileSync(${JSON.stringify(archive)});
    const name='dscode-'+version+'-'+process.platform+'-'+process.arch+'-standalone.tar.gz';
    const result=await updateStandalone([], {root,env:standaloneEnvironment(root),
      fetchImpl:async url=>url==='https://fixture/package'
        ? new Response(bytes)
        : Response.json({tag_name:'v'+version,assets:[{name,digest:'sha256:'+${JSON.stringify(digest)},browser_download_url:'https://fixture/package'}]})});
    assert.equal(result.status,'updated'); assert.equal(result.version,version);
    console.log('FULL_PACKAGE_UPDATE_OK');`;
  assert.match(run(join(destination, 'runtime/bin/node'), ['--input-type=module', '-e', updateProbe],
    { env: cleanEnv, timeout: 180000 }), /FULL_PACKAGE_UPDATE_OK/);
  assert.equal(run(join(commands, 'dscode'), ['--version']).trim(), version);
  assert.match(run(join(commands, 'dscode'), ['--dump-config']), /targetWords: 17/);
  assert.equal(readFileSync(settings, 'utf8'), saved);
  assert.equal(readFileSync(join(user, '.dsh/untouched'), 'utf8'), sentinel);
  assert.deepEqual(readdirSync(join(user, '.dsh')), ['untouched']);
  assert.equal(readFileSync(join(user, '.dscode/credentials.yaml'), 'utf8'), 'DO_NOT_IMPORT: sentinel\n');
  assert(!readdirSync(app).includes('.runtime'));
  const report = { version, platform: `${process.platform}-${process.arch}`, archive, sha256: digest,
    checks: ['private runtime', 'native imports', 'native PTY', 'cold profile composition', 'native Host diagnostics', 'foreign DSH and Node isolation', 'home-directory skill isolation', 'external provider and email state', 'local shell installer', 'full candidate archive replacement from synthetic 0.0.0', 'native settings effective after restart, relocation and upgrade'],
    limits: ['No remote model calls', 'No macOS Computer Use permission interaction', 'No public publication performed'] };
  mkdirSync(join(root, 'artifacts/local'), { recursive: true });
  writeFileSync(join(root, 'artifacts/local', `standalone-${process.platform}-${process.arch}.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { rmSync(work, { recursive: true, force: true }); }
