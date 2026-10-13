import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceOnce } from './patch-util.mjs';

export function standaloneSkillsSource(source) {
  const marker = "import { isolatedDshPath } from '../../../../plugins/tui-tools/workspace-discovery.mjs';";
  if (source.startsWith(marker)) return source;
  return marker + '\n' + replaceOnce(source, '\t\treturn roots;\n\t}\n};', '\t\treturn roots.filter(root => !isolatedDshPath(root.path));\n\t}\n};');
}

export function patchStandaloneSkills(root) {
  const file = join(root, 'node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js');
  writeFileSync(file, standaloneSkillsSource(readFileSync(file, 'utf8')));
}
