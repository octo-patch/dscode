import { createHash, randomUUID } from 'node:crypto';
import { LlmError, requestImageHandleText } from '@deepseek-ai/dsh-llm';
import { thinkingConfig } from './models.mjs';

export const REPLAY_KIND = 'dscode-antigravity';
const textOf = blocks => blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
const signature = value => typeof value === 'string' && value.length > 0;

function imageParts(blocks, images) {
  return blocks.flatMap(block => {
    if (block.type === 'text') return block.text ? [{ text: block.text }] : [];
    if (block.type !== 'image') return [];
    const version = images?.versions.get(block.attachment.attachmentId);
    if (!version) throw new LlmError('Antigravity image was not prepared by the attachment service', 'UNSUPPORTED_CONTENT');
    return [{ text: requestImageHandleText(block.attachment, version, images.access?.(block.attachment)) },
      { inlineData: { mimeType: version.mediaType, data: Buffer.from(version.data).toString('base64') } }];
  });
}

/** Preserve signed model turns verbatim. On a provider/model switch, represent
 * earlier unsigned calls as historical text, not fresh executable requests. */
export function convertMessages(options, route, images) {
  const contents = [], calls = new Map();
  const append = (role, parts) => {
    if (!parts.length) return;
    if (contents.at(-1)?.role === role) contents.at(-1).parts.push(...parts);
    else contents.push({ role, parts });
  };
  const result = (id, blocks, isError) => {
    const call = calls.get(id), parts = imageParts(blocks, images);
    const output = parts.filter(p => p.text !== undefined).map(p => p.text).join('\n') || '(no output)';
    if (!call?.signed) {
      append('user', [{ text: `Historical tool result (${call?.name ?? id}):\n${output}` }, ...parts.filter(p => p.inlineData)]);
    } else {
      append('user', [{ functionResponse: { name: call.name, response: { [isError ? 'error' : 'output']: output },
        ...(parts.some(p => p.inlineData) ? { parts: parts.filter(p => p.inlineData) } : {}) } }]);
    }
  };
  for (const message of options.messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') { result(message.toolCallId, message.content, message.isError); continue; }
    if (message.role !== 'assistant') {
      for (const block of message.content) {
        if (block.type === 'tool-result') result(block.toolCallId, block.content, block.isError);
        else append('user', imageParts([block], images));
      }
      continue;
    }
    const source = message.source, replay = source?.replayState;
    const same = source?.provider === options.provider && source?.model === options.model && replay?.response?.kind === REPLAY_KIND
      && replay.response.runtimeModel === route.id && replay.blocks?.length === message.content.length;
    const firstCall = message.content.findIndex(b => b.type === 'tool-call');
    const signedCalls = same && firstCall >= 0 && signature(replay.blocks[firstCall]?.thoughtSignature);
    const parts = [];
    message.content.forEach((block, index) => {
      const sig = same ? replay.blocks[index]?.thoughtSignature : undefined;
      if (block.type === 'text') {
        if (block.text || sig) parts.push({ text: block.text, ...(sig ? { thoughtSignature: sig } : {}) });
      } else if (block.type === 'reasoning' && same) {
        parts.push({ thought: true, text: block.text, ...(sig ? { thoughtSignature: sig } : {}) });
      } else if (block.type === 'tool-call') {
        calls.set(block.id, { name: block.name, signed: signedCalls });
        if (signedCalls) {
          let args;
          try { args = JSON.parse(block.arguments); } catch { throw new LlmError('Invalid saved Antigravity tool arguments', 'INVALID_REQUEST'); }
          parts.push({ functionCall: { name: block.name, args }, ...(sig ? { thoughtSignature: sig } : {}) });
        } else parts.push({ text: `Historical tool call: ${block.name}(${block.arguments})` });
      }
    });
    append('model', parts);
  }
  if (!contents.length || contents[0].role !== 'user') contents.unshift({ role: 'user', parts: [{ text: 'Continue using the following conversation history.' }] });
  if (contents.at(-1).role === 'model') append('user', [{ text: 'Continue the active task.' }]);
  return contents;
}

export function requestBody(options, model, route, project, images) {
  const contents = convertMessages(options, route, images);
  const system = [options.system, ...options.messages.filter(m => m.role === 'system').map(m => textOf(m.content))].filter(Boolean).join('\n\n');
  const seed = options.sessionId ?? createHash('sha256').update(JSON.stringify(contents[0])).digest('hex');
  const hash = createHash('sha256').update(String(seed)).digest('hex');
  const trajectory = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const step = contents.length;
  const labels = { last_step_index: String(step - 1), request_id: `${trajectory}-${options.messages.filter(m => m.role === 'assistant').length}`,
    trajectory_id: trajectory, used_claude: 'false', used_claude_conservative: 'false', used_non_gemini_model: 'false',
    ...(route.modelEnum ? { model_enum: route.modelEnum } : {}) };
  const thinking = thinkingConfig(route);
  const tools = (options.tools ?? []).map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters }));
  return { project, model: route.id, requestType: 'agent', userAgent: 'antigravity',
    requestId: `agent/${trajectory}/${Date.now()}/${trajectory}/${step}`,
    request: { contents, sessionId: BigInt(`0x${hash.slice(0, 15)}`).toString(), labels,
      ...(system ? { systemInstruction: { role: 'user', parts: [{ text: system }] } } : {}),
      generationConfig: { maxOutputTokens: Math.min(options.maxTokens ?? model.maxTokens, model.maxTokens),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.stop ? { stopSequences: options.stop } : {}), ...(thinking ? { thinkingConfig: thinking } : {}) },
      ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}) } };
}

