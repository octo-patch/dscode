import { openBrowser } from '../account/index.mjs';
import { authorize, callbackServer, exchangeCode } from './oauth.mjs';

const message = (locale, en, zh) => locale.startsWith('zh') ? zh : en;

export class AntigravityLogin {
  constructor({ session, client, models, open = openBrowser, callback = callbackServer, exchange = exchangeCode }) {
    Object.assign(this, { session, client, models, open, callback, exchange });
  }
  async status(locale) {
    const grant = await this.session.current();
    return [this.attempt ? message(locale, 'Waiting for Google sign-in in your browser. /antigravity cancel stops it.', '等待浏览器中的 Google 登录。/antigravity cancel 可取消。') : this.outcome,
      grant ? message(locale, 'Antigravity is signed in. Use /provider antigravity. Tokens refresh automatically.', 'Antigravity 已登录。使用 /provider antigravity 切换；凭据会自动续期。')
        : message(locale, 'Antigravity is not signed in. Run /antigravity login.', 'Antigravity 未登录。运行 /antigravity login。')].filter(Boolean).join('\n');
  }
  async login(locale) {
    if (this.attempt) return this.status(locale);
    const attempt = { ...authorize(), controller: new AbortController(), revision: this.session.revision };
    this.attempt = attempt; this.outcome = undefined;
    try {
      attempt.listener = await this.callback(attempt.state, { signal: attempt.controller.signal });
      if (this.attempt !== attempt) { attempt.listener.close(); return this.status(locale); }
      attempt.done = this.follow(attempt, locale);
      await this.open(attempt.url).catch(() => false);
      return message(locale,
        'Complete Google sign-in for Antigravity (community integration). Waiting for up to 5 minutes; /antigravity shows the result. If the browser did not open:',
        '请在浏览器中完成 Antigravity 的 Google 登录（社区接入）。最多等待 5 分钟；/antigravity 查看结果。如果浏览器未打开，请访问：') + '\n' + attempt.url;
    } catch {
      if (this.attempt === attempt) this.attempt = undefined;
      throw new Error(message(locale, 'Could not open the Antigravity login callback on port 51121. Close another pending login and retry.', '无法在 51121 端口启动登录回调。请关闭其他正在等待的登录后重试。'));
    }
  }
  async follow(attempt, locale) {
    try {
      const code = await attempt.listener.code;
      const grant = await this.exchange(code, attempt.verifier, this.client, { fetch: this.client.fetch, signal: attempt.controller.signal });
      if (this.attempt !== attempt || attempt.controller.signal.aborted) return;
      if (await this.session.save(grant, attempt.revision)) {
        this.models.clear();
        this.outcome = message(locale, 'Google sign-in completed. Use /provider antigravity.', 'Google 登录完成。使用 /provider antigravity。');
      }
    } catch {
      if (this.attempt === attempt) this.outcome = message(locale, 'Antigravity sign-in did not complete. Check account setup and retry /antigravity login.', 'Antigravity 登录未完成。请检查账号设置后重试 /antigravity login。');
    } finally {
      attempt.listener.close();
      if (this.attempt === attempt) this.attempt = undefined;
    }
  }
  cancel(locale) {
    this.session.revision++;
    this.attempt?.controller.abort(); this.attempt?.listener?.close(); this.attempt = undefined;
    return this.outcome = message(locale, 'Antigravity sign-in cancelled.', '已取消 Antigravity 登录。');
  }
  async logout(locale) {
    this.cancel(locale); await this.session.logout(); this.models.clear(); this.outcome = undefined;
    return message(locale, 'Removed the DSCODE Antigravity login. Other applications are unchanged.', '已移除 DSCODE 的 Antigravity 登录，其他应用的登录不变。');
  }
  dispose() { this.cancel('en'); }
}

export function antigravityCommand(login, language) {
  return { name: 'antigravity', description: 'Antigravity Google login and Gemini models', input: { hint: '[login|status|models|cancel|logout]' },
    handler: async ({ rawInput }) => {
      const locale = language(), arg = String(rawInput ?? '').trim().toLowerCase();
      try {
        let text;
        if (!arg || arg === 'status') text = await login.status(locale);
        else if (arg === 'login') text = await login.login(locale);
        else if (arg === 'cancel') text = login.cancel(locale);
        else if (arg === 'logout') text = await login.logout(locale);
        else if (arg === 'models') {
          const models = await login.models.list(true);
          text = [login.models.discovered ? 'Antigravity account model catalog' : 'Antigravity fallback catalog (availability not verified)', login.models.error,
            ...models.map(m => `${m.id} · ${Object.keys(m.routes).join('/')} · ${m.contextWindow} context`)].filter(Boolean).join('\n');
        } else return { kind: 'error', text: 'Usage: /antigravity [login|status|models|cancel|logout]' };
        return { kind: 'success', text };
      } catch { return { kind: 'error', text: message(locale, 'Antigravity operation failed. Check port 51121 and account connectivity, then retry.', 'Antigravity 操作失败。请检查 51121 端口和账号连接后重试。') }; }
    } };
}
