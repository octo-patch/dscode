import { LlmError } from '@deepseek-ai/dsh-llm';
import { serializeMessages } from '../providers/chat-messages.mjs';
import { resolveSpeed } from './models.mjs';
import { responseError } from './http.mjs';
export const REPLAY_KIND = 'dscode-openai';
export function requestBody(options, model, auth, requested, images) {
  const input = [], system = [options.system].filter(Boolean);
  for (const message of options.messages) {
    if (message.role === 'system') { system.push(message.content.filter(b => b.type === 'text').map(b => b.text).join('\n')); continue; }
    const replay = message.source?.replayState?.response;
    if (message.role === 'assistant' && message.source?.provider === 'openai' && message.source.model === model.id && replay?.kind === REPLAY_KIND && replay.account === auth.key && Array.isArray(replay.items)) { input.push(...replay.items); continue; }
    for (const wire of serializeMessages([message], { model: model.id, images, dialect: { provider: 'openai', reasoningContent: () => false } })) {
      if (wire.role === 'tool') { input.push({ type: 'function_call_output', call_id: wire.tool_call_id, output: wire.content }); continue; }
      const content = typeof wire.content === 'string' ? wire.content ? [{ type: wire.role === 'assistant' ? 'output_text' : 'input_text', text: wire.content }] : []
        : wire.content.map(p => p.type === 'text' ? { type: 'input_text', text: p.text } : { type: 'input_image', image_url: p.image_url.url, detail: 'auto' });
      if (content.length) input.push({ role: wire.role === 'system' ? 'developer' : wire.role, content });
      for (const call of wire.tool_calls ?? []) input.push({ type: 'function_call', namespace: 'dscode', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }
  const effort = options.reasoningEffort ?? model.defaultEffort;
  if (effort !== undefined && !model.efforts.includes(effort)) throw new LlmError('This OpenAI model does not advertise that reasoning effort', 'UNSUPPORTED_REASONING_EFFORT');
  const tools = (options.tools ?? []).map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }));
  return { model: model.id, stream: true, store: false, input, include: ['reasoning.encrypted_content'], service_tier: resolveSpeed(model, requested),
    ...(system.length ? { instructions: system.join('\n\n') } : {}), ...(effort ? { reasoning: { effort, summary: 'auto' } } : {}),
    ...(tools.length ? { tools: [{ type: 'namespace', name: 'dscode', description: 'DSCODE local tools', tools }] } : {}),
    ...(auth.mode === 'api-key' ? { max_output_tokens: Math.min(options.maxTokens ?? model.maxTokens, model.maxTokens), ...(options.temperature !== undefined && !effort ? { temperature: options.temperature } : {}) } : {}) };
}
const usageOf = u => u && Number.isFinite(u.input_tokens) && Number.isFinite(u.output_tokens) ? {
  inputTokens: Math.max(0, u.input_tokens - (u.input_tokens_details?.cached_tokens ?? 0)), outputTokens: u.output_tokens,
  cacheReadTokens: u.input_tokens_details?.cached_tokens ?? 0, reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
  ...(Number.isFinite(u.total_tokens) ? { totalTokens: u.total_tokens } : {}) } : undefined;
