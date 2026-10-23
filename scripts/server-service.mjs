// User-owned launchd/systemd services. Service files contain paths and ordinary
// environment only; the server reads its existing private token at runtime.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { acquireLock } from '../packages/launcher/locks.mjs';
import { callDscode } from '../plugins/local-carrier/client.mjs';
import { root, runtimeHome } from './harness.mjs';
import { hostStatus, parseServerArgs, serverTokenFile } from './host.mjs';

export const SERVICE_USAGE = [
  'Usage:',
  '  dscode server --port PORT [--bind ADDRESS] [--cwd DIR]  run in the foreground',
  '    [--token TOKEN | --new-token]  choose or rotate the foreground server token',
  '  dscode server install --port PORT [--bind ADDRESS] [--cwd DIR]',
  '  dscode server start',
  '  dscode server stop|restart|uninstall [--force]',
  '  dscode server status [--json]',
  '  dscode server logs [--lines N] [--follow]',
  '  dscode server connect           print the client configuration command (includes token)',
  'Service commands manage this machine and state directory only.',
].join('\n');
export const serviceLabel = home => `ai.dscode.server.${createHash('sha256').update(resolve(home)).digest('hex').slice(0, 12)}`;
export const serviceConfigFile = home => join(home, 'run', 'server-service.json');
export const serviceLogFile = home => join(home, 'run', 'server.log');

const xml = value => String(value).replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char]));
// systemd specifiers are expanded even in quotes; ExecStart also expands dollars.
const unitValue = (value, command = false) => '"' + String(value).replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', () => command ? '$$' : '$') + '"';

