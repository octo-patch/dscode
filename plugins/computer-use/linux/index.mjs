import { Service } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ComputerUseService } from '@anionex/dsh-computer-use/service';
import { readFileSync } from 'node:fs';
import { LinuxBackend } from './backend.mjs';
import { ObservationProjection } from './projection.mjs';
import { checkCondition, validateCondition, validateScope, conditionSchema, scopeSchema } from './conditions.mjs';

// The pinned package exposes the service but not its schema/tool factories.
const upstream = relative => import(new URL(relative, import.meta.resolve('@anionex/dsh-computer-use')));
const { resolveConfig, readComputerUseConfig } = await upstream('./config.js');
const { createComputerUseTools } = await upstream('./tools.js');
export const instructions = readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8');
export const inject = ['approval', 'sessions', 'agents', 'tools', 'skills', 'commands'];
export const name = 'dscode-linux-computer-use';

export class LinuxComputerUseService extends ComputerUseService {
  controls = new WeakMap();
  constructor(ctx, config = {}, backend) {
    const resolved = resolveConfig({ ...readComputerUseConfig(config), interaction: { ...readComputerUseConfig(config).interaction, cursorVisualization: 'hidden' } });
    super(ctx, backend ?? new LinuxBackend(resolved), resolved);
  }
  async [Service.init]() { await this.initialize(); }
  status() { return { ...super.status(), platform: 'linux', capabilities: this.backend.capabilities }; }
  async control(agent, operation, ttlMs = 60000, signal) {
    const old = this.controls.get(agent);
    if (operation === 'release') {
      this.controls.delete(agent);
      if (old) await this.backend.release(old.token);
      return { released: true };
    }
    const lease = await this.backend.acquire(`${process.pid}:${agent.session.id}`, old?.token, ttlMs, signal);
    this.controls.set(agent, lease);
    const { token: _token, ...publicLease } = lease;
    return publicLease;
  }
  releaseAgent(agent) {
    super.releaseAgent(agent);
    const lease = this.controls.get(agent);
    this.controls.delete(agent);
    if (lease) void this.backend.release(lease.token).catch(() => {});
  }
  async actNow(action, context, signal) {
    const stored = this.requireObservation(action.observationId, context.agent);
    // Bind even the upstream target-rebinding reads to the observed helper.
    // A restarted helper cannot make a pre-cancellation handle valid again.
    const held = this.controls.get(context.agent);
    if (action.coordinateSpace === 'stream' && (!stored.backend.screenshot?.streamId || action.streamId !== stored.backend.screenshot.streamId)) throw Error('Stream input needs a screenshot from the referenced observation and its exact streamId.');
    const lease = held ?? await this.backend.acquire(`${process.pid}:${context.agent.session.id}`, undefined, 60000, signal);
    try {
      return await this.backend.withControl(lease.token, () => this.backend.withScope(stored.backend.scope,
        () => this.backend.withInstance(stored.backend.helperInstance, async () => {
          // One immediate post-action read. Explicit conditions drive subsequent
          // event waits instead of treating arbitrary UI change as success.
          const delegate = Object.assign(Object.create(this), { config: { ...this.config, settleMs: 0, maxSettleMs: 0 } });
          return await ComputerUseService.prototype.actNow.call(delegate, action, context, signal);
        })));
    } finally { if (!held) await this.backend.release(lease.token).catch(() => {}); }
  }
  resolveScope(scope, app, agent) {
    if (!scope) return this.backend.observationScope?.getStore();
    validateScope(scope);
    if ((scope.rootObservationId === undefined) !== (scope.rootElementIndex === undefined)) throw Error('Subtree selection needs rootObservationId and rootElementIndex together.');
    const result = { ...scope };
    if (scope.rootObservationId) {
      const stored = this.requireObservation(scope.rootObservationId, agent);
      if (stored.backend.app.pid !== app.pid || stored.backend.app.bundleId !== app.bundleId) throw Error('Subtree must belong to the same application.');
      const row = stored.backend.elements.find(row => row.index === scope.rootElementIndex);
      if (!row) throw Error('Subtree root is absent from the referenced observation.');
      result.root = { locator: row.locator, title: row.title, role: row.role, helperInstance: stored.backend.helperInstance };
    }
    return result;
  }
  async capture(app, request, context, sourceTool, preObserved) {
    const scope = this.resolveScope(request.scope, app, context.agent);
    const state = this.state(context.agent);
    const previous = state.observations.get(state.latestByApp.get(`${app.bundleId}:${app.pid}`));
    if (JSON.stringify(previous?.backend.scope ?? {}) !== JSON.stringify(scope ?? {})) request = { ...request, full: true };
    const result = await this.backend.withScope(scope, () => super.capture(app, sourceTool === 'computer_action' ? { ...request, screenshot: 'none' } : request, context, sourceTool, preObserved));
    const backend = this.state(context.agent).observations.get(result.observationId)?.backend;
    const captureFrame = backend?.screenshot?.captureFrame;
    if (result.screenshot && captureFrame) result.screenshot = { ...result.screenshot, captureFrame };
    if (result.screenshot && backend?.screenshot?.streamId) result.screenshot = { ...result.screenshot,
      streamId: backend.screenshot.streamId, coordinateFrame: backend.screenshot.coordinateFrame, frameAgeMs: backend.screenshot.frameAgeMs };
    result.scopeId = backend?.scopeId;
    result.metrics = backend?.metrics;
    result.eventEpoch = backend?.eventEpoch;
    return result;
  }
  async waitFor(request, context) {
    validateCondition(request.condition);
    const timeoutMs = request.timeoutMs ?? 10000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000) throw Error('Condition timeout must be between 0 and 30000 ms.');
    const started = Date.now(), deadline = started + timeoutMs;
    let observation, result, reads = 0;
    do {
      context.signal.throwIfAborted();
      observation = await this.observe({ app: request.app, scope: request.scope, screenshot: 'none', full: true }, context);
      reads++;
      result = checkCondition(observation, request.condition);
      if (result.matched || Date.now() >= deadline) break;
      await this.backend.waitChange(observation.eventEpoch, Math.min(1000, deadline - Date.now()), context.signal);
    } while (!result.matched && Date.now() < deadline);
    return { verification: { ...result, status: result.matched ? 'satisfied' : 'timeout', elapsedMs: Date.now() - started, reads }, observation };
  }
}

