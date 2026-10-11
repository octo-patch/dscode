import test from 'node:test';
import assert from 'node:assert/strict';
import { providerStatus, registerStatus, acpStatus, statusConnection } from '../plugins/status/index.mjs';
import { registerStatusSelection, statusSelection } from '../plugins/status/selection.mjs';

function fixture(provider = 'deepseek-official') {
  const profile = { apiKeyEnv: 'ACTIVE_KEY' }, keys = new Map([['ACTIVE_KEY', 'fake-active-secret']]);
  const services = {
    settings: { describe: () => [{ ns: 'route', value: { profiles: { active: profile } } }] },
    credentials: { resolve: async ref => keys.has(ref) ? { value: keys.get(ref) } : undefined },
    launchEnvironment: { get: () => undefined },
  };
  const declarations = [{ provider, settingsNs: 'route', settingsPath: ['profiles', 'active'] }];
  const ctx = { get: name => services[name], llm: { listConfigurableProviders: () => declarations } };
  const selection = { provider, model: 'test-model' }, requests = [];
  const run = (body, options = {}) => providerStatus(ctx, selection, { locale: 'en', fetch: async (url, init) => {
    requests.push({ url, ...init });
    return typeof body === 'function' ? body(url, init) : Response.json(body);
  }, ...options });
  return { ctx, profile, services, keys, declarations, selection, requests, run };
}

test('status queries the active credential on every call, preserving zero, currencies and account availability', async () => {
  const f = fixture();
  const body = { is_available: false, balance_infos: [{ currency: 'USD', total_balance: '0.00' }, { currency: 'CNY', total_balance: '12.34' }, { currency: 'BTC', total_balance: '8' }, { currency: 'USD', total_balance: 'fake-active-secret' }] };
  const output = await f.run(body);
  assert.match(output, /Provider: deepseek-official\nModel: test-model/);
  assert.match(output, /Account balance: 0.00 USD/);
  assert.match(output, /Account balance: 12.34 CNY/);
  assert.match(output, /Account available: no/);
  assert.match(output, /Checked: \d{4}-/);
  assert.doesNotMatch(output, /BTC|secret/);
  f.keys.set('ACTIVE_KEY', 'fake-second-key');
  await f.run(body);
  assert.deepEqual(f.requests.map(r => r.headers.Authorization), ['Bearer fake-active-secret', 'Bearer fake-second-key']);
  assert(f.requests.every(r => r.url === 'https://api.deepseek.com/user/balance' && r.redirect === 'error'));
});

test('status refuses unknown/custom endpoints and never sends their credential to the official billing API', async () => {
  for (const baseURL of ['https://custom.example/v1', 'http://api.deepseek.com', 'https://api.deepseek.com.evil.test', 'https://api.deepseek.com/proxy', 'https://user:pass@api.deepseek.com', 'https://api.deepseek.com/?key=secret']) {
    const f = fixture(); f.profile.baseURL = baseURL;
    assert.match(await f.run({}), /not supported/);
    assert.equal(f.requests.length, 0);
  }
  for (const provider of ['custom-llama', 'grok', 'opencode-go', undefined]) {
    const f = fixture(provider); f.selection.provider = provider;
    assert.match(await f.run({}), /not supported/);
    assert.equal(f.requests.length, 0);
  }
  const f = fixture();
  f.services.launchEnvironment.get = ref => ref === 'DEEPSEEK_BASE_URL' ? { value: 'https://proxy.example' } : undefined;
  assert.match(await f.run({}), /not supported/);
  assert.equal(f.requests.length, 0);
});

test('status honors configured references and fails closed when their metadata or key is missing', async () => {
  const f = fixture();
  f.keys.delete('ACTIVE_KEY'); f.keys.set('DEEPSEEK_API_KEY', 'wrong-key');
  assert.match(await f.run({}), /not configured/);
  delete f.profile.apiKeyEnv;
  assert.match(await f.run({}), /unavailable/);
  assert.equal(f.requests.length, 0);
  f.declarations.length = 0;
  assert.deepEqual(statusConnection(f.ctx, 'deepseek-official'), { ref: 'DEEPSEEK_API_KEY' });
  assert.equal(statusConnection(f.ctx, 'unknown'), undefined);
  delete f.services.credentials;
  f.services.launchEnvironment.get = ref => ref === 'DEEPSEEK_API_KEY' ? { value: 'launch-key' } : undefined;
  await f.run({ balance_infos: [{ currency: 'USD', total_balance: '2' }] });
  assert.equal(f.requests[0].headers.Authorization, 'Bearer launch-key');
});

test('OpenRouter shows account funds separately from key limits and effective budget using only the active key', async () => {
  const f = fixture('dscode-openrouter');
  const output = await f.run(url => Response.json({ data: url.endsWith('/credits') ? { total_credits: 0.3, total_usage: 0.1 } : { limit: 1, limit_remaining: 0, effective_budget: { remaining_usd: 0 } } }));
  assert.match(output, /Account balance: 0.2 USD/);
  assert.match(output, /This key remaining limit: 0 USD/);
  assert.match(output, /Effective budget remaining: 0 USD/);
  assert.equal(f.requests.length, 2);
  assert(f.requests.every(r => r.headers.Authorization === 'Bearer fake-active-secret'));
  const noCap = await f.run(url => url.endsWith('/credits') ? new Response('secret', { status: 403 }) : Response.json({ data: { limit: null, limit_remaining: null } }));
  assert.match(noCap, /Account balance: unavailable/);
  assert.match(noCap, /No key spending cap \(not an unlimited account balance\)/);
  const noKey = await f.run(url => url.endsWith('/key') ? new Response('', { status: 403 }) : Response.json({ data: { total_credits: '5', total_usage: '2' } }));
  assert.match(noKey, /Account balance: 3 USD/);
  assert.match(noKey, /This key remaining limit: unavailable/);
});

