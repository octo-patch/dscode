import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import Credentials from '../plugins/credentials/index.mjs';
import * as Anthropic from '../plugins/anthropic/index.mjs';
import { AnthropicAdapter } from '../plugins/anthropic/adapter.mjs';
import { MODELS, getModel } from '../plugins/anthropic/models.mjs';
import { requestBody, prefixHash, REPLAY_KIND } from '../plugins/anthropic/wire.mjs';
import { providerArgument, pickModel } from '../plugins/providers/catalog.mjs';
import { loadModelDirectory } from '../packages/tui/src/models.ts';
import { DscodeProviderPanel } from '../packages/tui/src/app.ts';
import { mount, assertFits } from './fixtures/tui-mount.mjs';

const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
const base = { provider: 'anthropic', model: 'claude-opus-5-5', messages: [user('hello')] };
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
const sse = events => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
function events(content, reason = 'end_turn') {
  return [{ type: 'message_start', message: { id: 'msg_test', usage: { input_tokens: 7, cache_read_input_tokens: 11, cache_creation_input_tokens: 13 } } },
    ...content.flatMap((block, index) => [{ type: 'content_block_start', index, content_block: block }, { type: 'content_block_stop', index }]),
    { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 17 } }, { type: 'message_stop' }];
}
const adapter = fetch => new AnthropicAdapter({ options: () => Anthropic.resolveOptions(), resolveApiKey: async () => 'synthetic-key', fetch });

test('Anthropic catalog works offline, uses official limits and selects Opus by default', async () => {
  const a = adapter(() => { throw Error('catalog must not fetch'); });
  assert.equal(providerArgument(' Anthropic '), 'anthropic');
  assert.equal(providerArgument('claude'), 'anthropic');
  assert.deepEqual((await a.listModels('anthropic')).map(m => m.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);
  for (const model of MODELS) {
    const info = await a.resolveModel('anthropic', model.id);
    assert.equal(info.context.contextWindow, 1_000_000);
    assert.equal(info.defaultMaxTokens, 128_000);
    assert.deepEqual(info.reasoning.efforts.map(e => e.id), ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(info.inputModalities, ['text', 'image']);
    const body = requestBody({ ...base, model: model.id, temperature: 0.3 }, model, undefined, 'account');
    assert.equal(body.output_config.effort, model.defaultEffort);
    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
    assert(!('temperature' in body));
    assert.throws(() => requestBody({ ...base, reasoningEffort: 'off' }, model), /effort/);
    assert.throws(() => requestBody({ ...base, maxTokens: 128001 }, model), /budget/);
  }
  const rows = MODELS.toReversed().map(m => ({ provider: 'anthropic', model: m.id }));
  assert.equal(pickModel(rows, 'anthropic', 'deepseek-official/deepseek-flash').row.model, base.model);
  await assert.rejects(a.resolveModel('anthropic', 'unknown'), /Unknown/);
});

test('Anthropic streams split tool arguments and signatures, then replays exact content with native results', async () => {
  const requests = [];
  const a = adapter(async (url, init) => {
    requests.push(JSON.parse(init.body));
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.headers['x-api-key'], 'synthetic-key');
    assert.equal(init.headers['anthropic-version'], '2023-06-01');
    assert.equal(init.redirect, 'error');
    if (requests.length > 1) return sse(events([{ type: 'text', text: 'done' }]));
    const fixture = events([], 'tool_use');
    fixture.splice(1, 0,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Checking. ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '现在' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'summary' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'opaque-' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'signature' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call1', name: 'lookup', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"你好"}' } },
      { type: 'content_block_stop', index: 2 });
    return sse(fixture);
  });
  const options = { ...base, tools: [{ name: 'lookup', description: 'lookup', parameters: { type: 'object' } }], reasoningEffort: 'xhigh' };
  const first = await collect(a.stream(options)), finish = first.at(-1);
  assert.equal(finish.reason.kind, 'tool-calls');
  assert.equal(requests[0].output_config.effort, 'xhigh');
  assert.deepEqual(first.find(c => c.type === 'usage').usage, { inputTokens: 7, outputTokens: 17, totalTokens: 48, cacheReadTokens: 11, cacheWriteTokens: 13 });
  const content = finish.replayState.response.nativeContent;
  assert.deepEqual(content.map(b => b.type), ['text', 'thinking', 'tool_use']);
  assert.equal(content[0].text, 'Checking. 现在');
  assert.equal(content[1].signature, 'opaque-signature');
  assert.deepEqual(content[2].input, { q: '你好' });
  const second = await collect(a.stream({ ...options, messages: [...base.messages,
    { role: 'assistant', source: { provider: 'anthropic', model: base.model, replayState: finish.replayState }, content: first.filter(c => c.type === 'block-end').map(c => c.block) },
    createToolResultMessage({ callId: 'call1', content: [{ type: 'text', text: 'result' }], isError: false })] }));
  assert.deepEqual(requests[1].messages[1].content, content);
  assert.equal(requests[1].messages[2].content[0].tool_use_id, 'call1');
  assert.equal(second.at(-1).reason.kind, 'stop');
});

test('Anthropic accepts empty argument deltas without losing no-argument tools or replay', async () => {
  for (const fragments of [[], [''], ['', '{}', '']]) {
    const fixture = events([], 'tool_use');
    fixture.splice(1, 0,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'review1', name: 'review', input: {} } },
      ...fragments.map(partial_json => ({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } })),
      { type: 'content_block_stop', index: 0 });
    const chunks = await collect(adapter(async () => sse(fixture)).stream(base));
    const call = chunks.find(c => c.type === 'block-end').block;
    assert.equal(call.name, 'review');
    assert.deepEqual(JSON.parse(call.arguments), {});
    assert.deepEqual(chunks.at(-1).replayState.response.nativeContent[0].input, {});
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
  }
});

