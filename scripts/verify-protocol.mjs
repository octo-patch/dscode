// Checks protocol/dscode-runtime.schema.json against a real Host: what the
// runtime sends has to be what the schema says, or clients generated from the
// schema break. Drives a session in a temporary state directory with the
// fixture model (a plain turn, a turn with a rejected approval, a /btw child),
// then validates:
//   - every committed session event against SessionEventKnown (strict: an event
//     kind the schema does not list, or a field it gets wrong, fails);
//   - the child-session feed against ChildStreamItem;
//   - the result of every read-only method, and the first item of every value
//     watch, against their definitions;
//   - the arguments this script sends against their definitions.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'dscode-protocol-'));
const workspace = join(home, 'workspace'); mkdirSync(workspace);
const userHome = join(home, 'user'); mkdirSync(userHome);
const patch = join(home, 'protocol-fixture.patch.yml');
writeFileSync(patch, [
  '- id: agent-default-model\n  config:\n    provider: fixture\n    model: fixture',
  '- id: permission\n  config:\n    defaultPreset: workspace-write',
  '- id: dscode-session-cards\n  config:\n    enabled: false', '- id: dscode-memory\n  config:\n    generate: false',
  `- insert:\n    - id: fixture-model\n      name: ${JSON.stringify(join(root, 'scripts/fixture-model.mjs'))}`,
].join('\n') + '\n');
// harness.mjs resolves the state directory at import, so the environment comes first.
Object.assign(process.env, { DSCODE_SOURCE_HOME: home, DSCODE_HOST_PATCH: patch, HOME: userHome, CI: 'false', DSCODE_LANGUAGE: 'en',
  DSCODE_UPDATE_CHECK: 'off', DSCODE_ACCOUNT_LOGIN: '0', DSCODE_MEMORY_HOME: join(home, 'memories'), DSCODE_HOST_IDLE_MS: '0',
  FIXTURE_OUTSIDE_PATH: join(home, 'outside-write-probe.txt') });
const { ensureHost, stop } = await import('./host.mjs');
const { call, callDscode, openDscodeStream, openStream } = await import('../plugins/local-carrier/client.mjs');

