// A throwaway DSCODE Host for developing the desktop client: its own state
// directory under the temp folder, the deterministic fixture model (no paid
// requests), and optionally a TCP listener. Prints one FIXTURE_HOST line with
// the socket, the URL and token, and the workspace, then serves until Ctrl-C.
//
//   node clients/desktop/scripts/fixture-host.mjs [--port PORT]
//
// Fixture prompts: APPROVE asks to write a file outside the workspace, ASK asks
// a question, SLOW streams slowly; anything else streams a short reply.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const portIndex = process.argv.indexOf('--port');
const port = portIndex > 0 ? Number(process.argv[portIndex + 1]) : undefined;

const home = mkdtempSync(join(tmpdir(), 'dscode-desktop-'));
const workspace = join(home, 'workspace'); mkdirSync(workspace);
const userHome = join(home, 'user'); mkdirSync(userHome);
const patch = join(home, 'fixture.patch.yml');
writeFileSync(patch, [
  '- id: agent-default-model\n  config:\n    provider: fixture\n    model: fixture',
  '- id: permission\n  config:\n    defaultPreset: workspace-write',
  '- id: dscode-session-cards\n  config:\n    enabled: false', '- id: dscode-memory\n  config:\n    generate: false',
  `- insert:\n    - id: fixture-model\n      name: ${JSON.stringify(join(root, 'scripts/fixture-model.mjs'))}`,
].join('\n') + '\n');
// harness.mjs resolves the state directory at import, so the environment comes first.
// HOME is isolated too, so nothing touches the real ~/.dsh.
Object.assign(process.env, { DSCODE_SOURCE_HOME: home, DSCODE_HOST_PATCH: patch, HOME: userHome, CI: 'false', DSCODE_LANGUAGE: 'en',
  DSCODE_UPDATE_CHECK: 'off', DSCODE_ACCOUNT_LOGIN: '0', DSCODE_MEMORY_HOME: join(home, 'memories'),
  FIXTURE_OUTSIDE_PATH: join(home, 'outside-write-probe.txt') });
const { serve, hostSocket, hostStatus, serverToken, serverTokenFile } = await import(join(root, 'scripts/host.mjs'));

const tcp = port ? { port, bind: '127.0.0.1', tokenFile: serverTokenFile(home) } : undefined;
const token = tcp ? serverToken(home) : undefined;
const served = serve({ home, idleExitMs: 0, defaultCwd: workspace, tcp });

const deadline = Date.now() + 90_000;
while (await hostStatus(home) === undefined) {
  if (Date.now() > deadline) { console.error(`fixture Host did not start; see ${join(home, 'run', 'host.log')}`); process.exit(1); }
  await new Promise(r => setTimeout(r, 200));
}
console.log('FIXTURE_HOST ' + JSON.stringify({ socket: hostSocket(home), url: tcp ? `http://127.0.0.1:${port}` : undefined, token, workspace, home }));

const code = await served;
if (!process.env.KEEP) rmSync(home, { recursive: true, force: true });
process.exit(code);
