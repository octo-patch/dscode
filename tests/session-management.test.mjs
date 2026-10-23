import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import { apply as mountJsonl } from '@deepseek-ai/dsh-session-persistence-jsonl';
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import { DscodeRemoteRegistry } from '../packages/tui/src/host/registry.ts';
import { registerDelivery } from '../packages/tui/src/host/delivery.ts';
import { registerSessions } from '../packages/tui/src/host/sessions.ts';
import { sessionDirectoryFor } from '../packages/tui/src/session-directory.ts';
import { historyPage } from '../packages/tui/src/runtime/history.ts';

function delivery(events = []) {
  const inbox = { nextTurn: [], nextStep: [],
    remove(id) { const at = this.nextTurn.findIndex(m => m.id === id); if (at < 0) return false; this.nextTurn.splice(at, 1); return true; },
    replace(id, message) { this.nextTurn.splice(this.nextTurn.findIndex(m => m.id === id), 1, message); },
    append(_target, message) { this.nextTurn.push(message); },
  };
  let count = 0, injected = 0, flushes = 0;
  const insert = (target, message) => { inbox[target].push(message); events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } }); };
  const agent = { inbox, status: 'running', session: { snapshotEvents: () => events },
    followup: message => { count++; insert('nextTurn', message); },
    steer: message => { count++; insert('nextStep', message); },
    inject: message => { injected++; insert('nextStep', message); },
    cancel: () => { inbox.nextTurn = []; inbox.nextStep = []; agent.status = 'idle'; },
  };
  const services = { agents: { get: () => agent }, sessions: { flush: async () => { flushes++; return true; } } };
  const registry = new DscodeRemoteRegistry(); registerDelivery({ get: key => services[key] }, registry);
  return { registry, agent, events, services, stats: () => ({ count, injected, flushes }) };
}
const request = { sessionId: 'session-one', requestId: 'submission-one', mode: 'followup', content: [{ type: 'text', text: 'hello' }] };

test('concurrent delivery retries admit once, conflict on changed payload, and retain receipts after cancellation/reload', async () => {
  const f = delivery();
  const context = { id: 'context-one', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'context' }] };
  const input = { ...request, context };
  await Promise.all(Array.from({ length: 8 }, () => f.registry.invoke('session/deliver', input)));
  assert.deepEqual(f.stats(), { count: 1, injected: 1, flushes: 8 });
  await assert.rejects(f.registry.invoke('session/deliver', { ...input, mode: 'steer' }), e => e.code === 'dscode/idempotency-conflict');
  await assert.rejects(f.registry.invoke('session/deliver', { ...input, context: { ...context, content: [{ type: 'text', text: 'different' }] } }), e => e.code === 'dscode/idempotency-conflict');
  f.agent.cancel();
  const resumed = delivery(JSON.parse(JSON.stringify(f.events)));
  await resumed.registry.invoke('session/deliver', input);
  assert.equal(resumed.stats().count, 0);
  assert.equal(resumed.stats().injected, 0);
  await resumed.registry.invoke('session/deliver', { ...input, sessionId: 'session-fork' });
  assert.equal(resumed.stats().count, 1, 'a fork uses a distinct request namespace');
});

test('delivery retry repeats a failed flush without duplicating admitted content or partially injected context', async () => {
  const f = delivery();
  f.services.sessions.flush = async () => { throw Error('disk failed'); };
  await assert.rejects(f.registry.invoke('session/deliver', request), /disk failed/);
  f.services.sessions.flush = async () => true;
  await f.registry.invoke('session/deliver', request);
  assert.equal(f.stats().count, 1);
  const context = { id: 'context', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'context' }] };
  const send = f.agent.followup;
  f.agent.followup = () => { throw Error('admission failed'); };
  const input = { ...request, requestId: 'second', context };
  await assert.rejects(f.registry.invoke('session/deliver', input), /admission failed/);
  f.agent.followup = send;
  await f.registry.invoke('session/deliver', input);
  assert.equal(f.stats().injected, 1);
  assert.equal(f.stats().count, 2);
});

test('invalid extension arguments and already-aborted calls fail before mutation', async () => {
  const f = delivery();
  for (const input of [null, [], {}, { ...request, mode: 'unexpected' }, { ...request, content: [] }, { ...request, content: [{ type: 'text' }] }, { ...request, content: [{ type: 'image', attachment: {} }] }]) {
    await assert.rejects(f.registry.invoke('session/deliver', input), e => e.code === 'dscode/invalid-arguments');
  }
  await assert.rejects(f.registry.invoke('session/deliver', request, AbortSignal.abort(Error('closed'))), /closed/);
  await assert.rejects(f.registry.invoke('session/updateQueued', { sessionId: 's', messageId: 'm', action: { kind: 'invented' } }), e => e.code === 'dscode/invalid-arguments');
  assert.equal(f.stats().count, 0);
});

test('stale interrupts cannot cancel a newer turn and queue steering restores the row on failure', async () => {
  const f = delivery([{ type: 'turn/start', seq: 9, data: {} }]);
  await f.registry.invoke('session/deliver', request);
  await assert.rejects(f.registry.invoke('session/interrupt', { sessionId: 's', expectedTurnSeq: 8 }), e => e.code === 'dscode/conflict');
  assert.equal(f.agent.status, 'running');
  const message = f.agent.inbox.nextTurn[0];
  f.agent.steer = () => { throw Error('cannot steer'); };
  await assert.rejects(f.registry.invoke('session/updateQueued', { sessionId: 's', messageId: message.id, action: { kind: 'steer' } }), /cannot steer/);
  assert.deepEqual(f.agent.inbox.nextTurn, [message]);
  assert.deepEqual(await f.registry.invoke('session/interrupt', { sessionId: 's', expectedTurnSeq: 9 }), { cancelled: true, preserved: 1 });
  assert.equal(f.agent.inbox.nextTurn.length, 1);
});

