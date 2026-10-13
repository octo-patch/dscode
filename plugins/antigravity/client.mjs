import { LlmError } from '@deepseek-ai/dsh-llm';
import { errorCode, retryAfterMs } from '../providers/http-errors.mjs';

// Wire compatibility follows pi-antigravity d59d22b (see NOTICE). This is an
// unofficial model transport, independent of both the ACP agent and the CLI.
export const ENDPOINTS = Object.freeze([
  'https://daily-cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
]);
export const USER_AGENT = 'antigravity/cli/1.2.4 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)';
export const headers = token => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', 'User-Agent': USER_AGENT });

export function projectId(data) {
  if (!data || typeof data !== 'object') return undefined;
  for (const key of ['antigravityProjectId', 'projectId', 'backendProjectId', 'userDefinedCloudaicompanionProject', 'cloudaicompanionProject', 'project']) {
    const value = data[key], id = typeof value === 'string' ? value : value?.id;
    if (typeof id === 'string' && id.trim()) return id;
  }
  for (const key of ['projects', 'projectIds', 'cloudaicompanionProjects']) {
    for (const item of Array.isArray(data[key]) ? data[key] : []) {
      const id = typeof item === 'string' ? item : projectId(item);
      if (id) return id;
    }
  }
  return undefined;
}

/** Never put server text, URLs containing auth codes, or fetch causes into logs. */
export async function responseError(response) {
  let error;
  try { error = (await response.json())?.error; } catch { /* status is sufficient */ }
  const code = errorCode(response.status, typeof error === 'object' ? error : undefined);
  const delay = retryAfterMs(response.headers.get('retry-after'));
  return new LlmError(`Antigravity request failed (HTTP ${response.status})`, code,
    { status: response.status, ...(delay === undefined ? {} : { providerRetryAfterMs: delay }) });
}

export class AntigravityClient {
  constructor({ fetch = globalThis.fetch, endpoints = ENDPOINTS, metadataTimeoutMs = 10000 } = {}) {
    this.fetch = fetch; this.endpoints = endpoints; this.metadataTimeoutMs = metadataTimeoutMs;
  }
  async json(method, token, body, signal) {
    const deadline = AbortSignal.timeout(this.metadataTimeoutMs);
    const combined = AbortSignal.any([deadline, ...(signal ? [signal] : [])]);
    let last;
    for (const endpoint of this.endpoints) {
      try {
        const response = await this.fetch(`${endpoint}/v1internal:${method}`, {
          method: 'POST', redirect: 'error', headers: headers(token), body: JSON.stringify(body), signal: combined,
        });
        if (response.ok) return await response.json();
        last = await responseError(response);
        // A quota/auth rejection is final; changing endpoints must not hide it.
        if (![404, 500, 502, 503, 504].includes(response.status)) throw last;
      } catch (error) {
        if (signal?.aborted) throw new LlmError('Antigravity request cancelled', 'ABORTED');
        if (deadline.aborted) throw new LlmError('Antigravity discovery timed out', 'TIMEOUT');
        if (error instanceof LlmError) throw error;
        last = new LlmError('Could not connect to Antigravity', 'TRANSPORT');
      }
    }
    throw last ?? new LlmError('No Antigravity endpoint available', 'TRANSPORT');
  }
  async project(token, signal) {
    const data = await this.json('loadCodeAssist', token, { metadata: { ideType: 'ANTIGRAVITY' } }, signal);
    let id = projectId(data);
    if (!id) id = projectId(await this.json('listCloudAICompanionProjects', token, {}, signal));
    if (typeof id !== 'string' || !id) throw new LlmError('Antigravity did not return an enabled project for this account; open Antigravity to finish account setup, then sign in again', 'AUTH');
    return id;
  }
  models(grant, signal) { return this.json('fetchAvailableModels', grant.access, { project: grant.projectId }, signal); }
}
