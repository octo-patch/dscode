import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import Credentials from '../plugins/credentials/index.mjs';
import * as plugin from '../plugins/antigravity/index.mjs';
import { AntigravityClient, ENDPOINTS } from '../plugins/antigravity/client.mjs';
import { authorize, callbackServer, exchangeCode, AntigravitySession, GRANT_REF, parseGrant } from '../plugins/antigravity/oauth.mjs';
import { AntigravityLogin, antigravityCommand } from '../plugins/antigravity/command.mjs';
import { AntigravityModels, FALLBACK_MODELS, parseModels, modelRoute } from '../plugins/antigravity/models.mjs';
import { AntigravityAdapter } from '../plugins/antigravity/adapter.mjs';
import { requestBody, translate } from '../plugins/antigravity/wire.mjs';
import { sseData } from '../plugins/providers/chat-stream.mjs';
import { providerArgument, providerSpec, pickModel } from '../plugins/providers/catalog.mjs';
import { loadModelDirectory } from '../packages/tui/src/models.ts';

const collect = async stream => { const out = []; for await (const item of stream) out.push(item); return out; };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const grant = () => ({ version: 1, access: 'test-access', refresh: 'test-refresh', projectId: 'test-project', expires: Date.now() + 3600000 });
const memory = initial => { let value = initial; return { read: async () => value, write: async v => { value = v; }, remove: async () => { value = undefined; } }; };
const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
const options = () => ({ provider: 'antigravity', model: 'gemini-3.8-flash', system: 'Use DSCODE tools.', sessionId: 'test-session', messages: [user('hello')], tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] });
const catalog = { models: { 'gemini-3.8-flash-low': { model: 'MODEL_LIVE', displayName: 'Gemini 3.8 Flash Low' } } };
const chunk = (parts, finishReason) => ({ response: { candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }] } });
const sse = packets => new Response(packets.map(p => `data: ${JSON.stringify(p)}\r\n\r\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const streamed = packets => translate(sseData(sse(packets).body), { model: 'gemini-3.8-flash', runtimeModel: 'gemini-3.8-flash-low' });
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('Antigravity OAuth uses distinct state and PKCE verifier, S256 and offline consent', () => {
  const a = authorize(), b = authorize(), url = new URL(a.url);
  assert.notEqual(a.state, a.verifier); assert.notEqual(a.state, b.state);
  assert.equal(url.searchParams.get('state'), a.state);
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(a.verifier).digest('base64url'));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert(!a.url.includes(a.verifier));
});

test('loopback callback rejects bad states, accepts one matching response, and releases its port', async () => {
  const listener = await callbackServer('expected', { port: 0 });
  const url = `http://127.0.0.1:${listener.port}/oauth-callback`;
  try {
    assert.equal((await fetch(`${url}?state=wrong&code=bad`)).status, 400);
    const response = await fetch(`${url}?state=expected&code=secret-code`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert(!(await response.text()).includes('secret-code'));
    assert.equal(await listener.code, 'secret-code');
  } finally { listener.close(); }
  const again = await callbackServer('new', { port: listener.port });
  again.close(); await assert.rejects(again.code, /cancelled/);
});

test('callback cancellation and expiry settle promptly without leaving the login pending', async () => {
  const controller = new AbortController();
  const pending = await callbackServer('state', { port: 0, signal: controller.signal });
  controller.abort(); await assert.rejects(pending.code, /cancelled/);
  const expired = await callbackServer('state', { port: 0, timeoutMs: 10 });
  await assert.rejects(expired.code, /expired/);
});

test('OAuth code exchange discovers the project and does not persist the authorization code', async () => {
  const requests = [];
  const saved = await exchangeCode('auth-code', 'verifier', { project: async access => { assert.equal(access, 'access'); return 'project'; } }, {
    fetch: async (url, init) => { requests.push(init); return json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }); },
  });
  assert.equal(requests[0].body.get('code_verifier'), 'verifier');
  assert.equal(requests[0].redirect, 'error');
  assert.equal(saved.projectId, 'project'); assert(!JSON.stringify(saved).includes('auth-code'));
  assert.deepEqual(parseGrant(JSON.stringify(saved)), saved);
  assert.equal(parseGrant('{"access":"bad"}'), undefined);
  await assert.rejects(exchangeCode('auth-code', 'verifier', {}, { fetch: async () => json({ error: 'secret auth-code' }, 401) }), e => e.code === 'AUTH' && !e.message.includes('auth-code'));
});