/** Stream visible deltas, but commit tool calls only after response.completed. */
export async function* translate(payloads, { model, account, requested }) {
  let completed;
  const completedItems = new Map();
  const started = new Map(); let nextIndex = 0;
  for await (const raw of payloads) {
    if (raw === '[DONE]') break;
    let e; try { e = JSON.parse(raw); } catch { throw new LlmError('Malformed OpenAI stream', 'MALFORMED_RESPONSE'); }
    if (e.type === 'error' || e.type === 'response.failed') throw responseError(e.response?.error?.code?.includes('usage_limit') ? 429 : 400, { error: e.error ?? e.response?.error ?? e }, e.response?.id);
    if (e.type === 'response.incomplete') throw new LlmError('OpenAI response was incomplete; no tool calls were committed', 'INCOMPLETE_RESPONSE');
    if (e.type === 'response.completed') { completed = e.response; continue; }
    if (completed && /delta|output_item/.test(e.type)) throw new LlmError('OpenAI emitted content after completion', 'MALFORMED_RESPONSE');
    if (e.type === 'response.output_item.done') {
      if (!Number.isSafeInteger(e.output_index) || e.output_index < 0 || !e.item || typeof e.item !== 'object'
        || completedItems.has(e.output_index) || e.item.status && e.item.status !== 'completed') throw new LlmError('Invalid completed OpenAI output item', 'MALFORMED_RESPONSE');
      completedItems.set(e.output_index, e.item);
      continue;
    }
    const kind = e.type === 'response.output_text.delta' ? 'text' : e.type === 'response.reasoning_summary_text.delta' ? 'reasoning' : undefined;
    if (kind) {
      const key = `${e.output_index}:${kind}`;
      if (!started.has(key)) { const index = nextIndex++; started.set(key, index); yield { type: 'block-start', index, blockType: kind }; }
      yield { type: kind === 'text' ? 'text-delta' : 'reasoning-delta', index: started.get(key), text: e.delta };
    }
  }
  if (!completed || completed.status !== 'completed' || !Array.isArray(completed.output)) throw new LlmError('OpenAI stream ended before completion', 'TRANSPORT');
  // The direct route may send an empty output array in the terminal envelope.
  // In that case use fully completed items, never argument/text deltas. The
  // response.completed gate above still controls all tool commits.
  const itemEntries = [...completedItems].sort(([a], [b]) => a - b);
  if (!completed.output.length && itemEntries.some(([index], position) => index !== position)) throw new LlmError('OpenAI completion omitted output items', 'MALFORMED_RESPONSE');
  const output = completed.output.length ? completed.output : itemEntries.map(([, item]) => item), blocks = [];
  let hasTools = false;
  for (let i = 0; i < output.length; i++) {
    const item = output[i]; let block;
    if (item.type === 'message') {
      if (item.content?.some(p => p.type === 'refusal')) throw new LlmError('OpenAI declined the response', 'CONTENT_FILTER');
      if (!Array.isArray(item.content) || item.content.some(p => p.type !== 'output_text')) throw new LlmError('Unsupported OpenAI output content', 'UNSUPPORTED_CONTENT');
      block = { type: 'text', text: item.content.map(p => p.text).join('') };
    } else if (item.type === 'reasoning') block = { type: 'reasoning', text: (item.summary ?? []).map(p => p.text ?? '').join('') };
    else if (item.type === 'function_call') {
      if (item.namespace && item.namespace !== 'dscode') throw new LlmError('Unknown OpenAI tool namespace', 'MALFORMED_RESPONSE');
      let args; try { args = JSON.parse(item.arguments); } catch { throw new LlmError('Invalid OpenAI tool arguments', 'MALFORMED_RESPONSE'); }
      if (!args || typeof args !== 'object' || Array.isArray(args) || typeof item.name !== 'string' || !item.name || typeof item.call_id !== 'string' || !item.call_id) throw new LlmError('Invalid OpenAI tool call', 'MALFORMED_RESPONSE');
      block = { type: 'tool-call', id: item.call_id, name: item.name, arguments: item.arguments }; hasTools = true;
    } else throw new LlmError('Unsupported OpenAI output item', 'UNSUPPORTED_CONTENT');
    const key = `${i}:${block.type}`;
    let index = started.get(key);
    const needsStart = index === undefined;
    if (needsStart) index = nextIndex++;
    blocks.push({ index, block, needsStart });
  }
  if (!blocks.length || !blocks.some(b => b.block.type === 'tool-call' || b.block.text)) throw new LlmError('OpenAI returned no content', 'EMPTY_RESPONSE');
  // Validate every returned item before emitting any committed block.
  if ([...started.values()].some(index => !blocks.some(b => b.index === index))) throw new LlmError('OpenAI completion omitted streamed content', 'MALFORMED_RESPONSE');
  for (const { index, block, needsStart } of blocks.sort((a,b) => a.index-b.index)) {
    if (needsStart) yield { type: 'block-start', index, blockType: block.type };
    yield { type: 'block-end', index, block };
  }
  const usage = usageOf(completed.usage); if (usage) yield { type: 'usage', usage };
  yield { type: 'finish', reason: { kind: hasTools ? 'tool-calls' : 'stop' }, replayState: { response: { kind: REPLAY_KIND, model, account, items: output, requestedTier: requested, actualTier: completed.service_tier }, blocks: blocks.sort((a,b) => a.index-b.index).map(b => ({ type: b.block.type })) } };
}
