import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply, authorized, VERSION } from '../plugins/local-carrier/index.mjs';
import { call, callDscode, openDscodeStream, openStream } from '../plugins/local-carrier/client.mjs';
import { checkRemote } from '../scripts/runtimes.mjs';

const freePort = () => new Promise(resolve => { const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });

async function carrier(t, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'carrier-unit-'));
  const socketPath = join(home, 'run', 'host.sock');
  const operator = { id: 'operator' }, seen = [];
  const disposers = [];
  const ctx = {
    connection: { operator, createSharedFetchHandler: channel => ({ fetch: async request => {
      const body = await request.json();
      seen.push({ channel, path: new URL(request.url).pathname, body });
      return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: body.payload.args } });
    } }) },
    typertGateway: { wireStream: {
      open: async (endpoint, payload, uplink, peer, signal) => {
        assert.equal(peer, operator); assert(signal instanceof AbortSignal);
        if (endpoint === 'fail') throw Error('boom');
        return (async function* () {
          yield { endpoint, payload };
          if (endpoint === 'echo') for await (const item of uplink) { yield { echoed: item }; if (item === 'last') return; }
        })();
      },
      failure: error => ({ code: 'test/failed', message: error.message }),
    } },
    effect: fn => { const disposer = fn(); disposers.push(disposer); return disposer; },
    // A stand-in DSCODE registry: echoes its arguments, answers host/status.
    get: name => name === 'dscodeRemote' ? {
      invoke: async (method, args) => method === 'host/status' ? { version: extra.version ?? VERSION, defaultCwd: '/srv/app' } : { method, args },
      open: async function* (stream, args) { yield { stream, args }; },
    } : undefined,
  };
  await apply(ctx, { socketPath, ...extra.config });
  // Listening completes with the chmod; the 0700 directory already excludes other users before it.
  for (let i = 0; i < 200 && !(existsSync(socketPath) && (statSync(socketPath).mode & 0o777) === 0o600); i++) await new Promise(r => setTimeout(r, 10));
  t.after(async () => { for (const dispose of disposers) await (await dispose)?.(); rmSync(home, { recursive: true, force: true }); });
  return { socketPath, seen, disposers, home };
}

/** A carrier that also serves TCP with a token, as `dscode server` runs it. */
async function tcpCarrier(t, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'carrier-tcp-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const tokenFile = join(home, 'server-token');
  const token = 'dsk_unit-test-token-0123456789';
  writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
  const port = await freePort();
  const base = await carrier(t, { ...options, config: { tcp: { port, bind: '127.0.0.1', tokenFile } } });
  const url = `http://127.0.0.1:${port}`;
  return { ...base, target: { url, token }, wrong: { url, token: 'dsk_not-the-right-token-000' } };
}

test('unary calls reach the shared /api dispatcher with the Typert args envelope', async t => {
  const { socketPath, seen } = await carrier(t);
  assert.deepEqual(await call(socketPath, 'session/create', { request: { cwd: '/w' } }), { ok: true, value: { request: { cwd: '/w' } } });
  assert.equal(seen[0].channel, '/api'); assert.equal(seen[0].path, '/api/session/create');
  assert.equal(seen[0].body.type, 'client-request'); assert.equal(seen[0].body.method, 'session/create');
});

test('the socket is owner-only inside an owner-only directory, and is removed on dispose', async t => {
  const { socketPath, disposers } = await carrier(t);
  assert.equal(statSync(socketPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(socketPath, '..')).mode & 0o777, 0o700);
  for (const dispose of disposers.splice(0)) await (await dispose)();
  assert(!existsSync(socketPath));
});

test('streams carry the opening payload, uplink items, and the end frame', async t => {
  const { socketPath } = await carrier(t);
  const uplink = (async function* () { yield 'first'; yield 'last'; })();
  const items = [];
  for await (const item of openStream(socketPath, 'echo', { args: { a: 1 } }, undefined, uplink)) items.push(item);
  assert.deepEqual(items, [{ endpoint: 'echo', payload: { args: { a: 1 } } }, { echoed: 'first' }, { echoed: 'last' }]);
});

