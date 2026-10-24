import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { LinuxHelperClient } from '../plugins/computer-use/linux/client.mjs';
import { ObservationProjection } from '../plugins/computer-use/linux/projection.mjs';
import { LinuxBackend } from '../plugins/computer-use/linux/backend.mjs';
import { apply, linuxTools } from '../plugins/computer-use/linux/index.mjs';
import { checkCondition, validateScope } from '../plugins/computer-use/linux/conditions.mjs';
import { parseServerArgs } from '../scripts/host.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function transport() {
  const children = [];
  const launch = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.calls = []; child.signals = [];
    child.stdin.on('data', data => child.calls.push(JSON.parse(data)));
    child.kill = signal => { child.signals.push(signal); setImmediate(() => child.emit('close')); };
    child.reply = (result, error) => child.stdout.write(JSON.stringify({ id: child.calls.at(-1).id, result, error }) + '\n');
    children.push(child); return child;
  };
  return { children, client: new LinuxHelperClient({ launch, timeoutMs: 1000 }) };
}
test('Linux helper serializes actions, returns structured errors, and reuses its process', async t => {
  const { children, client } = transport(); t.after(() => client.dispose());
  const first = client.invoke({ command: 'one' }), second = client.invoke({ command: 'two' });
  await tick(); assert.equal(children.length, 1); assert.equal(children[0].calls.length, 1);
  children[0].reply({ ok: true }); assert.deepEqual(await first, { ok: true });
  await tick(); assert.equal(children[0].calls.length, 2);
  children[0].reply(undefined, { code: 'STALE', message: 'changed' });
  await assert.rejects(second, { code: 'STALE', message: 'changed' });
});
test('Linux cancellation never replays input and waits for the old helper to close', async t => {
  const { children, client } = transport(); t.after(() => client.dispose());
  const abort = new AbortController();
  const first = client.invoke({ command: 'act' }, abort.signal);
  const rejected = assert.rejects(first, /cancelled/);
  await tick();
  children[0].kill = signal => children[0].signals.push(signal);
  abort.abort(Error('cancelled')); await rejected;
  const next = client.invoke({ command: 'observe' }); await tick();
  assert.equal(children.length, 1); assert.equal(children[0].calls.length, 1);
  children[0].emit('close'); await tick(); assert.equal(children.length, 2);
  assert.equal(children[1].calls[0].command, 'observe'); children[1].reply({ fresh: true }); await next;
});
test('Linux queued cancellation is immediate and sends no command', async t => {
  const { children, client } = transport(); t.after(() => client.dispose());
  const first = client.invoke({ command: 'observe' }); await tick();
  const abort = new AbortController(), queued = client.invoke({ command: 'act' }, abort.signal);
  abort.abort(Error('skip')); await assert.rejects(queued, /skip/);
  children[0].reply({}); await first; await tick(); assert.equal(children[0].calls.length, 1);
});
test('Linux malformed output and timeout retire the transport without retrying', async t => {
  for (const malformed of [true, false]) {
    const { children, client } = transport(); t.after(() => client.dispose());
    const result = client.invoke({ command: 'act' }, undefined, malformed ? 1000 : 20);
    const rejected = assert.rejects(result, malformed ? /JSON/ : /uncertain/);
    await tick(); if (malformed) children[0].stdout.write('broken\n'); await rejected;
    assert.deepEqual(children[0].signals, ['SIGTERM']); assert.equal(children[0].calls.length, 1);
  }
});
const observation = (id, elements, mode = 'diff') => ({ observationId: id, app: { bundleId: 'linux.app', pid: 1 }, tree: { mode, text: '' }, elements });
test('Linux deltas preserve full service state, ignore rotating handles and reset after context loss', () => {
  const project = new ObservationProjection(), agent = {};
  const old = observation('a', [{ index: 0, title: 'same', targetHandle: 'old' }, { index: 1, title: 'gone' }]);
  assert.equal(project.project(agent, old).elementsMode, 'full');
  const current = observation('b', [{ index: 0, title: 'same', targetHandle: 'new' }, { index: 2, title: 'added' }]);
  const delta = project.project(agent, current);
  assert.equal(delta.baseObservationId, 'a'); assert.deepEqual(delta.removedElementIndexes, [1]);
  assert.deepEqual(delta.elements.map(row => row.index), [2]); assert.equal(current.elements.length, 2);
  assert.equal(project.project({}, current).elementsMode, 'full');
  assert.equal(project.project(agent, observation('c', current.elements), true).elements.length, 2);
});
test('Linux tool output accepts app lists, defaults to structure and suppresses the macOS vision handoff', async () => {
  let request;
  const service = { listApps: async () => [{ pid: 1 }], observe: async args => { request = args; return { ...observation('a', [], 'full'), screenshot: { path: '/tmp/image.png' } }; } };
  const tools = linuxTools(service), agent = { session: { header: {} } };
  const exec = { agent, signal: AbortSignal.timeout(1000), deferContext: () => assert.fail('legacy vision handoff') };
  const list = tools.find(tool => tool.name === 'computer_list_apps');
  assert.deepEqual(await list.execute({}, exec), [{ pid: 1 }]); assert.deepEqual(list.output.schema, {});
  const observe = tools.find(tool => tool.name === 'computer_observe');
  const result = await observe.execute({ app: { pid: 1 } }, exec);
  assert.equal(request.screenshot, 'none'); assert.equal(observe.parameters.type, 'object');
  assert.match(result.screenshot.description, /read_image/);
});
test('Linux capability failures keep the Host available; explicit Portal captures allow consent time', async () => {
  const calls = [];
  const backend = new LinuxBackend({}, { invoke: async (...args) => { calls.push(args); throw Error('missing GI'); } });
  assert.equal((await backend.health()).ready, false);
  backend.capabilities = { session: 'wayland' };
  await assert.rejects(backend.observe({}, { screenshot: 'required' }), /missing GI/);
  assert.equal(calls.at(-1)[2], 120000);
});

