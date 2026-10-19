import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyConfig, listing, parseConfigArgs, readRuntimes, resolveRuntime, runtimeUrl, writeRuntimes,
} from '../scripts/runtimes.mjs';
import { parseServerArgs, serverToken, serverTokenFile } from '../scripts/host.mjs';
import { attachmentClient } from '../packages/tui/src/runtime/views.ts';
import { resilient, retryable } from '../packages/tui/src/runtime/watch.ts';
import { inspectFileFacts, inspectImageFacts, saveImageData } from '../packages/tui/src/attachments.ts';

const temp = t => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-runtime-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const TOKEN = 'dsk_0123456789abcdefghij';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('runtime addresses normalize to plain http://host:port', () => {
  assert.equal(runtimeUrl('1.1.1.1:8080'), 'http://1.1.1.1:8080');
  assert.equal(runtimeUrl('http://box.local:9000'), 'http://box.local:9000');
  assert.equal(runtimeUrl('box:80'), 'http://box:80');
  assert.equal(runtimeUrl('[::1]:8080'), 'http://[::1]:8080');
  assert.throws(() => runtimeUrl('1.1.1.1'), /needs a port/);
  assert.throws(() => runtimeUrl('https://box:443'), /only plain http/);
  assert.throws(() => runtimeUrl('box:80/path'), /just HOST:PORT/);
});

test('dscode config validates one action and its options', () => {
  assert.deepEqual(parseConfigArgs(['--runtime', '1.1.1.1:8080', '--alias', 'server1', '--token', TOKEN, '--set-default']),
    { runtime: '1.1.1.1:8080', alias: 'server1', token: TOKEN, setDefault: true, url: 'http://1.1.1.1:8080' });
  assert.throws(() => parseConfigArgs(['--runtime', '1.1.1.1:8080', '--token', TOKEN]), /needs --alias/);
  assert.throws(() => parseConfigArgs(['--runtime', '1.1.1.1:8080', '--alias', 'x']), /needs --token/);
  assert.throws(() => parseConfigArgs(['--runtime', '1.1.1.1:8080', '--alias', 'local', '--token', TOKEN]), /reserved/);
  assert.throws(() => parseConfigArgs(['--runtime', '1.1.1.1:8080', '--alias', 'a b', '--token', TOKEN]), /alias is letters/);
  assert.throws(() => parseConfigArgs(['--runtime', '1.1.1.1:8080', '--alias', 'x', '--token', TOKEN, '--cwd', 'relative']), /absolute path on the server/);
  assert.throws(() => parseConfigArgs(['--alias', 'x']), /belong to --runtime/);
  assert.throws(() => parseConfigArgs(['--default', 'a', '--remove', 'b']), /one of/);
  assert.deepEqual(parseConfigArgs(['--help']), { help: true });
  assert.deepEqual(parseConfigArgs([]), {});
});

test('adding, defaulting and removing runtimes; the listing never shows a token', () => {
  let config = { default: 'local', runtimes: {} };
  ({ config } = applyConfig(config, parseConfigArgs(['--runtime', '10.0.0.2:8080', '--alias', 'box', '--token', TOKEN, '--cwd', '/srv/app', '--set-default'])));
  assert.equal(config.default, 'box');
  assert.deepEqual(config.runtimes.box, { url: 'http://10.0.0.2:8080', token: TOKEN, cwd: '/srv/app' });
  const shown = listing(config);
  assert.match(shown, /\* box\s+10\.0\.0\.2:8080 {2}\/srv\/app/);
  assert.match(shown, /^ {2}local/m);
  assert(!shown.includes(TOKEN));
  assert.equal(applyConfig(config, { default: 'local' }).config.default, 'local');
  assert.throws(() => applyConfig(config, { default: 'nope' }), /no runtime named nope/);
  const removed = applyConfig(config, { remove: 'box' });
  assert.equal(removed.config.default, 'local');
  assert.match(removed.message, /default is local again/);
});

test('runtimes are stored owner-only and resolved by name or default', t => {
  const home = temp(t);
  assert.deepEqual(resolveRuntime(home), { kind: 'local' });
  writeRuntimes(home, { default: 'box', runtimes: { box: { url: 'http://10.0.0.2:8080', token: TOKEN } } });
  assert.equal(statSync(join(home, 'runtimes.json')).mode & 0o777, 0o600);
  assert.deepEqual(resolveRuntime(home), { kind: 'remote', alias: 'box', target: { url: 'http://10.0.0.2:8080', token: TOKEN } });
  assert.deepEqual(resolveRuntime(home, 'local'), { kind: 'local' });
  assert.throws(() => resolveRuntime(home, 'other'), /no runtime named other/);
  writeRuntimes(home, { default: 'gone', runtimes: {} });
  assert.throws(() => resolveRuntime(home), /default runtime "gone" is not configured/);
  writeFileSync(join(home, 'runtimes.json'), '{oops');
  assert.throws(() => readRuntimes(home), /not valid JSON/);
});

test('dscode server needs a port and keeps one owner-only token until told otherwise', t => {
  const home = temp(t);
  assert.deepEqual(parseServerArgs(['--port', '8080']), { bind: '0.0.0.0', rotate: false, port: 8080 });
  assert.throws(() => parseServerArgs([]), /--port is required/);
  assert.throws(() => parseServerArgs(['--port', '70000']), /TCP port/);
  assert.throws(() => parseServerArgs(['--port', '8080', '--bogus']), /unknown option/);
  const first = serverToken(home);
  assert.match(first, /^dsk_[\w-]{32}$/);
  assert.equal(statSync(serverTokenFile(home)).mode & 0o777, 0o600);
  assert.equal(serverToken(home), first);
  const rotated = serverToken(home, { rotate: true });
  assert.notEqual(rotated, first);
  assert.equal(serverToken(home, { wanted: TOKEN }), TOKEN);
  assert.equal(serverToken(home), TOKEN);
  assert.throws(() => serverToken(home, { wanted: 'short' }), /at least 16/);
});