const output = { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
const outputSpec = { ...output, schema: { type: 'json' } };
const linuxText = value => typeof value === 'string'
  ? value.replaceAll('macOS bundle identifier', 'application identity returned by computer_list_apps').replaceAll('macOS', 'Linux').replaceAll('Quartz', 'X11').replaceAll('target-process', 'foreground-desktop')
  : Array.isArray(value) ? value.map(linuxText)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, linuxText(item)])) : value;

function linuxParameters(value) {
  const result = linuxText(value);
  const extend = node => {
    if (!node || typeof node !== 'object') return;
    if (node.properties?.coordinateSpace) {
      node.properties.coordinateSpace = { type: 'string', enum: ['window', 'screen', 'stream'] };
      node.properties.streamId = { type: 'string' };
    }
    for (const child of Object.values(node)) if (child && typeof child === 'object') extend(child);
  };
  extend(result); return result;
}

export function linuxTools(service) {
  const projection = new ObservationProjection();
  const context = exec => ({ agent: exec.agent, callId: exec.callId, signal: exec.signal, workspace: exec.agent.session.header.cwd ?? process.cwd() });
  const extras = [defineTool({ name: 'computer_wait_for', description: 'Wait for an exact UI postcondition using accessibility events. Timeout does not mean an earlier action failed; never replay an uncertain submit.',
    parameters: { app: { type: 'object', required: true, additionalProperties: false, properties: { pid: { type: 'integer' }, bundleId: { type: 'string' }, name: { type: 'string' } } },
      condition: { ...conditionSchema, required: true }, scope: scopeSchema, timeoutMs: { type: 'integer' } }, output: outputSpec,
    execute: (args, exec) => service.waitFor(args, context(exec)) }),
  defineTool({ name: 'computer_control', description: 'Reserve this desktop for a bounded multi-action sequence or release it. Reads remain available. Manual pause revokes control.',
    parameters: { operation: { type: 'string', enum: ['acquire', 'release'], required: true }, ttlMs: { type: 'integer' } }, output: outputSpec,
    execute: (args, exec) => service.control(exec.agent, args.operation, args.ttlMs, exec.signal) })];
  return [...createComputerUseTools(service), ...extras].map(tool => ({
    ...tool, description: linuxText(tool.description) + (tool.name === 'computer_observe'
      ? ' Linux defaults to screenshot=none. Subsequent observations emit changed elements; use full=true after losing the base observation.' : ''),
    parameters: { ...linuxParameters(tool.parameters), properties: { ...linuxParameters(tool.parameters).properties,
      ...(tool.name === 'computer_observe' ? { scope: scopeSchema } : {}),
      ...(['computer_click', 'computer_drag', 'computer_scroll'].includes(tool.name) ? {
        coordinateSpace: { type: 'string', enum: ['window', 'screen', 'stream'] }, streamId: { type: 'string' },
      } : {}),
      ...(['computer_click', 'computer_set_value', 'computer_type_text', 'computer_press_key', 'computer_scroll', 'computer_drag', 'computer_perform_action'].includes(tool.name)
        ? { expect: conditionSchema, timeoutMs: { type: 'integer' } } : {}),
    } }, output,
    execute: async (args, exec) => {
      // Structure-first: pixel capture is explicit, never a side effect of every
      // tree read. Keep full Service state for stale checks and target rebinding.
      const { expect, timeoutMs, ...actionArgs } = args;
      const actual = tool.name === 'computer_observe' ? { ...args, screenshot: args.screenshot ?? 'none' }
        : expect ? actionArgs : args;
      if (args.expect) {
        validateCondition(args.expect);
        if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000)) throw Error('Condition timeout must be between 0 and 30000 ms.');
      }
      const temporaryLease = expect && !service.controls.has(exec.agent);
      if (temporaryLease) await service.control(exec.agent, 'acquire', 60000, exec.signal);
      let result;
      try {
        const pointerKind = { computer_click: 'click', computer_scroll: 'scroll', computer_drag: 'drag' }[tool.name];
        result = pointerKind && args.coordinateSpace === 'stream'
          ? await service.act({ kind: pointerKind, ...actionArgs }, context(exec))
          : await tool.execute(actual, { ...exec, deferContext: () => {} });
        if (expect && result?.observation) {
          const checked = await service.waitFor({ app: result.observation.app, condition: expect, timeoutMs }, context(exec));
          result = { ...result, ...checked };
        }
      } finally { if (temporaryLease) await service.control(exec.agent, 'release').catch(() => {}); }
      const compact = observation => {
        const value = projection.project(exec.agent, observation, args.full === true);
        if (value.screenshot) value.screenshot = { ...value.screenshot,
          description: 'Inspect with read_image. X11 captureFrame maps image pixels to screen coordinates. A Wayland streamId plus coordinateFrame maps pixels to stream-local logical coordinates; other Portal screenshots are not coordinate-action targets.' };
        return value;
      };
      if (result?.observationId) return compact(result);
      if (result?.observation) return { ...result, observation: compact(result.observation) };
      return result;
    },
  }));
}

