import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply } from '../plugins/local-carrier/index.mjs';
import { call, openStream } from '../plugins/local-carrier/client.mjs';

async function carrier(t) {
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
    effect: fn => { disposers.push(fn()); },
  };
  apply(ctx, { socketPath });
  // Listening completes with the chmod; the 0700 directory already excludes other users before it.
  for (let i = 0; i < 200 && !(existsSync(socketPath) && (statSync(socketPath).mode & 0o777) === 0o600); i++) await new Promise(r => setTimeout(r, 10));
  t.after(async () => { for (const dispose of disposers) await dispose?.(); rmSync(home, { recursive: true, force: true }); });
  return { socketPath, seen, disposers };
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
  for (const dispose of disposers.splice(0)) await dispose();
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
