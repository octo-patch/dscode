import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as Instructions from '@deepseek-ai/dsh-agent-instructions';
import * as FilesystemSkills from '@deepseek-ai/dsh-skill-filesystem';
import { ancestorSkillDirs, writeWorkspaceInstructions } from '../tui-tools/workspace-discovery.mjs';
import { writeHookConfig } from '../tui-tools/hook-sources.mjs';
import { mountWorkspaceHooks } from './hooks.mjs';

export const name = 'dscode-desktop-workspace';
export const inject = ['agents', 'agentPresets', 'skills', 'sessionProjections', 'shell'];

/**
 * Session-owned discovery; Desktop's process cwd is not a workspace identity.
 * Each DSCODE session mounts its folder's instructions, ancestor skill roots
 * and hooks as one unit, which `dscodeSessionWorkspace.reload` rebuilds from
 * the current files (/reload).
 */
export function apply(ctx) {
  const stateDir = resolveDshHome();
  mkdirSync(join(stateDir, 'config'), { recursive: true });
  const installationHooks = join(stateDir, 'config/hooks.local.json');
  if (!existsSync(installationHooks)) writeFileSync(installationHooks, '{"hooks":{}}\n', { mode: 0o600, flag: 'wx' });
  const mounted = new WeakMap();

  /** Mount (or remount) one agent's workspace; SessionStart runs only with a creation payload. */
  const mount = async (agent, creation) => {
    const cwd = agent.session.header.cwd;
    if (!cwd) throw Error('DSCODE Desktop sessions require a workspace directory');
    const home = homedir();
    const key = createHash('sha256').update(JSON.stringify([agent.session.id, resolve(cwd)])).digest('hex');
    const directory = join(stateDir, 'desktop-workspaces', key);
    const outputDir = join(directory, 'instructions');
    const instructionHome = writeWorkspaceInstructions({ cwd, home, stateDir, outputDir }) ?? stateDir;
    const skillDirs = ancestorSkillDirs({ cwd, home });
    const hooks = writeHookConfig({ root: stateDir, cwd, home: directory });
    // A scope admits one filesystem skill provider, so the old mount leaves first.
    // /reload runs only while every agent is idle, so no turn sees the gap.
    const previous = mounted.get(agent);
    await previous?.fiber.dispose();
    const fiber = agent.ctx.plugin({
      name: 'dscode-session-workspace',
      async apply(scope) {
        await scope.plugin(Instructions, { dshHome: instructionHome, maxBytes: 65536 });
        await scope.plugin(FilesystemSkills, { customSkillDirs: skillDirs });
        await mountWorkspaceHooks(scope, hooks.path, creation);
      },
    });
    mounted.set(agent, { fiber, skillDirs });
    await fiber;
    if (previous === undefined) agent.ctx.effect(() => () => rmSync(directory, { recursive: true, force: true }));
    return { skillDirs };
  };

  ctx.on('agent/created', async payload => {
    const { agent } = payload;
    if (ctx.agentPresets.composedPreset(agent.ctx) !== 'dscode') return;
    await mount(agent, payload);
  });

  ctx.provide('dscodeSessionWorkspace', {
    /** Whether this agent's workspace is mounted here (a DSCODE session on a Host or in Desktop). */
    has: agent => mounted.has(agent),
    /** Re-read the session folder's instructions, ancestor skill roots and hooks. */
    reload: agent => {
      if (!mounted.has(agent)) throw Error('this session has no per-session workspace mount');
      return mount(agent, undefined);
    },
  });
}
