process.env.DSCODE_UPDATE_CHECK = 'off';
process.env.DSCODE_LANGUAGE = 'en';
// This file runs an interactive in-memory TTY. Ink's CI mode suppresses live
// frames and resize listeners, even when stdout.isTTY is true. Keep the runner's
// CI environment from changing the terminal behavior these tests exercise.
process.env.CI = 'false';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { registerHooks } from 'node:module';
import { patchInkApp, patchInkLogUpdate } from '../scripts/patch-ink.mjs';
import xterm from '@xterm/headless';

import { createTranscriptView } from '../packages/tui/src/render/projection.ts';
import { setTheme } from '../packages/tui/src/theme.ts';
import { createSplitStdin } from '../packages/tui/src/input-split.ts';
// Exercise the shipped Ink patches without changing the developer's dependencies.
const hooks = registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  const patch = url.endsWith('/ink/build/log-update.js') ? patchInkLogUpdate
    : url.endsWith('/ink/build/ink.js') ? patchInkApp : undefined;
  return patch === undefined ? loaded : { ...loaded, source: patch(String(loaded.source)) };
} });
const { render } = await import('ink');
const { App } = await import('../packages/tui/src/app.ts');
hooks.deregister();
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

async function terminalApp(columns, rows, splitInput = false, overrides = {}) {
  const work = mkdtempSync(join(tmpdir(), 'dscode-layout-'));
  const saved = { DSCODE_HOME: process.env.DSCODE_HOME, DSCODE_EMAIL_DIR: process.env.DSCODE_EMAIL_DIR };
  process.env.DSCODE_HOME = work;
  process.env.DSCODE_EMAIL_DIR = join(work, 'email');
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const split = splitInput ? createSplitStdin(stdin) : undefined;
  Object.assign(stdout, { columns, rows, isTTY: true });
  const terminal = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true, convertEol: true });
  let pending = Promise.resolve();
  stdout.on('data', data => { pending = pending.then(() => new Promise(resolve => terminal.write(data.toString(), resolve))); });
  const errors = [];
  stderr.on('data', data => errors.push(data.toString()));
  const noop = () => {};
  const frozen = value => ({ getSnapshot: () => value, subscribe: () => noop });
  let view = createTranscriptView();
  const listeners = new Set();
  const empty = [];
  let mounted;
  const submitted = [];
  const props = {
    store: { getView: () => view, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, reset() { view = createTranscriptView(); for (const listener of listeners) listener(); } },
    approval: frozen({ pending: undefined, answered: false, queued: 0 }),
    questions: frozen({ pending: undefined }),
    subagents: { ...frozen(empty), getTotalSeen: () => 0 },
    btw: { list: () => empty, subscribe: () => noop },
    commands: { descriptors: empty, subscribe: () => noop },
    skills: { rows: empty, count: 0, subscribe: () => noop },
    model: 'deepseek-official/deepseek-flash', effort: 'high', cwd: 'dscode', workspaceRoot: '/workspace/dscode',
    branch: '', sessionId: 'layout', sessionKey: 'layout', resumed: false, mode: 'dscode', permission: 'auto',
    animations: false, history: empty, onBridgeReady: noop, recordHistory: noop, dispatch: text => submitted.push(text), steer: text => submitted.push(text), interrupt: () => false, quit: noop,
    createSession() {
      view = createTranscriptView();
      stdout.emit('dscode:frame-reset');
      stdout.write('\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[H');
      mounted.rerender(createElement(App, { ...props, key: 'new-session', sessionKey: 'new-session' }));
    },
    loadMentions: async () => [], inspectImages: async () => [], inspectFiles: async () => [],
    ...overrides,
  };
  setTheme('dark');
  mounted = render(createElement(App, props), { stdin: split?.stdin ?? stdin, stdout, stderr, patchConsole: false, exitOnCtrlC: false });
  const settle = async () => { await tick(180); await pending; assert.deepEqual(errors, []); };
  await settle();
  return {
    terminal,
    submitted,
    screen: () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) ?? ''),
    async resize(cols, height) { terminal.resize(cols, height); Object.assign(stdout, { columns: cols, rows: height }); stdout.emit('resize'); await settle(); },
    async write(text) { stdin.write(text); await settle(); },
    async update(changes) { view = { ...view, ...changes }; for (const listener of listeners) listener(); await settle(); },
    close() { mounted.unmount(); mounted.cleanup(); split?.dispose(); stdin.destroy(); stdout.destroy(); stderr.destroy(); terminal.dispose(); rmSync(work, { recursive: true, force: true }); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } },
  };
}

function assertBottom(ui) {
  const lines = ui.screen();
  assert.match(lines.at(-2), /cache/, lines.join('\n'));
  assert.equal(lines.at(-1), '');
}

