import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { createTypertRuntime } from '../packages/tui/src/runtime/typert.ts';
import { retryable } from '../packages/tui/src/runtime/watch.ts';
import { RUNTIME_PROTOCOL } from '../plugins/local-carrier/protocol.mjs';

const record = seq => ({ event: { seq, time: seq, type: 'fixture/event', data: {} } });
const records = (...seqs) => seqs.map(record);
async function until(fn) { for (let n = 0; n < 400; n++) { if (fn()) return; await sleep(10); } throw Error('history fixture timed out'); }
async function fixture(t, mode = 'normal') {
  const state = { follows: [], pages: 0, closed: 0, errors: [] };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (req.url !== '/stream' || !body.includes('\n') || res.headersSent) return;
      const { endpoint } = JSON.parse(body.split('\n')[0]);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const send = item => res.write(JSON.stringify({ item }) + '\n');
      if (endpoint === '$events' && mode !== 'waiting') send({ type: 'ready', clientId: 'fixture-client' });
      if (endpoint === 'session/follow') {
        state.follows.push(res); res.on('close', () => { state.closed++; });
        const reopened = state.follows.length > 1;
        send({ type: 'snapshot', header: { id: 'session-fixture', cwd: '/fixture' }, cursor: reopened ? 9 : 3, records: reopened ? records(8, 9) : records(2, 3), hasMore: true });
        if (reopened) { send({ type: 'event', event: record(9).event }); send({ type: 'event', event: record(10).event }); }
      }
    });
    req.on('end', () => {
      if (req.url === '/stream') return;
      const input = JSON.parse(body);
      if (req.url.startsWith('/dscode/')) { res.end(JSON.stringify({ ok: true, value: { version: 'fixture', protocol: RUNTIME_PROTOCOL } })); return; }
      let value = { items: [{ sessionId: 'session-fixture', running: false }] };
      if (input.method === 'session/page') {
        state.pages++;
        if (mode === 'pending') return;
        const before = input.payload.args.request.beforeSeq;
        value = mode === 'repeated' ? { records: records(2, 3), hasMore: true }
          : { records: records(before - 2, before - 1), hasMore: before > 2 };
      }
      res.end(JSON.stringify({ type: 'server-response', rpcId: input.rpcId, result: { ok: true, value } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const life = new AbortController(), sessionLife = new AbortController();
  const runtime = createTypertRuntime({ target: { url: `http://127.0.0.1:${server.address().port}`, token: 'fixture' }, signal: life.signal, onError: error => state.errors.push(error) });
  t.after(async () => { life.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const open = () => runtime.open({ sessionId: 'session-fixture', resume: true, cwd: '/fixture', preset: 'dscode', selection: {}, signal: sessionLife.signal });
  return { state, runtime, open, sessionLife };
}

test('real protocol client fills several missed pages exactly once before accepting live suffix events', async t => {
  const f = await fixture(t);
  const seen = []; f.runtime.onSessionEvent((_session, event) => seen.push(event.seq));
  const session = await f.open();
  assert.deepEqual(session.snapshotEvents().map(e => e.seq), [0, 1, 2, 3]);
  f.state.follows[0].destroy();
  await until(() => session.snapshotEvents().at(-1)?.seq === 10);
  assert.deepEqual(session.snapshotEvents().map(e => e.seq), Array.from({ length: 11 }, (_, i) => i));
  assert.deepEqual(seen, [4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(f.state.errors, []);
  await session.dispose();
});

test('non-progressing initial pages fail and close the follow stream instead of looping', async t => {
  const f = await fixture(t, 'repeated');
  await assert.rejects(f.open(), error => error.code === 'dscode/history-invalid');
  await until(() => f.state.closed === 1);
  await sleep(300);
  assert.equal(f.state.pages, 1); assert.equal(f.state.follows.length, 1);
});

test('canceling an open session aborts its pending page request and follow stream', async t => {
  const f = await fixture(t, 'pending');
  const opened = f.open();
  const rejected = assert.rejects(opened, /switch canceled/);
  await until(() => f.state.pages === 1);
  f.sessionLife.abort(Error('switch canceled'));
  await rejected; await until(() => f.state.closed === 1);
});

test('upstream application failures are not network retries', () => {
  for (const code of ['session/not-found', 'gateway/bad-request', 'dscode/history-invalid']) assert.equal(retryable({ code }), false);
  assert.equal(retryable({ code: 'ECONNRESET' }), true);
});

test('canceling a session open during the shared handshake settles without creating a session', async t => {
  const f = await fixture(t, 'waiting');
  const opened = f.open();
  f.sessionLife.abort(Error('open canceled'));
  await assert.rejects(opened, /open canceled/);
  assert.equal(f.state.follows.length, 0);
});
