process.env.DSCODE_UPDATE_CHECK = 'off';
process.env.DSCODE_LANGUAGE = 'en';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { Box, Text } from 'ink';
import { DscodeActivityLine, DiffPanel, ModelPanel, StreamTail, VerbosePanel } from '../packages/tui/src/app.ts';
import { createChatLinesCache, dscodeChatLines } from '../packages/tui/src/dscode/chat.ts';
import { DelegateDashboardPanel } from '../packages/tui/src/dscode/delegate-panel.ts';
import { createDisplayTailCache, displayTail } from '../packages/tui/src/render/text.ts';
import { toolResultDetail } from '../packages/tui/src/render/tool-detail.ts';
import { panelViewport, layoutGutterRows } from '../packages/tui/src/render/inspector.ts';
import { visibleColumns } from '../packages/tui/src/render/markdown.ts';
import { setLanguage } from '../packages/tui/src/i18n.ts';
import { mount, assertFits } from './fixtures/tui-mount.mjs';

const textOf = lines => lines.map(row => row.segments.map(segment => segment.text).join('')).join('\n');
const tool = (overrides = {}) => ({
  kind: 'tool', name: 'bash', callId: 'call1', ordinal: 1, time: 1000,
  arguments: '{}', preview: 'npm test', prompt: '', state: 'done', summary: '',
  detail: undefined, subs: [], subsDropped: 0, ...overrides,
});

test('quiet chat keeps bounded, safe failures visible while successful reads stay quiet', () => {
  for (const columns of [12, 48, 80]) {
    const failure = tool({ name: 'bash\x1b[2J', state: 'error', summary: 'Timed out\n' + 'details '.repeat(200) });
    const lines = dscodeChatLines(failure, columns);
    const text = textOf(lines);
    assert.match(text, /⨯/);
    assert.doesNotMatch(text, /\x1b/);
    assert(lines.every(row => visibleColumns(textOf([row])) <= columns));
    assert(lines.some(row => row.segments.some(segment => segment.style === 'error')));
    assert.deepEqual(dscodeChatLines(tool({ name: 'read' }), columns), []);
  }
  assert.equal(textOf(dscodeChatLines(tool({ state: 'error', summary: 'Timed out' }), 80)), '⨯ bash [1]: Timed out');
});

test('file mutations show counts when folded and real diff lines when expanded', () => {
  const detail = toolResultDetail({ diffs: [
    { path: 'src/a.ts', oldText: 'const a = 1\n', newText: 'const a = 2\n' },
    { path: 'src/new.ts', oldText: null, newText: 'export const b = 1\nexport const c = 2\n' },
  ] }, 'Updated files');
  const entry = tool({ name: 'edit', detail });
  const folded = textOf(dscodeChatLines(entry, 80));
  assert.match(folded, /src\/a.ts \+1 −1/);
  assert.match(folded, /src\/new.ts \+2 −0/);
  assert.doesNotMatch(folded, /const a/);
  assert.equal(folded.split('\n').length, 2, 'one line per file without repeated expansion hints');
  const expanded = dscodeChatLines(entry, 80, true);
  assert.match(textOf(expanded), /-const a = 1/);
  assert.match(textOf(expanded), /\+const a = 2/);
  assert(expanded.some(row => row.segments.some(segment => segment.style === 'diffAdd')));
  assert(expanded.some(row => row.segments.some(segment => segment.style === 'diffDel')));
  assert.deepEqual(dscodeChatLines(tool({ name: 'edit', detail, state: 'running' }), 80), []);
  assert.doesNotMatch(textOf(dscodeChatLines(tool({ name: 'edit', detail, state: 'error' }), 80)), /✓/);
});

test('capped diff counts are labelled as shown and long paths fit the terminal', () => {
  const detail = toolResultDetail({ diffs: [{ path: 'very-long-path/'.repeat(50), oldText: null, newText: 'new line\n'.repeat(400) }] }, 'written');
  const cached = createChatLinesCache();
  const entry = tool({ name: 'write', detail });
  for (const language of ['en', 'zh-CN']) {
    setLanguage(language);
    try {
      const lines = cached(entry, 48);
      assert.match(textOf(lines), language === 'en' ? /\(shown\)/ : /已显示部分/);
      assert(lines.every(row => visibleColumns(textOf([row])) <= 48));
    } finally { setLanguage('en'); }
  }
});

test('incremental tails match fresh wrapping across every UTF-16 boundary', () => {
  const source = 'hello 世界（测试），e\u0301 👩🏽‍💻🇺🇸🇬🇧\n\tend\r\nnext 👨‍👩‍👧‍👦 \x1b[31m\n'.repeat(3);
  for (const columns of [1, 2, 8, 15, 80]) {
    const tail = createDisplayTailCache();
    for (let end = 0; end <= source.length; end++) {
      const text = source.slice(0, end);
      for (const rows of [1, 2, 7]) assert.deepEqual(tail(text, columns, rows), displayTail(text, columns, rows), `${columns}/${rows}/${end}`);
    }
  }
});

