import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot';

/** Shipped profile bundles must work without a user's local version exemptions. */
export function checkProfileCompatibility(root) {
  const read = path => JSON.parse(readFileSync(path, 'utf8'));
  const manifest = read(join(root, 'package.json'));
  const runtime = read(join(root, 'node_modules/@deepseek-ai/dsh/package.json')).version;
  for (const name of manifest.dsh.profile.bundles) {
    const plugin = read(join(root, 'node_modules', name, 'package.json'));
    const issue = evaluatePluginCompatibility(plugin, {}, runtime);
    if (issue) throw Error(`Shipped bundle ${name}@${plugin.version} is incompatible with DSH ${runtime}: ${JSON.stringify(issue.requirements)}`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  checkProfileCompatibility(resolve(import.meta.dirname, '..'));
  console.log('Profile bundle compatibility: clean');
}