test('an opening failure arrives as the mapped Remote failure', async t => {
  const { socketPath } = await carrier(t);
  await assert.rejects(async () => { for await (const _ of openStream(socketPath, 'fail', { args: {} })) void _; },
    error => error.remote?.code === 'test/failed' && error.message === 'boom');
});

test('aborting a stream from the client ends iteration without an error', async t => {
  const { socketPath } = await carrier(t);
  const controller = new AbortController();
  const items = [];
  const never = (async function* () { await new Promise(() => {}); })();
  const iteration = (async () => { for await (const item of openStream(socketPath, 'echo', { args: {} }, controller.signal, never)) { items.push(item); controller.abort(); } })();
  await iteration.catch(() => {});
  assert.equal(items.length, 1);
});

test('bearer tokens are compared exactly', () => {
  assert.equal(authorized('Bearer dsk_abcdefghijklmnop', 'dsk_abcdefghijklmnop'), true);
  assert.equal(authorized('Bearer dsk_abcdefghijklmnoq', 'dsk_abcdefghijklmnop'), false);
  assert.equal(authorized('Bearer dsk_abc', 'dsk_abcdefghijklmnop'), false);
  assert.equal(authorized('dsk_abcdefghijklmnop', 'dsk_abcdefghijklmnop'), false);
  assert.equal(authorized(undefined, 'dsk_abcdefghijklmnop'), false);
});

test('the TCP listener serves every route with the token and refuses each without it', async t => {
  const { target, wrong } = await tcpCarrier(t);
  assert.deepEqual(await call(target, 'session/create', { request: { cwd: '/w' } }), { ok: true, value: { request: { cwd: '/w' } } });
  assert.deepEqual(await callDscode(target, 'sessions/list', { a: 1 }), { method: 'sessions/list', args: { a: 1 } });
  const items = [];
  for await (const item of openStream(target, 'once', { args: { b: 2 } })) items.push(item);
  assert.deepEqual(items, [{ endpoint: 'once', payload: { args: { b: 2 } } }]);
  const streamed = [];
  for await (const item of openDscodeStream(target, 'notices/watch', { c: 3 })) streamed.push(item);
  assert.deepEqual(streamed, [{ stream: 'notices/watch', args: { c: 3 } }]);

  await assert.rejects(call(wrong, 'session/create', { request: {} }), error => error.code === 'dscode/unauthorized');
  await assert.rejects(callDscode(wrong, 'sessions/list', {}), error => error.code === 'dscode/unauthorized');
  await assert.rejects(async () => { for await (const _ of openStream(wrong, 'once', { args: {} })) void _; }, error => error.remote?.code === 'dscode/unauthorized');
});

test('the local socket needs no token while the TCP listener runs beside it', async t => {
  const { socketPath } = await tcpCarrier(t);
  assert.deepEqual(await callDscode(socketPath, 'sessions/list', {}), { method: 'sessions/list', args: {} });
});

test('a terminal refuses a runtime of another release', async t => {
  const same = await tcpCarrier(t);
  assert.equal((await checkRemote({ alias: 'box', target: same.target }, VERSION)).defaultCwd, '/srv/app');
  await assert.rejects(checkRemote({ alias: 'box', target: same.wrong }, VERSION), /refused the token/);
  const other = await tcpCarrier(t, { version: '0.0.1' });
  await assert.rejects(checkRemote({ alias: 'box', target: other.target }, VERSION), /runs DSCODE 0\.0\.1, this terminal is/);
  await assert.rejects(checkRemote({ alias: 'gone', target: { url: 'http://127.0.0.1:1', token: 'x' } }, VERSION, 2000), /did not answer/);
});
