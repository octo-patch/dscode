// /reload: re-read the installation's configuration overlays (config/mcp.local.yml,
// config/harness.local.yml and the other --patch files this Harness started with)
// and reconcile the running composition against them, the way upstream's own hot
// reload applies a new patch generation. Unchanged entries keep running; added MCP
// servers start, removed ones stop and changed ones restart.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as LinkedAppBoot from '@deepseek-ai/dsh-app-boot';

const MCP = '@deepseek-ai/dsh-mcp-client';

/**
 * The dsh-app-boot instance the running DSH booted with. Reconciliation finds
 * the root Include entry in a module-level map, so another copy of the package
 * (a second install, a patched fixture) would see none. Resolved from the DSH
 * entry this process runs; this module's own import is the fallback.
 */
export async function bootedAppBoot(entry = process.argv[1]) {
  try {
    const manifest = createRequire(realpathSync(entry)).resolve('@deepseek-ai/dsh-app-boot/package.json');
    const exported = JSON.parse(readFileSync(manifest, 'utf8')).exports?.['.'];
    const file = typeof exported === 'string' ? exported : exported?.import ?? exported?.default;
    if (typeof file === 'string') return await import(pathToFileURL(join(dirname(manifest), file)).href);
  } catch { /* not launched through a DSH entry */ }
  return LinkedAppBoot;
}

/** `--patch` files named on a command line, in order. */
export function patchArguments(argv) {
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--patch' && argv[i + 1] !== undefined) files.push(resolve(argv[++i]));
    else if (argv[i].startsWith('--patch=')) files.push(resolve(argv[i].slice('--patch='.length)));
  }
  return files;
}

/**
 * The overlay files to load now, in the launcher's order: the installation's
 * local overlays that exist (including one created after start), then every
 * other --patch file this process was started with.
 */
export function overlayFiles({ argv = process.argv, env = process.env, exists = existsSync } = {}) {
  let local = [];
  try { local = JSON.parse(env.DSCODE_LOCAL_OVERLAYS ?? '[]').map(path => resolve(path)); } catch { /* launched without the launcher */ }
  const started = patchArguments(argv);
  return [...local.filter(path => exists(path)), ...started.filter(path => !local.includes(path))];
}

/** id, config fingerprint and enablement of every MCP entry. */
function mcpSnapshot(loader) {
  return new Map([...loader.entries()].filter(entry => entry.options.name === MCP)
    .map(entry => [entry.options.id, JSON.stringify([entry.options.config ?? {}, entry.options.disabled === true])]));
}

/** What changed among MCP entries between two snapshots. */
export function mcpChanges(before, after) {
  const added = [...after.keys()].filter(id => !before.has(id));
  const removed = [...before.keys()].filter(id => !after.has(id));
  const changed = [...after.keys()].filter(id => before.has(id) && before.get(id) !== after.get(id));
  return { added, removed, changed };
}

/**
 * Reload the configuration overlays into the running composition.
 * @returns the files read, the MCP changes and upstream's diagnostics.
 * @throws when a file cannot be parsed or the new generation does not activate;
 * the previous generation is restored first.
 */
export async function reloadOverlays(ctx, { files = overlayFiles(), appBoot } = {}) {
  const profile = ctx.get('profileContext');
  if (profile === undefined) throw Error('this runtime was not started from a profile, so its configuration cannot be reloaded; restart it instead');
  const { loadOverlayPatches, readProfilePatches, reconcileProfilePatches } = appBoot ?? await bootedAppBoot();
  // Parse everything before touching the running composition.
  const overlays = files.flatMap(file => loadOverlayPatches('dsh', file));
  const loader = ctx.get('loader');
  const before = mcpSnapshot(loader);
  const reconcile = () => reconcileProfilePatches(ctx.root, readProfilePatches('dsh', profile), 'dsh');
  const apply = async () => {
    const previous = profile.overlays;
    // Upstream reloads (plugin installs, config edits, hot reload) re-read the
    // profile from this object, so it must carry the new overlays too.
    profile.overlays = overlays;
    try {
      return await reconcile();
    } catch (error) {
      profile.overlays = previous;
      await reconcile().catch(() => {});
      throw error;
    }
  };
  const hmr = ctx.get('hmr');
  const warnings = await (hmr === undefined ? apply() : hmr.runExclusive(apply));
  return { files, mcp: mcpChanges(before, mcpSnapshot(loader)), warnings };
}