export function serviceDefinition(config) {
  const { id, command, environment, cwd, platform, logFile } = config;
  if (platform === 'darwin') return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>', `<key>Label</key><string>${xml(id)}</string>`,
    '<key>ProgramArguments</key><array>', ...command.map(arg => `<string>${xml(arg)}</string>`), '</array>',
    `<key>WorkingDirectory</key><string>${xml(cwd)}</string>`,
    '<key>EnvironmentVariables</key><dict>', ...Object.entries(environment).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`), '</dict>',
    '<key>RunAtLoad</key><true/>', '<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    '<key>ThrottleInterval</key><integer>5</integer>', '<key>ExitTimeOut</key><integer>30</integer>',
    `<key>StandardOutPath</key><string>${xml(logFile)}</string>`, `<key>StandardErrorPath</key><string>${xml(logFile)}</string>`,
    '</dict></plist>', '',
  ].join('\n');
  return [
    '[Unit]', 'Description=DSCODE remote runtime', 'StartLimitIntervalSec=60', 'StartLimitBurst=5', '', '[Service]',
    'Type=exec', `ExecStart=${command.map(arg => unitValue(arg, true)).join(' ')}`, `WorkingDirectory=${unitValue(cwd)}`,
    ...Object.entries(environment).map(([key, value]) => `Environment=${unitValue(`${key}=${value}`)}`),
    'Restart=on-failure', 'RestartSec=5', 'TimeoutStopSec=30', 'KillMode=control-group', 'UMask=0077',
    'StandardOutput=journal', 'StandardError=journal', '', '[Install]', 'WantedBy=default.target', '',
  ].join('\n');
}

export function servicePlan(options, { home = runtimeHome, platform = process.platform, userHome = homedir(), env = process.env, unitDirectory } = {}) {
  if (!['darwin', 'linux'].includes(platform)) throw Error('server services require macOS launchd or Linux systemd');
  const id = serviceLabel(home);
  const directory = unitDirectory ?? (platform === 'darwin' ? join(userHome, 'Library', 'LaunchAgents') : join(env.XDG_CONFIG_HOME || join(userHome, '.config'), 'systemd', 'user'));
  const cwd = options.cwd ?? process.cwd();
  if (!statSync(cwd).isDirectory()) throw Error('--cwd must name an existing directory');
  const launcher = env.DSCODE_CLI_PATH;
  const command = launcher ? [launcher] : [process.execPath, join(root, 'bin/dscode.mjs')];
  command.push('server', '--port', String(options.port), '--bind', options.bind, '--cwd', cwd);
  const environment = { HOME: userHome, PATH: env.PATH ?? '/usr/local/bin:/usr/bin:/bin', DSCODE_HOME: resolve(home), DSCODE_SOURCE_HOME: resolve(home), DSCODE_SERVER_SERVICE_ID: id };
  // Reject line breaks/control characters before generating either manager's syntax.
  for (const value of [...command, ...Object.values(environment), directory]) if (/[\x00-\x1f\x7f]/.test(value)) throw Error('service paths and environment must not contain control characters');
  if (!isAbsolute(directory) || !isAbsolute(command[0])) throw Error('service executable and unit directory must be absolute');
  return { format: 1, id, platform, command, environment, cwd, port: options.port, bind: options.bind,
    servicePath: join(directory, platform === 'darwin' ? `${id}.plist` : `${id}.service`), logFile: serviceLogFile(home) };
}

export function readService(home = runtimeHome) {
  const file = serviceConfigFile(home);
  if (!existsSync(file)) return undefined;
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (config.format !== 1 || config.id !== serviceLabel(home) || !['darwin', 'linux'].includes(config.platform)) throw Error(`invalid service configuration: ${file}`);
  return config;
}

export function runServiceCommand(command, args, { inherit = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const capture = chunk => { output = (output + chunk).slice(-8000); };
    child.stdout?.on('data', capture); child.stderr?.on('data', capture);
    const timer = inherit ? undefined : setTimeout(() => child.kill('SIGTERM'), 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolveRun({ code: code ?? 1, output }); });
  });
}

/** Injectable manager boundary: tests can exercise lifecycle without registering a user service. */
export function serviceManager(config, { exec = runServiceCommand, uid = process.getuid?.() } = {}) {
  const target = `gui/${uid}/${config.id}`;
  const unit = `${config.id}.service`;
  const run = async (command, args, options) => {
    let result;
    try { result = await exec(command, args, options); }
    catch (error) { throw Error(`${command} is unavailable: ${error.message}`, { cause: error }); }
    if (result.code !== 0) throw Error(`${command} ${args.join(' ')} failed: ${result.output || `exit ${result.code}`}`);
    return result;
  };
  const registered = async () => {
    if (config.platform === 'darwin') {
      // A missing GUI domain must not be mistaken for a stopped service.
      await run('launchctl', ['print', `gui/${uid}`]);
      return (await exec('launchctl', ['print', target])).code === 0;
    }
    const result = await exec('systemctl', ['--user', 'show', unit, '--property=ActiveState', '--value']);
    if (result.code !== 0) throw Error(`systemd user manager is unavailable: ${result.output}`);
    return ['active', 'activating', 'reloading', 'deactivating'].includes(result.output.trim());
  };
  return {
    registered,
    async install() { if (config.platform === 'linux') { await run('systemctl', ['--user', 'daemon-reload']); await run('systemctl', ['--user', 'enable', unit]); } },
    async start() {
      if (config.platform === 'darwin') {
        await run('launchctl', ['enable', target]);
        if (await registered()) await run('launchctl', ['kickstart', target]);
        else await run('launchctl', ['bootstrap', `gui/${uid}`, config.servicePath]);
      } else await run('systemctl', ['--user', 'start', unit]);
    },
    async stop() {
      if (config.platform === 'darwin') { if (await registered()) await run('launchctl', ['bootout', target]); }
      else await run('systemctl', ['--user', 'stop', unit]);
    },
    async uninstall() { if (config.platform === 'linux') await run('systemctl', ['--user', 'disable', unit]); },
    async reload() { if (config.platform === 'linux') await run('systemctl', ['--user', 'daemon-reload']); },
    logs(lines, follow) {
      return config.platform === 'darwin' ? run('/usr/bin/tail', ['-n', String(lines), ...(follow ? ['-F'] : []), config.logFile], { inherit: true })
        : run('journalctl', ['--user', '--unit', unit, '--lines', String(lines), '--no-pager', ...(follow ? ['--follow'] : [])], { inherit: true });
    },
  };
}

function assertIdle(status, force) {
  if (!force && status && (status.clients > 0 || status.running > 0)) throw Error('server has attached terminals or running turns; detach/wait, or use --force to interrupt them');
}

export async function readyService(config, { home = runtimeHome, status = hostStatus, timeoutMs = 90000, probe } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = await status(home);
    if (live && live.serviceId === config.id && live.tcp?.port === config.port && live.tcp.bind === config.bind) {
      try {
        const address = ['0.0.0.0', '::'].includes(config.bind) ? (config.bind === '::' ? '[::1]' : '127.0.0.1') : config.bind.includes(':') ? `[${config.bind}]` : config.bind;
        const target = { url: `http://${address}:${config.port}`, token: readFileSync(serverTokenFile(home), 'utf8').trim() };
        const tcp = await (probe ?? ((target) => callDscode(target, 'host/status', {}, AbortSignal.timeout(2000))))(target);
        if (tcp.serviceId === config.id && tcp.pid === live.pid) return tcp;
      } catch { /* local socket readiness alone is insufficient */ }
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 150));
  }
  throw Error('server did not become ready; inspect `dscode server status` and `dscode server logs`');
}

