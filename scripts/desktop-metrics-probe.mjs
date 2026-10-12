import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { appendMetric } from '../plugins/session-metrics/store.mjs';
import * as metrics from '../plugins/session-metrics/desktop-host.mjs';

export const inject = ['agents', 'agentPresets', 'llm', 'sessions'];
export function apply(ctx) { void run(ctx).catch(error => {
  console.error(error.stack);
  if (process.env.DSCODE_METRICS_ELECTRON) process.send({ type: 'dscode-metrics-failed' }); else ctx.get('appExit')(1);
}); }
async function run(ctx) {
  await ctx.get('loader').await();
  const phase = process.env.DSCODE_METRICS_PHASE, ui = !!process.env.DSCODE_METRICS_UI, home = process.env.DSH_HOME, handles = [];
  let modelCalls = 0;
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 } }; }
    async *stream() {
      modelCalls++; writeFileSync(join(home, 'metrics-model-calls.json'), JSON.stringify({ modelCalls }));
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Usage fixture complete.' }; await delay(25);
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Usage fixture complete. This response and its usage are scripted.' } };
      yield { type: 'usage', usage: { inputTokens: 20, cacheReadTokens: 80, outputTokens: 10 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['desktop-metrics-fixture'], new Adapter());
  const make = async (id, preset, resume = false, target = { provider: 'desktop-metrics-fixture', model: 'fixture' }) => {
    const setup = async (scope, agent) => { await ctx.agentPresets.mount(scope, preset);
      installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined }); };
    const handle = resume ? await ctx.agents.resume({ resumeSessionId: id, setup }) : await ctx.agents.create({ sessionId: id,
      meta: { cwd: process.cwd(), agentPreset: preset }, agentOptions: target, setup });
    handles.push(handle); return handle.agent;
  };
  const agent = await make('desktop-usage-current', 'dscode', phase !== 'generate');
  const standard = await make('desktop-usage-standard-' + phase, 'standard');
  const origin = `http://127.0.0.1:${ctx.get('webServer').port}`, connection = ctx.get('connection');
  const auth = await fetch(connection.authenticatedUrl(origin), { redirect: 'manual' });
  const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const request = (sessionId = agent.id, headers = { Cookie: cookie, Origin: origin }) => fetch(origin + '/api/dscode-metrics', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'dscode-metrics', payload: { action: 'status', sessionId } }),
  });
  const status = async (sessionId = agent.id) => { const response = await request(sessionId); assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json(); assert(body.result.ok, body.result.error?.message); return body.result.value; };
  try {
    if (phase === 'generate') {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Desktop usage fixture' }] }));
      await agent.whenIdle(); await ctx.sessions.flush(agent.session);
      const time = agent.session.snapshotEvents().find(event => event.type === 'turn/start').time + 1;
      appendMetric(home, agent.id, { kind: 'start', id: 'synthetic-cost', time, provider: 'fixture', model: 'fixture', purpose: 'memory' });
      appendMetric(home, agent.id, { kind: 'end', id: 'synthetic-cost', time, cost: 0.012 });
      appendMetric(home, standard.id, { kind: 'end', id: 'foreign-cost', time, cost: 900 });
    }
    assert.equal((await request(agent.id, {})).status, 401);
    assert.equal((await request(agent.id, { Cookie: cookie, Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await (await request(standard.id)).json()).result.ok, false);
    assert.equal((await (await request('missing')).json()).result.ok, false);
    const seq = agent.session.seq, snapshot = await status(); await status();
    assert.equal(agent.session.seq, seq); assert.equal(modelCalls, phase === 'generate' ? 1 : 0);
    assert.equal(snapshot.cost, 0.012); assert.equal(snapshot.partial, true); assert.equal(snapshot.cachePercent, 80);
    assert.equal(snapshot.turns.length, 1); assert.equal(snapshot.turns[0].cost, 0.012);
    assert.equal(snapshot.calls, 2); assert.equal(snapshot.pending, 0);
    assert(!JSON.stringify(snapshot).includes('Desktop usage fixture')); assert(!snapshot.turns.some(turn => turn.cost === 900));
    const credentials = ctx.get('credentials'), nativeFetch = globalThis.fetch;
    const credentialUpdates = [];
    ctx.on('credentials/reference-updated', ref => credentialUpdates.push(ref));
    let releaseLate, lateBodyRead = false, balanceRequests = 0, lastReading;
    const balanceBody = amount => Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: String(amount) }] });
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const authorization = new Headers(init?.headers).get('authorization');
      if (url.origin === 'https://api.deepseek.com' && url.pathname === '/user/balance') {
        balanceRequests++;
        if (authorization === 'Bearer metrics-late-fixture') return new Promise(resolve => {
          releaseLate = () => {
            const response = balanceBody(99), json = response.json.bind(response);
            response.json = async () => { const body = await json(); lateBodyRead = true; return body; };
            resolve(response);
          };
        });
        assert(['Bearer metrics-A-fixture', 'Bearer metrics-B-fixture'].includes(authorization), 'Unexpected fixture balance credential');
        return balanceBody(authorization === 'Bearer metrics-A-fixture' ? 11 : 3);
      }
      if (url.origin === 'https://openrouter.ai' && ['/api/v1/credits', '/api/v1/key'].includes(url.pathname)) {
        assert.equal(authorization, 'Bearer metrics-limited-fixture');
        return url.pathname.endsWith('/credits') ? Response.json({}, { status: 403 }) : Response.json({ data: { limit_remaining: 2 } });
      }
      return nativeFetch(input, init);
    };
    const waitFor = async predicate => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) { if (await predicate()) return; await delay(10); }
      assert.fail('Native balance fixture did not settle: ' + JSON.stringify({ balanceRequests, credentialUpdates, lastReading: lastReading && { provider: lastReading.provider, model: lastReading.model, balance: lastReading.balance, currency: lastReading.balanceCurrency } }));
    };
    try {
      const balanceAgent = await make('desktop-balance-' + phase, 'dscode', false, { provider: 'deepseek-official', model: 'deepseek-flash' });
      const reading = async () => { lastReading = await status(balanceAgent.id); return lastReading; };
      await credentials.set('DEEPSEEK_API_KEY', 'metrics-A-fixture');
      await waitFor(async () => (await reading()).balance === 11);
      await credentials.set('DEEPSEEK_API_KEY', 'metrics-B-fixture');
      await waitFor(async () => (await reading()).balance === 3);
      const current = await reading();
      assert.equal(current.balanceCurrency, 'CNY'); assert.equal(current.balanceSource, 'account');
      assert(!JSON.stringify(current).includes('metrics-B-fixture'));
      await credentials.set('DEEPSEEK_API_KEY', 'metrics-late-fixture');
      await waitFor(() => !!releaseLate);
      assert.equal((await reading()).balance, null);
      await credentials.set('DEEPSEEK_API_KEY', 'metrics-B-fixture');
      await waitFor(async () => (await reading()).balance === 3);
      releaseLate();
      await waitFor(() => lateBodyRead);
      assert.equal((await reading()).balance, 3);
      await credentials.unset('DEEPSEEK_API_KEY');
      await waitFor(async () => (await reading()).balance === null);
      assert.equal((await reading()).balanceCurrency, null);
      const limitAgent = await make('desktop-limit-' + phase, 'dscode', false, { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' });
      await credentials.set('OPENROUTER_API_KEY', 'metrics-limited-fixture');
      await waitFor(async () => (await status(limitAgent.id)).balance === 2);
      const limit = await status(limitAgent.id);
      assert.equal(limit.balanceCurrency, 'USD'); assert.equal(limit.balanceSource, 'key-limit');
      await credentials.unset('OPENROUTER_API_KEY');
      await waitFor(async () => (await status(limitAgent.id)).balance === null);
      assert.equal(modelCalls, phase === 'generate' ? 1 : 0, 'Balance verification must not request inference');
    } finally {
      releaseLate?.();
      globalThis.fetch = nativeFetch;
    }
    if (phase === 'generate') writeFileSync(join(home, 'metrics-snapshot.json'), JSON.stringify(snapshot));
    else assert.equal(snapshot.cost, JSON.parse(readFileSync(join(home, 'metrics-snapshot.json'))).cost);
    if (phase === 'unload') {
      await [...ctx.get('loader').entries()].find(entry => entry.options.id === 'dscode-desktop-metrics').fiber.dispose();
      assert.equal((await request()).status, 404);
      const reload = ctx.plugin(metrics); await reload; assert.equal((await status()).cost, snapshot.cost); await reload.dispose();
    }
    console.log('DESKTOP_METRICS_PASSED ' + JSON.stringify({ phase, authenticatedRpc: true, originEnforced: true,
      presetAndSessionIsolation: true, metadataOnly: true, ledgerProjection: true, noReadSideEffects: true,
      nativeCredentialBalanceUpdates: true, credentialRemoval: true, obsoleteBalanceRejected: true, balanceCurrencyAndSource: true,
      ...(phase !== 'generate' ? { persistedCost: true } : {}), ...(phase === 'unload' ? { unloadReload: true } : {}) }));
    if (ui) { console.log('DESKTOP_METRICS_UI_READY ' + JSON.stringify({ home, sessionId: agent.id })); return; }
  } finally { if (!ui) for (const handle of handles.reverse()) await handle.dispose(); }
  if (process.env.DSCODE_METRICS_ELECTRON) process.send({ type: 'dscode-metrics-shutdown' }); else ctx.get('appExit')(0);
}
