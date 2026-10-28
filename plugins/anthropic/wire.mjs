import { createHash } from 'node:crypto';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { requestBody as messagesBody } from '../custom/wire.mjs';

export const REPLAY_KIND = 'dscode-anthropic';
const isThinking = block => ['thinking', 'redacted_thinking'].includes(block.type);
// Include thinking too: removing a block changes the chain for later blocks.
export function prefixHash(body, messages = body.messages) {
  return createHash('sha256').update(JSON.stringify({ system: body.system, tools: body.tools,
    messages })).digest('hex');
}

export function requestBody(options, model, images, account) {
  const effort = options.reasoningEffort ?? model.defaultEffort;
  if (!model.efforts.includes(effort)) throw new LlmError('Unsupported Anthropic reasoning effort', 'UNSUPPORTED_REASONING_EFFORT');
  const body = messagesBody({ id: 'anthropic', api: 'anthropic', replayKind: REPLAY_KIND }, model,
    { ...options, reasoningEffort: undefined, temperature: undefined }, images);
  if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > model.maxTokens) {
    throw new LlmError('Anthropic output budget must be between 1 and 128000 tokens', 'INVALID_REQUEST');
  }
  const sources = options.messages.filter(m => m.role === 'assistant');
  let assistant = 0;
  for (let index = 0; index < body.messages.length; index++) {
    const message = body.messages[index];
    if (message.role !== 'assistant') continue;
    const source = sources[assistant++]?.source, replay = source?.replayState?.response;
    const invalid = source?.provider !== 'anthropic' || source.model !== model.id || replay?.account !== account
      || replay?.requestPrefix !== prefixHash(body, body.messages.slice(0, index));
    if (invalid) message.content = message.content.filter(b => !isThinking(b));
  }
  body.messages = body.messages.filter(m => m.content.length);
  return { ...body, thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort } };
}
