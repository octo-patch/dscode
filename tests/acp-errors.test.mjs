import test from 'node:test';
import assert from 'node:assert/strict';
import { acpFailure, deepSeekTransportMessage, patchAcpErrors, patchDeepSeekErrors } from '../scripts/patch-acp-errors.mjs';
import { createTestRuntime } from '../scripts/test-runtime.mjs';
import { readFileSync } from 'node:fs';
import { patchAcpStatus } from '../scripts/patch-acp-status.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('ACP failures expose bounded categories and guidance without raw provider secrets', () => {
  const error = { code: 'TRANSPORT', message: 'Authorization: Bearer fake-secret', status: 503, cause: { password: 'fake-password' } };
  const failure = acpFailure(error);
  assert.equal(failure.code, 'TRANSPORT');
  assert.equal(failure.status, 503);
  assert.match(failure.message, /connection.*failed/i);
  assert.match(failure.message, /retry/i);
  assert.doesNotMatch(JSON.stringify(failure), /fake-secret|fake-password|Authorization/);
  for (const code of ['TIMEOUT', 'MISSING_CREDENTIAL', 'ACCOUNT_SIGN_IN_REQUIRED', 'RATE_LIMIT', 'UNKNOWN']) {
    assert(acpFailure({ code }).message);
  }
  assert.equal(acpFailure({ code: 'fake-secret', status: 999 }).code, 'UNKNOWN');
  assert.equal(acpFailure({}).status, undefined);
  assert.equal(acpFailure(undefined).code, 'UNKNOWN');
});

test('DeepSeek transport diagnostics preserve safe nested codes and elapsed time only', () => {
  const error = new TypeError('fetch failed: fake-secret', { cause: Object.assign(new Error('https://key@host/?token=secret'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
  const message = deepSeekTransportMessage(error, 10523.9);
  assert.equal(message, 'DeepSeek Messages transport failed (UND_ERR_CONNECT_TIMEOUT; 10524 ms)');
  assert.doesNotMatch(message, /fake-secret|token|https/);
  assert.match(acpFailure({ code: 'TRANSPORT', message }).message, /UND_ERR_CONNECT_TIMEOUT; 10524 ms/);
  assert.equal(deepSeekTransportMessage({ code: 'FAKE_SECRET' }, -1), 'DeepSeek Messages transport failed');
  const cyclic = {}; cyclic.cause = cyclic;
  assert.equal(deepSeekTransportMessage(cyclic, NaN), 'DeepSeek Messages transport failed');
  const accessor = { get code() { throw Error('do not inspect'); }, get cause() { throw Error('do not inspect'); } };
  assert.equal(deepSeekTransportMessage(accessor, 0), 'DeepSeek Messages transport failed (0 ms)');
  const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw Error('opaque'); } });
  assert.equal(deepSeekTransportMessage(hostile, 1), 'DeepSeek Messages transport failed (1 ms)');
});

test('runtime error patches apply to pinned upstream and are idempotent', () => {
  const fixture = createTestRuntime({ runtime: true, patched: false });
  try {
    for (const [pkg, patch] of [['dsh-acp', patchAcpErrors], ['dsh-acp', patchAcpStatus], ['dsh-llm-deepseek', patchDeepSeekErrors]]) {
      const source = readFileSync(join(fixture.root, 'node_modules/@deepseek-ai', pkg, 'lib/index.js'), 'utf8');
      const result = patch(source);
      assert.notEqual(result, source);
      assert.equal(patch(result), result);
      assert.throws(() => patch('unrecognized upstream'), /patch|match|anchor/i);
    }
  } finally { fixture.close(); }
});

test('the patched DeepSeek adapter carries safe transport facts through its real failure boundary', async () => {
  const fixture = createTestRuntime({ runtime: true });
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('fetch failed with fake-secret', { cause: Object.assign(new Error('fake-password'), { code: 'ECONNRESET' }) }); };
  try {
    const { DeepSeekAdapter, resolveAdapterOptions } = await import(pathToFileURL(join(fixture.root, 'node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js')));
    const adapter = new DeepSeekAdapter({ options: () => resolveAdapterOptions({ models: [{ id: 'fixture' }] }), resolveAuth: async () => ({ headers: { Authorization: 'Bearer fixture-not-a-key' } }), resolveUserId: () => 'fixture', prepareExtensions: async () => ({ fields: {}, accept: async () => {} }), resolveFiles: () => ({}) });
    await assert.rejects(async () => {
      for await (const _chunk of adapter.stream({ provider: 'deepseek-official', model: 'fixture', messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }], tools: [] })) { }
    }, error => {
      assert.equal(error.code, 'TRANSPORT');
      assert.match(error.message, /^DeepSeek Messages transport failed \(ECONNRESET; \d+ ms\)$/);
      assert.doesNotMatch(error.message, /fake-secret|fake-password/);
      return true;
    });
  } finally { globalThis.fetch = original; fixture.close(); }
});