test('balance failures never expose raw errors, bodies or credentials and never become zero', async () => {
  for (const provider of ['deepseek-official', 'openrouter']) {
    const f = fixture(provider);
    for (const code of [401, 403, 500]) {
      const output = await f.run(() => new Response('fake-secret-response', { status: code }));
      assert.match(output, code === 500 ? /unavailable/ : /refused/);
      assert.doesNotMatch(output, /fake-|0 USD/);
    }
    for (const body of [null, {}, { balance_infos: [{ currency: 'USD', total_balance: 'NaN' }] }]) {
      const output = await f.run(body);
      assert.match(output, /unavailable/);
      assert.doesNotMatch(output, /0 USD/);
    }
    assert.doesNotMatch(await f.run(() => { throw Error('fake-secret'); }), /fake-secret/);
  }
});

test('DeepSeek account preserves recharge and bonus wallets and handles signed-out/failed state', async () => {
  const f = fixture('deepseek-account');
  assert.match(await f.run({}), /not configured/);
  let balance = { status: 'ready', value: [{ currency: 'CNY', balance: '3.40' }], bonusWallets: [{ currency: 'USD', balance: '0' }] };
  f.services.deepseekAccount = { getState: async () => ({ status: 'credential-stored' }), getBalance: async metadata => {
    assert.equal(metadata.locale, 'en'); assert.equal(typeof metadata.version, 'string'); assert.equal(typeof metadata.timezoneOffsetSeconds, 'number'); return balance;
  } };
  const output = await f.run({});
  assert.match(output, /Recharge balance: 3.40 CNY/);
  assert.match(output, /Bonus balance: 0 USD/);
  for (const state of [null, { status: 'failed' }, { status: 'ready' }]) {
    balance = state; assert.match(await f.run({}), /unavailable/);
  }
  assert.equal(f.requests.length, 0);
});

test('status bounds network/account waits and propagates explicit cancellation', async () => {
  // AbortSignal.timeout is unref'ed, so keep the test alive while the fake backend never settles.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const f = fixture();
    assert.match(await f.run(() => new Promise(() => {}), { timeoutMs: 10 }), /timed out/);
    const controller = new AbortController();
    const pending = f.run(() => new Promise(() => {}), { signal: controller.signal });
    controller.abort(new Error('user cancelled'));
    await assert.rejects(pending, /user cancelled/);
    await assert.rejects(f.run({}, { signal: controller.signal }), /user cancelled/);
    f.selection.provider = 'deepseek-account';
    f.services.deepseekAccount = { getState: () => new Promise(() => {}) };
    assert.match(await f.run({}, { timeoutMs: 10 }), /timed out/);
  } finally { clearInterval(keepAlive); }
});

test('terminal command reads the selected session model and rejects arguments without echoing them', async () => {
  const f = fixture('custom-llama'); let command;
  f.ctx.commands = { register: value => { command = value; } };
  registerStatus(f.ctx);
  assert.equal(command.name, 'status');
  const result = await command.handler({ agent: { options: { provider: 'deepseek-official', model: 'old' }, session: { requestHeader: () => ({ config: { provider: 'custom-llama', model: 'new' } }) } }, rawInput: '' });
  assert.equal(result.kind, 'success'); assert.match(result.text, /custom-llama/); assert.match(result.text, /new/);
  const invalid = await command.handler({ rawInput: 'secret' });
  assert.equal(invalid.kind, 'error'); assert.doesNotMatch(invalid.text, /secret/);
});

test('terminal status follows a new picker choice before another model request and isolates sessions', () => {
  const agent = { options: { provider: 'default', model: 'default' }, session: { requestHeader: () => ({ config: { provider: 'old', model: 'old' } }) } };
  let picked = { provider: 'new', model: 'new' };
  registerStatusSelection(agent, () => picked);
  assert.equal(statusSelection(agent), picked);
  picked = { provider: 'another', model: 'another' };
  assert.equal(statusSelection(agent), picked);
  assert.deepEqual(statusSelection({ options: { provider: 'default' }, session: { requestHeader: () => undefined } }), { provider: 'default' });
  picked = undefined;
  assert.deepEqual(statusSelection(agent), { provider: 'old', model: 'old' });
});

test('ACP intercepts only a standalone /status and localizes balance output', async () => {
  const f = fixture('custom-llama');
  assert.match(await acpStatus(f.ctx, f.selection, [{ type: 'text', text: ' /status ' }]), /custom-llama/);
  assert.doesNotMatch(await acpStatus(f.ctx, f.selection, [{ type: 'text', text: '/status secret' }]), /secret/);
  for (const prompt of [[], [{ type: 'text', text: '/status/file' }], [{ type: 'text', text: 'explain /status' }], [{ type: 'image', data: '/status' }], [{ type: 'text', text: '/status' }, { type: 'text', text: 'more' }]]) {
    assert.equal(await acpStatus(f.ctx, f.selection, prompt), undefined);
  }
  assert.match(await f.run({}, { locale: 'zh-CN' }), /暂不支持余额查询/);
});