test('a remote terminal sends readable local files as content and leaves other paths to the Host', async t => {
  const dir = temp(t);
  const shot = join(dir, 'shot.png');
  writeFileSync(shot, PNG);
  const calls = [];
  const runtime = {
    sharesFilesystem: false,
    async call(name, args) {
      calls.push({ name, args });
      if (name === 'attachments/inspectImageData') return args.items.map(item => ({ path: item.path, name: item.name, mediaType: 'image/png', bytes: item.bytes }));
      if (name === 'attachments/inspectImages') return args.paths.map(path => ({ path: `/srv/${path}`, name: path, mediaType: 'image/png', bytes: 1 }));
      if (name === 'attachments/saveImageData') return args.items.map(item => ({ type: 'image', attachment: { from: 'content', name: item.name } }));
      if (name === 'attachments/saveImages') return args.paths.map(path => ({ type: 'image', attachment: { from: 'host', path } }));
      throw Error(`unexpected ${name}`);
    },
  };
  const client = attachmentClient(runtime, () => '/srv/app');
  const inspected = await client.inspectImages(['server-only.png', shot]);
  assert.deepEqual(inspected.map(row => row.path), ['/srv/server-only.png', shot]);
  const sent = calls.find(entry => entry.name === 'attachments/inspectImageData').args.items[0];
  assert.equal(sent.bytes, PNG.length);
  assert.equal(Buffer.from(sent.signature, 'base64').subarray(0, 8).toString('hex'), PNG.subarray(0, 8).toString('hex'));
  assert.deepEqual(calls.find(entry => entry.name === 'attachments/inspectImages').args, { paths: ['server-only.png'], cwd: '/srv/app' });
  const blocks = await client.prepareImages([shot, '/srv/other.png']);
  assert.deepEqual(blocks.map(block => block.attachment.from), ['content', 'host']);
  assert.equal(Buffer.from(calls.find(entry => entry.name === 'attachments/saveImageData').args.items[0].data, 'base64').equals(PNG), true);
});

test('a terminal sharing the Host filesystem passes paths through unchanged', async () => {
  const calls = [];
  const client = attachmentClient({ sharesFilesystem: true, call: async (name, args) => { calls.push({ name, args }); return []; } }, () => '/w');
  await client.inspectFiles(['a.txt']);
  await client.prepareFiles(['/w/a.txt']);
  assert.deepEqual(calls, [{ name: 'attachments/inspectFiles', args: { paths: ['a.txt'], cwd: '/w' } }, { name: 'attachments/saveFiles', args: { paths: ['/w/a.txt'] } }]);
});

test('content attachments meet the same limits as paths', async () => {
  const store = {
    imageLimits: { maxImagesPerMessage: 2, maxImageBytes: 100, maxMessageImageBytes: 150, mediaTypes: ['image/png'] },
    saveImages: async inputs => inputs.map(input => ({ id: input.name, mediaType: input.mediaType })),
  };
  const fact = (name, bytes, signature = PNG.subarray(0, 16)) => ({ path: `/local/${name}`, name, bytes, signature });
  assert.deepEqual(inspectImageFacts([fact('a.png', 70)], store), [{ path: '/local/a.png', name: 'a.png', mediaType: 'image/png', bytes: 70 }]);
  assert.throws(() => inspectImageFacts([fact('a', 1), fact('b', 1), fact('c', 1)], store), /too many images/);
  assert.throws(() => inspectImageFacts([fact('big.png', 101)], store), /limit 100/);
  assert.throws(() => inspectImageFacts([fact('a.png', 80), fact('b.png', 80)], store), /image batch is 160 bytes/);
  assert.throws(() => inspectImageFacts([fact('x.png', 10, Buffer.from('not an image'))], store), /unsupported image file/);
  assert.throws(() => inspectFileFacts([{ path: '/l/f', name: 'f', bytes: 9 * 1024 * 1024 }], store), /limit/);
  assert.deepEqual(await saveImageData([{ name: 'a.png', data: PNG }], store), [{ type: 'image', attachment: { id: 'a.png', mediaType: 'image/png' } }]);
  await assert.rejects(saveImageData([{ name: 'a.txt', data: Buffer.from('text') }], store), /unsupported image file "a.txt"/);
});

test('long-lived streams reopen after a connection failure but not after an operation failure', async () => {
  assert.equal(retryable(Object.assign(Error('socket hang up'), { code: 'ECONNRESET' })), true);
  assert.equal(retryable(Object.assign(Error('no'), { code: 'dscode/unknown-stream' })), false);
  assert.equal(retryable(Object.assign(Error('no'), { remote: { code: 'x' } })), false);
  const controller = new AbortController();
  let opens = 0;
  const seen = [];
  // The reconnect pause is unref'd so a quitting terminal never waits on it; with nothing
  // else pending, Node 22's runner would end the test inside that pause.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await resilient(() => (async function* () {
      opens += 1;
      if (opens === 1) { yield 'a'; throw Object.assign(Error('reset'), { code: 'ECONNRESET' }); }
      yield 'b';
      controller.abort();
    })(), controller.signal, (item, reopened) => seen.push([item, reopened]));
  } finally { clearInterval(keepAlive); }
  assert.deepEqual(seen, [['a', false], ['b', true]]);
  await assert.rejects(resilient(() => (async function* () { throw Object.assign(Error('gone'), { code: 'dscode/unknown-stream' }); })(), new AbortController().signal, () => {}), /gone/);
});
