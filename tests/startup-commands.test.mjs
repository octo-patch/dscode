import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import Commands from '@deepseek-ai/dsh-commands';
import { registerStartupCommand } from '../plugins/providers/startup-commands.mjs';
import { watchCommands } from '../packages/tui/src/commands.ts';
import { completionCandidates } from '../packages/tui/src/app.ts';
import { openaiCommand } from '../plugins/openai/command.mjs';
import { speedCommand } from '../plugins/openai/speed.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('OpenAI commands complete before the first Agent, retain input hints, and switch to the native catalog', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(Commands);
    let invoked = false;
    registerStartupCommand(ctx, openaiCommand({ status: () => { invoked = true; } }));
    registerStartupCommand(ctx, speedCommand({}));
    const view = watchCommands(ctx);
    const rows = completionCandidates('/ope', view.descriptors, []);
    assert(rows.some(row => row.label === '/openai' && row.description.includes('login') && row.description.includes('api-key')));
    assert(completionCandidates('/spe', view.descriptors, []).some(row => row.label === '/speed'));
    assert.equal(invoked, false, 'discovery does not execute a command or start a login');
    const expected = ctx.commands.list({});
    view.setAgent({});
    assert.deepEqual(view.descriptors, expected);
    assert.equal(completionCandidates('/openai', view.descriptors, []).filter(row => row.label === '/openai').length, 1);
    view.setAgent(undefined);
    assert(view.descriptors.some(row => row.name === 'openai'));
  } finally { await ctx.fiber.dispose(); }
});

test('startup discovery follows registration and removal, and stays isolated between Hosts', async () => {
  const ctx = new Context(), other = new Context();
  try {
    await ctx.plugin(Commands); await other.plugin(Commands);
    const view = watchCommands(ctx), otherView = watchCommands(other);
    let changes = 0; const stop = view.subscribe(() => changes++);
    const remove = registerStartupCommand(ctx, openaiCommand({}));
    await tick(); assert.equal(changes, 1); assert(view.descriptors.some(row => row.name === 'openai'));
    assert.equal(otherView.descriptors.length, 0);
    remove(); await tick(); assert.equal(changes, 2); assert.equal(view.descriptors.length, 0);
    stop();
  } finally { await ctx.fiber.dispose(); await other.fiber.dispose(); }
});
