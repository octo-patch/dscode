import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setImmediate as turn } from 'node:timers/promises';
import { createSplitStdin } from '../packages/tui/src/input-split.ts';

function input() {
  const source = new PassThrough();
  Object.assign(source, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const split = createSplitStdin(source);
  const units = [];
  split.stdin.on('readable', () => {
    let value;
    while ((value = split.stdin.read()) !== null) units.push(value);
  });
  return { source, split, units, close() { split.dispose(); source.destroy(); } };
}

test('input bursts preserve order, split escape keys and atomic bracketed pastes', async () => {
  const ui = input();
  try {
    const text = '世界🐋'.repeat(40);
    const paste = '\x1b[200~line one\rline two\n\x1b[A\x1b[201~';
    ui.source.write(text + '\x1b[');
    ui.source.write('D\r' + paste.slice(0, 14));
    ui.source.write(paste.slice(14) + '\r');
    for (let n = 0; n < 100 && ui.units.length < [...text].length + 4; n++) await turn();
    assert.deepEqual(ui.units, [...text, '\x1b[D', '\r', paste, '\r']);
  } finally { ui.close(); }
});

test('disposing an input stream stops the remaining queued burst', async () => {
  const ui = input();
  try {
    ui.source.write('queued text '.repeat(100));
    for (let n = 0; n < 10 && ui.units.length === 0; n++) await turn();
    assert(ui.units.length > 0 && ui.units.length < 1200);
    ui.split.dispose();
    const received = [...ui.units];
    ui.source.write('should not arrive');
    await turn(); await turn();
    assert.deepEqual(ui.units, received);
  } finally { ui.close(); }
});
