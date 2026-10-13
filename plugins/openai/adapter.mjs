import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { isAttachmentError } from '@deepseek-ai/dsh-attachment';
import { sseData } from '../providers/chat-stream.mjs';
import { prepareImages } from '../custom/images.mjs';
import { API, responseError } from './http.mjs';
import { requestBody, translate } from './wire.mjs';
export class OpenAIAdapter extends LlmAdapter {
  constructor(config) { super(); this.config = config; }
  providerInfo(provider) { return { id: provider, name: 'OpenAI / ChatGPT' }; }
  providerRetryPolicy() { return this.config.options().retryPolicy; }
  async listModels(provider) { return (await this.config.models.list()).map(m => ({ provider, id: m.id, name: m.name, inputModalities: m.inputModalities })); }
  async resolveModel(provider, id) {
    const m = await this.config.models.get(id);
    return { provider, id, name: m.name, context: { contextWindow: m.contextWindow }, defaultMaxTokens: m.maxTokens, inputModalities: m.inputModalities,
      ...(m.efforts.length ? { reasoning: { efforts: m.efforts.map(id => ({ id: ReasoningEffortId(id), name: id })), defaultEffort: ReasoningEffortId(m.efforts.includes(m.defaultEffort) ? m.defaultEffort : m.efforts[0]) } } : {}) };
  }
  async *stream(options) {
    const config = this.config, settings = config.options(), controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
    const release = config.registerRequest?.(controller);
    let timer, timedOut = false;
    const pulse = ms => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms); timer.unref?.(); };
    try {
      const auth = await config.auth.acquire(signal), model = await config.models.get(options.model, auth, signal);
      const images = await prepareImages(options.messages, model, config.resolveAttachments?.(), config.resolveImageAccess, signal);
      const requested = config.speed(options), body = requestBody({ ...options, messages: images.messages }, model, auth, requested, images);
      signal.throwIfAborted(); pulse(settings.headerTimeoutMs);
      const response = await config.fetch(API + '/responses', { method: 'POST', redirect: 'error', headers: { authorization: 'Bearer ' + auth.token, 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body), signal });
      if (!response.ok) { let data; try { data = await response.json(); } catch {} throw responseError(response.status, data, response.headers.get('x-request-id')); }
      const mediaType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      // The ChatGPT direct route can deliver valid SSE without Content-Type.
      // Missing metadata is not proof of a malformed body: the translator still
      // requires response.completed and validates every item before committing.
      if (!response.body || mediaType && mediaType !== 'text/event-stream') {
        const label = mediaType && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType) ? mediaType.slice(0,100) : 'unknown content type';
        throw new LlmError(`OpenAI did not return a stream (HTTP ${response.status}; ${response.body ? label : 'empty body'})`, 'MALFORMED_RESPONSE');
      }
      pulse(settings.streamIdleTimeoutMs);
      for await (const chunk of translate(sseData(response.body, () => pulse(settings.streamIdleTimeoutMs)), { model: model.id, account: auth.key, requested: body.service_tier })) {
        signal.throwIfAborted();
        clearTimeout(timer); yield chunk; pulse(settings.streamIdleTimeoutMs);
      }
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('OpenAI request cancelled', 'ABORTED');
      if (timedOut) throw new LlmError('OpenAI connection timed out; retry', 'TIMEOUT');
      if (controller.signal.aborted) throw new LlmError('OpenAI account changed or signed out', 'ABORTED');
      if (isAttachmentError(error)) throw new LlmError('OpenAI image input failed: ' + error.code, error.code);
      if (error instanceof LlmError) throw error;
      throw new LlmError('Could not complete the OpenAI request', 'TRANSPORT');
    } finally { clearTimeout(timer); controller.abort(); release?.(); }
  }
}
