import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { readLanguage } from '../i18n/messages.mjs';
import { dscodeVersion } from '../opencode-go/version.mjs';
import { canonicalProvider, providerSpec } from '../providers/catalog.mjs';
import { statusSelection } from './selection.mjs';

const words = {
  en: { title: 'DSCODE status', provider: 'Provider', model: 'Model', balance: 'Account balance', key: 'This key remaining limit', unlimited: 'No key spending cap (not an unlimited account balance)', budget: 'Effective budget remaining', recharge: 'Recharge balance', bonus: 'Bonus balance', missing: 'Credentials are not configured.', unsupported: 'Balance lookup is not supported for this provider or endpoint.', failed: 'Balance unavailable. Check your connection or provider account and retry.', denied: 'The provider refused this credential for balance lookup.', timeout: 'Balance lookup timed out. Retry /status.', available: 'Account available', yes: 'yes', no: 'no', checked: 'Checked', usage: 'Usage: /status', unknown: 'unavailable' },
  'zh-CN': { title: 'DSCODE 状态', provider: '服务商', model: '模型', balance: '账户余额', key: '当前 key 剩余额度', unlimited: '此 key 未设消费上限（不代表账户余额无限）', budget: '当前有效预算剩余', recharge: '充值余额', bonus: '赠送余额', missing: '尚未配置凭据。', unsupported: '此服务商或接口暂不支持余额查询。', failed: '余额暂不可用，请检查网络或服务商账户后重试。', denied: '服务商拒绝使用当前凭据查询余额。', timeout: '余额查询超时，请重试 /status。', available: '账户可用', yes: '是', no: '否', checked: '查询时间', usage: '用法：/status', unknown: '暂不可用' },
};
const decimal = value => (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value));
const money = (value, currency) => decimal(value) && ['USD', 'CNY'].includes(currency) ? `${value} ${currency}` : undefined;

/** Resolve the same configured reference as the active route, never a different saved key. */
export function statusConnection(ctx, provider) {
  const entry = ctx.llm.listConfigurableProviders().find(item => item.provider === provider);
  if (entry) {
    const descriptor = ctx.get('settings')?.describe({ redactSecrets: true }).find(item => item.ns === entry.settingsNs);
    const profile = entry.settingsPath.reduce((value, key) => value?.[key], descriptor?.value);
    if (!profile || typeof profile.apiKeyEnv !== 'string') return undefined;
    return { ref: profile.apiKeyEnv, baseURL: profile.baseURL };
  }
  const ref = providerSpec(provider)?.credentialRef;
  return ref ? { ref } : undefined;
}

function officialEndpoint(ctx, provider, baseURL) {
  const fallback = provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.deepseek.com/anthropic';
  const configured = baseURL ?? (provider === 'deepseek-official' ? launchEnvironmentOf(ctx).get('DEEPSEEK_BASE_URL')?.value : undefined);
  const url = new URL(configured ?? fallback);
  const expected = new URL(fallback);
  return url.origin === expected.origin && !url.username && !url.password && !url.search && !url.hash
    && (provider === 'openrouter' ? /^\/api\/v1\/?$/.test(url.pathname) : /^\/(?:anthropic\/?|v1\/?)?$/.test(url.pathname));
}

async function json(url, key, fetchImpl, signal) {
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal, redirect: 'error' });
  if (!response.ok) throw Object.assign(new Error('Balance query failed'), { status: response.status });
  return response.json();
}

