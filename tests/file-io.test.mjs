import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { apply as observationPolicy } from '@deepseek-ai/dsh-fs-observation-policy';
import { applyBatchEdits, readWindow, createReadWindowCache } from '../scripts/file-io.mjs';
import { patchFileTools, patchLocalFileIO } from '../scripts/patch-file-io.mjs';
import { createTestRuntime } from '../scripts/test-runtime.mjs';
import { toolResultDetail } from '../packages/tui/src/render/tool-detail.ts';

const runtime = createTestRuntime({ runtime: true });
after(runtime.close);
const load = name => import(pathToFileURL(`${runtime.root}/node_modules/@deepseek-ai/${name}/lib/index.js`));
const { LocalFileSystem } = await load('dsh-fs-local');
const { apply: fileTools } = await load('dsh-tool-fs');
const request = { offset: 1, limit: 2, maxLineLength: 2000, maxBytes: 50 * 1024 };

test('read stops after a page, closes its iterator and reports only known totals', async () => {
  let chunks = 0, closed = false;
  async function* source() {
    try { for (let i = 0; i < 10000; i++) { chunks++; yield 'alpha\nbeta\ngamma\n'; } }
    finally { closed = true; }
  }
  assert.deepEqual(await readWindow(source(), request, '/sample'), {
    lines: [{ number: 1, text: 'alpha' }, { number: 2, text: 'beta' }], hasMore: true, truncatedByBytes: false,
  });
  assert.equal(chunks, 1); assert(closed);
  const eof = await readWindow(['alpha\nbeta\n'], request, '/sample');
  assert.equal(eof.totalLines, 2); assert.equal(eof.hasMore, false);
  const empty = await readWindow([], request, '/sample');
  assert.equal(empty.totalLines, 0);
  await assert.rejects(readWindow(['one'], { ...request, offset: 2 }, '/sample'), /out of range/);
});

test('read preserves chunked CRLF, Unicode, blank lines and bounds long lines and bytes', async () => {
  const value = await readWindow(['a\r', '\n中', '文\n', '\nend'], { ...request, offset: 2, limit: 4 }, '/sample');
  assert.deepEqual(value.lines, [{ number: 2, text: '中文' }, { number: 3, text: '' }, { number: 4, text: 'end' }]);
  assert.equal(value.totalLines, 4);
  const long = await readWindow(['x'.repeat(100000), '\nrest'], { ...request, limit: 1 }, '/sample');
  assert(long.lines[0].text.length < 2100); assert.equal(long.hasMore, true);
  const bytes = await readWindow(['中文\nsecond\nthird'], { ...request, maxBytes: 6 }, '/sample');
  assert.equal(bytes.lines.length, 1); assert.equal(bytes.truncatedByBytes, true);
});

test('page cache isolates sessions, bounds entries/bytes and protects cached values', () => {
  const cache = createReadWindowCache(80, 2), owner = {}, peer = {};
  cache.set(owner, 'one', { lines: ['one'] });
  const copy = cache.get(owner, 'one'); copy.lines[0] = 'mutated';
  assert.equal(cache.get(owner, 'one').lines[0], 'one');
  assert.equal(cache.get(peer, 'one'), undefined);
  cache.set(owner, 'two', { lines: ['two'] }); cache.get(owner, 'one');
  cache.set(owner, 'three', { lines: ['three'] });
  assert.equal(cache.get(owner, 'two'), undefined);
  cache.set(owner, 'huge', { text: 'x'.repeat(100) });
  assert.equal(cache.get(owner, 'huge'), undefined);
  cache.set(undefined, 'x', {}); assert.equal(cache.get(undefined, 'x'), undefined);
  const byteCache = createReadWindowCache(40, 100);
  byteCache.set(owner, '1', { text: 'x'.repeat(20) }); byteCache.set(owner, '2', { text: 'x'.repeat(20) });
  assert.equal(byteCache.get(owner, '1'), undefined);
});

test('batch matching uses the original file and rejects ambiguity, overlaps and invalid input', () => {
  const edit = (oldString, newString) => ({ oldString, newString });
  assert.equal(applyBatchEdits('one two', [edit('one', 'two'), edit('two', 'three')], '/sample').content, 'two three');
  assert.equal(applyBatchEdits('ab', [edit('a', ''), edit('b', 'B')], '/sample').content, 'B');
  assert.equal(applyBatchEdits('a\nb', [edit('a\r\nb', 'A\r\nB')], '/sample').content, 'A\nB');
  for (const edits of [[], Array(101).fill(edit('a', 'b')), [edit('', 'b')], [edit('a', 'a')], [{}], [edit('absent', 'x')]]) {
    assert.throws(() => applyBatchEdits('abc', edits, '/sample'));
  }
  assert.throws(() => applyBatchEdits('aaa', [edit('aa', 'x')], '/sample'), /not unique/);
  assert.throws(() => applyBatchEdits('abc', [edit('ab', 'x'), edit('bc', 'y')], '/sample'), /overlap/);
});

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dscode-io-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fs = new LocalFileSystem(new Context(), { cwd: dir, diffBasisMaxBytes: 1048576 });
  const tools = new Map(), handlers = new Map();
  let streams = 0;
  const streamText = fs.streamText.bind(fs);
  fs.streamText = (...args) => { streams++; return streamText(...args); };
  const ctx = {
    fs, tools: { register: tool => tools.set(tool.name, tool), get: name => tools.get(name) },
    systemPrompt: { section() {}, getSectionOrder: () => 1 },
    workingDirectory: { ensure: async () => dir },
    effect() {}, on: (event, handler) => handlers.set(event, handler),
    emit: (event, ...args) => handlers.get(event)?.(...args),
    waterfall: (event, ...args) => handlers.get(event)?.(...args), get() {},
  };
  observationPolicy(ctx);
  fileTools(ctx, { read: true, edit: true, write: true, readImage: false, readLimit: 2000, readMaxLineLength: 2000, readMaxBytes: 51200, readStreamMinSize: 10485760 });
  const exec = { agent: { session: {} }, signal: new AbortController().signal };
  const run = (name, args, execution = exec) => tools.get(name).execute(args, execution);
  return { fs, dir, tools, exec, run, get streams() { return streams; } };
}

