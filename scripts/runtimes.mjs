// Named runtimes a terminal can attach to (docs/remote-runtime.md): `local`, the
// background Host on this machine, plus remote Hosts started with `dscode
// server`. `dscode config --runtime` records them, `dscode runtime <alias>`
// attaches to one, and a default makes bare `dscode` attach to it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { callDscode } from '../plugins/local-carrier/client.mjs';
import { requireCompatibleRuntime, runtimeCompatibility } from '../plugins/local-carrier/protocol.mjs';

export const LOCAL = 'local';
const ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export const RUNTIME_USAGE = [
  'Usage:',
  '  dscode runtime                         list configured runtimes',
  '  dscode runtime NAME [terminal options] start a terminal on NAME',
  '  dscode runtime status NAME [--json]    inspect connection, version and activity',
  '  dscode runtime doctor NAME [--json]    also inspect server configuration without model calls',
].join('\n');

export const CONFIG_USAGE = [
  'Usage:',
  '  dscode config --runtime HOST:PORT --token TOKEN --alias NAME [--cwd DIR] [--set-default]',
  '  dscode config --alias NAME [--runtime HOST:PORT] [--token TOKEN] [--cwd DIR | --clear-cwd] [--set-default]',
  '  dscode config --default NAME      make NAME (or local) the runtime bare `dscode` uses',
  '  dscode config --remove NAME',
  '  dscode config [--list]',
].join('\n');

/** The runtimes file: tokens live here, so it is written 0600. */
export const runtimesFile = home => join(home, 'runtimes.json');

export function readRuntimes(home) {
  const file = runtimesFile(home);
  if (!existsSync(file)) return { default: LOCAL, runtimes: {} };
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { throw Error(`${file} is not valid JSON (${error.message}); fix or remove it`, { cause: error }); }
  return { default: typeof parsed.default === 'string' ? parsed.default : LOCAL, runtimes: parsed.runtimes && typeof parsed.runtimes === 'object' ? parsed.runtimes : {} };
}

export function writeRuntimes(home, config) {
  const file = runtimesFile(home);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const staged = `${file}.${process.pid}.tmp`;
  writeFileSync(staged, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(staged, file);
}

/** Normalize `host:port` (or `http://host:port`) into the URL the carrier client uses. */
export function runtimeUrl(address) {
  const text = /^[a-z]+:\/\//i.test(address) ? address : `http://${address}`;
  let url;
  try { url = new URL(text); } catch { throw Error(`"${address}" is not HOST:PORT`); }
  if (url.protocol !== 'http:') throw Error(`"${address}": only plain http://HOST:PORT is supported`);
  // URL drops a port equal to the scheme default (80), so the port is checked on the text itself.
  const authority = text.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0];
  if (!/:\d+$/.test(authority)) throw Error(`"${address}" needs a port (HOST:PORT)`);
  if (url.pathname !== '/' || url.search || url.hash || url.username) throw Error(`"${address}" must be just HOST:PORT`);
  return `http://${authority}`;
}

/** Parse `dscode config` arguments into one action. */
export function parseConfigArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], next = () => {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw Error(`${flag} needs a value\n${CONFIG_USAGE}`);
      return value;
    };
    if (flag === '--runtime') options.runtime = next();
    else if (flag === '--alias') options.alias = next();
    else if (flag === '--token') options.token = next();
    else if (flag === '--cwd') options.cwd = next();
    else if (flag === '--clear-cwd') options.clearCwd = true;
    else if (flag === '--set-default') options.setDefault = true;
    else if (flag === '--default') options.default = next();
    else if (flag === '--remove') options.remove = next();
    else if (flag === '--list') options.list = true;
    else if (flag === '--help' || flag === '-h') return { help: true };
    else throw Error(`unknown option ${flag}\n${CONFIG_USAGE}`);
  }
  const actions = ['default', 'remove', 'list'].filter(key => options[key] !== undefined);
  if (options.runtime !== undefined || options.alias !== undefined) actions.push('runtime');
  if (actions.length > 1) throw Error(`use one of --runtime, --default, --remove or --list at a time\n${CONFIG_USAGE}`);
  if (options.alias === undefined && options.runtime === undefined && (options.token !== undefined || options.cwd !== undefined || options.clearCwd || options.setDefault)) {
    throw Error(`--token, --cwd, --clear-cwd and --set-default need --alias\n${CONFIG_USAGE}`);
  }
  if (options.runtime !== undefined || options.alias !== undefined) {
    if (options.alias === undefined) throw Error(`--runtime needs --alias NAME\n${CONFIG_USAGE}`);
    if (!ALIAS.test(options.alias)) throw Error('an alias is letters, digits, ".", "_" or "-" (at most 64)');
    if (options.alias.toLowerCase() === LOCAL) throw Error(`"${LOCAL}" is reserved for this machine's runtime`);
    if (options.token !== undefined && (options.token.length < 16 || /\s/.test(options.token))) throw Error('--token needs at least 16 characters and no spaces');
    if (options.cwd !== undefined && !options.cwd.startsWith('/')) throw Error('--cwd must be an absolute path on the server');
    if (options.cwd !== undefined && options.clearCwd) throw Error('use --cwd or --clear-cwd, not both');
    if (options.runtime !== undefined) options.url = runtimeUrl(options.runtime);
  }
  return options;
}