test('token refresh is single-flight, persists rotation, and retries after failure', async () => {
  const store = memory(JSON.stringify({ ...grant(), expires: 1 })); let count = 0;
  const session = new AntigravitySession(store, { fetch: async () => { count++; return json({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 }); } });
  const [a, b] = await Promise.all([session.auth(), session.auth()]);
  assert.equal(count, 1); assert.equal(a.access, b.access); assert.equal(a.refresh, 'rotated');
  assert.equal((await session.current()).access, 'new');
  await store.write(JSON.stringify({ ...grant(), expires: 1 }));
  session.fetch = async () => json({ error: 'invalid_grant' }, 400);
  await assert.rejects(session.auth(), e => e.code === 'AUTH');
  session.fetch = async () => json({ access_token: 'recovered', expires_in: 3600 });
  assert.equal((await session.auth()).access, 'recovered');
});

test('logout and replacement login cannot be overwritten by a late refresh', async () => {
  const store = memory(JSON.stringify({ ...grant(), expires: 1 })); const started = gate(), response = gate();
  const session = new AntigravitySession(store, { fetch: async () => { started.resolve(); return response.promise; } });
  const pending = session.auth(); await started.promise; await session.logout();
  response.resolve(json({ access_token: 'late', expires_in: 3600 }));
  await assert.rejects(pending, e => e.code === 'MISSING_CREDENTIAL');
  assert.equal(await store.read(), undefined);
  assert.equal(await session.save(grant(), 0), false);
  await session.save(grant()); assert.equal((await session.auth()).access, 'test-access');
});

test('cancelled browser login cannot write credentials after its exchange finishes', async () => {
  const response = gate(), store = memory(), session = new AntigravitySession(store), code = gate();
  const login = new AntigravityLogin({ session, client: {}, models: { clear() {} }, open: async () => true,
    callback: async () => ({ code: code.promise, close() {} }), exchange: async () => response.promise });
  assert.match(await login.login('en'), /Google/); const pending = login.attempt;
  code.resolve('code'); await Promise.resolve(); login.cancel('en'); response.resolve(grant()); await pending.done;
  assert.equal(await session.current(), undefined); assert.equal(login.attempt, undefined);
});

test('login completes, status reports success, command logs out without exposing grants', async () => {
  const store = memory(), session = new AntigravitySession(store); let cleared = 0;
  const login = new AntigravityLogin({ session, client: {}, models: { clear() { cleared++; } }, open: async () => false,
    callback: async () => ({ code: Promise.resolve('code'), close() {} }), exchange: async () => grant() });
  await login.login('en'); if (login.attempt) await login.attempt.done;
  assert.equal((await session.current()).access, 'test-access'); assert.equal(cleared, 1);
  const command = antigravityCommand(login, () => 'en');
  const status = await command.handler({ rawInput: 'status' }); assert.match(status.text, /signed in/); assert(!status.text.includes('test-access'));
  assert.equal((await command.handler({ rawInput: 'unknown' })).kind, 'error');
  await command.handler({ rawInput: 'logout' }); assert.equal(await session.current(), undefined);
});

test('project discovery requires a real project and metadata errors redact server bodies', async () => {
  const client = new AntigravityClient({ fetch: async () => json({ cloudaicompanionProject: { id: 'found' } }) });
  assert.equal(await client.project('token'), 'found');
  client.fetch = async () => json({}); await assert.rejects(client.project('token'), e => e.code === 'AUTH');
  client.fetch = async () => json({ error: { message: 'secret-token' } }, 403);
  await assert.rejects(client.models(grant()), e => !e.message.includes('secret-token') && e.failure.status === 403);
});

test('model discovery groups actual Gemini routes, filters non-chat models and honors token limits', () => {
  const parsed = parseModels({ models: { ...catalog.models, 'gemini-3.8-flash-medium': { model: 'MODEL_MEDIUM' }, 'gemini-next-high': { inputTokenLimit: 250000, outputTokenLimit: 12000 }, 'gemini-image': {}, 'claude-opus': {} } });
  assert.equal(parsed.length, 2); assert.deepEqual(Object.keys(parsed[0].routes), ['low', 'medium']);
  assert.equal(modelRoute(parsed[0], 'medium').modelEnum, 'MODEL_MEDIUM');
  assert.throws(() => modelRoute(parsed[0], 'ultra'), e => e.code === 'UNSUPPORTED_REASONING_EFFORT');
  assert.equal(parsed[1].contextWindow, 250000); assert.equal(parsed[1].maxTokens, 12000);
  assert.throws(() => parseModels({}), e => e.code === 'MALFORMED_RESPONSE');
});

