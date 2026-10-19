import { composePlugins } from './composition.mjs';
import { spawn } from 'node:child_process';
import { validateHooks } from '../plugins/tui-tools/hooks.mjs';
import { writeHookConfig } from '../plugins/tui-tools/hook-sources.mjs';
import { ancestorSkillDirs, writeWorkspaceInstructions } from '../plugins/tui-tools/workspace-discovery.mjs';
import { patchRuntime, patchAppBootPackage } from './patch-runtime.mjs';
import { patchInkFrame } from './patch-ink.mjs';
import { dscodeComposition, presetDeclaration } from './preset.mjs';
import { existsSync, mkdirSync, chmodSync, readFileSync, writeFileSync, renameSync, symlinkSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MARKER, canonical, inside, standaloneEnvironment } from './standalone-layout.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
export const standalone = existsSync(join(root, MARKER));
// DSCODE_SOURCE_HOME relocates a source checkout's state (verification uses it so
// a background Host never lands in the developer's .runtime).
export const runtimeHome = standalone ? standaloneEnvironment(root).DSCODE_HOME : process.env.DSCODE_SOURCE_HOME || join(root, '.runtime');
export const configRoot = standalone ? runtimeHome : root;
// Native model/settings edits live in this profile's cordis.patch.yml. Its name must
// survive upgrades and relocations, while remaining separate from the legacy Hub profile.
export const profileName = standalone ? 'dscode-app' : 'tui';
export const dshEntry = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js');

