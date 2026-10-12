import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBalance, parseOpenRouterKeyRemaining, refreshBalance, balanceNow, trustedNow } from '../plugins/session-metrics/balance.mjs';
import { isPeak, peakEmoji } from '../plugins/session-metrics/pricing.mjs';
import { formatFooter } from '../plugins/session-metrics/view.mjs';
import { apply as applyMetrics } from '../plugins/session-metrics/index.mjs';

test('peak window follows the UTC billing hours and marks the footer', () => {
  const at = value => Date.parse(value);
  assert.equal(isPeak(at('2026-09-14T02:00:00Z')), true, 'Monday 02:00 UTC is peak');
  assert.equal(isPeak(at('2026-09-14T07:30:00Z')), true, 'Monday 07:30 UTC is peak');
  assert.equal(isPeak(at('2026-09-14T00:30:00Z')), false, 'before the window is off-peak');
  assert.equal(isPeak(at('2026-09-14T04:30:00Z')), false, 'the gap between windows is off-peak');
  assert.equal(isPeak(at('2026-09-19T02:00:00Z')), false, 'weekend early hours are off-peak');
  assert.equal(peakEmoji(at('2026-09-14T02:00:00Z')), '🔥');
  assert.equal(peakEmoji(at('2026-09-14T12:00:00Z')), '❄️');
});

test('balance parses the USD entry and refuses unavailable accounts', () => {
  assert.equal(parseBalance({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '12.3456' }] }), 12.3456);
  assert.equal(parseBalance({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '80.00' }] }), 80);
  assert.equal(parseBalance({ is_available: false, balance_infos: [{ currency: 'USD', total_balance: '3.00' }] }), null);
  assert.equal(parseBalance({}), null);
  assert.equal(parseBalance({ balance_infos: [{ currency: 'USD', total_balance: 'oops' }] }), null);
});

test('balance caches its answer and anchors the clock to the response Date header', async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return {
      ok: true,
      headers: { get: name => (name === 'date' ? new Date(Date.now() + 90_000).toUTCString() : null) },
      json: async () => ({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '7.5' }] }),
    };
  };
  assert.equal(await refreshBalance({ key: 'k', fetch }), 7.5);
  assert.equal(balanceNow(), 7.5);
  assert(trustedNow() > Date.now() + 30_000, 'the trusted clock follows the response header');
  assert.equal(await refreshBalance({ key: 'k', fetch }), 7.5);
  assert.equal(calls, 1, 'the cache holds for the refresh window');
});

test('a transient failure keeps the last balance and retries sooner', async () => {
  const before = balanceNow();
  await refreshBalance({ key: 'k', fetch: async () => { throw new Error('offline'); } });
  assert.equal(balanceNow(), before, 'a failed refresh never blanks a known balance');
  assert.equal(await refreshBalance({ key: 'k', fetch: async () => { throw new Error('offline'); } }), before);
});