test('catalog requests are cached, recover after errors, and do not retain another account catalog', async () => {
  const store = memory(), session = new AntigravitySession(store); let calls = 0;
  const client = { models: async () => { calls++; return catalog; } };
  const models = new AntigravityModels(session, client);
  assert.equal((await models.list()).length, FALLBACK_MODELS.length); assert.equal(calls, 0);
  await session.save(grant());
  await Promise.all([models.list(), models.list()]); assert.equal(calls, 1);
  await models.list(); assert.equal(calls, 1);
  assert.equal(models.discovered, true); assert.equal((await models.list())[0].routes.low.modelEnum, 'MODEL_LIVE');
  await session.logout(); assert.equal((await models.list()).length, FALLBACK_MODELS.length); assert.equal(models.discovered, false);
  await session.save(grant()); client.models = async () => { throw Error('secret'); };
  await models.list(); assert.equal(models.error, 'Antigravity model discovery failed');
  client.models = async () => catalog; await models.list(true); assert.equal(models.error, undefined);
});

test('request carries the DSCODE system, tools, stable session and native thinking configuration', () => {
  const model = FALLBACK_MODELS[0], route = modelRoute(model, 'medium'), o = options();
  const body = requestBody(o, model, route, 'project');
  assert.equal(body.model, 'gemini-3.8-flash-medium'); assert.equal(body.project, 'project');
  assert.equal(body.request.systemInstruction.parts[0].text, o.system);
  assert.deepEqual(body.request.tools[0].functionDeclarations[0].parametersJsonSchema, o.tools[0].parameters);
  assert.equal(body.request.generationConfig.thinkingConfig.thinkingBudget, 4000);
  assert.equal(body.request.sessionId, requestBody(o, model, route, 'project').request.sessionId);
  assert.notEqual(body.request.sessionId, requestBody({ ...o, sessionId: 'other' }, model, route, 'project').request.sessionId);
});

test('SSE reasoning, signed tool calls and usage replay across a JSON-persisted multi-turn conversation', async () => {
  const packets = [chunk([{ thought: true, text: 'Think', thoughtSignature: 'reason-signature' }]),
    chunk([{ functionCall: { name: 'read', args: { path: 'file' } }, thoughtSignature: 'call-signature' }], 'STOP')];
  packets[1].response.usageMetadata = { promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 3, cachedContentTokenCount: 10, totalTokenCount: 28 };
  const chunks = await collect(streamed(packets));
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
  assert.deepEqual(chunks.find(c => c.type === 'usage').usage, { inputTokens: 10, outputTokens: 8, cacheReadTokens: 10, reasoningTokens: 3, totalTokens: 28 });
  const content = chunks.filter(c => c.type === 'block-end').map(c => c.block), call = content[1];
  const assistant = JSON.parse(JSON.stringify({ role: 'assistant', source: { kind: 'model', provider: 'antigravity', model: 'gemini-3.8-flash', replayState: chunks.at(-1).replayState }, content }));
  const o = { ...options(), messages: [user('read'), assistant, { role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: 'file contents' }] }] };
  const model = FALLBACK_MODELS[0], body = requestBody(o, model, modelRoute(model), 'project');
  assert.equal(body.request.contents[1].parts[1].thoughtSignature, 'call-signature');
  assert.equal(body.request.contents[2].parts[0].functionResponse.name, 'read');
  assert.equal(body.request.contents[2].parts[0].functionResponse.response.output, 'file contents');
  const switched = requestBody(o, model, modelRoute(model, 'high'), 'project');
  assert(!JSON.stringify(switched).includes('call-signature')); assert(!JSON.stringify(switched).includes('functionResponse'));
  assert.match(JSON.stringify(switched), /Historical tool call/);
});

