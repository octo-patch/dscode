import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';

export const inject = ['agents', 'agentPresets', 'llm', 'tools', 'sessions', 'commands', 'approval'];
export function apply(ctx) { void probe(ctx).catch(error => { console.error(error.stack); ctx.get('appExit')(1); }); }
async function probe(ctx) {
  await ctx.get('loader').await();
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 } }; }
    async *stream() { yield { type: 'finish', reason: { kind: 'stop' } }; }
  }
  ctx.llm.registerAdapter(['linux-fixture'], new Adapter());
  const handle = await ctx.agents.create({ sessionId: 'linux-computer-fixture', meta: { cwd: join(process.env.DSCODE_LINUX_FIXTURE_HOME, 'workspace'), agentPreset: 'dscode' },
    agentOptions: { provider: 'linux-fixture', model: 'fixture' }, setup: async (scope, agent) => {
      await ctx.agentPresets.mount(scope, 'dscode');
      installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined });
    } });
  const agent = handle.agent;
  const invoke = (name, args = {}) => ctx.tools.execute({ name, arguments: args, agent, callId: randomUUID(), signal: AbortSignal.timeout(20000) });
  const ok = async (name, args) => { const result = await invoke(name, args); assert(!result.isError, JSON.stringify(result)); return result.value; };
  try {
    const status = await ok('computer_status'); assert.equal(status.platform, 'linux'); assert(status.ready);
    assert((await ok('computer_use_activate')).activated);
    const apps = await ok('computer_list_apps'); assert(Array.isArray(apps));
    const app = { pid: Number(process.env.DSCODE_LINUX_FIXTURE_PID) }; assert(apps.some(row => row.pid === app.pid));
    setApprovalPolicy(agent.session, 'never');
    const denied = await invoke('computer_observe', { app }); assert(denied.isError, 'unconfigured app must be denied');
    const service = ctx.get('computerUse');
    service.config = { ...service.config, allowAllApps: true }; // Fixture only, exercises the same all-app setting as server YOLO.
    const first = await ok('computer_observe', { app, full: true });
    assert.equal(first.elementsMode, 'full'); assert.equal(first.screenshot, undefined);
    assert(!JSON.stringify(first).includes('fixture-secret-must-not-appear'));
    const unchanged = await ok('computer_observe', { app });
    assert.equal(unchanged.elementsMode, 'diff'); assert.equal(unchanged.baseObservationId, first.observationId); assert.equal(unchanged.elements.length, 0);
    const entry = first.elements.find(row => row.title === 'Fixture input'); assert(entry);
    const scoped = await ok('computer_observe', { app, scope: { rootObservationId: first.observationId, rootElementIndex: entry.index, maxDepth: 0 } });
    assert.equal(scoped.elements.length, 1); assert(scoped.metrics.visitedNodes < first.metrics.visitedNodes);
    const found = await ok('computer_observe', { app, scope: { name: 'Fixture input', limit: 1 } });
    assert.equal(found.elements.length, 1); assert.equal(found.elements[0].title, 'Fixture input');
    assert.equal(found.elementsMode, 'full', 'changing observation scope must reset the diff baseline');
    const edited = await ok('computer_set_value', { observationId: unchanged.observationId, elementIndex: entry.index, value: 'Host 中文 ✓' });
    assert(edited.observation); assert.match(JSON.stringify(edited), /Host 中文 ✓/);
    const stale = await invoke('computer_set_value', { observationId: first.observationId, elementIndex: entry.index, value: 'stale' });
    assert(stale.isError, 'changed observation must not admit input');
    const current = await ok('computer_observe', { app, full: true, screenshot: 'required' });
    assert(current.screenshot); assert.equal(statSync(current.screenshot.path).mode & 0o777, 0o600);
    assert.equal(readFileSync(current.screenshot.path).subarray(1, 4).toString(), 'PNG');
    const button = current.elements.find(row => row.title === 'Apply fixture'); assert(button);
    const clicked = await ok('computer_click', { observationId: current.observationId, elementIndex: button.index });
    assert.equal(clicked.observation.screenshot, undefined, 'actions must not repeat explicit screenshot capture');
    const final = await ok('computer_observe', { app, full: true }); assert.match(JSON.stringify(final), /Applied: Host 中文 ✓/);
    const delayed = final.elements.find(row => row.title === 'Delayed fixture');
    const verified = await ok('computer_click', { observationId: final.observationId, elementIndex: delayed.index,
      expect: { name: 'Delayed complete', exists: true }, timeoutMs: 3000 });
    assert.equal(verified.verification.status, 'satisfied');
    const timeout = await ok('computer_wait_for', { app, condition: { name: 'Never appears' }, timeoutMs: 100 });
    assert.equal(timeout.verification.status, 'timeout');
    await ok('computer_control', { operation: 'acquire', ttlMs: 5000 });
    assert((await ok('computer_status')).capabilities.control.owned);
    await ok('computer_control', { operation: 'release' });
    service.backend.client.stop(service.backend.client.child);
    const oldButton = final.elements.find(row => row.title === 'Apply fixture');
    const rebound = await invoke('computer_click', { observationId: final.observationId, targetHandle: oldButton.targetHandle, allowRebind: true });
    assert(rebound.isError, 'target rebinding must not bypass helper restart invalidation');
    assert.match(JSON.stringify(rebound), /restarted|STALE/);
    const command = await ctx.commands.execute(agent, '/computer status', [], AbortSignal.timeout(10000)); assert.equal(command.result.kind, 'success');
    console.log('LINUX_COMPUTER_HOST: ' + JSON.stringify({ activated: true, appList: true, deniedBeforeGrant: true, unicodeEdit: true, deltaRows: unchanged.elements.length,
      fullRows: first.elements.length, fullBytes: Buffer.byteLength(JSON.stringify(first)), deltaBytes: Buffer.byteLength(JSON.stringify(unchanged)),
      staleRejected: true, restartedHandleRejected: true, screenshot: true, atspiClick: true, noImplicitRecapture: true,
      scopedReads: true, verifiedPostcondition: true, conditionTimeout: true, desktopLease: true }));
  } finally { await handle.dispose(); }
  ctx.get('appExit')(0);
}
