import { resolveSpeed } from './models.mjs';
let source;
export function setSpeedSource(next) { source = next; return () => { if (source === next) source = undefined; }; }
export function speedLabel(sessionId, modelLabel) { return source?.(sessionId, modelLabel) ?? ''; }
// Reuse the native command lifecycle, which the persisted session vocabulary
// understands. Failed commands and status-only queries never select a tier.
function selection(events) {
  const runs = new Map(); let selected;
  for (const event of events) {
    if (event.type === 'command/run' && event.data.name === 'speed') {
      const tier = event.data.args?.trim();
      if (['standard','default','fast','priority','ultrafast'].includes(tier)) runs.set(event.data.commandId, tier === 'standard' ? 'default' : tier);
    } else if (event.type === 'command/done' && event.data.kind === 'success' && runs.has(event.data.commandId)) {
      selected = { tier: runs.get(event.data.commandId), seq: event.seq };
    }
  }
  return selected;
}
export function selectedSpeed(session, fallback = 'default') {
  return selection(session?.snapshotEvents() ?? [])?.tier ?? fallback;
}
export const canonicalSpeed = tier => tier === 'priority' ? 'fast' : tier;
export function speedState(session, model, fallback = 'default') {
  const events = session?.snapshotEvents() ?? [], selected = selection(events);
  const requested = selected?.tier ?? fallback;
  const used = events.findLast(e => e.type === 'assistant/message' && !e.data.interrupted
    && e.data.message?.source?.provider === 'openai' && e.data.message.source.model === model
    && e.data.message.source.replayState?.response?.kind === 'dscode-openai');
  const replay = used?.data.message.source.replayState.response;
  return { requested, actual: used && (!selected || used.seq > selected.seq) && canonicalSpeed(replay.requestedTier) === canonicalSpeed(requested) ? replay.actualTier : undefined };
}
export function speedCommand(service) {
  return { name: 'speed', description: 'OpenAI service speed, independent of reasoning effort', input: { hint: '[standard|fast|ultrafast]' }, handler: async ({ agent, rawInput }) => {
    const route = agent.session.requestHeader()?.config ?? agent.options;
    if (route.provider !== 'openai') return { kind: 'error', text: '/speed currently applies to /provider openai.' };
    try {
      const model = await service.models.get(route.model);
      const requested = String(rawInput ?? '').trim();
      if (!requested) {
        const state = speedState(agent.session, route.model, service.options().serviceTier);
        return { kind: 'success', text: `Speed requested: ${state.requested}; last confirmed: ${state.actual ?? 'not yet confirmed'}. Available: ${model.tiers.map(t => t.name).join(', ')}. Fast and Ultrafast consume more usage.` };
      }
      if (agent.status === 'running') return { kind: 'error', text: 'Stop the current turn before changing speed.' };
      const tier = resolveSpeed(model, requested);
      return { kind: 'success', text: `OpenAI speed: ${canonicalSpeed(tier)}. This selection is saved for this session. Higher speeds consume more usage; /effort remains independent.` };
    } catch (error) { return { kind: 'error', text: error.code ? error.message : 'Could not change OpenAI speed.' }; }
  } };
}