const schema = JSON.parse(readFileSync(join(root, 'protocol/dscode-runtime.schema.json'), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema(schema, 'dscode');
const failures = [];
const counts = {};
/** Validate `value` against one definition; failures are collected, not thrown. */
function check(definition, value, label) {
  const valid = ajv.validate({ $ref: `dscode#/definitions/${definition}` }, value);
  counts[definition] = (counts[definition] ?? 0) + 1;
  if (!valid) failures.push(`${label} (${definition}): ${ajv.errorsText(ajv.errors, { separator: '; ' }).slice(0, 600)}\n    ${JSON.stringify(value).slice(0, 400)}`);
}
const methods = schema['x-dscode-methods'];
const streams = schema['x-dscode-streams'];
const typertMethods = schema['x-typert-methods'];
const typertStreams = schema['x-typert-streams'];
const waterfalls = schema['x-typert-waterfalls'];
/** A Typert call through `/api`, with its arguments and value checked. */
async function typert(name, args) {
  check(typertMethods[name].args, args, `${name} args`);
  const result = value(await call(socket, name, args));
  check(typertMethods[name].result, result === undefined ? null : result, `${name} result`);
  return result;
}
async function method(name, args) {
  check(methods[name].args, args, `${name} args`);
  const result = await callDscode(socket, name, args);
  check(methods[name].result, result === undefined ? null : result, `${name} result`);
  return result;
}
async function firstItem(name, args) {
  check(streams[name].args, args, `${name} args`);
  const controller = new AbortController();
  for await (const item of openDscodeStream(socket, name, args, controller.signal)) {
    check(streams[name].item, item, `${name} item`);
    controller.abort();
    return item;
  }
}
const tick = ms => new Promise(r => setTimeout(r, ms));
const until = async (label, predicate, ms = 30000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await tick(50); }
  throw Error(`timed out waiting for ${label}`);
};
const value = result => { assert.equal(result?.ok, true, JSON.stringify(result)); return result.value; };

let socket;
const controller = new AbortController();
try {
  socket = await ensureHost();
  const status = await method('host/status', {});
  assert.deepEqual(status.protocol, schema['x-protocol-version'], 'the Host speaks the protocol version the schema describes');

  // Attach; reject every approval, pass on anything else. Every frame and the
  // payload of each waterfall the contract lists are checked.
  let clientId;
  const answered = [];
  check(typertStreams.$events.args, {}, '$events args');
  void (async () => {
    for await (const frame of openStream(socket, '$events', { args: {} }, controller.signal)) {
      check(typertStreams.$events.item, frame, `$events ${frame.type} frame`);
      if (frame.type === 'ready') clientId = frame.clientId;
      if (frame.type !== 'waterfall') continue;
      const known = waterfalls[frame.event];
      if (known !== undefined) check(known.request, frame.request, `${frame.event} payload`);
      const outcome = frame.event === 'approval/request' ? { kind: 'result', value: 'rejected' } : { kind: 'next' };
      if (outcome.kind === 'result') check(known.value, outcome.value, `${frame.event} answer`);
      answered.push(await typert('$events/result', { clientId, eventId: frame.eventId, outcome }));
    }
  })().catch(error => failures.push(`$events: ${error.message}`));
  await until('$events ready', () => clientId);

  const { sessionId } = await typert('session/create', { request: { cwd: workspace, agentPreset: 'dscode' } });
  await typert('session/selectModel', { request: { sessionId, provider: 'fixture', model: 'fixture' } });
  const live = [];
  const followArgs = { request: { address: { kind: 'session', sessionId }, assistantStream: true } };
  check(typertStreams['session/follow'].args, followArgs, 'session/follow args');
  void (async () => {
    for await (const frame of openStream(socket, 'session/follow', { args: followArgs }, controller.signal)) {
      check(typertStreams['session/follow'].item, frame, `session/follow ${frame.type} frame`);
      live.push(frame);
    }
  })().catch(error => failures.push(`session/follow: ${error.message}`));
  await until('follow snapshot', () => live.length > 0);
  const children = [];
  void (async () => {
    for await (const item of openDscodeStream(socket, 'sessions/children', { sessionId }, controller.signal)) children.push(item);
  })().catch(() => {});

  const turnEnds = () => live.filter(frame => frame.type === 'event' && frame.event.type === 'turn/end').length;
  for (const [index, text] of ['hello', 'APPROVE writing a file'].entries()) {
    await method('session/deliver', { sessionId, mode: 'followup', content: [{ type: 'text', text }] });
    await until(`turn ${index + 1}`, () => turnEnds() > index);
  }
  // A /btw child: its committed events and live frames arrive on sessions/children.
  const childId = `session-${randomUUID()}`;
  await method('btw/start', { sessionId, childId, question: 'hello from the side', mode: 'dscode' });
  await until('child turn end', () => children.some(item => item.kind === 'event' && item.event.type === 'turn/end'));
  for (const item of children) {
    check(streams['sessions/children'].item, item, 'sessions/children item');
    if (item.kind === 'event') check('SessionEventKnown', item.event, `child event ${item.event.type}`);
  }
  await method('btw/dispose', { ids: [childId] });

  assert.ok(answered.length > 0, 'the approval was answered through $events/result');
  assert.ok(live.some(frame => frame.type === 'assistant-stream'), 'live assistant frames were followed');

  // Every committed event, from a fresh snapshot, must be a member the schema knows.
  // A small page size forces history paging through session/page.
  const kinds = new Set();
  const address = { kind: 'session', sessionId };
  let snapshot;
  for await (const frame of openStream(socket, 'session/follow', { args: { request: { address, assistantStream: true, maxMessages: 4 } } })) { snapshot = frame; break; }
  assert.equal(snapshot.type, 'snapshot');
  check(typertStreams['session/follow'].item, snapshot, 'paged snapshot');
  const records = [...snapshot.records];
  for (let hasMore = snapshot.hasMore; hasMore;) {
    const page = await typert('session/page', { request: { address, throughSeq: snapshot.cursor, beforeSeq: records[0].event.seq, maxMessages: 4 } });
    records.unshift(...page.records);
    hasMore = page.hasMore;
  }
  for (const record of records) { kinds.add(record.event.type); check('SessionEventKnown', record.event, `event ${record.event.type} seq ${record.event.seq}`); }
  await typert('session/list', { _request: {} });
  await typert('session/fork', { request: { sessionId } });

  // Read-only methods and value watches.
  await method('models/directory', {});
  await method('models/compactionPreview', { sessionId, row: { provider: 'fixture', providerName: 'Fixture', model: 'fixture', modelName: 'Fixture' } });
  await method('sessions/list', { options: { sessions: 'all', cwd: 'all', sort: 'newest', currentCwd: workspace, query: '' } });
  await method('sessions/subagents', { sessionId, cwd: workspace });
  await method('sessions/usage', { sessionId });
  await method('sessions/transcript', { id: sessionId });
  await method('sessions/search', { query: 'hello' });
  await method('sessions/resolveResume', { wanted: sessionId, allowLive: true });
  await method('jobs/list', { sessionId });
  await method('schedules/list', { sessionId });
  await method('plugins/list', {});
  await method('presets/planAvailable', {});
  await method('permissions/rows', {});
  await method('permissions/names', {});
  await method('permissions/effective', { sessionId });
  await method('mentions/candidates', { sessionId, cwd: workspace, query: '' });
  await method('mentions/prepare', { sessionId, cwd: workspace, parsed: { text: 'plain text', references: [] } });
  await method('providers/directory', {});
  await method('authorization/directory', {});
  await method('openrouter/managementKeyStatus', {});
  await method('custom/available', {});
  await method('custom/list', {});
  await method('workspace/gitBranch', { cwd: workspace });
  writeFileSync(join(workspace, 'notes.txt'), 'attachment probe\n');
  await method('attachments/inspectFiles', { paths: [join(workspace, 'notes.txt')], cwd: workspace });
  for (const [name, args] of [['commands/watch', { sessionId }], ['skills/watch', { sessionId, cwd: workspace }], ['status/watch', { sessionId, modelLabel: 'fixture/fixture' }],
    ['models/defaults', {}], ['providers/watch', {}], ['authorization/watch', {}]]) await firstItem(name, args);

  if (failures.length > 0) throw Error(`${failures.length} schema mismatch(es):\n  ${failures.join('\n  ')}`);
  console.log('PROTOCOL_VERIFIED ' + JSON.stringify({ eventKinds: [...kinds].sort(), checked: counts }));
} finally {
  controller.abort();
  await stop().catch(() => {});
  if (!process.env.KEEP) rmSync(home, { recursive: true, force: true });
}