/** No shared balance cache: every invocation belongs to this exact route and credential. */
export async function providerStatus(ctx, selection, { signal, fetch: fetchImpl = globalThis.fetch, locale = readLanguage(), timeoutMs = 8000 } = {}) {
  const w = words[locale] ?? words.en;
  const provider = selection?.provider, model = selection?.model;
  const lines = [`${w.title}`, `${w.provider}: ${provider ?? w.unknown}`, `${w.model}: ${model ?? w.unknown}`];
  const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
  const run = async () => {
    const route = canonicalProvider(provider);
    if (route === 'deepseek-account') {
      const account = ctx.get('deepseekAccount');
      if ((await account?.getState())?.status !== 'credential-stored') return [w.missing];
      const balance = await account.getBalance({ version: dscodeVersion(), locale, timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 });
      if (balance?.status !== 'ready') return [w.failed];
      const result = [];
      for (const [label, wallets] of [[w.recharge, balance.value], [w.bonus, balance.bonusWallets]]) {
        for (const wallet of wallets ?? []) {
          const amount = money(wallet.balance, wallet.currency);
          if (amount !== undefined) result.push(`${label}: ${amount}`);
        }
      }
      return result.length ? result : [w.failed];
    }
    if (!['deepseek-official', 'openrouter'].includes(route)) return [w.unsupported];
    const connection = statusConnection(ctx, provider);
    if (!connection) return [w.failed];
    if (!officialEndpoint(ctx, route, connection.baseURL)) return [w.unsupported];
    const credentials = ctx.get('credentials');
    const key = credentials ? (await credentials.resolve(connection.ref))?.value : launchEnvironmentOf(ctx).get(connection.ref)?.value;
    if (!key) return [w.missing];
    if (route === 'deepseek-official') {
      const body = await json('https://api.deepseek.com/user/balance', key, fetchImpl, deadline);
      const amounts = (Array.isArray(body?.balance_infos) ? body.balance_infos : []).flatMap(info => {
        const amount = money(info.total_balance, info.currency);
        return amount === undefined ? [] : [`${w.balance}: ${amount}`];
      });
      if (!amounts.length) return [w.failed];
      if (typeof body.is_available === 'boolean') amounts.push(`${w.available}: ${body.is_available ? w.yes : w.no}`);
      return amounts;
    }
    // Never borrow a management key: it may belong to a different account.
    const [credits, keyInfo] = await Promise.allSettled([
      json('https://openrouter.ai/api/v1/credits', key, fetchImpl, deadline),
      json('https://openrouter.ai/api/v1/key', key, fetchImpl, deadline),
    ]);
    const result = [];
    const data = credits.status === 'fulfilled' ? credits.value?.data : undefined;
    const remaining = decimal(data?.total_credits) && decimal(data?.total_usage) ? Number(data.total_credits) - Number(data.total_usage) : NaN;
    result.push(`${w.balance}: ${Number.isFinite(remaining) ? `${Number(remaining.toFixed(8))} USD` : w.unknown}`);
    const current = keyInfo.status === 'fulfilled' ? keyInfo.value?.data : undefined;
    result.push(`${w.key}: ${current?.limit === null && current?.limit_remaining === null ? w.unlimited : money(current?.limit_remaining, 'USD') ?? w.unknown}`);
    const effective = money(current?.effective_budget?.remaining_usd, 'USD');
    if (effective !== undefined) result.push(`${w.budget}: ${effective}`);
    if (credits.status === 'rejected' && keyInfo.status === 'rejected') throw keyInfo.reason;
    return result;
  };
  let onAbort;
  try {
    deadline.throwIfAborted();
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(deadline.reason);
      deadline.addEventListener('abort', onAbort, { once: true });
    });
    lines.push(...await Promise.race([run(), cancelled]));
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    lines.push(deadline.aborted ? w.timeout : [401, 403].includes(error?.status) ? w.denied : w.failed);
  } finally {
    if (onAbort) deadline.removeEventListener('abort', onAbort);
  }
  return [...lines, `${w.checked}: ${new Date().toISOString()}`].join('\n');
}

export function registerStatus(ctx) {
  ctx.commands.register({ name: 'status', description: 'Show the current provider, model and available balance', handler: async ({ agent, rawInput, signal }) => {
    if (rawInput.trim()) return { kind: 'error', text: (words[readLanguage()] ?? words.en).usage };
    const selection = statusSelection(agent);
    return { kind: 'success', text: await providerStatus(ctx, selection, { signal }) };
  } });
}

/** Only a standalone text command is intercepted; paths and attached prompts stay model input. */
export async function acpStatus(ctx, selection, prompt, signal) {
  if (prompt.length !== 1 || prompt[0].type !== 'text' || !/^\/status(?:\s|$)/.test(prompt[0].text.trim())) return undefined;
  if (prompt[0].text.trim() !== '/status') return (words[readLanguage()] ?? words.en).usage;
  return providerStatus(ctx, selection, { signal });
}
