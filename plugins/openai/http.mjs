import { LlmError } from '@deepseek-ai/dsh-llm';
export const API = 'https://api.openai.com/v1';
export const ISSUER = 'https://auth.openai.com';
export const TOKEN_URL = ISSUER + '/api/accounts/oauth/token';
export const REQUEST_MS = 15000;
const safe = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value) ? value : undefined;
export function responseError(status, data, requestId) {
  const code = safe(data?.error?.code ?? (typeof data?.error === 'string' ? data.error : undefined));
  const param = safe(data?.error?.param);
  const category = code === 'subscription_sharing_usage_limit_exceeded' ? 'QUOTA'
    : code?.includes('unsupported') ? 'INVALID_REQUEST'
      : status === 401 || status === 403 ? 'AUTH' : status === 429 ? 'RATE_LIMIT' : status >= 500 ? 'SERVER' : 'INVALID_REQUEST';
  const error = new LlmError(`OpenAI HTTP ${status}${code ? ': ' + code : ''}${param ? ' (' + param + ')' : ''}${safe(requestId) ? ' [request ' + requestId + ']' : ''}`, category);
  error.oauthCode = code; error.status = status; return error;
}
export async function jsonRequest(url, init = {}, fetcher = globalThis.fetch) {
  const signal = AbortSignal.any([AbortSignal.timeout(REQUEST_MS), ...(init.signal ? [init.signal] : [])]);
  try {
    const response = await fetcher(url, { ...init, redirect: 'error', signal });
    let data; try { data = await response.json(); } catch { /* HTTP category still applies */ }
    if (!response.ok) throw responseError(response.status, data, response.headers.get('x-request-id'));
    if (!data || typeof data !== 'object') throw new LlmError('OpenAI returned invalid JSON', 'MALFORMED_RESPONSE');
    return data;
  } catch (error) {
    if (error instanceof LlmError) throw error;
    throw new LlmError(init.signal?.aborted ? 'OpenAI request cancelled' : signal.aborted ? 'OpenAI request timed out' : 'Could not contact OpenAI', init.signal?.aborted ? 'ABORTED' : signal.aborted ? 'TIMEOUT' : 'TRANSPORT');
  }
}
export const tokenRequest = (body, fetcher, signal) => jsonRequest(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...body, resource: API }), signal }, fetcher);