/** Apply one parsed `dscode config` action to a configuration; returns the new one and a message. */
export function applyConfig(config, options) {
  const next = { default: config.default, runtimes: { ...config.runtimes } };
  if (options.alias !== undefined) {
    const previous = Object.hasOwn(next.runtimes, options.alias) ? next.runtimes[options.alias] : undefined;
    const replaced = previous !== undefined;
    if (!replaced && (options.url === undefined || options.token === undefined)) throw Error('a new runtime needs --runtime HOST:PORT and --token TOKEN');
    const entry = { ...previous, ...(options.url === undefined ? {} : { url: options.url }), ...(options.token === undefined ? {} : { token: options.token }), ...(options.cwd === undefined ? {} : { cwd: options.cwd }) };
    if (options.clearCwd) delete entry.cwd;
    next.runtimes[options.alias] = entry;
    if (options.setDefault) next.default = options.alias;
    return { config: next, message: `${replaced ? 'Updated' : 'Added'} runtime ${options.alias} (${entry.url})${options.setDefault ? '; it is now the default' : ''}` };
  }
  if (options.default !== undefined) {
    if (options.default !== LOCAL && !Object.hasOwn(next.runtimes, options.default)) throw Error(`no runtime named ${options.default}`);
    next.default = options.default;
    return { config: next, message: `Default runtime: ${options.default}` };
  }
  if (options.remove !== undefined) {
    if (!Object.hasOwn(next.runtimes, options.remove)) throw Error(`no runtime named ${options.remove}`);
    delete next.runtimes[options.remove];
    const fallback = next.default === options.remove;
    if (fallback) next.default = LOCAL;
    return { config: next, message: `Removed runtime ${options.remove}${fallback ? '; the default is local again' : ''}` };
  }
  return { config, message: listing(config) };
}

