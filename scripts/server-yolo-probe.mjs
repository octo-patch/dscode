import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { callDscode } from '../plugins/local-carrier/client.mjs';

export const name = 'server-yolo-probe';
export const inject = ['agents', 'agentPresets', 'llm', 'sessions', 'tools', 'approval', 'permissionPresets', 'sandboxPolicy'];
export function apply(ctx) { void probe(ctx).catch(error => { console.error(error.stack); ctx.get('appExit')(1); }); }

async function probe(ctx) {
  await ctx.get('loader').await();
  const home = process.env.DSCODE_YOLO_PROBE_HOME, mode = process.env.DSCODE_YOLO_PROBE_MODE;
  const cwd = join(home, 'workspace'), id = 'yolo-resume-fixture';
  let action;
  const childWrites = new Set();
  const requests = [];
  const toolResults = [];
  ctx.on('tools/result', (event, result) => toolResults.push({ session: event.agent?.session.id, name: event.name, result }));
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 } }; }
    async *stream(options) {
      requests.push(JSON.stringify(options.messages));
      let next = options.sessionId === id ? action : undefined;
      if (options.sessionId === id) action = undefined;
      if (mode === 'yolo' && options.sessionId !== id && options.sessionId !== 'yolo-fresh-fixture' && !childWrites.has(options.sessionId)) {
        childWrites.add(options.sessionId);
        next = { name: 'write', args: { file_path: join(home, `child-${options.sessionId}.txt`), content: 'child write outside workspace' } };
      }
      const block = next ? { type: 'tool-call', id: randomUUID(), name: next.name, arguments: JSON.stringify(next.args) } : { type: 'text', text: 'YOLO fixture complete.' };
      yield { type: 'block-start', index: 0, blockType: block.type };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: next ? 'tool-calls' : 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['yolo-fixture'], new Adapter());
  const setup = async (scope, agent) => {
    await ctx.agentPresets.mount(scope, 'dscode');
    installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined });
  };
  const create = sessionId => ctx.agents.create({ sessionId, meta: { cwd, agentPreset: 'dscode' }, agentOptions: { provider: 'yolo-fixture', model: 'fixture' }, setup });
  const handle = mode === 'prepare' ? await create(id) : await ctx.agents.resume({ resumeSessionId: id, setup });
  const agent = handle.agent;
  const ask = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
  const run = async (name, args) => {
    const seq = agent.session.seq;
    action = { name, args }; agent.followup(ask('Run the local YOLO verification action.')); await agent.whenIdle();
    const results = agent.session.snapshotEvents().filter(event => event.seq >= seq && event.type === 'tool/result');
    assert(results.length > 0, JSON.stringify(agent.session.snapshotEvents().slice(-8)));
    for (const event of results) assert.equal(event.data.message.isError, false, JSON.stringify(event));
  };
  if (mode === 'prepare') {
    setSandboxMode(agent.session, 'read-only'); setApprovalPolicy(agent.session, 'never');
    agent.followup(ask('Record the original restricted session.')); await agent.whenIdle();
    writeFileSync(join(home, 'original-permissions.json'), JSON.stringify(permissionEvents(agent)));
  } else if (mode === 'restore') {
    assert.equal(ctx.sandboxPolicy.resolve({ session: agent.session }).mode, 'read-only');
    assert.equal(ctx.approval.effectivePolicy(agent.session), 'never');
    assert.equal(ctx.approval.serverYolo, undefined);
    assert.deepEqual(permissionEvents(agent), JSON.parse(readFileSync(join(home, 'original-permissions.json'), 'utf8')));
    const fresh = await ctx.agents.resume({ resumeSessionId: 'yolo-fresh-fixture', setup });
    assert.notEqual(ctx.sandboxPolicy.resolve({ session: fresh.agent.session }).mode, 'danger-full-access');
    await fresh.dispose();
    for (const childId of JSON.parse(readFileSync(join(home, 'children.json'), 'utf8'))) {
      const child = await ctx.agents.resume({ resumeSessionId: childId, setup });
      assert.equal(ctx.sandboxPolicy.resolve({ session: child.agent.session }).mode, 'read-only');
      assert.equal(ctx.approval.effectivePolicy(child.agent.session), 'never');
      await child.dispose();
    }
  } else {
    assert.equal(mode, 'yolo');
    assert.equal(ctx.sandboxPolicy.resolve({ session: agent.session }).mode, 'danger-full-access');
    assert.equal(ctx.approval.effectivePolicy(agent.session), 'ask');
    assert.equal(ctx.permissionPresets.current(agent.session), 'server-yolo');
    assert(!Object.hasOwn(ctx.permissionPresets.presets, 'server-yolo'));
    assert.deepEqual(ctx.permissionPresets.catalog().options.map(row => row.value), ['server-yolo']);
    const target = { url: `http://127.0.0.1:${process.env.DSCODE_YOLO_PROBE_PORT}`, token: 'yolo-fixture-private-token' };
    assert.equal((await callDscode(target, 'host/status', {})).yolo, true);
    await assert.rejects(callDscode({ ...target, token: 'wrong-token' }, 'host/status', {}), error => error.code === 'dscode/unauthorized');
    const outside = join(home, 'outside.txt');
    await run('write', { file_path: outside, content: 'outside workspace\n' });
    await run('bash', { command: `printf 'shell-ok' > '${join(home, 'shell.txt')}'` });
    assert.equal(readFileSync(outside, 'utf8'), 'outside workspace\n');
    assert.equal(readFileSync(join(home, 'shell.txt'), 'utf8'), 'shell-ok');
    for (const name of ['subagent', 'subagent_fork']) {
      await run(name, { name: name === 'subagent' ? 'spawned' : 'forked', description: 'Verify YOLO inheritance', prompt: 'Run the fixture file write.', run_in_background: false });
      // rc.3 returns at activation acceptance, before the child's turn finishes.
      const childId = toolResults.findLast(row => row.name === name).result.value.subagentId;
      const child = ctx.agents.get(childId);
      assert(child);
      await child.whenIdle();
      const written = toolResults.find(row => row.session === childId && row.name === 'write');
      assert(written && !written.result.isError, JSON.stringify(toolResults));
      assert.equal(ctx.approval.effectivePolicy(child.session), 'ask');
      await ctx.sessions.flush(child.session);
    }
    assert.equal(childWrites.size, 2, JSON.stringify(toolResults));
    for (const childId of childWrites) {
      try { assert.equal(readFileSync(join(home, `child-${childId}.txt`), 'utf8'), 'child write outside workspace'); }
      catch (error) { throw Error(`${error.message}\nTool results: ${JSON.stringify(toolResults)}`, { cause: error }); }
    }
    writeFileSync(join(home, 'children.json'), JSON.stringify([...childWrites]));
    assert(requests.some(request => request.includes('explicitly started with dscode server --yolo')));
    let humanCalls = 0;
    ctx.on('approval/request', () => { humanCalls++; return 'rejected'; }, { prepend: true });
    // Real upstream sensitive-action manager, with a synthetic app/action: no
    // native UI input is sent by this verification.
    const upstream = new URL('./confirmations.js', import.meta.resolve('@anionex/dsh-computer-use'));
    const { ComputerConfirmationManager } = await import(upstream.href);
    const manager = new ComputerConfirmationManager(ctx, () => ({ confirmationTtlMs: 300000 }));
    const app = { bundleId: 'test.yolo.fixture', pid: 123, name: 'Fixture' };
    const proposed = { kind: 'click', observationId: 'fixture-observation', sensitive: true };
    let confirmed = false;
    ctx.on('agent/pre-step', async (event, next) => {
      if (event.agent === agent && !confirmed) {
        confirmed = true;
        const token = await manager.confirm(agent, app, { reason: 'Fixture action', target: 'Fixture', action: proposed }, 'fixture-confirm', new AbortController().signal);
        manager.consume(agent, app, { ...proposed, confirmationToken: token.token });
        assert.throws(() => manager.consume(agent, app, { ...proposed, confirmationToken: token.token }), /already consumed/);
        assert.equal(await ctx.approval.request({ agent, toolName: 'cancelled-fixture', signal: AbortSignal.abort() }), 'cancelled');
      }
      return next();
    });
    agent.followup(ask('Verify automatic desktop confirmation.')); await agent.whenIdle();
    assert(confirmed); assert.equal(humanCalls, 0);
    const decisions = agent.session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data.outcome);
    assert(decisions.includes('allowed-once')); assert(decisions.includes('cancelled'));
    const computer = ctx.get('computerUse');
    assert(computer, 'Computer Use service must be mounted');
    assert.equal(computer.config.allowAllApps, true);
    assert.equal(await computer.leases.ensure(agent, app, 'control', 'fixture-control'), 'configured');
    const fresh = await create('yolo-fresh-fixture');
    setApprovalPolicy(fresh.agent.session, 'never'); // Same pin applied to delegated agents.
    assert.equal(ctx.approval.effectivePolicy(fresh.agent.session), 'ask');
    assert.equal(ctx.sandboxPolicy.resolve({ session: fresh.agent.session }).mode, 'danger-full-access');
    ctx.permissionPresets.set(fresh.agent.session, 'server-yolo');
    fresh.agent.followup(ask('Persist a session created on the YOLO server.')); await fresh.agent.whenIdle();
    assert(!permissionEvents(fresh.agent).some(event => JSON.stringify(event).includes('server-yolo')));
    await ctx.sessions.flush(fresh.agent.session); await fresh.dispose();
  }
  await ctx.sessions.flush(agent.session); await handle.dispose();
  console.log(`SERVER_YOLO_${mode.toUpperCase()}: passed`);
  ctx.get('appExit')(0);
}

const permissionEvents = agent => agent.session.snapshotEvents().filter(event => ['permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type));