test('tail replacement, resize, reset, growth and repeated reads invalidate only appropriate state', () => {
  const tail = createDisplayTailCache();
  const long = 'Chinese 中文 and emoji 🐋\n'.repeat(1000);
  for (const [text, columns, rows] of [
    [long, 80, 10], [long + 'last', 80, 10], [long + 'last', 80, 1],
    [long + 'last', 48, 6], ['replacement', 48, 6], ['', 48, 6],
    ['new\n', 48, 6], ['new\n\n', 48, 1], [long, 100, 30],
  ]) assert.deepEqual(tail(text, columns, rows), displayTail(text, columns, rows));
});

test('mounted stream preserves its tail through appends and resize', async () => {
  const props = { text: '世界 hello\n'.repeat(40), dim: false, maxRows: 5, prefix: '  ' };
  const ui = await mount(StreamTail, props, { columns: 80, rows: 24 });
  try {
    await ui.rerender({ ...props, text: props.text + 'latest 🐋' });
    assert.match(ui.frame(), /latest 🐋/);
    assert(ui.frame().split('\n').length <= 5);
    assertFits(ui);
    // Historical frames use the old width; check the resized frame itself.
    await ui.resize(24, 16);
    await ui.rerender({ ...props, text: props.text + 'latest 🐋 more' });
    assert(ui.frame().split('\n').every(row => visibleColumns(row) <= 24));
    assert.match(ui.frame(), /latest 🐋 more/);
  } finally { ui.close(); }
});

test('activity shows the target and current tool time instead of borrowing the turn time', async () => {
  const ui = await mount(DscodeActivityLine, {
    entries: [tool({ name: 'read', preview: 'src/cart.ts', state: 'running', time: Date.now() - 2000 })],
    streaming: false, since: Date.now() - 60000, animated: false,
  }, { columns: 80 });
  try {
    assertFits(ui);
    assert.match(ui.frame(), /read · src\/cart.ts/);
    assert.match(ui.frame(), /tool 2s/);
    assert.doesNotMatch(ui.frame(), /this turn/);
    assert.match(ui.frame(), /Esc to interrupt/);
  } finally { ui.close(); }
});

// Include the largest persistent chrome beside each actual panel, not just a
// formula check: increasing panel height must not move the input offscreen.
function WithChrome({ Panel, props, rows }) {
  return createElement(Box, { flexDirection: 'column' },
    createElement(Panel, props),
    layoutGutterRows(rows) ? createElement(Text, null, ' ') : undefined,
    createElement(Text, null, 'notice\ncomposer top\n> draft\ncomposer bottom\nstatus 1\nstatus 2\nstatus 3'),
  );
}

test('details use spare height and leave chrome visible; paging and close still work', async () => {
  for (const rows of [16, 24, 40]) {
    const viewport = panelViewport(80, rows);
    assert(viewport.bodyRows >= (rows === 16 ? 2 : rows === 24 ? 10 : 24));
    let closed = 0;
    const entry = tool({ summary: Array.from({ length: 60 }, (_, i) => `output row ${i}`).join('\n') });
    const ui = await mount(WithChrome, { Panel: VerbosePanel, props: { entries: [entry], onClose: () => closed++ }, rows }, { columns: 80, rows });
    try {
      assertFits(ui);
      assert(ui.frame().split('\n').length <= rows - 2, ui.frame());
      assert.match(ui.frame(), /> draft/);
      const first = ui.frame();
      await ui.write('\x1b[6~');
      assert.notEqual(ui.frame(), first);
      await ui.write('q');
      assert.equal(closed, 1);
    } finally { ui.close(); }
  }
});

test('model, diff and delegation panels fit with chrome at short and ordinary heights', async () => {
  for (const rows of [16, 24, 40]) for (const Panel of [ModelPanel, DiffPanel, DelegateDashboardPanel]) {
    const props = Panel === DiffPanel
      ? { view: { title: 'Changes', files: [{ path: 'src/a.ts', lines: Array.from({ length: 60 }, (_, i) => `+line ${i}`) }] }, onClose() {} }
      : Panel === DelegateDashboardPanel
      ? { load: () => ({ running: 1, limit: 3, columns: { pending: [], running: [{ id: 't1', child: 'worker', title: 'Do work' }], verifying: [], complete: [] } }), close() {} }
      : { directory: { failures: [], rows: Array.from({ length: 60 }, (_, i) => ({ provider: 'deepseek-official', providerName: 'DeepSeek', model: `m${i}`, modelName: `Model ${i}` })) }, current: 'deepseek-official/m0', onSelect() {}, onClose() {}, onRetry() {} };
    const ui = await mount(WithChrome, { Panel, props, rows }, { columns: 80, rows });
    try {
      assertFits(ui);
      assert(ui.frame().split('\n').length <= rows - 2, ui.frame());
      assert.match(ui.frame(), /status 3/);
    } finally { ui.close(); }
  }
});
