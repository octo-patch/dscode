import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { patchInkLogUpdate } from '../scripts/patch-ink.mjs';

// Patch an in-memory copy: fresh installs and provisioned trees exercise the same ledger.
const source = patchInkLogUpdate(readFileSync(new URL('../node_modules/ink/build/log-update.js', import.meta.url), 'utf8'))
  .replace(/from '([^']+)'/g, (_match, name) => `from '${import.meta.resolve(name)}'`)
  // The patched in-memory module has no matching source map. Node 22.19's
  // coverage loader throws when it resolves a relative map against a data URL.
  .replace(/^\/\/# sourceMappingURL=.*$/gm, '');
const { default: logUpdate } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

test('an explicit screen replay forgets the old height and releases its reset listener', () => {
  const stream = new EventEmitter();
  const writes = [];
  stream.write = text => writes.push(text);
  const log = logUpdate.create(stream, { showCursor: true });
  log(Array.from({ length: 30 }, () => 'old').join('\n'));
  stream.emit('dscode:frame-reset');
  log.clear();
  log('new', 5);
  assert.equal(writes.at(-1).split('\n').length - 1, 1, 'old padding must not displace the new welcome card');
  assert.equal(stream.listenerCount('dscode:frame-reset'), 1);
  log.done();
  assert.equal(stream.listenerCount('dscode:frame-reset'), 0);
});

/**
 * The composer sits at the bottom of Ink's dynamic frame, so "the composer never rides up"
 * means "the emitted block never loses height". One write advances the cursor by its padding
 * plus its own newlines, which is the number the ledger keeps monotonic.
 */
test('the frame ledger keeps the composer from riding up across a static flush', () => {
  const writes = [];
  const log = logUpdate.create({ write: chunk => { writes.push(chunk); } }, { showCursor: true });
  const advance = () => writes.at(-1).split('\n').length - 1;
  let staticRows = 0;
  let row = 0;
  const step = (output, flush = 0) => {
    if (flush > 0) {
      log.clear();
      staticRows += flush;
      log(output, flush); // ink.js reports the rows the static write consumed
    } else log(output);
    const next = staticRows + advance();
    assert(next >= row, 'the composer rode up: ' + row + ' -> ' + next);
    row = next;
    return advance();
  };
  // Six rows, then a flush that writes one row while the frame shrinks to one: without the
  // reserved rows the block would fall from six to two and the composer would ride up.
  assert.equal(step('l1\nl2\nl3\nl4\nl5\nl6'), 6, 'six rows fill a six-row block');
  // Only the rows a flush did NOT consume stay reserved: the row it wrote is consumed by
  // the flush itself, so the block is one row shorter instead of parking the freed live
  // region as a band of blank rows for the next stream to refill.
  assert.equal(step('s1', 1), 5, 'the flushed row is consumed, not reserved a second time');
  // Streaming again inside the same flush keeps the floor.
  step('t1\nt2');
  // An ordinary shrink without a flush is still padded by the ledger.
  step('u1');
  // A taller frame grows the block, and the next flush keeps that height too.
  step('v1\nv2\nv3\nv4\nv5\nv6\nv7\nv8');
  step('w1', 2);
  // A flush that carries as many rows as the frame gave up leaves no band at all.
  assert.equal(step('y1', 5), 1, 'a covered shrink leaves no blank band above the frame');
});