/** The `dscode config --list` table; tokens are never printed. */
export function listing(config) {
  const rows = [[LOCAL, 'this machine', ''], ...Object.entries(config.runtimes).map(([alias, entry]) => [alias, entry.url.replace(/^http:\/\//, ''), entry.cwd ?? ''])];
  const width = Math.max(...rows.map(row => row[0].length)) + 2;
  return rows.map(([alias, where, cwd]) => `${alias === config.default ? '*' : ' '} ${alias.padEnd(width)}${where}${cwd ? `  ${cwd}` : ''}`).join('\n');
}

/**
 * The runtime a launch attaches to: an explicit name, else the configured default.
 * @returns `{ kind: 'local' }` or `{ kind: 'remote', alias, target, cwd? }`.
 */
export function resolveRuntime(home, name) {
  const config = readRuntimes(home);
  const wanted = name ?? config.default;
  if (wanted === LOCAL) return { kind: LOCAL };
  const entry = Object.hasOwn(config.runtimes, wanted) ? config.runtimes[wanted] : undefined;
  if (entry === undefined) {
    if (name === undefined) throw Error(`the default runtime "${wanted}" is not configured; run \`dscode config --default local\` or add it again`);
    throw Error(`no runtime named ${wanted}; \`dscode config --list\` shows the configured ones`);
  }
  return { kind: 'remote', alias: wanted, target: { url: entry.url, token: entry.token }, ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }) };
}

/**
 * Ask a remote runtime for its status and check it runs this release.
 * @throws when it does not answer, refuses the token, or runs another version.
 */
export async function checkRemote(runtime, version, timeoutMs = 10_000) {
  let status;
  try {
    status = await callDscode(runtime.target, 'host/status', {}, AbortSignal.timeout(timeoutMs));
  } catch (error) {
    if (error.code === 'dscode/unauthorized') throw Error(`runtime ${runtime.alias} refused the token; copy the current one from the server's \`dscode server\` output into \`dscode config --runtime … --alias ${runtime.alias}\``, { cause: error });
    throw Error(`runtime ${runtime.alias} (${runtime.target.url}) did not answer: ${error.message}`, { cause: error });
  }
  try { requireCompatibleRuntime(status, version); }
  catch (error) { throw Error(`runtime ${runtime.alias}: ${error.message}`, { cause: error }); }
  return status;
}

/** `dscode config`. */
export async function configMain(argv, { home, version, log = console.log } = {}) {
  const options = parseConfigArgs(argv);
  if (options.help) { log(CONFIG_USAGE); return; }
  const { config, message } = applyConfig(readRuntimes(home), options);
  if (options.list === undefined && (options.alias !== undefined || options.default !== undefined || options.remove !== undefined)) writeRuntimes(home, config);
  log(message);
  // Saving never depends on the server being up, but say at once whether it answers.
  if (options.alias !== undefined) {
    try {
      const status = await checkRemote(resolveRuntime(home, options.alias), version, 5000);
      log(`Connected: DSCODE ${status.version} on ${config.runtimes[options.alias].url}, default folder ${status.defaultCwd}`);
    } catch (error) { log(`Saved, but not reachable now: ${error.message}`); }
  }
}

/** Read-only remote status/diagnostics; failures have a nonzero exit code, also with --json. */
export async function runtimeInspect(argv, { home, version, log = console.log, timeoutMs = 5000 } = {}) {
  const [command, alias, ...flags] = argv;
  if (!['status', 'doctor'].includes(command) || !alias || alias.startsWith('-') || flags.some(flag => flag !== '--json')) {
    throw Error(RUNTIME_USAGE);
  }
  const runtime = resolveRuntime(home, alias);
  if (runtime.kind === LOCAL) throw Error('use `dscode host status` or `dscode doctor --local` for this machine');
  const report = { alias, address: runtime.target.url, ok: false, checks: [] };
  const started = Date.now();
  try {
    const status = await callDscode(runtime.target, 'host/status', {}, AbortSignal.timeout(timeoutMs));
    report.latencyMs = Date.now() - started;
    report.status = Object.fromEntries(['version', 'protocol', 'pid', 'startedAt', 'clients', 'streams', 'sessions', 'running', 'defaultCwd'].filter(key => status[key] !== undefined).map(key => [key, status[key]]));
    report.cwd = runtime.cwd ?? status.defaultCwd;
    report.checks.push({ name: 'connection', ok: true, detail: 'server answered with the configured token' });
    const compatibility = runtimeCompatibility(status, version);
    const compatible = compatibility.ok;
    report.checks.push({ name: 'version', ...compatibility });
    if (command === 'doctor' && compatible) {
      if (status.protocol !== undefined && (!Array.isArray(status.protocol.capabilities) || !status.protocol.capabilities.includes('host/diagnostics'))) {
        report.checks.push({ name: 'diagnostics', ok: false, detail: 'server does not advertise host/diagnostics; update the server to use this check' });
      } else {
        const diagnostics = await callDscode(runtime.target, 'host/diagnostics', { cwd: report.cwd }, AbortSignal.timeout(timeoutMs));
        report.checks.push(...diagnostics.checks);
      }
    }
    report.ok = report.checks.every(check => check.ok);
  } catch (error) {
    report.checks.push({ name: report.status ? 'diagnostics' : 'connection', ok: false, detail: error.code === 'dscode/unauthorized'
      ? `token refused; update it with dscode config --alias ${alias} --token TOKEN`
      : `request failed (${error.code ?? error.name ?? 'error'}); check the server address, service and network` });
  }
  if (flags.includes('--json')) log(JSON.stringify(report, null, 2));
  else {
    const status = report.status;
    log([
      `Runtime ${alias} (${report.address})`,
      ...(status ? [`DSCODE ${status.version}; PID ${status.pid ?? '?'}; ${report.latencyMs} ms`,
        `Folder: ${report.cwd}`, `Clients: ${status.clients ?? '?'}; sessions: ${status.sessions ?? '?'}; running: ${status.running ?? '?'}`] : []),
      ...report.checks.map(check => `${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.detail}`),
      ...(command === 'doctor' ? ['Checks inspect server configuration only; no model or tool execution is performed.'] : []),
    ].join('\n'));
  }
  return report.ok ? 0 : 1;
}
