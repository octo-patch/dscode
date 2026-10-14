import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
const script = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
function fixture(t, fail = false) {
  const work = mkdtempSync(join(tmpdir(), 'dscode-install-new-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const app = join(work, 'package'), install = join(work, 'installed'), bin = join(work, 'bin');
  mkdirSync(app); mkdirSync(bin);
  writeFileSync(join(app, '.dscode-standalone.json'), '{}');
  writeFileSync(join(app, 'dscode'), `#!/bin/sh\ncase "$1" in --check) exit ${fail ? 8 : 0} ;; --version) echo 2.0.0 ;; update) echo updated-$2 ;; --update-installation) echo repaired-$2-$3 ;; esac\n`);
  chmodSync(join(app, 'dscode'), 0o755);
  writeFileSync(join(app, 'install.sh'), script);
  return { work, app, install, bin, env: { PATH: '/usr/bin:/bin', HOME: work, DSCODE_HOME: join(work, 'state'), DSCODE_INSTALL_DIR: install, DSCODE_BIN_DIR: bin } };
}
test('local installer needs no Node, installs spaces safely and delegates an existing install to its updater', t => {
  const f = fixture(t); f.env.DSCODE_INSTALL_DIR = f.install + ' with spaces';
  const result = spawnSync('/bin/sh', [join(f.app, 'install.sh')], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readlinkSync(join(f.bin, 'dscode')), join(f.env.DSCODE_INSTALL_DIR, 'dscode'));
  const again = spawnSync('/bin/sh', [join(f.app, 'install.sh'), '2.1.0'], { env: f.env, encoding: 'utf8' });
  assert.equal(again.status, 0, again.stderr); assert.match(again.stdout, /updated-2.1.0/);
});
test('installer refuses foreign commands and leaves no install after failed verification', t => {
  const f = fixture(t, true);
  let result = spawnSync('/bin/sh', [join(f.app, 'install.sh')], { env: f.env, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert(!existsSync(f.install)); assert(!existsSync(join(f.bin, 'dscode')));
  writeFileSync(join(f.bin, 'dscode'), 'foreign');
  result = spawnSync('/bin/sh', [join(f.app, 'install.sh')], { env: f.env, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /another installation/);
  assert.equal(readFileSync(join(f.bin, 'dscode'), 'utf8'), 'foreign');
});
test('installer repairs 0.7.41 using the verified new package rather than its broken updater', t => {
  const f = fixture(t);
  let result = spawnSync('/bin/sh', [join(f.app, 'install.sh')], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(f.install, 'dscode'), '#!/bin/sh\ncase "$1" in --version) echo 0.7.41 ;; *) exit 91 ;; esac\n');
  result = spawnSync('/bin/sh', [join(f.app, 'install.sh'), '2.0.0'], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert(result.stdout.includes(`repaired-${f.install}-2.0.0`));
});
async function piped(t, { system = 'Darwin', machine = 'arm64', glibc = true, corrupt = false } = {}) {
  const f = fixture(t), tools = join(f.work, 'tools'); mkdirSync(tools);
  // Fake the platform probes so every target is exercised on any test host.
  writeFileSync(join(tools, 'uname'), `#!/bin/sh\ncase "$1" in -s) echo ${system} ;; -m) echo ${machine} ;; esac\n`); chmodSync(join(tools, 'uname'), 0o755);
  writeFileSync(join(tools, 'getconf'), glibc ? '#!/bin/sh\necho glibc 2.36\n' : '#!/bin/sh\nexit 1\n'); chmodSync(join(tools, 'getconf'), 0o755);
  const archive = join(f.work, 'package.tgz'); assert.equal(spawnSync('tar', ['-czf', archive, '-C', f.app, '.']).status, 0);
  const bytes = readFileSync(archive), digest = corrupt ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex');
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url.endsWith('/latest')) { res.writeHead(302, { location: '/releases/tag/v2.0.0' }); res.end(); }
    else if (req.url.includes('/tag/')) res.end('release');
    else if (req.url.endsWith('.sha256')) res.end(`${digest}  package.tar.gz\n`);
    else res.end(bytes);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { ...f.env, PATH: `${tools}:/usr/bin:/bin`, DSCODE_RELEASES_URL: `http://127.0.0.1:${server.address().port}/releases` };
  const result = await new Promise(done => {
    const child = spawn('/bin/sh', [], { cwd: f.work, env }); let stdout = '', stderr = '';
    child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    child.on('exit', status => done({ status, stdout, stderr })); child.stdin.end(script);
  });
  return { ...result, requests, installed: existsSync(f.install) };
}
for (const corrupt of [false, true]) test(`piped installer downloads one platform package and ${corrupt ? 'rejects corruption' : 'verifies it without Node'}`, async t => {
  const result = await piped(t, { corrupt });
  assert.equal(result.status === 0, !corrupt, result.stderr);
  assert.equal(result.installed, !corrupt);
  if (corrupt) assert.match(result.stderr, /checksum mismatch/);
  assert(result.requests.includes('/releases/download/v2.0.0/dscode-2.0.0-darwin-arm64-standalone.tar.gz'));
});
for (const [machine, platform] of [['x86_64', 'linux-x64'], ['aarch64', 'linux-arm64']]) test(`piped installer selects the ${platform} package on glibc Linux`, async t => {
  const result = await piped(t, { system: 'Linux', machine });
  assert.equal(result.status, 0, result.stderr); assert(result.installed);
  assert(result.requests.includes(`/releases/download/v2.0.0/dscode-2.0.0-${platform}-standalone.tar.gz`));
});
test('piped installer refuses musl Linux and unsupported systems before downloading a package', async t => {
  for (const [options, message] of [[{ system: 'Linux', machine: 'x86_64', glibc: false }, /require glibc/], [{ system: 'FreeBSD' }, /macOS and Linux only/], [{ system: 'Linux', machine: 'riscv64' }, /Unsupported architecture/]]) {
    const result = await piped(t, options);
    assert.notEqual(result.status, 0); assert.match(result.stderr, message); assert(!result.installed);
    assert(!result.requests.some(url => url.includes('/download/')));
  }
});