test('OpenRouter key limits are tracked apart from DeepSeek and the footer drops the peak marker', async () => {
  assert.equal(parseOpenRouterKeyRemaining({ data: { limit: 20, limit_remaining: 12.75, usage: 7.25 } }), 12.75);
  assert.equal(parseOpenRouterKeyRemaining({ data: { limit: 5, limit_remaining: -1, usage: 6 } }), 0);
  assert.equal(parseOpenRouterKeyRemaining({ data: { limit: null, limit_remaining: null, usage: 3 } }), null, 'a key without a limit exposes no balance');
  assert.equal(parseOpenRouterKeyRemaining({ data: { limit_remaining: 'oops' } }), null);
  assert.equal(parseOpenRouterKeyRemaining({ data: {} }), null);
  assert.equal(parseOpenRouterKeyRemaining(null), null);
  const deepseek = balanceNow('deepseek-official');
  const urls = [];
  const fetch = async (url, init) => {
    urls.push([url, init.headers.Authorization]);
    return { ok: true, headers: { get: () => new Date(0).toUTCString() }, json: async () => ({ data: { total_credits: 10, total_usage: 2.5 } }) };
  };
  const clock = trustedNow() - Date.now();
  assert.equal(await refreshBalance({ provider: 'openrouter', key: 'synthetic-or', fetch }), 7.5);
  assert.deepEqual(urls, [['https://openrouter.ai/api/v1/credits', 'Bearer synthetic-or']]);
  assert.equal(balanceNow('openrouter'), 7.5);
  assert.equal(balanceNow('deepseek-official'), deepseek, 'providers keep separate balances');
  assert(Math.abs(trustedNow() - Date.now() - clock) < 1000, 'only DeepSeek anchors the billing clock');
  assert.equal(await refreshBalance({ provider: 'unknown', key: 'k', fetch }), null);
  const metrics = { cost: 0.01, unknown: false, pending: 0, cache: null };
  // The provider names the route: it picks the balance the money pairs with and
   // whether the peak window is marked at all.
  const line = formatFooter(metrics, 10, 200, undefined, 'en', 'openrouter');
  assert.match(line, /\$0\.01 \/ \$7\.50 · {5}-- cache$/, 'the OpenRouter balance rides the money');
  assert(!/🔥|❄️/.test(line), 'OpenRouter bills no peak window');
  assert.match(formatFooter(metrics, 10, 200, undefined, 'en', 'deepseek-official'), /\$0\.01 \/ \$(?:--|\d+\.\d{2}) (?:🔥|❄️)/);
});

const balanceResponse = (amount, currency = 'USD') => ({
  ok: true, headers: { get: () => null },
  json: async () => ({ is_available: true, balance_infos: [{ currency, total_balance: String(amount) }] }),
});

test('changing a credential refreshes its balance inside the cache window', async () => {
  const balance = await import('../plugins/session-metrics/balance.mjs?credential-change');
  const calls = [];
  const fetch = async (_url, init) => {
    calls.push(init.headers.Authorization);
    return balanceResponse(init.headers.Authorization === 'Bearer account-A' ? 11 : 3);
  };
  assert.equal(await balance.refreshBalance({ key: 'account-A', fetch }), 11);
  assert.equal(await balance.refreshBalance({ key: 'account-B', fetch }), 3);
  assert.deepEqual(calls, ['Bearer account-A', 'Bearer account-B']);
});

test('removing a credential clears its balance before and after cache expiry', async t => {
  const balance = await import('../plugins/session-metrics/balance.mjs?credential-removal');
  let now = Date.now(), calls = 0;
  t.mock.method(Date, 'now', () => now);
  const fetch = async () => { calls++; return balanceResponse(11); };
  await balance.refreshBalance({ key: 'account-A', fetch });
  assert.equal(await balance.refreshBalance({ key: '', fetch }), null);
  now += 6 * 60 * 1000;
  assert.equal(await balance.refreshBalance({ key: '', fetch }), null);
  assert.equal(balance.balanceNow(), null);
  assert.equal(calls, 1);
});

test('an old response cannot overwrite a new credential or its trusted clock', async () => {
  const balance = await import('../plugins/session-metrics/balance.mjs?credential-race');
  let resolveOld;
  const old = balance.refreshBalance({ key: 'account-A', fetch: () => new Promise(resolve => { resolveOld = resolve; }) });
  assert.equal(await balance.refreshBalance({ key: 'account-B', fetch: async () => balanceResponse(3) }), 3);
  const before = balance.trustedNow() - Date.now();
  resolveOld({ ...balanceResponse(11), headers: { get: () => new Date(Date.now() + 3600000).toUTCString() } });
  await old;
  assert.equal(balance.balanceNow(), 3);
  assert(Math.abs(balance.trustedNow() - Date.now() - before) < 1000);
});

test('removing a credential during a request prevents the old balance from returning', async () => {
  const balance = await import('../plugins/session-metrics/balance.mjs?pending-removal');
  let resolveOld;
  const old = balance.refreshBalance({ key: 'account-A', fetch: () => new Promise(resolve => { resolveOld = resolve; }) });
  await balance.refreshBalance({ key: '', fetch: async () => assert.fail('removed credential must not fetch') });
  resolveOld(balanceResponse(11));
  await old;
  assert.equal(balance.balanceNow(), null);
});