function usageOf(raw) {
  const valid = n => Number.isSafeInteger(n) && n >= 0;
  if (!valid(raw?.promptTokenCount) || !valid(raw?.candidatesTokenCount)) return undefined;
  const cached = valid(raw.cachedContentTokenCount) ? raw.cachedContentTokenCount : 0;
  const reasoning = valid(raw.thoughtsTokenCount) ? raw.thoughtsTokenCount : 0;
  return { inputTokens: Math.max(0, raw.promptTokenCount - cached), outputTokens: raw.candidatesTokenCount + reasoning,
    cacheReadTokens: cached, reasoningTokens: reasoning,
    ...(valid(raw.totalTokenCount) ? { totalTokens: raw.totalTokenCount } : {}) };
}

/** No tool block is committed before a successful terminal marker. Partial
 * streams fail so a disconnected call can never become a local side effect. */
export async function* translate(payloads, { model, runtimeModel }) {
  const blocks = [], metadata = [];
  let active, finish, usage;
  for await (const payload of payloads) {
    if (payload === '[DONE]') break;
    let packet;
    try { packet = JSON.parse(payload); } catch { throw new LlmError('Malformed Antigravity stream', 'MALFORMED_RESPONSE'); }
    if (packet.error || packet.response?.error) throw new LlmError('Antigravity returned a streaming error', 'SERVER');
    const data = packet.response ?? packet, candidate = data.candidates?.[0];
    if (data.promptFeedback?.blockReason) throw new LlmError('Antigravity blocked this request', 'CONTENT_FILTER');
    for (const part of candidate?.content?.parts ?? []) {
      // Google can send a signature in a separate part after its text/call.
      if (!part.functionCall && part.text === undefined && signature(part.thoughtSignature) && active) {
        metadata[active.index].thoughtSignature = part.thoughtSignature; continue;
      }
      const type = part.functionCall ? 'tool-call' : part.thought ? 'reasoning' : 'text';
      if (!part.functionCall && part.text === undefined && !part.thoughtSignature) throw new LlmError('Unsupported Antigravity output part', 'UNSUPPORTED_CONTENT');
      if (finish) throw new LlmError('Antigravity emitted content after finishing', 'MALFORMED_RESPONSE');
      if (!active || active.block.type !== type || type === 'tool-call' || active.closed) {
        const block = type === 'tool-call' ? { type, id: randomUUID(), name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) } : { type, text: '' };
        if (type === 'tool-call' && (typeof block.name !== 'string' || !block.name || part.functionCall.args !== undefined && (typeof part.functionCall.args !== 'object' || Array.isArray(part.functionCall.args) || part.functionCall.args === null))) throw new LlmError('Invalid Antigravity tool call', 'MALFORMED_RESPONSE');
        active = { index: blocks.length, block }; blocks.push(block); metadata.push({ type });
        yield { type: 'block-start', index: active.index, blockType: type };
      }
      if (part.thoughtSignature) metadata[active.index].thoughtSignature = part.thoughtSignature;
      if (type === 'tool-call') {
        yield { type: 'tool-call-delta', index: active.index, id: active.block.id, name: active.block.name, argumentsDelta: active.block.arguments };
        active.closed = true;
      } else if (typeof part.text === 'string') {
        active.block.text += part.text;
        yield { type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: active.index, text: part.text };
      }
    }
    if (candidate?.finishReason) finish = candidate.finishReason;
    usage = usageOf(data.usageMetadata) ?? usage;
  }
  if (!finish) throw new LlmError('Antigravity stream ended before completion', 'TRANSPORT');
  if (!['STOP', 'MAX_TOKENS'].includes(finish)) throw new LlmError('Antigravity did not complete the response', finish === 'SAFETY' ? 'CONTENT_FILTER' : 'MALFORMED_RESPONSE');
  if (!blocks.length) throw new LlmError('Antigravity returned no content', 'EMPTY_RESPONSE');
  if (finish === 'MAX_TOKENS' && blocks.some(b => b.type === 'tool-call')) throw new LlmError('Antigravity tool response reached the token limit; retry with a larger output budget', 'MALFORMED_RESPONSE');
  for (let index = 0; index < blocks.length; index++) yield { type: 'block-end', index, block: blocks[index] };
  if (usage) yield { type: 'usage', usage };
  yield { type: 'finish', reason: { kind: finish === 'MAX_TOKENS' ? 'max-tokens' : blocks.some(b => b.type === 'tool-call') ? 'tool-calls' : 'stop' },
    replayState: { response: { kind: REPLAY_KIND, version: 1, model, runtimeModel }, blocks: metadata } };
}