/** Stop only the service for this state directory; a manual Host is never killed here. */
async function stopService(config, manager, { home, status, force, timeoutMs = 30000 }) {
  const live = await status(home);
  if (live && live.serviceId !== config.id) throw Error('another Host owns this state directory; this command will not stop it');
  assertIdle(live, force);
  await manager.stop();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await status(home))?.serviceId !== config.id) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 150));
  }
  throw Error('server did not stop; inspect `dscode server logs`');
}

export async function serverService(argv, options = {}) {
  const { home = runtimeHome, platform = process.platform, status = hostStatus, log = console.log, managerFactory = serviceManager } = options;
  const [command, ...args] = argv;
  if (command === '--help' || command === '-h') { log(SERVICE_USAGE); return 0; }
  if (!['install', 'start', 'stop', 'restart', 'uninstall', 'status', 'logs', 'connect'].includes(command)) throw Error(SERVICE_USAGE);
  if (command !== 'install' && command !== 'logs') {
    const allowed = command === 'status' ? ['--json'] : ['stop', 'restart', 'uninstall'].includes(command) ? ['--force'] : [];
    if (args.some(arg => !allowed.includes(arg))) throw Error(SERVICE_USAGE);
  }
  const config = readService(home);
  if (config && config.platform !== platform) throw Error('installed service belongs to another platform; reinstall it on this machine');
  if (command === 'status') {
    const live = await status(home);
    let managed = false, error;
    try { managed = config ? await managerFactory(config, options).registered() : false; } catch (cause) { error = cause.message; }
    let ready = false;
    if (live?.tcp && (!config || live.serviceId === config.id)) {
      try {
        await readyService(config ?? { id: live.serviceId, ...live.tcp }, { ...options, home, status, timeoutMs: options.timeoutMs ?? 2500 });
        ready = true;
      } catch (cause) { error ??= cause.message; }
    }
    const report = { installed: Boolean(config), manager: config?.platform === 'darwin' ? 'launchd' : config ? 'systemd' : undefined,
      registered: managed, ready, ...(config ? { servicePath: config.servicePath } : {}), ...(live?.tcp ? { runtime: live } : {}), ...(error ? { error } : {}) };
    log(args.includes('--json') ? JSON.stringify(report, null, 2) : [
      `DSCODE server: ${ready ? 'running' : 'stopped or starting'}${config ? ` (${report.manager})` : ' (no installed service)'}`,
      ...(live?.tcp ? [`PID ${live.pid}; ${live.tcp.bind}:${live.tcp.port}; ${live.clients} clients; ${live.running} running turns`] : []),
      ...(config ? [`Service: ${config.servicePath}`] : []), ...(error ? [error] : []),
    ].join('\n'));
    return error ? 1 : ready ? 0 : 3;
  }
  if (command === 'logs') {
    if (!config) throw Error('no installed server service');
    let lines = 100, follow = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--follow') follow = true;
      else if (args[i] === '--lines' && /^\d+$/.test(args[i + 1] ?? '')) lines = Number(args[++i]);
      else throw Error(SERVICE_USAGE);
    }
    if (lines < 1 || lines > 10000) throw Error('--lines must be between 1 and 10000');
    await managerFactory(config, options).logs(lines, follow); return 0;
  }
  if (command === 'connect') {
    const live = await status(home);
    if (!live?.tcp) throw Error('no server is running; start it first');
    const token = readFileSync(serverTokenFile(home), 'utf8').trim();
    const address = ['0.0.0.0', '::'].includes(live.tcp.bind) ? '<server-address>' : live.tcp.bind.includes(':') ? `[${live.tcp.bind}]` : live.tcp.bind;
    log(`dscode config --runtime ${address}:${live.tcp.port} --token ${token} --alias server --set-default`); return 0;
  }
  const unlock = await acquireLock(join(home, 'run', 'server-management'));
  try {
    if (command === 'install') {
      const parsed = parseServerArgs(args);
      if (parsed.help) { log(SERVICE_USAGE); return 0; }
      if (parsed.token !== undefined || parsed.rotate) throw Error('service installation uses the private stored token; do not put tokens in service files');
      const plan = servicePlan(parsed, { ...options, home, platform });
      const previous = readService(home);
      if (previous) {
        if (JSON.stringify(previous) === JSON.stringify(plan)) { log('Server service is already installed. Run `dscode server start`.'); return 0; }
        throw Error('a server service is already installed with different settings; stop and uninstall it before reinstalling');
      }
      if (existsSync(plan.servicePath)) throw Error(`refusing to overwrite an unmanaged service file: ${plan.servicePath}`);
      mkdirSync(dirname(plan.servicePath), { recursive: true });
      mkdirSync(dirname(serviceConfigFile(home)), { recursive: true, mode: 0o700 });
      if (platform === 'darwin') writeFileSync(plan.logFile, '', { flag: 'a', mode: 0o600 });
      writeFileSync(plan.servicePath, serviceDefinition(plan), { flag: 'wx', mode: 0o600 });
      try {
        await managerFactory(plan, options).install();
        const file = serviceConfigFile(home), staged = `${file}.${process.pid}.tmp`;
        writeFileSync(staged, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 }); renameSync(staged, file);
      } catch (error) { rmSync(plan.servicePath, { force: true }); throw error; }
      log(`Installed server service: ${plan.servicePath}\nRun \`dscode server start\` to start it now. It is configured to start at user login.`); return 0;
    }
    const installed = readService(home);
    if (!installed) throw Error('no installed server service; run `dscode server install --port PORT`');
    const manager = managerFactory(installed, options);
    const context = { ...options, home, status, force: args.includes('--force') };
    if (['stop', 'restart', 'uninstall'].includes(command)) await stopService(installed, manager, context);
    if (command === 'uninstall') {
      await manager.uninstall(); rmSync(installed.servicePath, { force: true }); rmSync(serviceConfigFile(home), { force: true }); await manager.reload();
      log('Server service uninstalled; sessions, credentials and logs retained.'); return 0;
    }
    if (command === 'stop') { log('Server service stopped.'); return 0; }
    const live = await status(home);
    if (live && live.serviceId !== installed.id) throw Error('another Host owns this state directory; stop it before starting the server service');
    await manager.start();
    const ready = await readyService(installed, { ...options, home, status });
    log(`Server ready: ${ready.tcp.bind}:${ready.tcp.port}, PID ${ready.pid}\nRun \`dscode server connect\` to print the client configuration command.`); return 0;
  } finally { unlock(); }
}

/** Pause a running managed server before an update; caller resumes after releasing installation gates. */
export async function pauseServerForUpdate(options = {}) {
  const { home = runtimeHome, status = hostStatus, managerFactory = serviceManager } = options;
  const unlock = await acquireLock(join(home, 'run', 'server-management'));
  try {
    const config = readService(home);
    const live = await status(home);
    if (!config || live?.serviceId !== config.id) { unlock(); return undefined; }
    assertIdle(live, false);
    await stopService(config, managerFactory(config, options), { ...options, home, status, force: false });
    return async () => {
      try {
        await managerFactory(config, options).start();
        await readyService(config, { ...options, home, status });
      } finally { unlock(); }
    };
  } catch (error) { unlock(); throw error; }
}