for (const [name, packets, expected] of [
  ['truncated', [chunk([{ functionCall: { name: 'write', args: {} }, thoughtSignature: 's' }])], 'TRANSPORT'],
  ['filtered', [chunk([{ text: 'partial' }], 'SAFETY')], 'CONTENT_FILTER'],
  ['empty', [chunk([], 'STOP')], 'EMPTY_RESPONSE'],
  ['bad arguments', [chunk([{ functionCall: { name: 'write', args: [] } }], 'STOP')], 'MALFORMED_RESPONSE'],
  ['token-limited call', [chunk([{ functionCall: { name: 'write', args: {} } }], 'MAX_TOKENS')], 'MALFORMED_RESPONSE'],
  ['stream error', [{ error: { message: 'secret' } }], 'SERVER'],
]) test(`Antigravity ${name} response never commits a tool result`, async () => {
  const emitted = [];
  await assert.rejects((async () => { for await (const c of streamed(packets)) emitted.push(c); })(), e => e.code === expected && !e.message.includes('secret'));
  assert(!emitted.some(c => c.type === 'block-end' || c.type === 'finish'));
});

function adapter(fetch) {
  const session = new AntigravitySession(memory(JSON.stringify(grant()))), client = new AntigravityClient({ fetch });
  const models = new AntigravityModels(session, { models: async () => catalog });
  return new AntigravityAdapter({ session, client, models, options: () => plugin.resolveOptions({ headerTimeoutMs: 20, streamIdleTimeoutMs: 20 }) });
}

test('adapter forwards OAuth and tools, and retries a missing endpoint without replacing the local loop', async () => {
  const requests = [], route = adapter(async (url, init) => { requests.push({ url, init }); return requests.length === 1 ? json({}, 404) : sse([chunk([{ text: 'ok' }], 'STOP')]); });
  const chunks = await collect(route.stream(options()));
  assert.equal(requests.length, 2); assert(requests[1].url.startsWith(ENDPOINTS[1]));
  assert.equal(requests[0].init.headers.authorization, 'Bearer test-access');
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  assert.equal(JSON.parse(requests[0].init.body).request.tools[0].functionDeclarations[0].name, 'read');
});

test('HTTP failures are bounded and subsequent adapter requests still work', async () => {
  let attempts = 0;
  const route = adapter(async () => { attempts++; return attempts === 1 ? json({ error: { message: 'secret-token' } }, 429) : sse([chunk([{ text: 'recovered' }], 'STOP')]); });
  await assert.rejects(collect(route.stream(options())), e => e.failure.status === 429 && !e.message.includes('secret-token'));
  assert.equal(attempts, 1); assert.equal((await collect(route.stream(options()))).at(-1).reason.kind, 'stop');
});

test('response-header timeout and caller abort release the adapter for later requests', async () => {
  const route = adapter(async (_url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })));
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(collect(route.stream(options())), e => e.code === 'TIMEOUT');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(collect(route.stream({ ...options(), signal: controller.signal })), e => e.code === 'ABORTED');
    route.config.client.fetch = async () => sse([chunk([{ text: 'ok' }], 'STOP')]);
    assert.equal((await collect(route.stream(options()))).at(-1).reason.kind, 'stop');
  } finally { clearInterval(keepAlive); }
});

test('separately streamed signatures stay attached to the original tool call', async () => {
  const chunks = await collect(streamed([chunk([{ functionCall: { name: 'read', args: {} } }]), chunk([{ thoughtSignature: 'late-signature' }], 'STOP')]));
  assert.equal(chunks.filter(c => c.type === 'block-end').length, 1);
  assert.equal(chunks.at(-1).replayState.blocks[0].thoughtSignature, 'late-signature');
});

test('caller cancellation does not wait for or cancel a shared credential lookup', async () => {
  const waiting = gate(), route = adapter(async () => { throw Error('must not fetch'); });
  route.config.session.auth = () => waiting.promise;
  const controller = new AbortController(), pending = collect(route.stream({ ...options(), signal: controller.signal }));
  controller.abort();
  await assert.rejects(pending, e => e.code === 'ABORTED');
  waiting.resolve(grant());
});

