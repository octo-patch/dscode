#!/usr/bin/env node
import { main, manifest, runtimeHome } from '../scripts/harness.mjs';
import { CLIENT_COMMANDS, runClient } from '../plugins/session-bridge/client.mjs';
import { runEmailClient } from '../plugins/email/cli.mjs';
import { runDoctorCli } from '../scripts/doctor-cli.mjs';
import { selfUpdate } from '../scripts/self-update.mjs';
import { runExec } from '../scripts/exec.mjs';
import { runTriggerCli } from '../scripts/trigger.mjs';
import { runAcp } from '../scripts/acp.mjs';

const args = process.argv.slice(2);
// Once a session starts the DSH CLI owns `--version`, so DSCODE answers it here instead.
if (args[0] === '--version' || args[0] === '-v') console.log(manifest.version);
else if (args[0] === 'host') import('../scripts/host.mjs').then(host => host.main(args.slice(1))).catch(error => { console.error(error.message); process.exitCode = 1; });
// Remote runtimes (docs/remote-runtime.md): serve this machine, record a server, attach to one.
else if (args[0] === 'server') import('../scripts/host.mjs').then(async host => { process.exitCode = await host.server(args.slice(1)); }).catch(error => { console.error(error.message); process.exitCode = 1; });
else if (args[0] === 'desktop') import('../scripts/desktop-session.mjs').then(async desktop => { process.exitCode = await desktop.desktopMain(args.slice(1)); }).catch(error => { console.error(error.message); process.exitCode = 1; });
else if (args[0] === 'config') import('../scripts/runtimes.mjs').then(runtimes => runtimes.configMain(args.slice(1), { home: runtimeHome, version: manifest.version })).catch(error => { console.error(error.message); process.exitCode = 1; });
else if (args[0] === 'runtime' && (['--help', '-h'].includes(args[1]) || (['status', 'doctor'].includes(args[1]) && ['--help', '-h'].includes(args[2])))) import('../scripts/runtimes.mjs').then(runtimes => console.log(runtimes.RUNTIME_USAGE)).catch(error => { console.error(error.message); process.exitCode = 1; });
else if (args[0] === 'runtime' && ['status', 'doctor'].includes(args[1]) && args[2] !== undefined && !args[2].startsWith('-')) import('../scripts/runtimes.mjs').then(async runtimes => { process.exitCode = await runtimes.runtimeInspect(args.slice(1), { home: runtimeHome, version: manifest.version }); }).catch(error => { console.error(error.message); process.exitCode = 1; });
else if (args[0] === 'runtime' && (args[1] === undefined || args[1].startsWith('-'))) import('../scripts/runtimes.mjs').then(runtimes => console.log(runtimes.listing(runtimes.readRuntimes(runtimeHome)))).catch(error => { console.error(error.message); process.exitCode = 1; });
else if (args[0] === 'runtime') main(['start', ...args.slice(2)], process.cwd(), { runtime: args[1] }).catch(error => { console.error(error.message); process.exitCode = 1; });
else if (args[0] === 'acp') runAcp(args.slice(1)).then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });
else {
  if (args[0] === 'resume') {
    args.shift();
    const id = args[0] && !args[0].startsWith('-') ? args.shift() : undefined;
    args.unshift(...(id ? ['--resume', id] : ['--continue']));
  }
  (args[0] === 'exec' ? runExec(args.slice(1)).then(code => { process.exitCode = code; }) : args[0] === 'trigger' ? runTriggerCli(args.slice(1)).then(code => { process.exitCode = code; }) : args[0] === 'doctor' ? (args.length <= 2 && (!args[1] || ['--local', '--preview'].includes(args[1])) ? runDoctorCli(runtimeHome, args[1]?.slice(2) ?? 'analyze') : Promise.reject(Error('Usage: dscode doctor [--local|--preview]'))) : args[0] === 'email' ? runEmailClient(args.slice(1)) : args[0] === 'update' ? selfUpdate(args.slice(1)) : CLIENT_COMMANDS.includes(args[0]) ? runClient(args, runtimeHome) : main(['start', ...args], process.cwd())).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
