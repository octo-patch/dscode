import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { LlmError } from '@deepseek-ai/dsh-llm';

export const GRANT_REF = 'ANTIGRAVITY_OAUTH';
export const REDIRECT_URI = 'http://localhost:51121/oauth-callback';
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Public installed-app client distributed by pi-antigravity, not a user secret.
const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const SCOPES = ['aicode', 'cloud-platform', 'userinfo.email', 'userinfo.profile', 'cclog', 'experimentsandconfigs'].map(scope => `https://www.googleapis.com/auth/${scope}`);
const MARGIN = 5 * 60 * 1000;

export function authorize() {
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code',
    scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
  return { verifier, state, url: `${AUTH_URL}?${query}` };
}

/** A loopback-only callback; invalid state requests never consume the pending login. */
export async function callbackServer(state, { port = 51121, timeoutMs = MARGIN, signal } = {}) {
  let resolveCode, rejectCode, timer, settled = false;
  const code = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // The browser can finish before the caller attaches its continuation.
  code.catch(() => {});
  const finish = (error, value) => {
    if (settled) return;
    settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
    server.close(); server.closeIdleConnections?.();
    if (error) rejectCode(error); else resolveCode(value);
  };
  const abort = () => finish(new Error('Antigravity login cancelled'));
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('connection', 'close');
    res.setHeader('cache-control', 'no-store'); res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'none'");
    let url;
    try { url = new URL(req.url, REDIRECT_URI); } catch { res.writeHead(400); res.end('Invalid callback URL'); return; }
    if (req.method !== 'GET' || url.pathname !== '/oauth-callback') { res.writeHead(404); res.end('Not found'); return; }
    if (url.searchParams.get('state') !== state) { res.writeHead(400); res.end('Invalid login state'); return; }
    const value = url.searchParams.get('code');
    if (url.searchParams.has('error') || !value) {
      res.writeHead(400); res.end('Sign-in was not completed. Return to DSCODE.');
      finish(new Error('Google sign-in was declined or returned no code')); return;
    }
    res.end('Google authorization received. Return to DSCODE and run /antigravity to check completion.');
    finish(undefined, value);
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  try {
    signal?.throwIfAborted();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } catch { server.close(); throw new Error('Cannot open the Antigravity login callback on 127.0.0.1:51121; close another pending login and retry'); }
  server.on('error', () => finish(new Error('Antigravity callback failed')));
  timer = setTimeout(() => finish(new Error('Antigravity login expired; run /antigravity login again')), timeoutMs);
  timer.unref?.(); signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return { code, port: server.address()?.port, close: abort };
}

async function tokenRequest(body, { fetch = globalThis.fetch, signal } = {}) {
  const deadline = AbortSignal.timeout(15000);
  try {
    const response = await fetch(TOKEN_URL, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...body }),
      signal: AbortSignal.any([deadline, ...(signal ? [signal] : [])]),
    });
    const data = await response.json();
    if (!response.ok || typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
      throw new LlmError('Google could not authorize Antigravity; run /antigravity login again', response.status >= 500 ? 'SERVER' : 'AUTH');
    }
    return data;
  } catch (error) {
    if (signal?.aborted) throw new LlmError('Antigravity login cancelled', 'ABORTED');
    if (deadline.aborted) throw new LlmError('Google token request timed out', 'TIMEOUT');
    if (error instanceof LlmError) throw error;
    throw new LlmError('Could not contact Google for Antigravity authorization', 'TRANSPORT');
  }
}

export async function exchangeCode(code, verifier, client, options = {}) {
  const token = await tokenRequest({ code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI }, options);
  if (typeof token.refresh_token !== 'string' || !token.refresh_token) throw new LlmError('Google did not issue an offline login; run /antigravity login again', 'AUTH');
  const projectId = await client.project(token.access_token, options.signal);
  return { version: 1, access: token.access_token, refresh: token.refresh_token, expires: Date.now() + token.expires_in * 1000, projectId };
}
export function parseGrant(raw) {
  try {
    const g = JSON.parse(raw);
    return g?.version === 1 && ['access', 'refresh', 'projectId'].every(k => typeof g[k] === 'string' && g[k]) && Number.isFinite(g.expires) ? g : undefined;
  } catch { return undefined; }
}

/** Serialize writes so a late callback or refresh cannot undo logout in this Host. */
export class AntigravitySession {
  constructor(store, { fetch, now = Date.now } = {}) { this.store = store; this.fetch = fetch; this.now = now; this.revision = 0; this.writes = Promise.resolve(); }
  current() { return this.store.read().then(parseGrant); }
  write(action) { const next = this.writes.then(action); this.writes = next.catch(() => {}); return next; }
  save(grant, revision = this.revision) {
    return this.write(async () => {
      if (revision !== this.revision) return false;
      await this.store.write(JSON.stringify(grant)); return true;
    });
  }
  logout() { this.revision++; return this.write(() => this.store.remove()); }
  async auth() {
    const grant = await this.current();
    if (!grant) throw new LlmError('Sign in with /antigravity login first', 'MISSING_CREDENTIAL');
    if (grant.expires - this.now() > MARGIN) return grant;
    if (!this.pending) {
      const revision = this.revision;
      this.pending = (async () => {
        const token = await tokenRequest({ grant_type: 'refresh_token', refresh_token: grant.refresh }, { fetch: this.fetch });
        return this.write(async () => {
          const current = await this.current();
          if (!current || revision !== this.revision) throw new LlmError('Antigravity signed out during token refresh', 'MISSING_CREDENTIAL');
          if (current.access !== grant.access || current.refresh !== grant.refresh) return current;
          const next = { ...grant, access: token.access_token, refresh: token.refresh_token || grant.refresh, expires: this.now() + token.expires_in * 1000 };
          await this.store.write(JSON.stringify(next)); return next;
        });
      })().finally(() => { this.pending = undefined; });
    }
    return this.pending;
  }
}
