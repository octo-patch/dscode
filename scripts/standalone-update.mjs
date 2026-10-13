import { mkdirSync, mkdtempSync, existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { RELEASES, readPackage, VERSION } from './standalone-layout.mjs';
import { newerVersion } from '../plugins/tui-tools/update.mjs';

export function executePackageCommand(command, args, options = {}) {
  // A complete package's tar listing exceeds Node's default 1 MiB buffer.
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${command} failed: ${result.stderr || result.status}`);
  return result.stdout;
}

// Caller owns both the installation and state admission gates for the full update.
export async function updateStandalone(args, { root, env, fetchImpl = fetch, exec = executePackageCommand, swap = renameSync,
  platform = `${process.platform}-${process.arch}` }) {
  if (args.length > 1 || args[0] && args[0] !== 'latest' && !VERSION.test(args[0])) throw Error('Usage: dscode update [exact-version]');
  const wanted = args[0] === 'latest' ? undefined : args[0];
  const current = readPackage(root, platform);
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dscode' };
  const response = await fetchImpl(`${RELEASES}/${wanted ? `tags/v${wanted}` : 'latest'}`, { headers });
  if (!response.ok) throw Error(`Could not read the DSCODE release (${response.status}).`);
  const release = await response.json();
  const version = String(release.tag_name ?? '').replace(/^v/, '');
  if (release.draft || release.prerelease || !VERSION.test(version) || wanted && version !== wanted) throw Error('Invalid DSCODE release metadata.');
  if (version === current.version || !wanted && !newerVersion(version, current.version)) {
    console.log(`DSCODE ${current.version} is already current.`); return { status: 'current' };
  }
  const name = `dscode-${version}-${platform}-standalone.tar.gz`;
  const asset = release.assets?.find(item => item.name === name);
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) throw Error('No verified self-contained package for this platform. Nothing was changed.');
  const download = await fetchImpl(asset.browser_download_url, { headers });
  if (!download.ok) throw Error(`Package download failed (${download.status}).`);
  const bytes = Buffer.from(await download.arrayBuffer());
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== asset.digest) throw Error('Package checksum mismatch. Nothing was changed.');
  const work = mkdtempSync(join(dirname(root), '.dscode-update-'));
  const archive = join(work, 'package.tar.gz');
  const staged = join(work, 'app');
  const backup = `${root}.backup-${current.version}-${Date.now()}`;
  try {
    writeFileSync(archive, bytes, { mode: 0o600 });
    mkdirSync(staged);
    const names = exec('/usr/bin/tar', ['-tzf', archive]).trim().split('\n');
    if (names.some(path => path.startsWith('/') || path.split('/').includes('..'))) throw Error('Unsafe package archive paths.');
    exec('/usr/bin/tar', ['-xzf', archive, '-C', staged]);
    const next = readPackage(staged, platform);
    if (next.version !== version) throw Error('Package version does not match the requested release.');
    exec(join(staged, 'dscode'), ['--check'], { env });
    // State stays outside both trees. Failed checks and swaps never move user data.
    swap(root, backup);
    try {
      swap(staged, root);
      exec(join(root, 'dscode'), ['--check'], { env });
    } catch (error) {
      if (existsSync(root)) swap(root, staged);
      swap(backup, root);
      throw error;
    }
    console.log(`Updated DSCODE ${current.version} → ${version}. Previous package: ${backup}`);
    return { status: 'updated', backup, version };
  } finally { rmSync(work, { recursive: true, force: true }); }
}