test('real file tools cache unchanged pages, invalidate edits and external changes, and preserve session guards', async t => {
  const h = await harness(t), file = join(h.dir, 'test.txt');
  await writeFile(file, 'one\ntwo\nthree\n', { mode: 0o640 });
  const args = { file_path: file, offset: 1, limit: 1 };
  const batch = { file_path: file, edits: [{ old_string: 'one', new_string: 'ONE' }, { old_string: 'three', new_string: 'THREE' }] };
  await assert.rejects(h.run('edit_many', batch), /not been read/);
  const first = await h.run('read', args);
  assert.equal(first.totalLines, undefined); assert.equal(first.hasMore, true);
  const tool = h.tools.get('read');
  assert.match(tool.output.render(args, first)[0].text, /more content remains/);
  assert.equal(toolResultDetail(tool.output.presentationMeta(args, first), '').kind, 'read');
  await h.run('read', args); assert.equal(h.streams, 1);
  let commits = 0;
  h.fs.internals.inspectTemp = () => { commits++; };
  const changed = await h.run('edit_many', batch);
  assert.equal(commits, 1); assert.equal(changed.after, 'ONE\ntwo\nTHREE\n');
  assert.equal((await stat(file)).mode & 0o777, 0o640);
  assert.match(h.tools.get('edit_many').output.render(batch, changed)[0].text, /updated/);
  const meta = h.tools.get('edit_many').output.presentationMeta(batch, changed);
  assert(meta.diffs.some(diff => diff.newText.includes('THREE')));
  assert.equal((await h.run('read', args)).lines[0].text, 'ONE'); assert.equal(h.streams, 2);
  await writeFile(file, 'external\n');
  await assert.rejects(h.run('edit_many', batch), /re-read/);
  assert.equal((await h.run('read', args)).lines[0].text, 'external'); assert.equal(h.streams, 3);
  const peer = { ...h.exec, agent: { session: {} } };
  await assert.rejects(h.run('edit_many', { file_path: file, edits: [{ old_string: 'external', new_string: 'peer' }] }, peer), /not been read/);
  await h.run('read', args, peer); assert.equal(h.streams, 4);
  await assert.rejects(h.run('read', args, { ...h.exec, signal: AbortSignal.abort() }));
});

test('failed batches publish nothing; CRLF, symlinks and concurrent CAS keep provider semantics', async t => {
  const h = await harness(t), file = join(h.dir, 'test.txt'), alias = join(h.dir, 'alias.txt');
  await writeFile(file, 'one\r\ntwo\r\n'); await symlink(file, alias);
  await h.run('read', { file_path: alias });
  const invalid = { file_path: alias, edits: [{ old_string: 'one', new_string: 'ONE' }, { old_string: 'absent', new_string: 'x' }] };
  await assert.rejects(h.run('edit_many', invalid), /not found/);
  assert.equal(await readFile(file, 'utf8'), 'one\r\ntwo\r\n');
  const target = await h.fs.resolve(alias), expected = { version: (await h.fs.stat(target)).version };
  const results = await Promise.allSettled([
    h.fs.editText(target, { edits: [{ oldString: 'one', newString: 'ONE' }] }, expected),
    h.fs.editText(target, { edits: [{ oldString: 'two', newString: 'TWO' }] }, expected),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'FS_STALE_VERSION');
  assert.equal(await readFile(alias, 'utf8'), 'ONE\r\ntwo\r\n');
});

test('changes during a read are rejected and not cached or recorded as observed', async t => {
  const h = await harness(t), file = join(h.dir, 'test.txt');
  await writeFile(file, 'before\n');
  h.fs.streamText = async () => (async function* () { yield 'before\n'; await writeFile(file, 'after\n'); })();
  await assert.rejects(h.run('read', { file_path: file }), /changed while reading/);
  await assert.rejects(h.run('edit_many', { file_path: file, edits: [{ old_string: 'after', new_string: 'AFTER' }] }), /not been read/);
});

test('file patches are idempotent and reject unrecognized upstream code', async () => {
  for (const [name, patch] of [['dsh-tool-fs', patchFileTools], ['dsh-fs-local', patchLocalFileIO]]) {
    const source = await readFile(`${runtime.root}/node_modules/@deepseek-ai/${name}/lib/index.js`, 'utf8');
    assert.equal(patch(source), source);
    assert.throws(() => patch('wrong upstream'), /patch drift/);
  }
});
