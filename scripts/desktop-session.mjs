import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { root, runtimeHome } from './harness.mjs';

const entry = join(root, 'plugins/computer-use/linux/desktop.py');
const stateDirectory = home => join(home, 'desktop');
export const DESKTOP_USAGE = 'Usage: dscode desktop start|status|stop|exec -- COMMAND [ARGS...]';
async function supervisor(command, home) {
  if (process.platform !== 'linux') throw Error('Dedicated desktops require Linux, Xvfb, Openbox, x11-utils and dbus-run-session.');
  const child = spawn('/usr/bin/python3', [entry, command, stateDirectory(home)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors = (errors + data).slice(-4000); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    if (code !== 0) throw Error(errors || `Desktop ${command} failed.`);
    return JSON.parse(output);
  } finally { clearTimeout(timer); }
}
export const desktopStatus = (home = runtimeHome) => supervisor('status', home);
export async function ensureDesktop(home = runtimeHome) {
  let status = await desktopStatus(home);
  if (status.alive && status.state === 'ready') return status;
  if (!status.alive) {
    mkdirSync(stateDirectory(home), { recursive: true, mode: 0o700 });
    const log = openSync(join(stateDirectory(home), 'supervisor.log'), 'a', 0o600);
    try {
      const child = spawn('dbus-run-session', ['--', '/usr/bin/python3', entry, 'run', stateDirectory(home)], {
        detached: true, stdio: ['ignore', log, log], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1',
          XDG_CONFIG_HOME: join(stateDirectory(home), 'config'), XDG_CACHE_HOME: join(stateDirectory(home), 'cache'), QT_LINUX_ACCESSIBILITY_ALWAYS_ON: '1' },
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    } finally { closeSync(log); }
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    status = await desktopStatus(home);
    if (status.alive && status.state === 'ready') return status;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw Error(`Dedicated desktop did not become ready. Inspect ${join(stateDirectory(home), 'supervisor.log')}`);
}
export async function desktopMain(argv, { home = runtimeHome } = {}) {
  const [command, ...rest] = argv;
  if (['--help', '-h', undefined].includes(command)) { console.log(DESKTOP_USAGE); return 0; }
  if (command === 'status') { console.log(JSON.stringify(await desktopStatus(home), null, 2)); return 0; }
  if (command === 'start') { const state = await ensureDesktop(home); console.log(`Dedicated desktop ready on ${state.display}; generation ${state.generation}`); return 0; }
  if (command === 'stop') {
    await supervisor('stop', home);
    const deadline = Date.now() + 10000;
    while ((await desktopStatus(home)).alive && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if ((await desktopStatus(home)).alive) throw Error('Dedicated desktop has not stopped. Inspect its supervisor log.');
    console.log('Dedicated desktop stopped.'); return 0;
  }
  if (command === 'exec' && rest[0] === '--' && rest[1]) {
    const state = await ensureDesktop(home);
    const child = spawn(rest[1], rest.slice(2), { env: { ...process.env, ...state.env }, stdio: 'inherit' });
    const stop = () => child.kill('SIGTERM'); process.once('SIGTERM', stop);
    try { return (await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); })) ?? 1; }
    finally { process.removeListener('SIGTERM', stop); }
  }
  throw Error(DESKTOP_USAGE);
}
