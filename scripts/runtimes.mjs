// Named runtimes a terminal can attach to (docs/remote-runtime.md): `local`, the
// background Host on this machine, plus remote Hosts started with `dscode
// server`. `dscode config --runtime` records them, `dscode runtime <alias>`
// attaches to one, and a default makes bare `dscode` attach to it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { callDscode, formatProtocol, protocolCompatibility } from '../plugins/local-carrier/client.mjs';

export const LOCAL = 'local';
const ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export const CONFIG_USAGE = [
  'Usage:',
  '  dscode config --runtime HOST:PORT --token TOKEN --alias NAME [--cwd DIR] [--set-default]',
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
    else if (flag === '--set-default') options.setDefault = true;
    else if (flag === '--default') options.default = next();
    else if (flag === '--remove') options.remove = next();
    else if (flag === '--list') options.list = true;
    else if (flag === '--help' || flag === '-h') return { help: true };
    else throw Error(`unknown option ${flag}\n${CONFIG_USAGE}`);
  }
  const actions = ['runtime', 'default', 'remove', 'list'].filter(key => options[key] !== undefined);
  if (actions.length > 1) throw Error(`use one of --runtime, --default, --remove or --list at a time\n${CONFIG_USAGE}`);
  if (options.runtime === undefined && (options.alias !== undefined || options.token !== undefined || options.cwd !== undefined || options.setDefault)) {
    throw Error(`--alias, --token, --cwd and --set-default belong to --runtime\n${CONFIG_USAGE}`);
  }
  if (options.runtime !== undefined) {
    if (options.alias === undefined) throw Error(`--runtime needs --alias NAME\n${CONFIG_USAGE}`);
    if (!ALIAS.test(options.alias)) throw Error('an alias is letters, digits, ".", "_" or "-" (at most 64)');
    if (options.alias.toLowerCase() === LOCAL) throw Error(`"${LOCAL}" is reserved for this machine's runtime`);
    if (options.token === undefined) throw Error(`--runtime needs --token TOKEN (printed by \`dscode server\`)\n${CONFIG_USAGE}`);
    if (options.cwd !== undefined && !options.cwd.startsWith('/')) throw Error('--cwd must be an absolute path on the server');
    options.url = runtimeUrl(options.runtime);
  }
  return options;
}

/** Apply one parsed `dscode config` action to a configuration; returns the new one and a message. */
export function applyConfig(config, options) {
  const next = { default: config.default, runtimes: { ...config.runtimes } };
  if (options.runtime !== undefined) {
    const replaced = next.runtimes[options.alias] !== undefined;
    next.runtimes[options.alias] = { url: options.url, token: options.token, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) };
    if (options.setDefault) next.default = options.alias;
    return { config: next, message: `${replaced ? 'Updated' : 'Added'} runtime ${options.alias} (${options.url})${options.setDefault ? '; it is now the default' : ''}` };
  }
  if (options.default !== undefined) {
    if (options.default !== LOCAL && next.runtimes[options.default] === undefined) throw Error(`no runtime named ${options.default}`);
    next.default = options.default;
    return { config: next, message: `Default runtime: ${options.default}` };
  }
  if (options.remove !== undefined) {
    if (next.runtimes[options.remove] === undefined) throw Error(`no runtime named ${options.remove}`);
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
  const entry = config.runtimes[wanted];
  if (entry === undefined) {
    if (name === undefined) throw Error(`the default runtime "${wanted}" is not configured; run \`dscode config --default local\` or add it again`);
    throw Error(`no runtime named ${wanted}; \`dscode config --list\` shows the configured ones`);
  }
  return { kind: 'remote', alias: wanted, target: { url: entry.url, token: entry.token }, ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }) };
}

/**
 * Ask a remote runtime for its status and check it speaks a compatible protocol.
 * @throws when it does not answer, refuses the token, or is incompatible.
 */
export async function checkRemote(runtime, version, timeoutMs = 10_000) {
  let status;
  try {
    status = await callDscode(runtime.target, 'host/status', {}, AbortSignal.timeout(timeoutMs));
  } catch (error) {
    if (error.code === 'dscode/unauthorized') throw Error(`runtime ${runtime.alias} refused the token; copy the current one from the server's \`dscode server\` output into \`dscode config --runtime … --alias ${runtime.alias}\``, { cause: error });
    throw Error(`runtime ${runtime.alias} (${runtime.target.url}) did not answer: ${error.message}`, { cause: error });
  }
  const compatibility = protocolCompatibility(status, { version });
  if (!compatibility.compatible) throw Error(`runtime ${runtime.alias} ${compatibility.reason}`);
  return status;
}

/** `dscode config`. */
export async function configMain(argv, { home, version, log = console.log } = {}) {
  const options = parseConfigArgs(argv);
  if (options.help) { log(CONFIG_USAGE); return; }
  const { config, message } = applyConfig(readRuntimes(home), options);
  if (options.list === undefined && (options.runtime !== undefined || options.default !== undefined || options.remove !== undefined)) writeRuntimes(home, config);
  log(message);
  // Saving never depends on the server being up, but say at once whether it answers.
  if (options.runtime !== undefined) {
    try {
      const status = await checkRemote(resolveRuntime(home, options.alias), version, 5000);
      log(`Connected: DSCODE ${status.version} (protocol ${formatProtocol(status.protocol)}) on ${options.url}, default folder ${status.defaultCwd}`);
    } catch (error) { log(`Saved, but not reachable now: ${error.message}`); }
  }
}
