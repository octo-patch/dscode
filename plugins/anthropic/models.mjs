import { LlmError } from '@deepseek-ai/dsh-llm';

// https://platform.claude.com/docs/en/models/overview (2026-10-27).
export const MODELS = Object.freeze([
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', defaultEffort: 'medium' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', defaultEffort: 'high' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', defaultEffort: 'high' },
].map(model => Object.freeze({ ...model, contextWindow: 1_000_000, maxTokens: 128_000,
  inputModalities: Object.freeze(['text', 'image']), efforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']) })));

export function getModel(id) {
  const model = MODELS.find(model => model.id === id);
  if (!model) throw new LlmError('Unknown Anthropic model; select one with /model', 'INVALID_REQUEST');
  return model;
}