test('startup occupies the viewport with its welcome card above bottom-pinned input', async () => {
  for (const [columns, rows] of [[48, 12], [48, 16], [80, 24], [80, 30], [120, 40]]) {
    const ui = await terminalApp(columns, rows);
    try {
      const lines = ui.screen();
      assert.match(lines[0], /╭/, lines.join('\n'));
      assert(lines.some(line => line.includes('DSCODE')));
      assertBottom(ui);
    } finally { ui.close(); }
  }
});

test('resize and explicit redraw retain one welcome card and the bottom input position', async () => {
  const ui = await terminalApp(80, 30);
  try {
    for (const [cols, rows] of [[120, 40], [64, 24], [48, 16], [80, 30]]) {
      await ui.resize(cols, rows);
      assertBottom(ui);
      assert.equal(ui.screen().filter(line => line.includes('╭')).length, 1, cols + 'x' + rows + '\n' + ui.screen().join('\n'));
      await ui.write('\x0c');
      assertBottom(ui);
      assert.match(ui.screen()[0], /╭/, ui.screen().join('\n')); 
    }
  } finally { ui.close(); }
});

test('streaming, settled scrollback, panels and clear keep the input anchored', async () => {
  const ui = await terminalApp(80, 30);
  try {
    await ui.update({ busy: true, busySince: Date.now(), streaming: 'A short live reply' });
    assertBottom(ui);
    assert(ui.screen().some(line => line.includes('A short live reply')));
    const entries = [{ kind: 'user', text: 'Check this layout', time: Date.now() }, { kind: 'assistant', text: 'A short live reply', reasoning: '', time: Date.now(), turnEnded: true }];
    await ui.update({ busy: false, streaming: '', entries });
    assertBottom(ui);
    await ui.write('/help');
    await ui.write('\r');
    assertBottom(ui);
    await ui.write('\x1b');
    assertBottom(ui);
    await ui.update({ entries: entries.concat(Array.from({ length: 30 }, (_, i) => ({ kind: 'assistant', text: 'Settled reply ' + i, reasoning: '', time: Date.now(), turnEnded: true }))) });
    assertBottom(ui);
    assert(ui.terminal.buffer.active.baseY > 0, 'long history must remain scrollable');
    assert(ui.screen().some(line => line.includes('Settled reply 29')));
    await ui.write('/clear');
    await ui.write('\r');
    assertBottom(ui);
    assert.match(ui.screen()[0], /╭/, ui.screen().join('\n')); 
  } finally { ui.close(); }
});

test('a long unbracketed input burst submits once without React update recursion', async t => {
  const warnings = [];
  t.mock.method(console, 'error', (...args) => warnings.push(args.join(' ')));
  const ui = await terminalApp(120, 36, true);
  try {
    const prompt = 'Check Unicode 世界 🐋 and preserve all input. '.repeat(8);
    await ui.write(prompt + '\r');
    for (let attempt = 0; attempt < 60 && ui.submitted.length === 0; attempt++) await tick(50);
    assert.deepEqual(ui.submitted, [prompt]);
    assert.deepEqual(warnings, []);
    assertBottom(ui);
  } finally { ui.close(); }
});

test('bracketed image pastes retain markers and deliver image blocks through the split terminal input', async () => {
  const inspected = [], delivered = [];
  const paths = ['/tmp/first.png', '/tmp/second image.png'];
  const blocks = paths.map(path => ({ type: 'image', url: `attachment:${path}` }));
  const ui = await terminalApp(120, 36, true, {
    inspectImages: async paths => {
      inspected.push(...paths);
      return paths.map(path => ({ path, name: path.split('/').at(-1), mediaType: 'image/png', bytes: 100 }));
    },
    prepareImages: async selected => { assert.deepEqual(selected, paths); return blocks; },
    dispatch: (...args) => delivered.push(args),
    steer: (...args) => delivered.push(args),
  });
  try {
    await ui.write(`\x1b[200~${paths[0]}\x1b[201~`);
    assert.match(ui.screen().join('\n'), /\[Image 1\]/);
    // A terminal may split the payload and the closing wrapper across reads.
    await ui.write(`\x1b[200~"${paths[1]}`);
    await ui.write('"\x1b[201~');
    assert.deepEqual(inspected, paths);
    assert.match(ui.screen().join('\n'), /\[Image 1\] \[Image 2\]/);
    await ui.write('\r');
    assert.deepEqual(delivered, [['[Image 1] [Image 2]', blocks, 'layout']], ui.screen().join('\n'));
  } finally { ui.close(); }
});

test('bracketed text is submitted without leftover terminal escape bytes', async () => {
  const ui = await terminalApp(120, 36, true);
  try {
    await ui.write('\x1b[200~explain this code\x1b[201~');
    await ui.write('\r');
    assert.deepEqual(ui.submitted, ['explain this code']);
  } finally { ui.close(); }
});
