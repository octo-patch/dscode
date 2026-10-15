#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { readPackage, standaloneEnvironment, installationLockHome } from './standalone-layout.mjs';

/** Stop a shared Host that has no attached terminal; refuse while one is attached. */
async function stopIdleHost() {
  let host;
  // A package without the Host module (an older or reduced layout) has no Host to stop.
  try { host = await import('./host.mjs'); } catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND') return; throw error; }
  const { hostStatus, stop } = host;
  const status = await hostStatus();
  if (status === undefined) return;
  if (status.clients > 0) throw Error('Exit the DSCODE terminals attached to the background Host before updating.');
  await stop();
}

export async function standaloneMain(args = process.argv.slice(2)) {
  let root = resolve(import.meta.dirname, '..');
  let metadata = readPackage(root);
  if (process.versions.node !== metadata.node) throw Error(`This package requires its private Node ${metadata.node}; run ${join(root, 'dscode')}.`);
  // The freshly verified installer package can repair an older updater while
  // retaining the target installation's ownership checks and admission locks.
  if (args[0] === '--update-installation') {
    if (args.length < 2 || args.length > 3 || !isAbsolute(args[1])) throw Error('Expected an absolute installation path and optional release version.');
    root = realpathSync(args[1]); metadata = readPackage(root);
    args = ['update', ...args.slice(2)];
  }
  const env = standaloneEnvironment(root);
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  if (['--version', '-v'].includes(args[0])) { console.log(metadata.version); return; }
  if (['--help', '-h'].includes(args[0])) {
    console.log(`DSCODE ${metadata.version}\n\n  dscode [--cwd PATH]           Start the coding terminal\n  dscode exec [options] PROMPT  Run a prompt headless\n  dscode acp                    Serve ACP over stdio\n  dscode resume [SESSION_ID]    Resume a session\n  dscode server --port PORT     Serve this machine's runtime to remote terminals\n  dscode config --runtime ...   Record a remote runtime (see dscode config --help)\n  dscode runtime [ALIAS]        Start the terminal on a recorded runtime, or list them\n  dscode update [VERSION]       Replace the complete application package\n  dscode doctor [--local]       Inspect runtime diagnostics\n  dscode --check                Check bundled modules without starting a session\n  dscode --installation         Show program and data locations\n\nState: ${env.DSCODE_HOME}\nLocal configuration: ${join(env.DSCODE_HOME, 'config')}\nExisting dsh installations are not used or modified.`);
    return;
  }
  if (args[0] === '--installation') { console.log(JSON.stringify({ ...metadata, root, home: env.DSCODE_HOME, node: process.execPath })); return; }
  if (args[0] === '--check') {
    await import('dsh-code/startup');
    await import('dsh-code/client');
    await import('dsh-code/host');
    await import('node-pty');
    await import('@deepseek-ai/node-addon-system/flock');
    console.log(`DSCODE ${metadata.version}: bundled runtime and native modules OK`);
    return;
  }
  const { acquireLock, activeRuns, registerRun } = await import('../packages/launcher/locks.mjs');
  const homes = [...new Set([installationLockHome(root), env.DSCODE_HOME])].sort();
  const gates = [], leases = [];
  try {
    for (const home of homes) gates.push(await acquireLock(home));
    if (args[0] === 'update') {
      if (existsSync(join(root, '.dscode-brew'))) throw Error('Homebrew owns this package. Run "brew upgrade dscode" to replace the complete package.');
      // The shared Host holds a run lease while it waits for terminals; with
      // none attached it is stopped so the package can be replaced.
      gates.splice(0).reverse().forEach(unlock => unlock());
      await stopIdleHost();
      for (const home of homes) gates.push(await acquireLock(home));
      for (const home of homes) if ((await activeRuns(home)).length) throw Error('Exit running DSCODE sessions (and attached terminals of `dscode host`) before updating.');
      const { updateStandalone } = await import('./standalone-update.mjs');
      await updateStandalone(args.slice(1), { root, env });
      return;
    }
    const ownerPath = join(env.DSCODE_HOME, '.standalone-runtime.json');
    const owner = existsSync(ownerPath) ? JSON.parse(readFileSync(ownerPath, 'utf8')) : undefined;
    if ((!owner || owner.root !== root || owner.version !== metadata.version) && (await activeRuns(env.DSCODE_HOME)).length) {
      throw Error('Another DSCODE package is using this data directory. Exit its sessions before switching packages.');
    }
    writeFileSync(ownerPath, JSON.stringify({ root, version: metadata.version }), { mode: 0o600 });
    for (const home of homes) leases.push(await registerRun(home));
    const child = spawn(process.execPath, [join(root, 'bin/dscode.mjs'), ...args], {
      env: { ...env, DSCODE_LEASE_FDS: leases.map((_, i) => i + 3).join(',') },
      stdio: ['inherit', 'inherit', 'inherit', ...leases.map(lease => lease.fd)],
    });
    gates.splice(0).reverse().forEach(unlock => unlock());
    const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => {
      const handler = () => child.kill(signal); process.on(signal, handler); return [signal, handler];
    });
    try {
      process.exitCode = await new Promise((done, fail) => {
        child.once('error', fail); child.once('exit', (code, signal) => done(code ?? (signal ? 128 : 1)));
      });
    } finally { handlers.forEach(([signal, handler]) => process.off(signal, handler)); }
  } finally {
    leases.reverse().forEach(lease => lease.release());
    gates.reverse().forEach(unlock => unlock());
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  standaloneMain().catch(error => { console.error(error.message); process.exitCode = 1; });
}
