import { LlmError } from '@deepseek-ai/dsh-llm';
import { API, jsonRequest } from './http.mjs';
export const PROVIDER = 'openai';
const speed = id => ({ id, name: id === 'default' ? 'Standard' : id === 'priority' || id === 'fast' ? 'Fast' : id === 'ultrafast' ? 'Ultrafast' : id });
const model = (id, name) => ({ id, name, contextWindow: 1050000, maxTokens: 128000, inputModalities: ['text','image'], efforts: ['low','medium','high','xhigh','max'], defaultEffort: 'medium', tiers: ['default','fast','ultrafast'].map(speed) });
export const FALLBACK_MODELS = [model('gpt-6.1-sol','GPT-6.1 Sol'), model('gpt-6-astra','GPT-6 Astra')];
const positive = n => Number.isSafeInteger(n) && n > 0;
export function parseModels(data) {
  const rows = Array.isArray(data.models) ? data.models : Array.isArray(data.data) ? data.data : undefined;
  if (!rows) throw new LlmError('Invalid OpenAI model catalog', 'MALFORMED_RESPONSE');
  return rows.flatMap(raw => {
    const id = raw.slug ?? raw.id;
    if (typeof id !== 'string' || !/^(gpt-|o[1-9]|codex-)[a-zA-Z0-9._-]*$/.test(id) || /audio|realtime|image|transcri|tts|search|chat-latest|instruct/.test(id) || raw.visibility && raw.visibility !== 'list') return [];
    const known = FALLBACK_MODELS.find(m => m.id === id);
    const efforts = (raw.supported_reasoning_levels ?? raw.supported_reasoning_efforts ?? known?.efforts ?? []).map(e => typeof e === 'string' ? e : e.effort ?? e.reasoning_effort).filter(e => typeof e === 'string' && /^[a-z0-9_-]{1,64}$/.test(e));
    const rawTiers = raw.service_tiers ?? raw.serviceTiers;
    const tiers = Array.isArray(rawTiers) ? rawTiers.flatMap(t => {
      const id = typeof t === 'string' ? t : t.id;
      return typeof id === 'string' && /^[a-z0-9_-]{1,64}$/.test(id) ? [speed(id)] : [];
    }) : known?.tiers ?? [speed('default')];
    if (!tiers.some(t => t.id === 'default')) tiers.unshift(speed('default'));
    return [{ id, name: raw.display_name ?? known?.name ?? id,
      contextWindow: positive(raw.context_window) ? raw.context_window : known?.contextWindow ?? 32000,
      maxTokens: positive(raw.max_output_tokens) ? raw.max_output_tokens : known?.maxTokens ?? 8192,
      inputModalities: Array.isArray(raw.input_modalities) ? raw.input_modalities.filter(m => ['text','image'].includes(m)) : known?.inputModalities ?? ['text'],
      efforts: [...new Set(efforts)], defaultEffort: raw.default_reasoning_level ?? known?.defaultEffort ?? efforts[0], tiers }];
  });
}
export function resolveSpeed(model, requested = 'default') {
  const canonical = requested === 'standard' ? 'default' : requested;
  const tier = model.tiers.find(t => t.id === canonical) ?? (canonical === 'fast' ? model.tiers.find(t => t.id === 'priority') : undefined);
  if (!tier) throw new LlmError(`This model does not advertise ${requested} speed; use /speed to inspect available tiers`, 'UNSUPPORTED_SERVICE_TIER');
  return tier.id;
}
export class OpenAIModels {
  constructor(auth, fetcher = globalThis.fetch) { this.auth = auth; this.fetch = fetcher; this.clear(); }
  clear() { this.entries = FALLBACK_MODELS; this.checked = 0; this.key = undefined; this.discovered = false; this.error = undefined; }
  async list(force = false, credential, signal) {
    let auth = credential;
    try { auth ??= await this.auth.acquire(signal); }
    catch (error) { if (signal?.aborted) throw error; this.clear(); this.error = error.message; return this.entries; }
    if (auth.key !== this.key) { this.clear(); this.key = auth.key; }
    if (!force && Date.now() - this.checked < 300000) return this.entries;
    try {
      const entries = parseModels(await jsonRequest(API + '/models', { headers: { authorization: 'Bearer ' + auth.token }, signal }, this.fetch));
      if (this.key === auth.key) { this.entries = entries; this.discovered = true; this.error = undefined; }
      return entries;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (this.key === auth.key) this.error = error.message;
      return this.key === auth.key ? this.entries : FALLBACK_MODELS;
    } finally { if (this.key === auth.key) this.checked = Date.now(); }
  }
  async get(id, auth, signal) {
    const model = (await this.list(false, auth, signal)).find(m => m.id === id);
    if (!model) throw new LlmError('Model is not in the OpenAI account catalog; refresh with /openai models', 'MODEL_NOT_FOUND');
    return model;
  }
}
