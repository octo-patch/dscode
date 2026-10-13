import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { API, ISSUER, jsonRequest, tokenRequest } from './http.mjs';
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const random = () => randomBytes(32).toString('base64url');
export function transaction(data, account, consent = false) {
  return { state: random(), nonce: random(), verifier: random(), hostId: data.hostId, revision: data.revision,
    clientId: account?.clientId ?? 'dynamic_agent_client', subject: account?.subject, consent };
}
export function authorizationUrl(tx) {
  const params = new URLSearchParams({ client_id: tx.clientId, ext_agent_host_id: tx.hostId, response_type: 'code', redirect_uri: tx.redirectUri,
    scope: SCOPES, resource: API, state: tx.state, nonce: tx.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(tx.verifier).digest('base64url') });
  if (tx.clientId === 'dynamic_agent_client') params.set('agent_name_hint', 'DSCODE');
  if (tx.consent) params.set('prompt', 'consent');
  // Deliberately omit id_token_hint: a safe fallback URL must contain no tokens.
  return ISSUER + '/api/accounts/authorize?' + params;
}
export async function callbackServer(tx, { port = 0, timeoutMs = 300000, signal } = {}) {
  let resolve, reject, timer, settled = false;
  const result = new Promise((a,b) => { resolve = a; reject = b; }); result.catch(() => {});
  const finish = (error, value) => {
    if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    server.close(); server.closeAllConnections?.(); if (error) reject(error); else resolve(value);
  };
  const cancel = () => finish(new Error('OpenAI login cancelled'));
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/plain; charset=utf-8'); res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('connection', 'close'); res.setHeader('content-security-policy', "default-src 'none'");
    let url; try { url = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400); res.end(); return; }
    if (req.method !== 'GET' || url.pathname !== '/auth/callback') { res.writeHead(404); res.end(); return; }
    if (url.searchParams.get('state') !== tx.state) { res.writeHead(400); res.end('Invalid state'); return; }
    const code = url.searchParams.get('code'), clientId = url.searchParams.get('client_id') ?? tx.clientId;
    const valid = !url.searchParams.has('error') && code && clientId !== 'dynamic_agent_client'
      && /^[a-zA-Z0-9_-]{1,200}$/.test(clientId) && (tx.clientId === 'dynamic_agent_client' || clientId === tx.clientId);
    res.writeHead(valid ? 200 : 400); res.end(valid ? 'Authorization received. Return to DSCODE and run /openai status.' : 'Authorization failed. Return to DSCODE.');
    res.once('finish', () => finish(valid ? undefined : new Error('OpenAI authorization declined or invalid'), { code, clientId }));
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  signal?.throwIfAborted();
  await new Promise((a,b) => { server.once('error', b); server.listen(port, '127.0.0.1', a); });
  server.on('error', () => finish(new Error('OpenAI callback failed')));
  tx.redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
  timer = setTimeout(() => finish(new Error('OpenAI login expired')), timeoutMs); timer.unref?.();
  signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
  return { result, close: cancel, url: authorizationUrl(tx) };
}
export class IdentityVerifier {
  constructor(fetcher = globalThis.fetch) { this.fetch = fetcher; }
  async discovery() {
    if (!this.config) {
      const config = await jsonRequest(ISSUER + '/.well-known/openid-configuration', {}, this.fetch);
      if (config.issuer !== ISSUER || ![config.jwks_uri, config.revocation_endpoint].every(u => typeof u === 'string' && new URL(u).origin === ISSUER)) throw new LlmError('Invalid OpenAI discovery document', 'AUTH');
      this.config = config;
    }
    return this.config;
  }
  async verify(token, tx, { refresh = false } = {}) {
    const config = await this.discovery();
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.keys || Date.now() - this.fetched > 3600000 || attempt) { this.keys = createLocalJWKSet(await jsonRequest(config.jwks_uri, {}, this.fetch)); this.fetched = Date.now(); }
      try {
        const { payload } = await jwtVerify(token, this.keys, { issuer: ISSUER, audience: tx.clientId, algorithms: ['RS256', 'ES256'], requiredClaims: ['sub','exp','iat'], clockTolerance: 5 });
        if ((!refresh && payload.nonce !== tx.nonce) || typeof payload.sub !== 'string' || !payload.sub || (tx.subject && payload.sub !== tx.subject)) throw Error('Identity mismatch');
        return payload;
      } catch (error) { if (error.code === 'ERR_JWKS_NO_MATCHING_KEY' && !attempt) continue; throw new LlmError('OpenAI identity validation failed', 'AUTH'); }
    }
  }
}
export function tokenFields(token, previous = {}) {
  if (typeof token.access_token !== 'string' || !token.access_token || typeof token.refresh_token !== 'string' || !token.refresh_token
    || String(token.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(token.expires_in) || token.expires_in <= 0) throw new LlmError('OpenAI returned incomplete credentials', 'AUTH');
  const scopes = typeof token.scope === 'string' ? token.scope.split(/\s+/) : previous.scopes;
  if (!Array.isArray(scopes)) throw new LlmError('OpenAI did not return granted scopes', 'AUTH');
  return { access: token.access_token, refresh: token.refresh_token, idToken: token.id_token ?? previous.idToken, expires: Date.now() + token.expires_in * 1000, scopes };
}
export async function exchangeCode(callback, tx, verifier, fetcher, signal) {
  const token = await tokenRequest({ grant_type: 'authorization_code', client_id: callback.clientId, code: callback.code, code_verifier: tx.verifier, redirect_uri: tx.redirectUri }, fetcher, signal);
  const identity = await verifier.verify(token.id_token, { ...tx, clientId: callback.clientId });
  return { clientId: callback.clientId, subject: identity.sub, email: typeof identity.email === 'string' ? identity.email : undefined, ...tokenFields(token) };
}
