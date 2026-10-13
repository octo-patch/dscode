import { LlmError } from '@deepseek-ai/dsh-llm';
import { createHash } from 'node:crypto';
import { tokenRequest } from './http.mjs';
import { tokenFields } from './oauth.mjs';
const terminal = new Set(['invalid_grant','invalid_refresh_token','token_expired','refresh_token_expired','refresh_token_invalidated','refresh_token_reused']);
const strip = account => { const { access: _access, refresh: _refresh, expires: _expires, idToken: _idToken, scopes: _scopes, ...registration } = account; return registration; };
export class OpenAIAuth {
  constructor({ store, apiKey, verifier, fetch = globalThis.fetch }) { Object.assign(this, { store, apiKey, verifier, fetch }); }
  status() {
    const data = this.store.read();
    const account = data?.accounts.find(a => a.clientId === data.active);
    return { mode: data?.mode ?? 'chatgpt', account, accounts: data?.accounts ?? [], configured: Boolean(account?.access && account.scopes?.includes('chatgpt.tokens.use.direct')) };
  }
  async select(mode, id) {
    return this.store.locked(data => {
      if (mode === 'chatgpt' && id && !data.accounts.some(a => a.clientId === id)) throw Error('Unknown OpenAI account');
      data.mode = mode; if (id) data.active = id; delete data.pendingRegistration; data.revision++; this.store.write(data);
    });
  }
  async rememberRegistration(clientId, tx, signal) {
    if (tx.clientId !== 'dynamic_agent_client') return;
    return this.store.locked(data => {
      if (data.revision !== tx.revision || signal?.aborted) return;
      // A callback's client ID is a retry hint, not a verified account or grant.
      data.pendingRegistration = { clientId, revision: data.revision };
      this.store.write(data);
    }, signal);
  }
  async save(account, tx, signal) {
    return this.store.locked(data => {
      if (data.revision !== tx.revision || signal?.aborted) return false;
      const old = data.accounts.find(a => a.clientId === account.clientId);
      if (old && old.subject !== account.subject) throw Error('OpenAI registration identity changed');
      data.accounts = data.accounts.filter(a => a.clientId !== account.clientId); data.accounts.push(account);
      data.active = account.clientId; data.mode = 'chatgpt'; delete data.pendingRegistration; data.revision++; this.store.write(data); return true;
    }, signal);
  }
  async acquire(signal) {
    const status = this.status();
    if (status.mode === 'api-key') {
      const key = await this.apiKey();
      if (!key || /\s/.test(key)) throw new LlmError('Configure OPENAI_API_KEY with /login openai or in the launch environment', 'MISSING_CREDENTIAL');
      return { mode: 'api-key', token: key, key: 'api-key:' + createHash('sha256').update(key).digest('hex') };
    }
    // Hold the kernel lock across refresh, re-read after admission, then commit
    // the rotating token as a single atomic replacement. Other Hosts wait.
    return this.store.locked(async data => {
      if (data.mode !== 'chatgpt') throw new LlmError('OpenAI billing selection changed; retry', 'AUTH');
      let account = data.accounts.find(a => a.clientId === data.active);
      if (!account?.access || !account.refresh) throw new LlmError('Run /openai login to sign in with ChatGPT', 'MISSING_CREDENTIAL');
      if (account.expires - Date.now() < 60000) {
        try {
          const token = await tokenRequest({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: account.refresh }, this.fetch, signal);
          if (token.id_token) await this.verifier.verify(token.id_token, account, { refresh: true });
          account = { ...account, ...tokenFields(token, account) };
          data.accounts = data.accounts.map(a => a.clientId === account.clientId ? account : a); this.store.write(data);
        } catch (error) {
          if (terminal.has(error.oauthCode)) { data.accounts = data.accounts.map(a => a.clientId === account.clientId ? strip(a) : a); this.store.write(data); }
          throw error;
        }
      }
      if (!account.scopes.includes('chatgpt.tokens.use.direct')) throw new LlmError('ChatGPT plan usage is not enabled. Run /openai consent or choose /openai api-key', 'AUTH');
      return { mode: 'chatgpt', token: account.access, key: account.clientId + ':' + account.subject };
    }, signal);
  }
  async logout() {
    return this.store.locked(async data => {
      const account = data.accounts.find(a => a.clientId === data.active); let revoked = !account?.refresh;
      if (account?.refresh) {
        try {
          const config = await this.verifier.discovery();
          const response = await this.fetch(config.revocation_endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: account.refresh, token_type_hint: 'refresh_token', client_id: account.clientId }) });
          revoked = response.status === 200;
        } catch { /* local sign-out still completes */ }
        data.accounts = data.accounts.map(a => a.clientId === account.clientId ? strip(a) : a);
      }
      delete data.pendingRegistration; data.revision++; this.store.write(data); return revoked;
    });
  }
}
