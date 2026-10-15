// Behaviour baseline for the terminal runner: boots the real Harness with the
// real TUI rows, mounts the TUI on an in-memory TTY (tui-runner-probe.mjs) and
// drives it with keystrokes against the deterministic fixture model. A second
// boot resumes the persisted session. Both scenarios run in three modes:
// `in-process` (the terminal drives its own Harness), `typert` (the protocol
// runtime reaching the same Harness through the local carrier) and `split`
// (the real launcher: a background Host plus a separate terminal client
// process). The runtime/client separation must keep all three passing.
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { root, provision, environment, dshEntry } from './harness.mjs';
import { hostStatus, stop as stopHost } from './host.mjs';

const home = mkdtempSync(join(tmpdir(), 'dscode-tui-runner-'));
const workspace = join(home, 'workspace'); mkdirSync(workspace);
writeFileSync(join(workspace, 'notes-for-probe.txt'), 'probe notes\n');
// The terminal keeps history, theme and language under the user's home; the probe gets its own.
const userHome = join(home, 'user'); mkdirSync(userHome);
const outside = join(homedir(), `.dscode-tui-probe-${randomUUID()}`);

const fixtureRows = [
  '- id: agent-default-model\n  config:\n    provider: fixture\n    model: fixture',
  '- id: permission\n  config:\n    defaultPreset: workspace-write',
  '- id: dscode-session-cards\n  config:\n    enabled: false', '- id: dscode-memory\n  config:\n    generate: false',
];

function boot(runtime, scenario, args = []) {
  const socketPath = join(home, 'run', 'host.sock');
  const patch = join(home, 'probe.patch.yml');
  if (runtime === 'split') {
    // The Host loads the fixture; the separate client carries the probe.
    writeFileSync(patch, [...fixtureRows, `- insert:\n    - id: fixture-model\n      name: ${JSON.stringify(join(root, 'scripts/fixture-model.mjs'))}`].join('\n') + '\n');
    return collect(runtime, scenario, spawn(process.execPath, [join(root, 'bin/dscode.mjs'), ...args], {
      cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: userHome, CI: 'false', DSCODE_LANGUAGE: 'en', DSCODE_UPDATE_CHECK: 'off', DSCODE_ACCOUNT_LOGIN: '0',
        DSCODE_SOURCE_HOME: home, DSCODE_HOST_PATCH: patch, DSCODE_TERMINAL_CLIENT: join(root, 'scripts/tui-client-probe.mjs'),
        DSCODE_MEMORY_HOME: join(home, 'memories'), TUI_PROBE_SCENARIO: scenario, FIXTURE_OUTSIDE_PATH: outside },
    }));
  }
  writeFileSync(patch, [
    ...fixtureRows,
    `- insert:\n    - id: fixture-model\n      name: ${JSON.stringify(join(root, 'scripts/fixture-model.mjs'))}\n    - id: tui-runner-probe\n      name: ${JSON.stringify(join(root, 'scripts/tui-runner-probe.mjs'))}`
      + (runtime === 'typert' ? `\n    - id: api-remotes\n      name: '@deepseek-ai/dsh-api-remotes'\n    - id: local-carrier\n      name: ${JSON.stringify(join(root, 'plugins/local-carrier/index.mjs'))}\n      config:\n        socketPath: ${JSON.stringify(socketPath)}` : ''),
  ].join('\n') + '\n');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', dshEntry, '--profile', 'tui', '--patch', patch, ...args], {
    cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...environment(home, workspace), HOME: userHome, CI: 'false', DSCODE_LANGUAGE: 'en', DSCODE_UPDATE_CHECK: 'off', DSCODE_ACCOUNT_LOGIN: '0',
      DSCODE_MEMORY_HOME: join(home, 'memories'), TUI_PROBE_SCENARIO: scenario, FIXTURE_OUTSIDE_PATH: outside,
      ...(runtime === 'typert' ? { DSCODE_RUNTIME_SOCKET: socketPath } : {}) },
  });
  return collect(runtime, scenario, child);
}

function collect(runtime, scenario, child) {
  let output = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0 || !output.includes(`TUI_RUNNER_PROBE_PASSED ${scenario}`)) reject(Error(`${runtime} ${scenario} scenario failed (exit ${code}):\n${output.slice(-6000)}`));
      else resolve(output);
    });
  });
}

/** Newest root session persisted under this home: sessions/<folder>/session-<uuid>/. */
function newestSession() {
  const found = [];
  for (const folder of readdirSync(join(home, 'sessions'))) {
    for (const name of readdirSync(join(home, 'sessions', folder))) {
      if (/^session-[0-9a-f-]{36}$/.test(name)) found.push({ name, mtime: statSync(join(home, 'sessions', folder, name)).mtimeMs });
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  if (found.length === 0) throw Error('no persisted session found');
  return found[0].name;
}

try {
  provision(home);
  const runs = {};
  for (const runtime of (process.env.TUI_RUNTIMES ?? 'in-process,typert,split').split(',')) {
    const steps = [...(await boot(runtime, 'session')).matchAll(/TUI_PROBE_STEP ([^\n]+?)(?=TUI_PROBE_STEP|\n|$)/g)].map(match => match[1].trim());
    const sessionId = newestSession();
    // The split terminal must have attached to a separate, still-running Host.
    const host = runtime === 'split' ? await hostStatus(home) : undefined;
    if (runtime === 'split' && !(host?.pid > 0 && host.pid !== process.pid && host.sessions >= 1)) throw Error(`split mode did not use a separate Host: ${JSON.stringify(host)}`);
    await boot(runtime, 'resume', ['--resume', sessionId]);
    runs[runtime] = { steps, resumed: sessionId, ...(host === undefined ? {} : { hostPid: host.pid, hostSessions: host.sessions }) };
  }
  console.log('TUI_RUNNER_VERIFIED ' + JSON.stringify(runs));
} finally {
  // The split mode leaves its background Host running until stopped.
  process.env.DSCODE_SOURCE_HOME = home;
  await stopHost({ home }).catch(() => {});
  rmSync(outside, { force: true });
  if (!process.env.KEEP) rmSync(home, { recursive: true, force: true });
}
