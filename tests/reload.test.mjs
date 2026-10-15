import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootedAppBoot, mcpChanges, overlayFiles, patchArguments, reloadOverlays } from '../plugins/tui-tools/reload.mjs';
import * as LinkedAppBoot from '@deepseek-ai/dsh-app-boot';

test('--patch files are read from a command line in order, in both spellings', () => {
  assert.deepEqual(patchArguments(['node', 'bin.js', '--patch', '/a.yml', '--resume', 'x', '--patch=/b.yml']), ['/a.yml', '/b.yml']);
  assert.deepEqual(patchArguments(['node', 'bin.js', '--patch']), []);
});

test('the overlay list follows the launcher order and includes a local overlay created after start', () => {
  const env = { DSCODE_LOCAL_OVERLAYS: JSON.stringify(['/cfg/mcp.local.yml', '/cfg/harness.local.yml']) };
  // Started with only harness.local.yml and the Host overlay; mcp.local.yml was created later.
  const argv = ['node', 'dsh', '--patch', '/cfg/harness.local.yml', '--patch', '/run/host.patch.yml'];
  assert.deepEqual(overlayFiles({ argv, env, exists: () => true }), ['/cfg/mcp.local.yml', '/cfg/harness.local.yml', '/run/host.patch.yml']);
  // A local overlay deleted since start is no longer read.
  assert.deepEqual(overlayFiles({ argv, env, exists: path => path !== '/cfg/harness.local.yml' }), ['/cfg/mcp.local.yml', '/run/host.patch.yml']);
  // Without the launcher's list, only the command line counts.
  assert.deepEqual(overlayFiles({ argv, env: {}, exists: () => true }), ['/cfg/harness.local.yml', '/run/host.patch.yml']);
});

test('MCP changes are reported as added, removed and restarted', () => {
  const before = new Map([['keep', 'a'], ['edit', 'b'], ['drop', 'c']]);
  const after = new Map([['keep', 'a'], ['edit', 'B'], ['new', 'd']]);
  assert.deepEqual(mcpChanges(before, after), { added: ['new'], removed: ['drop'], changed: ['edit'] });
});

test('a runtime not started from a profile refuses to reload', async () => {
  await assert.rejects(reloadOverlays({ get: () => undefined }, { files: [] }), /not started from a profile/);
});

test('an overlay that does not parse leaves the running composition untouched', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'reload-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const broken = join(dir, 'mcp.local.yml');
  writeFileSync(broken, '- insert: [unclosed\n');
  const profile = { overlays: ['previous'] };
  const ctx = { get: name => ({ profileContext: profile, loader: { entries: () => [] } })[name] };
  await assert.rejects(reloadOverlays(ctx, { files: [broken] }));
  assert.deepEqual(profile.overlays, ['previous']);
});

test('reconciliation uses the app-boot copy the running DSH resolves, falling back to the linked one', async () => {
  const fromDsh = await bootedAppBoot(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url).pathname);
  assert.equal(typeof fromDsh.reconcileProfilePatches, 'function');
  assert.equal(await bootedAppBoot('/nonexistent/bin.js'), LinkedAppBoot);
});