export function loadLocalEnvironment() {
  const envFile = join(configRoot, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  if (standalone) {
    const env = standaloneEnvironment(root);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  }
}

export function runtimeStdio(stdio = 'inherit') {
  if (!standalone || !process.env.DSCODE_LEASE_FDS) return stdio;
  const streams = Array.isArray(stdio) ? [...stdio] : [stdio, stdio, stdio];
  return [...streams, ...process.env.DSCODE_LEASE_FDS.split(',').map(Number)];
}

export function provision(home = runtimeHome, { cwd = root, env = process.env } = {}) {
  if (!existsSync(dshEntry)) throw new Error('Dependencies missing. Run npm ci first.');
  // The terminal is vendored at packages/tui and edited as source: the text-patch
  // pass over dsh-code's published bundle is retired. Host-plane patches below
  // stay until @deepseek-ai/dsh-* carries the behaviour upstream.
  // Ink owns the frame repaint; the vendored terminal cannot carry this one.
  if (!standalone) {
    patchInkFrame(root);
    patchRuntime(root);
    patchAppBootPackage(root);
  }
  mkdirSync(join(configRoot, 'config'), { recursive: true, mode: 0o700 });
  const hooksPath = join(configRoot, 'config/hooks.local.json');
  try { writeFileSync(hooksPath, '{"hooks": {}}\n', { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  validateHooks(JSON.parse(readFileSync(hooksPath, 'utf8')));
  const hookConfig = writeHookConfig({ root: configRoot, cwd, home, env });
  const profile = join(home, 'profiles', profileName);
  mkdirSync(profile, { recursive: true });
  const moduleLink = join(profile, 'node_modules');
  let link;
  try { link = lstatSync(moduleLink); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (link) {
    if (!link.isSymbolicLink()) throw new Error(`Refusing to replace an independently managed profile: ${profile}`);
    let correct = false;
    try { correct = realpathSync(moduleLink) === realpathSync(join(root, 'node_modules')); } catch {}
    if (!correct) {
      if (!standalone) throw new Error(`Refusing to replace an independently managed profile: ${profile}`);
      // The standalone admission gate excludes other package versions while active.
      const replacement = `${moduleLink}.${process.pid}.tmp`;
      symlinkSync(join(root, 'node_modules'), replacement, 'dir'); renameSync(replacement, moduleLink);
    }
  }
  if (!link) {
    try { symlinkSync(join(root, 'node_modules'), moduleLink, 'dir'); }
    catch (error) { if (error.code !== 'EEXIST' || realpathSync(moduleLink) !== realpathSync(join(root, 'node_modules'))) throw error; }
  }
  const writeAtomic = (path, contents) => {
    const staged = `${path}.${process.pid}.tmp`;
    writeFileSync(staged, contents, { mode: 0o600 }); renameSync(staged, path);
  };
  const generatedName = '@dscode/standalone-profile';
  writeAtomic(join(profile, 'package.json'), JSON.stringify({
    name: 'todd-dsh-tui-profile', private: true, type: 'module',
    dependencies: { ...manifest.dependencies, ...(standalone ? { [generatedName]: manifest.version } : {}) },
    dsh: standalone ? { profile: { ...manifest.dsh.profile, bundles: [...manifest.dsh.profile.bundles, generatedName] } } : manifest.dsh,
  }, null, 2) + '\n');
  const plugins = composePlugins({ root, hooks: hookConfig.path, ...(standalone ? { credentialsPath: join(runtimeHome, 'credentials.yaml') } : {}) });
  const composition = [
    readFileSync(join(root, 'config/cordis.patch.yml'), 'utf8'),
    readFileSync(join(root, 'config/auto-review.patch.yml'), 'utf8'),
    plugins,
    presetDeclaration(root, dscodeComposition(root)),
  ].join('\n');
  if (standalone) {
    // An ancestor node_modules makes this generated base bundle resolvable without
    // modifying the immutable application tree or replacing the native user layer.
    const generated = join(home, 'node_modules', generatedName);
    mkdirSync(generated, { recursive: true });
    writeAtomic(join(generated, 'package.json'), JSON.stringify({ name: generatedName, version: manifest.version,
      private: true, dsh: { bundle: { patch: './cordis.patch.yml' } } }) + '\n');
    writeAtomic(join(generated, 'cordis.patch.yml'), composition);
    try { writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } else writeAtomic(join(profile, 'cordis.patch.yml'), composition);
  return profile;
}

/**
 * Align the Hub CLI's login with the state directory this launcher hands out.
 *
 * `dsh-hub login` writes `$DSH_HOME/.hub/auth.json`, but a login made outside
 * DSCODE lands in `~/.dsh/.hub/auth.json`. A session whose `DSH_HOME` points
 * elsewhere then reads "Not signed in", which sends the agent hunting for
 * tokens it should never handle. Copying the file once keeps the CLI working
 * and, because the copy lives under the state directory, lets the CLI refresh
 * its own session without leaving the sandbox. An existing copy always wins:
 * a refresh written there must never be overwritten by a stale user file.
 * @param home - state directory this launch hands to the child as DSH_HOME.
 * @param userHome - the real user home that holds a possible manual login.
 * @returns whether a copy was made.
 */
export function alignHubCredentials(home = runtimeHome, userHome = homedir()) {
  try {
    const target = join(home, '.hub', 'auth.json');
    const source = join(userHome, '.dsh', '.hub', 'auth.json');
    // An existing copy wins, which also covers the layout where the state
    // directory is the user home itself: there the CLI reads that one file.
    if (existsSync(target) || resolve(target) === resolve(source) || !existsSync(source)) return false;
    const directory = dirname(target);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // mkdir's mode applies only to a directory it creates, so normalize one that
    // already exists: the token must not sit in a listable directory.
    try { chmodSync(directory, 0o700); } catch { /* a copy is still better than no login */ }
    writeFileSync(target, readFileSync(source, 'utf8'), { mode: 0o600 });
    return true;
  } catch {
    // Best effort: the copy only spares the CLI a manual login, so an unreadable
    // source, a vanished file or a full disk must never stop the launch.
    return false;
  }
}

export function environment(home = runtimeHome, cwd = process.cwd()) {
  const userHome = homedir();
  if (!standalone) alignHubCredentials(home, userHome);
  // Ancestor discovery is resolved here because only the launcher knows the
  // session directory; the preset reads the results from these two variables.
  const instructions = writeWorkspaceInstructions({ cwd, home: userHome, stateDir: home });
  return {
    ...(standalone ? standaloneEnvironment(root) : process.env), PATH: (standalone ? join(root, 'runtime/bin') + ':' : '') + join(root, 'bin') + ':' + process.env.PATH, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'),
    DSCODE_SKILL_ANCESTOR_DIRS: JSON.stringify(ancestorSkillDirs({ cwd, home: userHome }).filter(path => !standalone || !inside(canonical(join(userHome, '.dsh')), canonical(path)))),
    DSCODE_INSTRUCTION_HOME: instructions ?? home,
    DSCODE_SANDBOX_RUNNER: join(root, 'plugins/tui-tools/sandbox-runner.mjs'),
    DSCODE_CLI_PATH: join(root, standalone ? 'dscode' : 'bin/dscode.mjs'),
    // /reload re-reads these, including one created after the Harness started (plugins/tui-tools/reload.mjs).
    DSCODE_LOCAL_OVERLAYS: JSON.stringify(localOverlayPaths()),
    DSH_TUI_REVIEW_ENTRY: join(root, 'plugins/auto-review/index.mjs'),
  };
}

// node:sqlite still ships experimental in the supported Node range, and the memory
// and mailbox stores import it as the profile boots. The flag is prepended to any
// caller-supplied node arguments, so every DSH child is quiet without each call
// site repeating it.
const quietNodeArgs = ['--disable-warning=ExperimentalWarning'];

/** The child's stdio: the given streams, the launcher's lease descriptors, then `extraFds`. */
export function dshStdio(stdio = 'inherit', extraFds = []) {
  const streams = runtimeStdio(stdio);
  return extraFds.length === 0 ? streams : [...(Array.isArray(streams) ? streams : [streams, streams, streams]), ...extraFds];
}

export function runDsh(args, { home = runtimeHome, cwd = root, stdio = 'inherit', env = {}, nodeArgs = [], extraFds = [] } = {}) {
  return spawn(process.execPath, [...quietNodeArgs, ...nodeArgs, dshEntry, '--profile', profileName, ...args], {
    cwd, env: { ...environment(home, cwd), ...env }, stdio: dshStdio(stdio, extraFds),
  });
}

/** Every installation-local overlay a Harness may read, present or not, in load order. */
export const localOverlayPaths = () => ['mcp.local.yml', 'harness.local.yml'].map(file => join(configRoot, 'config', file));

/** Installation-local composition overlays, applied to every Harness this launcher starts. */
export function localOverlays() {
  return localOverlayPaths().filter(path => existsSync(path)).flatMap(path => ['--patch', path]);
}

/**
 * @param options.runtime - the runtime alias `dscode runtime <alias>` names;
 * otherwise the configured default (docs/remote-runtime.md).
 */
export async function main(argv = process.argv.slice(2), defaultCwd = root, options = {}) {
  loadLocalEnvironment();
  const [command = 'start', ...args] = argv;
  if (!['setup', 'start', 'doctor', 'config'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (command === 'doctor') {
    await import('./doctor.mjs');
    return;
  }
  let cwd = defaultCwd;
  let cwdArgument;
  const cwdIndex = args.indexOf('--cwd');
  if (cwdIndex !== -1) {
    if (!args[cwdIndex + 1]) throw new Error('--cwd requires a directory');
    cwdArgument = args[cwdIndex + 1];
    args.splice(cwdIndex, 2);
  }
  // The interactive terminal attaches to the shared Host by default;
  // --in-process (or DSCODE_RUNTIME=in-process) keeps the single-process mode.
  const inProcessFlag = args.indexOf('--in-process');
  if (inProcessFlag !== -1) args.splice(inProcessFlag, 1);
  const inProcess = inProcessFlag !== -1 || process.env.DSCODE_RUNTIME === 'in-process';
  // Launcher-level flags (--dump-config, --patch, --profile) belong to the DSH CLI, not the terminal.
  const launcherFlag = args.some(arg => ['--dump-config', '--patch', '--profile'].includes(arg.split('=')[0]));
  const { checkRemote, resolveRuntime } = await import('./runtimes.mjs');
  // A remote runtime's folder is a path on the server, so it is never resolved here.
  const runtime = command !== 'start' || launcherFlag || (inProcess && options.runtime === undefined)
    ? { kind: 'local' }
    : resolveRuntime(runtimeHome, options.runtime);
  if (runtime.kind === 'remote' && inProcess) throw new Error(`--in-process runs this machine's runtime; it cannot be combined with runtime ${runtime.alias}`);
  if (runtime.kind === 'local' && cwdArgument !== undefined) cwd = realpathSync(resolve(cwdArgument));
  const profile = provision(runtimeHome, { cwd });
  if (command === 'setup') {
    console.log(`Ready: ${profile}\nStart with npm start. State stays in ${runtimeHome}`);
    return;
  }
  const overlays = localOverlays();
  // DSCODE_TERMINAL_CLIENT substitutes the client entry (verification installs its probe there).
  const startClient = connection => {
    const client = process.env.DSCODE_TERMINAL_CLIENT || join(root, 'scripts/terminal-client.mjs');
    const child = spawn(process.execPath, [...quietNodeArgs, client, ...args], {
      cwd, env: { ...environment(runtimeHome, cwd), ...connection }, stdio: runtimeStdio('inherit'),
    });
    for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  };
  if (runtime.kind === 'remote') {
    // No fallback: the user asked for that machine, so a refusal is the answer.
    const status = await checkRemote(runtime, manifest.version);
    const remoteCwd = cwdArgument ?? runtime.cwd ?? status.defaultCwd;
    if (!remoteCwd.startsWith('/')) throw new Error(`--cwd for runtime ${runtime.alias} must be an absolute path on the server`);
    startClient({ DSCODE_RUNTIME_URL: runtime.target.url, DSCODE_RUNTIME_TOKEN: runtime.target.token, DSCODE_RUNTIME_CWD: remoteCwd, DSCODE_RUNTIME_ALIAS: runtime.alias });
    return;
  }
  if (command === 'start' && !inProcess && !launcherFlag) {
    const { ensureHost } = await import('./host.mjs');
    let socket;
    try { socket = await ensureHost(); } catch (error) {
      console.error(`dscode: the shared Host is unavailable, continuing in a single process: ${error.message.split('\n')[0]}`);
    }
    if (socket !== undefined) {
      startClient({ DSCODE_RUNTIME_SOCKET: socket });
      return;
    }
  }
  const child = runDsh([...overlays, ...(command === 'config' ? ['--dump-config'] : args)], { cwd });
  for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
