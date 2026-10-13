import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { isAttachmentError } from '@deepseek-ai/dsh-attachment';
import { prepareImages } from '../custom/images.mjs';
import { sseData } from '../providers/chat-stream.mjs';
import { headers, responseError } from './client.mjs';
import { modelRoute } from './models.mjs';
import { requestBody, translate } from './wire.mjs';

/** Cancelling one caller must not cancel a shared token refresh/catalog read. */
async function abortable(promise, signal) {
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}

export class AntigravityAdapter extends LlmAdapter {
  constructor(config) { super(); this.config = config; }
  providerInfo(provider) { return { id: provider, name: 'Antigravity' }; }
  providerRetryPolicy() { return this.config.options().retryPolicy; }
  async listModels(provider) {
    return (await this.config.models.list()).map(m => ({ provider, id: m.id, name: m.name, inputModalities: m.inputModalities ?? ['text', 'image'] }));
  }
  async resolveModel(provider, id) {
    const m = await this.config.models.get(id);
    const efforts = Object.keys(m.routes).filter(e => e !== 'default');
    return { provider, id, name: m.name, inputModalities: m.inputModalities ?? ['text', 'image'], context: { contextWindow: m.contextWindow }, defaultMaxTokens: m.maxTokens,
      ...(efforts.length ? { reasoning: { efforts: efforts.map(id => ({ id: ReasoningEffortId(id), name: id })), defaultEffort: ReasoningEffortId(efforts.includes('low') ? 'low' : efforts[0]) } } : {}) };
  }
  async *stream(options) {
    const { session, models, client } = this.config;
    const config = this.config.options();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
    let timer, timedOut = false;
    const pulse = ms => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
      timer.unref?.();
    };
    try {
      signal.throwIfAborted();
      const grant = await abortable(session.auth(), signal);
      const model = await abortable(models.get(options.model), signal), route = modelRoute(model, options.reasoningEffort);
      const attachments = this.config.resolveAttachments?.();
      const images = await prepareImages(options.messages, { ...model, inputModalities: model.inputModalities ?? ['text', 'image'] }, attachments,
        ref => attachments && this.config.resolveImageAccess?.(attachments, ref), signal);
      signal.throwIfAborted();
      const body = JSON.stringify(requestBody({ ...options, messages: images.messages }, model, route, grant.projectId, images));
      let response;
      pulse(config.headerTimeoutMs);
      for (const endpoint of client.endpoints) {
        response = await client.fetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
          method: 'POST', redirect: 'error', headers: { ...headers(grant.access), accept: 'text/event-stream' }, body, signal,
        });
        if (response.ok) break;
        const error = await responseError(response);
        // Only a missing endpoint is retried here; rate limits and transient
        // failures belong to the Harness retry policy, never nested loops.
        if (response.status !== 404 || endpoint === client.endpoints.at(-1)) throw error;
      }
      if (!response?.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new LlmError('Antigravity did not return a stream', 'MALFORMED_RESPONSE');
      pulse(config.streamIdleTimeoutMs);
      for await (const chunk of translate(sseData(response.body, () => pulse(config.streamIdleTimeoutMs)), { model: model.id, runtimeModel: route.id })) {
        signal.throwIfAborted();
        clearTimeout(timer); yield chunk; pulse(config.streamIdleTimeoutMs);
      }
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('Antigravity request cancelled', 'ABORTED');
      if (timedOut) throw new LlmError('Antigravity connection timed out; retry the request', 'TIMEOUT');
      if (isAttachmentError(error)) throw new LlmError(`Antigravity image input failed: ${error.code}`, error.code);
      if (error instanceof LlmError) throw error;
      throw new LlmError('Could not complete the Antigravity request', 'TRANSPORT');
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
