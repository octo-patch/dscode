import test from 'node:test';
import assert from 'node:assert/strict';
import { mirrorStatusSources, subscribeRevisions } from '../packages/tui/src/runtime/views.ts';
import { metricData } from '../plugins/session-metrics/view.mjs';
import { speedLabel } from '../plugins/openai/speed.mjs';
import { delegateBoardFor } from '../plugins/dscode/board.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

// A runtime whose streams replay scripted items and record what was opened.
function scriptedRuntime(items) {
  const opened = [];
  return {
    opened,
    stream(name, args, signal) {
      opened.push({ name, args });
      return (async function* () {
        for (const item of items[name] ?? []) yield item;
        await new Promise(resolve => signal?.addEventListener('abort', resolve, { once: true }));
      })();
    },
  };
}

test('a separate terminal mirrors the Host footer sources for the followed session only', async () => {
  const state = { metrics: { rows: [{ cost: 0.5 }] }, speed: 'Fast', board: { columns: { pending: [] }, running: 1, limit: 4 } };
  const runtime = scriptedRuntime({ 'status/watch': [state] });
  const mirror = mirrorStatusSources(runtime);
  try {
    mirror.follow('session-a');
    for (let i = 0; i < 20 && metricData('session-a') === undefined; i++) await tick();
    assert.deepEqual(metricData('session-a'), state.metrics);
    assert.deepEqual(delegateBoardFor('session-a'), state.board);
    assert.equal(metricData('session-b'), undefined, 'another session is not answered from this cache');
    // The speed source retargets the stream when the model label changes.
    speedLabel('session-a', 'fixture/fixture-b');
    for (let i = 0; i < 20 && speedLabel('session-a', 'fixture/fixture-b') !== 'Fast'; i++) await tick();
    assert.equal(speedLabel('session-a', 'fixture/fixture-b'), 'Fast');
    assert.deepEqual(runtime.opened.at(-1), { name: 'status/watch', args: { sessionId: 'session-a', modelLabel: 'fixture/fixture-b' } });
  } finally { mirror.dispose(); }
  assert.equal(metricData('session-a'), undefined, 'dispose releases the sources');
});

test('revision subscriptions skip the opening revision and report each later change', async () => {
  const runtime = scriptedRuntime({ 'providers/watch': [0, 1, 2] });
  let changes = 0;
  const off = subscribeRevisions(runtime, 'providers/watch', () => { changes += 1; });
  for (let i = 0; i < 20 && changes < 2; i++) await tick();
  off();
  assert.equal(changes, 2);
});
