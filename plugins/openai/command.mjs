import { openBrowser } from '../account/index.mjs';
import { transaction, callbackServer, exchangeCode } from './oauth.mjs';
export class OpenAILogin {
  constructor({ auth, models, open = openBrowser, callback = callbackServer, exchange = exchangeCode, cancelRequests = () => {} }) { Object.assign(this, { auth, models, open, callback, exchange, cancelRequests }); }
  status() {
    const s = this.auth.status();
    return [`Billing: ${s.mode === 'api-key' ? 'OpenAI API key' : 'ChatGPT plan'}.`, this.attempt ? this.attempt.phase === 'exchange' ? 'Browser authorization received; exchanging and validating credentials.' : 'Waiting for browser sign-in; /openai cancel to stop.' : this.outcome,
      s.mode === 'chatgpt' ? s.configured ? `Signed in: ${s.account.email ?? 'ChatGPT account'} [${s.account.clientId}].` : 'ChatGPT plan access is not active. Use /openai login or /openai consent.' : 'Configure the key with /login openai or OPENAI_API_KEY.',
      'Usage and app permissions: https://chatgpt.com/settings/usage'].filter(Boolean).join('\n');
  }
  async login(arg) {
    if (this.attempt) return this.status();
    // Claim the attempt before asynchronous storage work so repeated commands
    // cannot open two browsers with different PKCE verifiers.
    const attempt = { controller: new AbortController() }; this.attempt = attempt; this.outcome = undefined;
    try {
      const data = await this.auth.store.initialize();
      if (this.attempt !== attempt) return this.status();
      const pending = data.pendingRegistration?.revision === data.revision ? data.pendingRegistration : undefined;
      const account = arg === 'new' ? undefined : pending ?? data.accounts.find(a => a.clientId === data.active);
      const tx = transaction(data, account, arg === 'consent'); attempt.tx = tx;
      attempt.listener = await this.callback(tx, { signal: attempt.controller.signal });
      if (this.attempt !== attempt) { attempt.listener.close(); return this.status(); }
      attempt.done = this.follow(attempt);
      await this.open(attempt.listener.url).catch(() => false);
      return 'Continue with ChatGPT in your browser. Waiting up to 5 minutes; /openai status checks the result.\n' + attempt.listener.url;
    } catch { if (this.attempt === attempt) this.attempt = undefined; throw Error('Could not start the OpenAI loopback login'); }
  }
  async follow(attempt) {
    try {
      const callback = await attempt.listener.result;
      if (this.attempt !== attempt || attempt.controller.signal.aborted) return;
      attempt.phase = 'exchange';
      await this.auth.rememberRegistration(callback.clientId, attempt.tx, attempt.controller.signal);
      const account = await this.exchange(callback, attempt.tx, this.auth.verifier, this.auth.fetch, attempt.controller.signal);
      if (this.attempt !== attempt || attempt.controller.signal.aborted) return;
      if (await this.auth.save(account, attempt.tx, attempt.controller.signal)) {
        this.cancelRequests();
        this.models.clear(); this.outcome = account.scopes.includes('chatgpt.tokens.use.direct') ? 'ChatGPT sign-in completed. Use /provider openai.' : 'Signed in, but plan usage was not granted. Use /openai consent or /openai api-key.';
      } else this.outcome = 'Account selection changed during sign-in; retry /openai login.';
    } catch (error) {
      if (this.attempt === attempt) this.outcome = 'OpenAI sign-in failed. ' + (error.code ? error.message : 'Retry /openai login.')
        + (error.oauthCode === 'invalid_grant' ? '\nAuthorization code rejected. Run /openai login again for a fresh code; the issued client registration is retained. Do not reuse the previous browser URL.' : '');
    }
    finally { attempt.listener.close(); if (this.attempt === attempt) this.attempt = undefined; }
  }
  cancel() { this.attempt?.controller.abort(); this.attempt?.listener?.close(); this.attempt = undefined; this.outcome = 'OpenAI sign-in cancelled.'; }
  dispose() { this.cancel(); }
}
export function openaiCommand(login) {
  return { name: 'openai', description: 'ChatGPT account sign-in and OpenAI billing selection', input: { hint: '[login [new]|status|accounts|use <id>|consent|api-key|models|logout|cancel]' }, handler: async ({ rawInput }) => {
    const [action = 'status', arg] = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean);
    try {
      let text;
      if (action === 'login' || action === 'consent') text = await login.login(action === 'consent' ? 'consent' : arg);
      else if (action === 'status') text = login.status();
      else if (action === 'accounts') text = login.auth.status().accounts.map(a => `${a.clientId}: ${a.email ?? 'ChatGPT account'}${a.access ? '' : ' (signed out)'}`).join('\n') || 'No saved registrations. /openai login';
      else if (action === 'cancel') { login.cancel(); text = login.outcome; }
      else if (action === 'logout') { login.cancel(); login.cancelRequests(); const revoked = await login.auth.logout(); login.models.clear(); text = 'Local ChatGPT tokens removed; the registration is retained for future sign-in.' + (revoked ? '' : '\nRemote revocation was not confirmed. Disconnect DSCODE at https://chatgpt.com/settings/usage'); }
      else if (action === 'api-key' || action === 'use' && arg) { login.cancel(); login.cancelRequests(); await login.auth.select(action === 'api-key' ? 'api-key' : 'chatgpt', arg); login.models.clear(); text = login.status(); }
      else if (action === 'models') { const models = await login.models.list(true); text = [login.models.discovered ? 'OpenAI account model catalog' : 'Fallback catalog; access is unverified.', login.models.error, ...models.map(m => `${m.id}: ${m.tiers.map(t => t.id).join('/')} speed; ${m.contextWindow} context; auto-compact at 272000 tokens or earlier for smaller models`)].filter(Boolean).join('\n'); }
      else return { kind: 'error', text: 'Usage: /openai [login [new]|status|accounts|use <id>|consent|api-key|models|logout|cancel]' };
      return { kind: 'success', text };
    } catch (error) { return { kind: 'error', text: error.code ? error.message : 'OpenAI operation failed. Check account selection and retry.' }; }
  } };
}