test('Anthropic still rejects nonempty incomplete tool JSON', async () => {
  const fixture = events([], 'tool_use');
  fixture.splice(1, 0,
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call1', name: 'lookup', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
    { type: 'content_block_stop', index: 0 });
  await assert.rejects(collect(adapter(async () => sse(fixture)).stream(base)), e => e.code === 'MALFORMED_RESPONSE');
});

test('changed prefixes, model switches and credentials discard bound thinking while preserving tool calls', () => {
  const model = getModel(base.model), initial = requestBody(base, model, undefined, 'account');
  const nativeContent = [{ type: 'redacted_thinking', data: 'opaque' }, { type: 'tool_use', id: 'call', name: 'lookup', input: {} }];
  const assistant = { role: 'assistant', content: [{ type: 'tool-call', id: 'call', name: 'lookup', arguments: '{}' }], source: {
    provider: 'anthropic', model: base.model, replayState: { response: { kind: REPLAY_KIND, nativeContent, requestPrefix: prefixHash(initial), account: 'account' } },
  } };
  const history = [...base.messages, assistant, user('result')];
  const body = (extra = {}, m = model, account = 'account') => requestBody({ ...base, messages: history, ...extra }, m, undefined, account);
  assert.deepEqual(body().messages[1].content, nativeContent);
  for (const changed of [body({ system: 'changed' }), body({ tools: [{ name: 'new', parameters: {} }] }),
    body({}, getModel('claude-sonnet-5-5')), body({}, model, 'another-account'), body({ messages: [user('summary'), assistant, user('result')] })]) {
    assert.deepEqual(changed.messages[1].content, [nativeContent[1]]);
  }
  assert.equal(nativeContent.length, 2, 'never mutate stored replay');
});

test('Anthropic rejects truncated, malformed and failed streams without committing an assistant turn', async () => {
  for (const fixture of [events([{ type: 'text', text: 'partial' }]).slice(0, -1),
    [{ type: 'error', error: { type: 'overloaded_error', message: 'synthetic-key' } }],
    events([{ type: 'tool_use', id: '', name: 'lookup', input: {} }], 'tool_use')]) {
    const committed = [];
    await assert.rejects(async () => { for await (const c of adapter(async () => sse(fixture)).stream(base)) committed.push(c); }, error => !error.message.includes('synthetic-key'));
    assert(!committed.some(c => c.type === 'finish'));
  }
  const failed = adapter(async () => Response.json({ error: { message: 'synthetic-key' } }, { status: 429, headers: { 'retry-after': '2' } }));
  await assert.rejects(collect(failed.stream(base)), e => e.code === 'RATE_LIMIT' && e.failure.providerRetryAfterMs === 2000 && !e.message.includes('synthetic-key'));
  await assert.rejects(collect(adapter(async () => { throw Error('synthetic-key'); }).stream(base)), e => e.code === 'TRANSPORT' && !e.message.includes('synthetic-key'));
});

test('Anthropic cancellation and idle timeout abort the HTTP operation', async () => {
  const pending = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  const controller = new AbortController(), a = adapter(pending);
  const running = collect(a.stream({ ...base, signal: controller.signal }));
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(running, e => e.code === 'ABORTED');
  a.config.options = () => Anthropic.resolveOptions({ streamIdleTimeoutMs: 10 });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(collect(a.stream(base)), e => e.code === 'TIMEOUT'); }
  finally { clearTimeout(keepAlive); }
});

test('Anthropic registers with the real Harness, persists shared keys and respects environment precedence', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anthropic-runtime-')), roots = [];
  const path = join(home, 'shared', 'credentials.yaml');
  const open = async values => {
    const ctx = new Context(); roots.push(ctx);
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values }]));
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(Credentials, { path, dshHome: home, watch: false });
    await ctx.plugin(Anthropic);
    return ctx;
  };
  try {
    const ctx = await open({});
    assert.equal((await loadModelDirectory(ctx)).rows.filter(r => r.provider === 'anthropic').length, 3);
    assert(ctx.llm.listConfigurableProviders().some(p => p.provider === 'anthropic'));
    const missing = (await collect(ctx.llm.stream(base))).at(-1);
    assert.equal(missing.reason.failure.code, 'MISSING_CREDENTIAL');
    assert.match(missing.reason.failure.message, /login anthropic/);
    await ctx.credentials.set('ANTHROPIC_API_KEY', 'synthetic-saved');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const restored = await open({});
    assert.equal((await restored.credentials.resolve('ANTHROPIC_API_KEY')).value, 'synthetic-saved');
    const overridden = await open({ ANTHROPIC_API_KEY: 'synthetic-env' });
    assert.equal((await overridden.credentials.resolve('ANTHROPIC_API_KEY')).value, 'synthetic-env');
    assert.equal((await overridden.credentials.describe('ANTHROPIC_API_KEY')).writable, false);
  } finally { for (const ctx of roots) await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); }
});

test('/provider exposes Anthropic as a selectable route', async () => {
  const choices = [];
  const ui = await mount(DscodeProviderPanel, { current: 'anthropic', load: async () => ({ rows: [] }), choose: p => choices.push(p), back() {} });
  try { assert.match(ui.frame(), /Anthropic/); await ui.write('\r'); assert.deepEqual(choices, ['anthropic']); assertFits(ui); }
  finally { ui.close(); }
});