test('Wayland stream identity survives tool execution and sensitive confirmation schemas', async () => {
  let request;
  const service = { act: async action => { request = action; return { ok: true }; } };
  const tools = linuxTools(service);
  const exec = { agent: { session: { header: {} } }, signal: AbortSignal.timeout(1000) };
  const click = tools.find(tool => tool.name === 'computer_click');
  await click.execute({ observationId: 'observed', coordinateSpace: 'stream', streamId: '42', x: 10, y: 20 }, exec);
  assert.equal(request.streamId, '42'); assert.equal(request.kind, 'click');
  const confirmation = tools.find(tool => tool.name === 'computer_confirm');
  const schema = confirmation.parameters.properties.action.oneOf.find(choice => choice.properties.kind.const === 'click');
  assert(schema.properties.coordinateSpace.enum.includes('stream')); assert.equal(schema.properties.streamId.type, 'string');
  request = undefined;
  await assert.rejects(click.execute({ observationId: 'observed', expect: { name: 'Saved' }, timeoutMs: -1 }, exec), /timeout/);
  assert.equal(request, undefined, 'invalid postconditions must fail before dispatching input');
});
test('Linux bootstrap compiles Host schemas, activates tools once and removes them on disposal', async () => {
  const registered = [], agentTools = [], events = new Map();
  let released = 0, removed = 0;
  const service = { health: async () => ({ ready: true }), releaseAgent: () => released++ };
  const ctx = { plugin: async () => {}, get: () => service, skills: { register() {} }, commands: { register() {} },
    tools: { register: tool => { registered.push(tool); return () => {}; } }, on: (name, fn) => events.set(name, fn), effect() {} };
  await apply(ctx);
  assert.deepEqual(registered.map(tool => tool.name), ['computer_use_activate', 'computer_status']);
  const agent = { ctx: { tools: { register: tool => { agentTools.push(tool); return () => removed++; } } } };
  const activate = registered[0];
  assert((await activate.execute({}, { agent })).activated);
  const count = agentTools.length; assert(count > 10);
  await activate.execute({}, { agent }); assert.equal(agentTools.length, count);
  events.get('agent/disposed')({ agent }); assert.equal(released, 1); assert.equal(removed, count);
});
test('Linux action and target-rebinding reads retain their observed helper instance across awaits', async () => {
  const calls = [];
  const backend = new LinuxBackend({}, { invoke: async command => { calls.push(command); return {}; } });
  await backend.withInstance('original-helper', async () => {
    await backend.observe({}, { screenshot: 'none' });
    await tick(); await backend.act({});
  });
  await backend.observe({}, { screenshot: 'none' });
  assert.deepEqual(calls.map(call => call.expectedInstance), ['original-helper', 'original-helper', undefined]);
});
test('Linux postconditions distinguish success, absence and incomplete observations', () => {
  const view = { elements: [{ index: 0, role: 'text', title: 'Input', value: '中文', enabled: true }], tree: { truncated: false } };
  assert(checkCondition(view, { name: 'Input', value: '中文' }).matched);
  assert(!checkCondition(view, { name: 'Input', value: 'other' }).matched);
  assert(checkCondition(view, { name: 'Missing', exists: false }).matched);
  assert(!checkCondition({ ...view, tree: { truncated: true } }, { name: 'Missing', exists: false }).matched);
  assert.throws(() => checkCondition(view, {}), /name or role/);
  assert.throws(() => validateScope({ maxScanNodes: 999999 }), /maxScanNodes/);
  assert.throws(() => validateScope({ name: 'x', unexpected: true }), /Unknown/);
});
test('Dedicated desktop is an explicit server option and observation scopes have separate delta bases', () => {
  assert.equal(parseServerArgs(['--port', '9988', '--desktop', '--yolo']).desktop, true);
  const projection = new ObservationProjection(), agent = {};
  const view = observation('one', [{ index: 0, title: 'all' }]);
  projection.project(agent, { ...view, scopeId: 'all' });
  assert.equal(projection.project(agent, { ...view, observationId: 'two', scopeId: 'query' }).elementsMode, 'full');
});
