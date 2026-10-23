import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { createTypertRuntime } from '../packages/tui/src/runtime/typert.ts';
import { VERSION, callDscode, openStream } from '../plugins/local-carrier/client.mjs';
import { RUNTIME_PROTOCOL } from '../plugins/local-carrier/protocol.mjs';

async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) { assert(Date.now() < deadline, 'timed out waiting for connection state'); await sleep(10); }
}

async function fixture(t) {
  const state = { mode: 'normal', events: [], opens: 0, writes: 0, checks: 0, connections: [], errors: [] };
  const server = createServer((req, res) => {
    if (req.url === '/stream') {
      let body = '';
      const read = chunk => {
        body += chunk;
        if (!body.includes('\n')) return;
        req.off('data', read);
        const { endpoint } = JSON.parse(body.split('\n')[0]);
        assert.equal(endpoint, '$events');
        state.opens++;
        if (state.mode === 'unauthorized') {
          res.writeHead(401);
          res.end(JSON.stringify({ error: { code: 'dscode/unauthorized', message: 'bad token' } }) + '\n');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(JSON.stringify({ item: { type: 'ready', clientId: `client-${state.opens}` } }) + '\n');
        state.events.push(res);
        if (state.mode === 'incompatible') res.write(JSON.stringify({ item: { type: 'waterfall', event: 'approval/request', eventId: 'after-upgrade', agentId: 'session-test', request: { toolName: 'bash' } } }) + '\n');
      };
      req.on('data', read);
      return;
    }
    req.resume();
    if (req.url === '/dscode/host%2Fstatus') {
      state.checks++;
      res.end(JSON.stringify({ ok: true, value: { version: ['incompatible', 'compatible-upgrade'].includes(state.mode) ? '99.0.0' : VERSION,
        ...(state.mode === 'compatible-upgrade' ? { protocol: RUNTIME_PROTOCOL } : {}) } }));
    } else {
      state.writes++;
      res.end(JSON.stringify({ ok: true, value: {} }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const target = { url: `http://127.0.0.1:${server.address().port}`, token: 'fixture-token-only' };
  const controller = new AbortController();
  const runtime = createTypertRuntime({ target, signal: controller.signal, onError: error => state.errors.push(error), onConnection: value => state.connections.push(value) });
  t.after(async () => { controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await until(() => state.connections.includes('connected'));
  return { state, runtime, target, drop: () => state.events.at(-1).destroy() };
}

test('a network drop withdraws approval UI and reconnects after checking the Host version', async t => {
  const { state, runtime, drop } = await fixture(t);
  let approvalSignal;
  runtime.onApprovalRequest(ask => { approvalSignal = ask.signal; return new Promise(() => {}); });
  state.events[0].write(JSON.stringify({ item: { type: 'waterfall', event: 'approval/request', eventId: 'pending', agentId: 'session-test', request: { toolName: 'bash' } } }) + '\n');
  await until(() => approvalSignal !== undefined);
  drop();
  await until(() => state.connections.filter(value => value === 'connected').length === 2);
  assert.equal(approvalSignal.aborted, true);
  assert.deepEqual(state.connections, ['connected', 'reconnecting', 'connected']);
  assert.equal(state.checks, 2);
  assert.deepEqual(state.errors, []);
});

test('token rotation stops reconnection and rejects further writes without sending them', async t => {
  const { state, runtime, drop } = await fixture(t);
  state.mode = 'unauthorized';
  drop();
  await until(() => state.connections.includes('unauthorized'));
  const attempts = state.opens;
  await sleep(800);
  assert.equal(state.opens, attempts);
  assert.equal(state.errors.length, 1);
  assert.match(state.errors[0].message, /config --alias NAME --token TOKEN/);
  await assert.rejects(runtime.call('session/deliver', {}), /refused the token/);
  assert.equal(state.writes, 0);
});

test('a changed server version stops recovery before approvals replay or connected is announced', async t => {
  const { state, runtime, drop } = await fixture(t);
  let approvals = 0;
  runtime.onApprovalRequest(() => { approvals++; return undefined; });
  state.mode = 'incompatible';
  drop();
  await until(() => state.connections.includes('incompatible'));
  assert.deepEqual(state.connections, ['connected', 'reconnecting', 'incompatible']);
  assert.equal(approvals, 0);
  assert.equal(state.errors.length, 1);
  await assert.rejects(runtime.call('session/deliver', {}), /99.0.0/);
  assert.equal(state.writes, 0);
  const attempts = state.opens;
  await sleep(800);
  assert.equal(state.opens, attempts);
});

test('already aborted carrier calls and streams do not reach the server', async t => {
  const { state, target } = await fixture(t);
  const signal = AbortSignal.abort(new Error('terminal closed'));
  await assert.rejects(callDscode(target, 'session/deliver', {}, signal), /terminal closed/);
  await assert.rejects(async () => { for await (const _ of openStream(target, '$events', {}, signal)) {} }, /terminal closed/);
  assert.equal(state.writes, 0);
  assert.equal(state.opens, 1);
});

test('a compatible server upgrade reconnects despite a changed application version', async t => {
  const { state, runtime, drop } = await fixture(t);
  state.mode = 'compatible-upgrade'; drop();
  await until(() => state.connections.filter(value => value === 'connected').length === 2);
  assert.deepEqual(state.errors, []);
  await runtime.call('session/deliver', {});
  assert.equal(state.writes, 1);
});
