import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export const MARKER = '.dscode-standalone.json';
export const RELEASES = 'https://api.github.com/repos/qiz029/dscode/releases';
export const VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
export const inside = (parent, child) => { const path = relative(parent, child); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); };

// Resolve existing ancestors as well: a symlink must not turn a private home into ~/.dsh.
export function canonical(path) {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(canonical(parent), relative(parent, path));
}

export function readPackage(root, platform = `${process.platform}-${process.arch}`) {
  const metadata = JSON.parse(readFileSync(join(root, MARKER), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (metadata.format !== 1 || !VERSION.test(metadata.version) || metadata.version !== pkg.version || metadata.platform !== platform) {
    throw Error('Invalid DSCODE package version or platform. Download the package for this machine.');
  }
  for (const file of ['dscode', 'runtime/bin/node', 'scripts/standalone.mjs', 'bin/dscode.mjs', 'node_modules/@deepseek-ai/dsh/lib/bin.js']) {
    if (!existsSync(join(root, file))) throw Error(`Incomplete DSCODE package: ${file} is missing.`);
  }
  return metadata;
}

export function standaloneEnvironment(root, input = process.env, userHome = homedir()) {
  const home = input.DSCODE_HOME || join(userHome, '.local/share/dscode-state');
  if (!isAbsolute(home)) throw Error('DSCODE_HOME must be an absolute path.');
  const state = canonical(resolve(home));
  if (inside(canonical(root), state) || inside(canonical(join(userHome, '.dsh')), state)) {
    throw Error('DSCODE_HOME must be outside the application package and the existing ~/.dsh installation.');
  }
  if (existsSync(join(state, 'bin/dscode.mjs'))) throw Error('DSCODE_HOME contains an old application installation. Choose a separate data directory and migrate the old state explicitly.');
  const env = { ...input };
  for (const key of Object.keys(env)) if (key.startsWith('DSH_') || ['NODE_OPTIONS', 'NODE_PATH'].includes(key)) delete env[key];
  return { ...env, DSCODE_HOME: state, DSH_HOME: state, DSH_AGENTS_HOME: join(state, 'agents'),
    DSCODE_STANDALONE_ROOT: root, DSCODE_CLI_PATH: join(root, 'dscode'),
    PATH: `${join(root, 'runtime/bin')}:${join(root, 'bin')}:${input.PATH ?? '/usr/bin:/bin'}` };
}

export function installationLockHome(root, userHome = homedir()) {
  const id = createHash('sha256').update(canonical(root)).digest('hex').slice(0, 24);
  return join(userHome, '.local/state/dscode-installations', id);
}