test('real HTTP stalled body and mid-stream cancellation close the connection; next request works', async () => {
  let attempt = 0;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (++attempt < 3) res.write(`data: ${JSON.stringify(chunk([{ text: 'partial' }]))}\n\n`);
    else res.end(`data: ${JSON.stringify(chunk([{ text: 'recovered' }], 'STOP'))}\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const route = adapter(globalThis.fetch); route.config.client.endpoints = [`http://127.0.0.1:${server.address().port}`];
  route.config.options = () => plugin.resolveOptions({ headerTimeoutMs: 2000, streamIdleTimeoutMs: 30 });
  try {
    const first = [];
    await assert.rejects((async () => { for await (const c of route.stream(options())) first.push(c); })(), e => e.code === 'TIMEOUT');
    assert(!first.some(c => c.type === 'finish' || c.type === 'block-end'));
    const controller = new AbortController();
    await assert.rejects((async () => {
      for await (const c of route.stream({ ...options(), signal: controller.signal })) if (c.type === 'text-delta') controller.abort();
    })(), e => e.code === 'ABORTED');
    const last = await collect(route.stream(options())); assert.equal(last.find(c => c.type === 'block-end').block.text, 'recovered');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('durable images and signed parallel tool results survive request conversion', async () => {
  const home = await mkdtemp(join(tmpdir(), 'antigravity-images-')), ctx = new Context();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==', 'base64');
  try {
    await ctx.plugin(LocalAttachmentStore, { dshHome: home });
    const image = await ctx.attachments.saveImage({ data: png, mediaType: 'image/png' });
    const block = { type: 'image', attachment: image };
    const first = await collect(streamed([chunk([
      { functionCall: { name: 'screenshot', args: {} }, thoughtSignature: 'group-signature' },
      { functionCall: { name: 'read', args: { path: 'x' } } },
    ], 'STOP')]));
    const content = first.filter(c => c.type === 'block-end').map(c => c.block);
    const assistant = { role: 'assistant', source: { provider: 'antigravity', model: 'gemini-3.8-flash', replayState: first.at(-1).replayState }, content };
    let request;
    const route = adapter(async (_url, init) => { request = JSON.parse(init.body); return sse([chunk([{ text: 'saw pixels' }], 'STOP')]); });
    route.config.resolveAttachments = () => ctx.attachments;
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'look' }, block] }, assistant,
      { role: 'user', content: [
        { type: 'tool-result', toolCallId: content[0].id, content: [block] },
        { type: 'tool-result', toolCallId: content[1].id, content: [{ type: 'text', text: 'result' }] },
      ] }];
    await collect(route.stream({ ...options(), messages }));
    const turns = request.request.contents;
    assert.equal(turns[0].parts.filter(p => p.inlineData).length, 1);
    assert.equal(turns[2].parts.filter(p => p.functionResponse).length, 2);
    assert.equal(turns[2].parts[0].functionResponse.name, 'screenshot');
    assert.equal(turns[2].parts[0].functionResponse.parts[0].inlineData.mimeType, 'image/png');
    assert(turns[2].parts[0].functionResponse.parts[0].inlineData.data.length > 0);
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); }
});

test('real Harness provider, credential store and model directory persist a login across restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dscode-antigravity-')), roots = [];
  const open = async () => {
    const ctx = new Context(); roots.push(ctx);
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]));
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(Credentials, { path: join(home, 'shared', 'credentials.yaml'), dshHome: home, watch: false });
    await ctx.plugin(plugin);
    const login = ctx.get('dscodeAntigravityLogin');
    login.client.fetch = async url => String(url).includes('fetchAvailableModels') ? json(catalog) : sse([chunk([{ text: 'real registry ok' }], 'STOP')]);
    return ctx;
  };
  try {
    const ctx = await open();
    assert.equal(providerArgument('agy'), 'antigravity'); assert.equal(providerSpec('antigravity').login, '/antigravity login');
    assert.equal((await ctx.credentials.describe(GRANT_REF)).writable, false);
    await ctx.get('dscodeAntigravityLogin').session.save(grant());
    assert.equal((await ctx.credentials.describe(GRANT_REF)).configured, true);
    const rows = (await loadModelDirectory(ctx)).rows;
    assert.equal(pickModel(rows, 'antigravity', 'deepseek-official/deepseek-flash', 'high').row.model, 'gemini-3.8-flash');
    const next = await open();
    assert.equal((await next.get('dscodeAntigravityLogin').session.current()).access, 'test-access');
    assert.equal((await stat(join(home, 'shared', 'credentials.yaml'))).mode & 0o777, 0o600);
    const chunks = await collect(next.llm.stream(options()));
    assert.equal(chunks.find(c => c.type === 'block-end').block.text, 'real registry ok');
    assert.equal(chunks.at(-1).reason.kind, 'stop');
    await next.get('dscodeAntigravityLogin').logout('en');
    assert.equal((await next.credentials.describe(GRANT_REF)).configured, false);
  } finally { for (const ctx of roots) await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); }
});