export async function apply(ctx, config = {}) {
  await ctx.plugin(LinuxComputerUseService, config);
  const service = ctx.get('computerUse');
  const active = new Map();
  ctx.skills.register({ name: 'computer-use', source: 'runtime', description: 'Linux desktop capability diagnostics, AT-SPI controls and X11/Wayland observations.', content: instructions });
  const activate = async agent => {
    if (!agent) throw Error('Linux Computer Use requires an agent session.');
    const status = await service.health(AbortSignal.timeout(15000));
    if (!status.ready) return { activated: false, status, instructions };
    if (!active.has(agent)) active.set(agent, linuxTools(service).map(tool => agent.ctx.tools.register(tool)));
    return { activated: true, status, instructions };
  };
  ctx.tools.register(defineTool({ name: 'computer_use_activate', description: 'Inspect Linux desktop capabilities and load its operating instructions and tools.', parameters: {}, output: outputSpec,
    execute: (_args, exec) => activate(exec.agent) }));
  ctx.tools.register(defineTool({ name: 'computer_status', description: 'Inspect Linux desktop capabilities without requesting Portal consent or sending input.', parameters: {}, output: outputSpec,
    execute: (_args, exec) => service.health(exec.signal) }));
  ctx.on('tools/result', (exec, result) => {
    if (exec.name === 'skill' && exec.agent && !result.isError && result.value?.name === 'computer-use' && result.value?.content === instructions) return activate(exec.agent);
  });
  ctx.on('agent/disposed', ({ agent }) => { service.releaseAgent(agent); for (const dispose of active.get(agent) ?? []) dispose(); active.delete(agent); });
  ctx.commands.register({ name: 'computer', description: 'Inspect desktop, connect Portal, or pause/resume agent control', input: { hint: '[status|connect|connect-keyboard|pause|resume]' },
    handler: async ({ rawInput, signal }) => {
      try {
        if (!['', 'status', 'connect', 'connect-keyboard', 'pause', 'resume'].includes(rawInput.trim())) throw Error('Usage: /computer [status|connect|connect-keyboard|pause|resume]');
        const result = ['pause', 'resume'].includes(rawInput.trim()) ? await service.backend.pause(rawInput.trim() === 'pause')
          : rawInput.trim().startsWith('connect') ? await service.backend.connectPortal(signal, rawInput.trim() === 'connect') : await service.health(signal ?? AbortSignal.timeout(15000));
        return { kind: 'success', text: JSON.stringify(result, null, 2) };
      } catch (error) { return { kind: 'error', text: error.message }; }
    } });
  ctx.effect(() => () => { for (const disposers of active.values()) for (const dispose of disposers) dispose(); active.clear(); });
}