test('canceling while cold recovery waits prevents delivery, and restore errors retain stable codes', async () => {
  const f = delivery();
  const abort = new AbortController();
  f.services.sessionController = { resolveAgent: async () => { abort.abort(Error('switched sessions')); return { agent: f.agent }; } };
  await assert.rejects(f.registry.invoke('session/deliver', request, abort.signal), /switched sessions/);
  assert.equal(f.stats().count, 0);
  for (const [upstream, expected] of [['session/not-found', 'dscode/not-found'], ['session/writer-held', 'dscode/conflict']]) {
    f.services.sessionController.resolveAgent = async () => ({ error: Object.assign(Error('restore failed'), { code: upstream }) });
    await assert.rejects(f.registry.invoke('session/deliver', request), error => error.code === expected);
  }
});

test('concurrent queue edits cannot overwrite a replacement message and accepted edits flush', async () => {
  const f = delivery();
  await f.registry.invoke('session/deliver', request);
  const messageId = f.agent.inbox.nextTurn[0].id;
  const edit = text => f.registry.invoke('session/updateQueued', { sessionId: request.sessionId, messageId, action: { kind: 'edit', text } });
  const results = await Promise.all([edit('first'), edit('second')]);
  assert.deepEqual(results, ['edited', 'unavailable']);
  assert.equal(f.agent.inbox.nextTurn[0].content[0].text, 'first');
  assert.equal(f.stats().flushes, 2);
});

async function storage(t) {
  const root = mkdtempSync(join(tmpdir(), 'dscode-delete-'));
  const contexts = [new Context(), new Context()];
  t.after(async () => { for (const ctx of contexts) await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }); });
  for (const ctx of contexts) await mountJsonl(ctx, { root, compression: 'none' });
  const backend = contexts[0].sessionPersistence, other = contexts[1].sessionPersistence;
  const ids = ['session-z-root', 'session-a-child'];
  for (const id of ids) {
    const h = await backend.create({ id, version: SESSION_FORMAT_VERSION, cwd: '/fixture', createdAt: 1, isSeeded: false, ...(id === ids[1] ? { parentSession: ids[0], origin: 'subagent' } : {}) });
    await h.flush(); await h.close();
  }
  const records = (await backend.list()).map(item => ({ header: item.header, live: false, persisted: true }));
  const adapter = { config: { root }, open: (...args) => backend.open(...args) };
  const services = { sessionQuery: { listSessions: async () => records }, sessionPersistence: adapter };
  const registry = new DscodeRemoteRegistry(); registerSessions({ get: key => services[key] }, registry);
  return { root, backend, other, ids, registry, adapter, services };
}

test('deletion takes real backend ownership before removing any subtree member and leaves the lock inode intact', async t => {
  const f = await storage(t);
  const owner = await f.other.open(f.ids[0], 'write');
  await assert.rejects(f.registry.invoke('sessions/delete', { id: f.ids[0] }), e => e.code === 'dscode/conflict');
  assert.equal((await f.backend.list()).length, 2, 'busy parent must preserve the already-locked child');
  const child = await f.other.open(f.ids[1], 'write'); await child.close();
  await owner.close();
  const locks = f.ids.map(id => join(sessionDirectoryFor(f.root, '/fixture', id), 'session.lock'));
  const inodes = locks.map(path => statSync(path).ino);
  assert.equal(await f.registry.invoke('sessions/delete', { id: f.ids[0] }), 'deleted 2 sessions');
  assert.equal((await f.backend.list()).length, 0);
  assert(locks.every(existsSync)); assert.deepEqual(locks.map(path => statSync(path).ino), inodes);
});

test('concurrent deletion has one winner and canceled preflight releases all handles without deleting', async t => {
  const f = await storage(t);
  const abort = new AbortController(), original = f.adapter.open;
  f.adapter.open = async (...args) => { const handle = await original(...args); abort.abort(Error('caller closed')); return handle; };
  await assert.rejects(f.registry.invoke('sessions/delete', { id: f.ids[0] }, abort.signal), /caller closed/);
  assert.equal((await f.backend.list()).length, 2);
  f.adapter.open = original;
  const outcomes = await Promise.allSettled([f.registry.invoke('sessions/delete', { id: f.ids[0] }), f.registry.invoke('sessions/delete', { id: f.ids[0] })]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await f.backend.list()).length, 0);
});

test('resume without currentId still refuses a live owner unless allowLive is explicit', async () => {
  const registry = new DscodeRemoteRegistry();
  registerSessions({ get: key => ({ agents: { get: () => ({}) }, sessionQuery: { listSessions: async () => [{ header: { id: 'session-one' } }] } })[key] }, registry);
  await assert.rejects(registry.invoke('sessions/resolveResume', { wanted: 'session-one' }), e => e.code === 'dscode/live-elsewhere');
  assert.equal(await registry.invoke('sessions/resolveResume', { wanted: 'session-one', allowLive: true }), 'session-one');
});

const records = (...seqs) => seqs.map(seq => ({ event: { seq, type: 'fixture', data: {} } }));
test('history validation rejects repeated pages, gaps and false completion instead of truncating or looping', () => {
  assert.deepEqual(historyPage({ records: records(2, 3), hasMore: true }, 4).map(e => e.seq), [2, 3]);
  for (const [rows, more, before] of [[records(2, 3), true, 2], [records(0, 2), false, 3], [records(1, 1), true, 2], [[], true, 2], [[], false, 2], [records(2, 3), false, 4]]) {
    assert.throws(() => historyPage({ records: rows, hasMore: more }, before), e => e.code === 'dscode/history-invalid');
  }
});
