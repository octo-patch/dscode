import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import Credentials from '../plugins/credentials/index.mjs';
import { loadModelDirectory } from '../packages/tui/src/models.ts';
import { createTestRuntime } from '../scripts/test-runtime.mjs';

const fixture = createTestRuntime({ runtime: true });
after(fixture.close);
const ApiKey = await import(pathToFileURL(join(fixture.root, 'node_modules/@deepseek-ai/dsh-llm-deepseek-api-key/lib/index.js')));
const LISTING_URL = 'https://api.deepseek.com/models';
const FLASH = {
  id: 'deepseek-flash', name: 'Listed Flash', context_window: 1_048_576,
  max_output_tokens: 393_216, input_modalities: ['text', 'image'], output_modalities: ['text'],
  api_capabilities: { anthropic_messages: { system_prompt_update: 'in-history', tool_update: 'addition-only' } },
};
const FUTURE = { ...FLASH, id: 'future-fixture', client_requirements: { 'deepseek-harness': { min_version: '0.0.1' } } };

async function host(t, config = {}, env = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dscode-official-models-'));
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); });
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: env }]));
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(Credentials, { path: join(home, 'credentials.yaml'), dshHome: home, watch: false });
  await ctx.plugin(ApiKey, config);
  return ctx;
}

function listing(t, reply) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, LISTING_URL, 'only fixture listing requests may leave the adapter');
    requests.push(request);
    return reply(request);
  });
  return requests;
}
const response = rows => Response.json({ object: 'list', data: rows });

test('official listing reaches the terminal directory with Ultra and invalidates on credential changes', async t => {
  const requests = listing(t, () => response([FLASH, FUTURE]));
  const ctx = await host(t);
  assert.deepEqual((await loadModelDirectory(ctx)).rows, []);
  assert.equal(requests.length, 0, 'signed-out discovery makes no request');
  await ctx.credentials.set('DEEPSEEK_API_KEY', 'synthetic-first');
  const directory = await loadModelDirectory(ctx);
  assert.deepEqual(directory.failures, []);
  assert.deepEqual(directory.reasoningFailures, []);
  assert.deepEqual(directory.rows.map(row => row.model), ['deepseek-flash', 'future-fixture']);
  for (const row of directory.rows) assert(row.reasoning.efforts.some(effort => effort.id === 'ultra'));
  const info = await ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-flash');
  assert.equal(info.context.contextWindow, 1_048_576);
  assert.equal(info.toolUpdate, 'addition-only');
  await loadModelDirectory(ctx);
  assert.equal(requests.length, 1, 'the model directory and capability lookups share the listing');
  assert.equal(requests[0].headers.get('x-api-key'), 'synthetic-first');
  await ctx.credentials.set('DEEPSEEK_API_KEY', 'synthetic-second');
  await loadModelDirectory(ctx);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].headers.get('x-api-key'), 'synthetic-second');
  await ctx.credentials.unset('DEEPSEEK_API_KEY');
  assert.deepEqual((await loadModelDirectory(ctx)).rows, []);
  assert.equal(requests.length, 2);
});

test('listing fallback retains Ultra and exported credentials keep precedence', async t => {
  const requests = listing(t, () => new Response('unavailable', { status: 503 }));
  const ctx = await host(t, {}, { DEEPSEEK_API_KEY: 'synthetic-env' });
  const directory = await loadModelDirectory(ctx);
  assert.deepEqual(directory.rows.map(row => row.model), ['deepseek-flash', 'deepseek-v4-pro']);
  assert(directory.rows.every(row => row.reasoning.efforts.some(effort => effort.id === 'ultra')));
  assert.equal(requests[0].headers.get('x-api-key'), 'synthetic-env');
  await assert.rejects(ctx.credentials.set('DEEPSEEK_API_KEY', 'replacement'), /read-only/);
  assert.equal(requests.length, 1);
});

test('listed incompatible models are hidden and refused while unlisted saved routes remain usable', async t => {
  const requests = listing(t, () => response([
    FLASH, { ...FUTURE, client_requirements: { 'deepseek-harness': { min_version: '99.0.0' } } },
  ]));
  const ctx = await host(t, {}, { DEEPSEEK_API_KEY: 'synthetic-env' });
  assert.deepEqual((await loadModelDirectory(ctx)).rows.map(row => row.model), ['deepseek-flash']);
  await assert.rejects(ctx.llm.prepareCall({ provider: 'deepseek-official', model: 'future-fixture' }), { code: 'CLIENT_UPGRADE_REQUIRED' });
  await ctx.llm.prepareCall({ provider: 'deepseek-official', model: 'saved-unlisted', reasoningEffort: 'ultra' });
  assert.equal(requests.length, 1, 'admission does not send an inference request');
});

for (const config of [{ baseURL: 'http://127.0.0.1:9/anthropic' }, { models: [{ id: 'custom-fixture' }] }]) {
  test(`custom DeepSeek configuration bypasses official discovery: ${JSON.stringify(config)}`, async t => {
    const requests = listing(t, () => assert.fail('custom configurations must not fetch official models'));
    const ctx = await host(t, config, { DEEPSEEK_API_KEY: 'synthetic-env' });
    const directory = await loadModelDirectory(ctx);
    assert.deepEqual(directory.rows.map(row => row.model), config.models ? ['custom-fixture'] : ['deepseek-flash', 'deepseek-v4-pro']);
    assert(directory.rows.every(row => row.reasoning.efforts.some(effort => effort.id === 'ultra')));
    assert.equal(requests.length, 0);
  });
}