test('a CNY balance is labelled with its currency in the footer', async t => {
  const now = Date.now() + 6 * 60 * 1000;
  t.mock.method(Date, 'now', () => now);
  await refreshBalance({ key: 'currency-fixture', fetch: async () => balanceResponse(80, 'CNY') });
  const line = formatFooter({ cost: 0.01, unknown: false, pending: 0, cache: null }, 10, 200);
  assert.match(line, /80\.00 CNY/);
  assert.doesNotMatch(line, /\$80\.00/);
});

test('a fallback key spending limit is distinguished from an account balance in the footer', async t => {
  const now = Date.now() + 6 * 60 * 1000;
  t.mock.method(Date, 'now', () => now);
  await refreshBalance({ provider: 'openrouter', key: 'limited-fixture', managementKey: '', fetch: async url => ({
    ok: !url.endsWith('/credits'), status: url.endsWith('/credits') ? 403 : 200,
    json: async () => ({ data: { limit_remaining: 2 } }),
  }) });
  const line = formatFooter({ cost: 0.01, unknown: false, pending: 0, cache: null }, 10, 200, undefined, 'en', 'openrouter');
  assert.match(line, /key \$2\.00/);
});

test('same-credential failures retain a known balance but a failed new credential does not', async t => {
  const balance = await import('../plugins/session-metrics/balance.mjs?transient-failure');
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await balance.refreshBalance({ key: 'account-A', fetch: async () => balanceResponse(11) });
  now += 6 * 60 * 1000;
  assert.equal(await balance.refreshBalance({ key: 'account-A', fetch: async () => { throw Error('offline'); } }), 11);
  assert.equal(await balance.refreshBalance({ key: 'account-B', fetch: async () => { throw Error('offline'); } }), null);
});

test('an obsolete rejection cannot replace the new credential snapshot', async () => {
  const balance = await import('../plugins/session-metrics/balance.mjs?rejected-old-request');
  let rejectOld;
  const old = balance.refreshBalance({ key: 'account-A', fetch: () => new Promise((_resolve, reject) => { rejectOld = reject; }) });
  await balance.refreshBalance({ key: 'account-B', fetch: async () => balanceResponse(3) });
  rejectOld(Error('obsolete failure'));
  await old;
  assert.equal(balance.balanceNow(), 3);
});

test('management credential rotation refreshes account credits without waiting for cache expiry', async () => {
  const balance = await import('../plugins/session-metrics/balance.mjs?management-rotation');
  const calls = [];
  const fetch = async (_url, init) => {
    calls.push(init.headers.Authorization);
    return { ok: true, json: async () => ({ data: { total_credits: init.headers.Authorization.endsWith('management-A') ? 11 : 3, total_usage: 0 } }) };
  };
  await balance.refreshBalance({ provider: 'openrouter', key: 'inference', managementKey: 'management-A', fetch });
  assert.equal(await balance.refreshBalance({ provider: 'openrouter', key: 'inference', managementKey: 'management-B', fetch }), 3);
  assert.deepEqual(calls, ['Bearer management-A', 'Bearer management-B']);
  assert.deepEqual(balance.balanceInfoNow('openrouter'), { amount: 3, currency: 'USD', source: 'account' });
});

test('an explicit missing credential does not revive an environment fallback', async t => {
  const balance = await import('../plugins/session-metrics/balance.mjs?explicit-missing');
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'environment-fixture';
  t.after(() => { if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous; });
  assert.equal(await balance.refreshBalance({ fetch: async () => balanceResponse(11) }), 11);
  assert.equal(await balance.refreshBalance({ key: undefined, fetch: async () => assert.fail('missing credential must not fetch') }), null);
});

