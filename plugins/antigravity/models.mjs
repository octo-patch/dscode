import { LlmError } from '@deepseek-ai/dsh-llm';

export const PROVIDER = 'antigravity';
const positive = n => Number.isSafeInteger(n) && n > 0;
// Conservative fallback catalog from pi-antigravity d59d22b. Runtime discovery
// narrows these routes to the variants actually advertised by the account.
const flash = (version, enums) => ({ id: `gemini-${version}-flash`, name: `Gemini ${version} Flash`, contextWindow: 1048576, maxTokens: 65536,
  routes: Object.fromEntries(['low', 'medium', 'high'].map((effort, i) => [effort, { id: `gemini-${version}-flash-${effort}`, modelEnum: `MODEL_PLACEHOLDER_M${enums[i]}` }])) });
export const FALLBACK_MODELS = [flash('3.8', [320, 319, 318]), flash('3.7', [300, 299, 298]), flash('3.6', [73, 72, 71]),
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', contextWindow: 1048576, maxTokens: 65536,
    routes: { low: { id: 'gemini-3.5-flash-extra-low', modelEnum: 'MODEL_PLACEHOLDER_M187' }, medium: { id: 'gemini-3.5-flash-low', modelEnum: 'MODEL_PLACEHOLDER_M20' }, high: { id: 'gemini-3-flash-agent', modelEnum: 'MODEL_PLACEHOLDER_M84' } } },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', contextWindow: 1048576, maxTokens: 65535,
    routes: { low: { id: 'gemini-3.1-pro-low', modelEnum: 'MODEL_PLACEHOLDER_M36' }, high: { id: 'gemini-pro-agent', modelEnum: 'MODEL_PLACEHOLDER_M16' } } },
];

export function parseModels(data) {
  if (!data?.models || typeof data.models !== 'object' || Array.isArray(data.models)) throw new LlmError('Antigravity returned an invalid model catalog', 'MALFORMED_RESPONSE');
  const models = new Map();
  for (const [runtime, info] of Object.entries(data.models)) {
    if (!/^gemini-[a-z0-9.-]+$/.test(runtime) || /image|embedding|audio|tts|live|tab|chat|tiered/i.test(runtime) || runtime === 'gemini-3.1-pro-high' || !info || typeof info !== 'object') continue;
    const known = FALLBACK_MODELS.find(m => Object.values(m.routes).some(r => r.id === runtime));
    const suffix = runtime.match(/-(low|medium|high)$/)?.[1];
    const effort = known ? Object.entries(known.routes).find(([, r]) => r.id === runtime)[0] : suffix;
    const id = known?.id ?? (suffix ? runtime.slice(0, -suffix.length - 1) : runtime);
    const entry = models.get(id) ?? { id, name: known?.name ?? id, contextWindow: known?.contextWindow ?? 128000, maxTokens: known?.maxTokens ?? 8192, inputModalities: ['text', 'image'], routes: {} };
    if (info.supportsImages === false) entry.inputModalities = ['text'];
    if (positive(info.inputTokenLimit)) entry.contextWindow = info.inputTokenLimit;
    if (positive(info.maxOutputTokens)) entry.maxTokens = info.maxOutputTokens;
    else if (positive(info.outputTokenLimit)) entry.maxTokens = info.outputTokenLimit;
    entry.routes[effort ?? 'default'] = { id: runtime,
      ...(typeof info.model === 'string' ? { modelEnum: info.model } : {}),
      ...(info.quotaInfo && typeof info.quotaInfo === 'object' ? { quota: info.quotaInfo } : {}) };
    models.set(id, entry);
  }
  return [...models.values()];
}

export class AntigravityModels {
  constructor(session, client) { this.session = session; this.client = client; this.clear(); }
  clear() { this.entries = FALLBACK_MODELS; this.key = undefined; this.checked = 0; this.generation = (this.generation ?? 0) + 1; this.pending = undefined; this.error = undefined; this.discovered = false; }
  async list(force = false) {
    const grant = await this.session.current();
    if (!grant) { if (this.key) this.clear(); return this.entries; }
    const key = grant.projectId + ':' + grant.refresh;
    if (this.key !== key) { this.clear(); this.key = key; }
    if (!force && Date.now() - this.checked < 300000) return this.entries;
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.pending = (async () => {
      try {
        const models = parseModels(await this.client.models(await this.session.auth()));
        if (generation === this.generation) { this.entries = models; this.discovered = true; this.error = undefined; }
      } catch (error) {
        if (generation === this.generation) this.error = error instanceof LlmError ? error.message : 'Antigravity model discovery failed';
      } finally {
        if (generation === this.generation) { this.checked = Date.now(); this.pending = undefined; }
      }
      return this.entries;
    })();
    return this.pending;
  }
  async get(id) {
    const model = (await this.list()).find(m => m.id === id);
    if (!model) throw new LlmError('This Gemini model is not in the Antigravity catalog; refresh with /antigravity models', 'MODEL_NOT_FOUND');
    return model;
  }
}

export function modelRoute(model, effort) {
  const chosen = effort ?? (model.routes.low ? 'low' : Object.keys(model.routes)[0]);
  const route = model.routes[chosen];
  if (!route) throw new LlmError('This Antigravity model does not offer that reasoning effort', 'UNSUPPORTED_REASONING_EFFORT');
  return { ...route, effort: chosen };
}
export function thinkingConfig(route) {
  if (route.effort === 'default') return undefined;
  const pro = route.id === 'gemini-pro-agent' || route.id.startsWith('gemini-3.1-pro');
  const olderFlash = route.id.startsWith('gemini-3.5-flash') || route.id === 'gemini-3-flash-agent';
  return { includeThoughts: true, thinkingBudget: pro ? (route.effort === 'high' ? 10001 : 1001) : route.effort === 'high' ? (olderFlash ? 10000 : -1) : route.effort === 'medium' ? 4000 : 1000 };
}
