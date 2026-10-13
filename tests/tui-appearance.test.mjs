process.env.DSCODE_UPDATE_CHECK = 'off';
process.env.DSCODE_LANGUAGE = 'en';

import test from 'node:test';
import assert from 'node:assert/strict';
import { Header, welcomeHeaderRows, DscodeCompactionLine, StatusLine } from '../packages/tui/src/app.ts';
import { dscodeChatLines } from '../packages/tui/src/dscode/chat.ts';
import { dscodeTelemetryNodes } from '../packages/tui/src/dscode/telemetry.ts';
import { createTranscriptView } from '../packages/tui/src/render/projection.ts';
import { layoutStatusBar, DEFAULT_STATUSLINE_ITEMS } from '../packages/tui/src/render/status.ts';
import { getPalette, inkColor, setTheme } from '../packages/tui/src/theme.ts';
import { mount, assertFits, tick } from './fixtures/tui-mount.mjs';

test('default welcome retains the framed identity, project and shared shortcuts', async () => {
  for (const theme of ['dark', 'light', 'auto']) for (const columns of [48, 80, 120]) {
    setTheme(theme);
    const ui = await mount(Header, { cwd: '/workspace/dscode', model: 'hidden-model', effort: 'hidden-effort' }, { columns, rows: 24 });
    try {
      assertFits(ui);
      assert.equal(ui.frame().trimEnd().split('\n').length, welcomeHeaderRows(columns, 24));
      assert.match(ui.frame(), /╭/);
      assert.match(ui.frame(), /DSCODE/);
      assert.match(ui.frame(), /dscode/);
      assert.match(ui.frame(), /Ctrl\+O/);
      assert.match(ui.frame(), /hidden-model/);
    } finally { ui.close(); }
  }
  setTheme('dark');
});

test('decorative themes retain the large welcome artwork', async () => {
  for (const theme of ['prismatic', 'rainbow']) {
    setTheme(theme);
    const ui = await mount(Header, { cwd: '/workspace/dscode', model: 'deepseek-flash', effort: 'high' }, { columns: 80, rows: 30 });
    try {
      assertFits(ui);
      assert.match(ui.frame(), /╭/);
      assert.match(ui.frame(), /deepseek-flash/);
      assert(ui.frame().split('\n').length > 10);
    } finally { ui.close(); }
  }
  setTheme('dark');
});

test('quiet replies share the streaming indent and use one blank row between turns', () => {
  const entry = { kind: 'assistant', time: Date.now(), text: 'Clear answer', reasoning: 'private reasoning', turnEnded: true };
  const rows = dscodeChatLines(entry, 80);
  assert.equal(rows[0].segments.map(part => part.text).join(''), '  Clear answer');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1].segments, []);
  assert(rows.every(row => row.segments.every(part => !part.text.includes('─'))));
});

test('file rows highlight only the mark and keep counts secondary', () => {
  const entry = { kind: 'tool', name: 'edit', state: 'done', detail: { kind: 'diff', diffs: [{ path: 'src/main.ts', lines: [{ mark: '-', text: 'old' }, { mark: '+', text: 'new' }], truncated: false }] } };
  const rows = dscodeChatLines(entry, 80);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].segments.map(part => [part.text, part.style]), [['✓ ', 'success'], ['src/main.ts', 'plain'], [' +1 −1', 'dim']]);
  for (const width of [1, 2]) assert(dscodeChatLines(entry, width)[0].segments.map(part => part.text).join('').length <= width);
});

test('ordinary telemetry uses neutral numbers while colourful themes retain tiers', () => {
  for (const theme of ['dark', 'light']) {
    setTheme(theme);
    const nodes = dscodeTelemetryNodes('25.0 tps · 70.0% cache', 'test', true);
    const tinted = nodes.filter(node => node.props.color !== undefined);
    assert(tinted.length > 0);
    assert(tinted.every(node => node.props.color === inkColor(getPalette().text)));
  }
  setTheme('prismatic');
  assert(dscodeTelemetryNodes('25.0 tps', 'test').some(node => node.props.color === inkColor(getPalette().warn)));
  setTheme('dark');
});

test('default compaction is one line while expressive compaction retains the board', async () => {
  for (const theme of ['dark', 'prismatic']) {
    setTheme(theme);
    const ui = await mount(DscodeCompactionLine, { since: Date.now(), rows: 5, animated: false }, { columns: 80 });
    try {
      assertFits(ui);
      assert.match(ui.frame(), /Compacting/);
      assert.equal(ui.frame().split('\n').length, theme === 'dark' ? 1 : 5);
    } finally { ui.close(); }
  }
  setTheme('dark');
});

test('permission stays visible without a standing shortcut hint, even beside a long title', () => {
  const facts = { title: 'A very long session title '.repeat(4), model: 'deepseek-official/deepseek-flash', effort: 'high', cwd: 'dscode', branch: 'main', sessionId: '123', sandbox: '', permission: 'accept-edits' };
  for (const columns of [32, 48, 80, 120]) {
    const layout = layoutStatusBar(facts, createTranscriptView().stats, columns);
    assert.equal(layout.row1.hint, false);
    assert.equal(layout.row1.right.at(-1)?.text, 'accept-edits');
  }
});

test('the default footer does not animate another spinner or repeat unknown TPS', async () => {
  const ui = await mount(StatusLine, {
    facts: { title: 'Work', model: 'deepseek-official/deepseek-flash', cwd: '', branch: '', sessionId: 'a', fullSessionId: 'appearance', permission: 'auto', sandbox: '' },
    stats: createTranscriptView().stats, busy: true, columns: 80, items: DEFAULT_STATUSLINE_ITEMS, animated: true,
  }, { columns: 80 });
  try {
    await tick(150);
    assertFits(ui);
    assert.doesNotMatch(ui.frame(), /[◌⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|-- tps avg|shift\+tab/);
    assert.match(ui.frame(), /-- tps/);
  } finally { ui.close(); }
});