test('malformed amounts stay unknown and public balance metadata contains no credential', async () => {
  const balance = await import('../plugins/session-metrics/balance.mjs?balance-metadata');
  for (const value of [null, undefined, '', ' ', true, {}, -1, 'oops']) {
    assert.equal(balance.parseBalance({ balance_infos: [{ currency: 'USD', total_balance: value }] }), null);
  }
  assert.equal(balance.parseBalance({ balance_infos: [{ total_balance: '80' }] }), null);
  await balance.refreshBalance({ key: 'PRIVATE_FIXTURE_KEY', fetch: async () => balanceResponse(0, 'CNY') });
  const info = balance.balanceInfoNow();
  assert.deepEqual(info, { amount: 0, currency: 'CNY', source: 'account' });
  assert(Object.isFrozen(info));
  assert(!JSON.stringify(info).includes('PRIVATE_FIXTURE_KEY'));
});

test('refused account credits cannot survive a failed fallback key-limit lookup', async t => {
  const balance = await import('../plugins/session-metrics/balance.mjs?source-change');
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await balance.refreshBalance({ provider: 'openrouter', key: 'inference', managementKey: '', fetch: async () => ({ ok: true, json: async () => ({ data: { total_credits: 11, total_usage: 0 } }) }) });
  now += 6 * 60 * 1000;
  const result = await balance.refreshBalance({ provider: 'openrouter', key: 'inference', managementKey: '', fetch: async url => ({
    ok: false, status: url.endsWith('/credits') ? 403 : 500,
    json: async () => { throw Error('not JSON'); },
  }) });
  assert.equal(result, null);
  assert.equal(balance.balanceInfoNow('openrouter'), null);
});

test('native credential notifications clear cached data and ignore obsolete credential resolution', async t => {
  const listeners = new Map(), disposers = [], calls = [];
  const environment = new Map(['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_MANAGEMENT_KEY'].map(ref => [ref, process.env[ref]]));
  for (const ref of environment.keys()) delete process.env[ref];
  t.after(() => { for (const [ref, value] of environment) { if (value === undefined) delete process.env[ref]; else process.env[ref] = value; } });
  let key = 'account-A', resolveOld;
  const oldResolution = new Promise(resolve => { resolveOld = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, init) => { calls.push(init.headers.Authorization); return balanceResponse(3); });
  applyMetrics({
    effect: fn => disposers.push(fn()), on: (name, fn) => listeners.set(name, fn), logger: { warn() {} },
    get: () => ({ resolve: async ref => ref === 'DEEPSEEK_API_KEY' ? key === 'account-A' ? oldResolution : key ? { value: key } : undefined : undefined }),
    agents: { get: () => undefined },
  });
  t.after(() => { for (const dispose of disposers.reverse()) dispose?.(); });
  key = 'account-B';
  await listeners.get('credentials/reference-updated')('DEEPSEEK_API_KEY');
  assert.equal(balanceNow(), 3);
  resolveOld({ value: 'account-A' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['Bearer account-B']);
  key = undefined;
  const clearing = listeners.get('credentials/reference-updated')('DEEPSEEK_API_KEY');
  assert.equal(balanceNow(), null, 'the old reading is cleared before asynchronous resolution');
  await clearing;
  assert.equal(balanceNow(), null);
});

test('credential notifications resolve a service that became available after metrics startup', async t => {
  const listeners = new Map(), disposers = [];
  let ready = false;
  const environment = new Map(['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_MANAGEMENT_KEY'].map(ref => [ref, process.env[ref]]));
  for (const ref of environment.keys()) delete process.env[ref];
  t.after(() => { for (const dispose of disposers.reverse()) dispose?.(); for (const [ref, value] of environment) { if (value === undefined) delete process.env[ref]; else process.env[ref] = value; } });
  t.mock.method(globalThis, 'fetch', async () => balanceResponse(7));
  applyMetrics({
    effect: fn => disposers.push(fn()), on: (name, fn) => listeners.set(name, fn), logger: { warn() {} },
    get: () => ready ? { resolve: async ref => ref === 'DEEPSEEK_API_KEY' ? { value: 'late-service-fixture' } : undefined } : undefined,
    agents: { get: () => undefined },
  });
  ready = true;
  await listeners.get('credentials/reference-updated')('DEEPSEEK_API_KEY');
  assert.equal(balanceNow(), 7);
});
