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
  writeFileSync(join(app, 'dscode'), `#!/bin/sh\ncase "$1" in --check) exit ${fail ? 8 : 0} ;; --version) echo 2.0.0 ;; update) echo updated-$2 ;; esac\n`);
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
for (const corrupt of [false, true]) test(`piped installer downloads one platform package and ${corrupt ? 'rejects corruption' : 'verifies it without Node'}`, async t => {
  const f = fixture(t), tools = join(f.work, 'tools'); mkdirSync(tools);
  // Keep the test portable while exercising the macOS-only installer contract.
  writeFileSync(join(tools, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo arm64 ;; esac\n'); chmodSync(join(tools, 'uname'), 0o755);
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
  assert.equal(result.status === 0, !corrupt, result.stderr);
  assert.equal(existsSync(f.install), !corrupt);
  if (corrupt) assert.match(result.stderr, /checksum mismatch/);
  assert(requests.includes('/releases/download/v2.0.0/dscode-2.0.0-darwin-arm64-standalone.tar.gz'));
});
