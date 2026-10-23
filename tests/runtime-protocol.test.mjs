import test from 'node:test';
import assert from 'node:assert/strict';
import { RUNTIME_PROTOCOL, requireCompatibleRuntime, runtimeCompatibility } from '../plugins/local-carrier/protocol.mjs';

test('compatible protocol and upstream pins permit independent application releases', () => {
  const status = { version: '0.8.12', protocol: RUNTIME_PROTOCOL };
  assert.equal(runtimeCompatibility(status, '0.7.50').ok, true);
  assert.equal(requireCompatibleRuntime(status, '0.7.50').mode, 'protocol');
});

test('a declared incompatible or malformed contract refuses even an equal application version', () => {
  for (const protocol of [null, {}, { revision: RUNTIME_PROTOCOL.revision + 1, upstream: RUNTIME_PROTOCOL.upstream }, { revision: RUNTIME_PROTOCOL.revision, upstream: '0.9.0' }]) {
    assert.throws(() => requireCompatibleRuntime({ version: '0.7.50', protocol }, '0.7.50'), error => error.code === 'dscode/version-mismatch');
  }
});

test('legacy servers retain exact-version checks', () => {
  assert.equal(runtimeCompatibility({ version: '0.7.50' }, '0.7.50').mode, 'legacy');
  assert.equal(runtimeCompatibility({ version: '0.7.50' }, '0.7.50').ok, true);
  assert.throws(() => requireCompatibleRuntime({ version: '0.7.49' }, '0.7.50'), /no protocol declaration/);
});
