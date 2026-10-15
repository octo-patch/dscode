import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import Commands from '@deepseek-ai/dsh-commands';
import { registerStartupCommand } from '../plugins/providers/startup-commands.mjs';
import { watchCommands } from '../packages/tui/src/commands.ts';
import { DscodeRemoteRegistry } from '../packages/tui/src/host/registry.ts';
import { registerCommands } from '../packages/tui/src/host/commands.ts';
import { completionCandidates } from '../packages/tui/src/app.ts';
import { openaiCommand } from '../plugins/openai/command.mjs';
import { speedCommand } from '../plugins/openai/speed.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
// The terminal watches commands through the Host's `commands/watch` stream; a
// registry plus this minimal runtime is the in-process path the runner uses.
function hostView(ctx, agents = new Map()) {
  ctx.provide('agents', { get: id => agents.get(id) });
  const registry = new DscodeRemoteRegistry();
  const disposers = registerCommands(ctx, registry);
  const runtime = { stream: (name, args, signal = new AbortController().signal) => registry.open(name, args, (async function* () {})(), signal) };
  return { view: watchCommands(runtime), dispose: () => { for (const dispose of disposers) dispose(); } };
}
async function until(predicate) {
  for (let i = 0; i < 200 && !predicate(); i++) await tick();
  assert(predicate(), 'condition not reached');
}

test('OpenAI commands complete before the first Agent, retain input hints, and switch to the native catalog', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(Commands);
    let invoked = false;
    registerStartupCommand(ctx, openaiCommand({ status: () => { invoked = true; } }));
    registerStartupCommand(ctx, speedCommand({}));
    const agent = {};
    const { view, dispose } = hostView(ctx, new Map([['session-1', agent]]));
    await until(() => view.descriptors.length > 0);
    const rows = completionCandidates('/ope', view.descriptors, []);
    assert(rows.some(row => row.label === '/openai' && row.description.includes('login') && row.description.includes('api-key')));
    assert(completionCandidates('/spe', view.descriptors, []).some(row => row.label === '/speed'));
    assert.equal(invoked, false, 'discovery does not execute a command or start a login');
    const expected = JSON.parse(JSON.stringify(ctx.commands.list(agent)));
    view.setSession('session-1');
    await until(() => JSON.stringify(view.descriptors) === JSON.stringify(expected));
    assert.equal(completionCandidates('/openai', view.descriptors, []).filter(row => row.label === '/openai').length, 1);
    view.setSession(undefined);
    await until(() => view.descriptors.some(row => row.name === 'openai'));
    dispose();
  } finally { await ctx.fiber.dispose(); }
});

test('startup discovery follows registration and removal, and stays isolated between Hosts', async () => {
  const ctx = new Context(), other = new Context();
  try {
    await ctx.plugin(Commands); await other.plugin(Commands);
    const mine = hostView(ctx), theirs = hostView(other);
    const view = mine.view, otherView = theirs.view;
    let changes = 0; const stop = view.subscribe(() => changes++);
    const remove = registerStartupCommand(ctx, openaiCommand({}));
    await until(() => view.descriptors.some(row => row.name === 'openai'));
    const afterAdd = changes;
    assert(afterAdd >= 1);
    await tick();
    assert.equal(otherView.descriptors.length, 0);
    remove();
    await until(() => view.descriptors.length === 0);
    assert(changes > afterAdd);
    stop(); mine.dispose(); theirs.dispose();
  } finally { await ctx.fiber.dispose(); await other.fiber.dispose(); }
});
