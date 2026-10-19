import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { MARKER } from './standalone-layout.mjs';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const node = '24.21.0';
// Official nodejs.org/dist/v24.21.0/SHASUMS256.txt. Never resolve latest or
// copy a Homebrew-linked Node into a redistributable application.
const hashes = {
  'darwin-arm64': 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
  'darwin-x64': '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097',
  'linux-arm64': '724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5',
  'linux-x64': '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff',
};
const entries = ['package.json', 'package-lock.json', 'LICENSE', 'bin', 'scripts', 'plugins', 'extensions',
  'presets', 'packages/tui', 'packages/launcher/locks.mjs', 'config/cordis.patch.yml', 'config/auto-review.patch.yml',
  'config/preset.json', 'README.md', 'README.zh-CN.md', 'docs', 'install.sh'];
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${command} failed (${result.status ?? result.signal})`);
}
const artifacts = join(root, 'artifacts');
mkdirSync(artifacts, { recursive: true });
// DSCODE_PREBUILT_ARCHS (arm64/x64) still selects macOS builds for older scripts.
const selected = process.env.DSCODE_PREBUILT_PLATFORMS
  ?? (process.env.DSCODE_PREBUILT_ARCHS ? process.env.DSCODE_PREBUILT_ARCHS.split(',').filter(Boolean).map(arch => `darwin-${arch}`).join(',') : Object.keys(hashes).join(','));
const platforms = selected.split(',').filter(Boolean);
if (!platforms.length || platforms.some(platform => !hashes[platform])) throw Error(`DSCODE_PREBUILT_PLATFORMS must select from ${Object.keys(hashes).join(', ')}. Source-only releases are no longer supported.`);
for (const platform of platforms) {
  const [os, arch] = platform.split('-');
  const work = mkdtempSync(join(artifacts, '.standalone-'));
  const stage = join(work, 'app');
  try {
    for (const entry of entries) {
      mkdirSync(dirname(join(stage, entry)), { recursive: true });
      cpSync(join(root, entry), join(stage, entry), { recursive: true,
        filter: source => !source.includes('/packages/tui/lib/') && source !== join(root, 'packages/tui/lib') });
    }
    // Linux packages are glibc builds: npm skips a native package that declares a libc it
    // cannot match on a foreign build host, so the target libc is named explicitly.
    run('npm', ['ci', '--ignore-scripts', '--no-audit', `--os=${os}`, `--cpu=${arch}`, ...(os === 'linux' ? ['--libc=glibc'] : []), '--cache', join(root, '.npm-cache')], stage);
    run(process.execPath, ['scripts/build-tui.mjs'], stage);
    run(process.execPath, ['--input-type=module', '-e', `
      import { patchRuntime, patchAppBootPackage } from './scripts/patch-runtime.mjs';
      import { patchInkFrame } from './scripts/patch-ink.mjs';
      import { patchStandaloneSkills } from './scripts/patch-standalone-skills.mjs';
      patchRuntime(process.cwd()); patchAppBootPackage(process.cwd()); patchInkFrame(process.cwd());
      patchStandaloneSkills(process.cwd());
    `], stage);
    const tuiPath = join(stage, 'packages/tui/package.json');
    const tui = JSON.parse(readFileSync(tuiPath, 'utf8'));
    const compiled = value => typeof value === 'string' ? value.replace(/^\.\/src\/(.*)\.ts$/, './lib/$1.mjs')
      : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compiled(item)]));
    tui.main = 'lib/index.mjs'; tui.exports = compiled(tui.exports);
    writeFileSync(tuiPath, JSON.stringify(tui, null, 2) + '\n');
    const name = `node-v${node}-${platform}`;
    const response = await fetch(`https://nodejs.org/dist/v${node}/${name}.tar.gz`);
    if (!response.ok) throw Error(`Could not download private Node (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== hashes[platform]) throw Error('Official Node archive checksum mismatch');
    const archive = join(work, 'node.tar.gz');
    writeFileSync(archive, bytes);
    run('tar', ['-xzf', archive, '-C', work], root);
    mkdirSync(join(stage, 'runtime/bin'), { recursive: true });
    cpSync(join(work, name, 'bin/node'), join(stage, 'runtime/bin/node'));
    cpSync(join(work, name, 'LICENSE'), join(stage, 'runtime/LICENSE'));
    cpSync(join(root, 'packages/standalone/dscode'), join(stage, 'dscode'));
    chmodSync(join(stage, 'dscode'), 0o755);
    writeFileSync(join(stage, MARKER), JSON.stringify({ format: 1, version: manifest.version, platform, node,
      runtime: manifest.dependencies['@deepseek-ai/dsh'] }, null, 2) + '\n');
    if (platform === `${process.platform}-${process.arch}`) run(join(stage, 'dscode'), ['--check'], work);
    const outputName = `dscode-${manifest.version}-${platform}-standalone.tar.gz`;
    const output = join(artifacts, outputName);
    run('tar', ['-czf', output, '-C', stage, '.'], root);
    writeFileSync(`${output}.sha256`, `${createHash('sha256').update(readFileSync(output)).digest('hex')}  ${outputName}\n`);
    console.log(output);
  } finally { rmSync(work, { recursive: true, force: true }); }
}
