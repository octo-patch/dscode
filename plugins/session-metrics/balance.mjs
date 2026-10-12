import { createHash } from 'node:crypto';
import { OPENROUTER_API, parseOpenRouterCredits, parseOpenRouterKeyRemaining } from '../providers/openrouter-account.mjs';

export { parseOpenRouterCredits, parseOpenRouterKeyRemaining };

// Remaining provider balance, refreshed on a long cache. DeepSeek's response
// also carries the trusted clock: its `Date` header anchors peak/off-peak pricing
// without a second network call. OpenRouter has no peak window. Its account
// credits (`/credits`) are documented as management-only but are served to
// inference keys too; a key refused them falls back to its own remaining limit (`/key`).
const SOURCES = {
  'deepseek-official': { env: 'DEEPSEEK_API_KEY', clock: true, requests: ({ key }) => [{ url: 'https://api.deepseek.com/user/balance', key, source: 'account', parse: parseBalanceInfo }] },
  openrouter: { env: 'OPENROUTER_API_KEY', managementEnv: 'OPENROUTER_MANAGEMENT_KEY', clock: false, requests: ({ key, managementKey }) => [
    { url: `${OPENROUTER_API}/credits`, key: managementKey || key, source: 'account', parse: body => usdBalance(parseOpenRouterCredits(body), 'account') },
    { url: `${OPENROUTER_API}/key`, key, source: 'key-limit', parse: body => usdBalance(parseOpenRouterKeyRemaining(body), 'key-limit') },
  ] },
};
export const BALANCE_PROVIDERS = Object.freeze(Object.keys(SOURCES));
const CACHE_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const snapshots = new Map();
let clock = { anchor: null, skewMs: 0 };
const snapshotOf = provider => snapshots.get(provider) ?? { balance: null, fetchedAt: 0, pending: false };

const usdBalance = (amount, source) => amount === null ? null : Object.freeze({ amount, currency: 'USD', source });

function parseBalanceInfo(body) {
  if (body?.is_available === false) return null;
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  const balances = infos.flatMap(info => {
    const value = info?.total_balance, currency = String(info?.currency ?? '').toUpperCase();
    if (!(typeof value === 'number' || typeof value === 'string' && value.trim()) || !/^[A-Z]{3}$/.test(currency)) return [];
    const amount = Number(value);
    return Number.isFinite(amount) && amount >= 0 ? [Object.freeze({ amount, currency, source: 'account' })] : [];
  });
  return balances.find(info => info.currency === 'USD') ?? balances[0] ?? null;
}

/** Numeric projection retained for callers that do not render currency or source. */
export function parseBalance(body) { return parseBalanceInfo(body)?.amount ?? null; }
export function balanceNow(provider = 'deepseek-official') { return balanceInfoNow(provider)?.amount ?? null; }
export function balanceInfoNow(provider = 'deepseek-official') { return snapshotOf(provider).balance; }
export function invalidateBalance(provider) { snapshots.delete(provider); }
export function formatBalance(balance, digits = 2) {
  if (!balance) return '';
  return balance.currency === 'USD' ? `$${balance.amount.toFixed(digits)}` : `${balance.amount.toFixed(digits)} ${balance.currency}`;
}
/** Clock anchored to the last DeepSeek balance response's `Date` header, else the local one. */
export function trustedNow() {
  const local = Date.now();
  return clock.anchor === null ? local : local + clock.skewMs;
}

/** Refresh one provider at most once per cache window; never throws into the render path. */
export async function refreshBalance(options = {}) {
  const provider = options.provider ?? 'deepseek-official';
  const source = SOURCES[provider];
  if (!source) return null;
  const key = Object.hasOwn(options, 'key') ? options.key : process.env[source.env];
  const managementKey = Object.hasOwn(options, 'managementKey') ? options.managementKey : source.managementEnv ? process.env[source.managementEnv] : undefined;
  const requests = source.requests({ key, managementKey }).filter(request => request.key);
  const identity = createHash('sha256').update(JSON.stringify(requests.map(({ url, key }) => [url, key]))).digest('hex');
  let snapshot = snapshots.get(provider);
  if (!snapshot || snapshot.identity !== identity) {
    snapshot = { balance: null, fetchedAt: 0, pending: false, identity };
    snapshots.set(provider, snapshot);
  }
  const now = Date.now();
  if (requests.length === 0) return null;
  if (snapshot.pending || snapshot.fetchedAt && now - snapshot.fetchedAt < CACHE_MS) return balanceNow(provider);
  const retrySoon = () => Date.now() - (CACHE_MS - RETRY_MS);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return balanceNow(provider);
  snapshot.pending = true;
  try {
    let response, body, request;
    for (request of requests) {
      response = await fetchImpl(request.url, { headers: { Authorization: `Bearer ${request.key}`, Accept: 'application/json' } });
      try { body = await response.json(); } catch { body = undefined; }
      if (snapshots.get(provider) !== snapshot) return balanceNow(provider);
      // A key refused this reading falls through to the next source.
      if (response.ok || (response.status !== 401 && response.status !== 403)) break;
      if (snapshot.balance?.source === request.source) snapshot.balance = null;
    }
    const header = source.clock ? response.headers?.get?.('date') : null;
    const anchor = header ? Date.parse(header) : NaN;
    const parsed = response.ok ? request.parse(body) : null;
    if (Number.isFinite(anchor)) clock = { anchor, skewMs: anchor - Date.now() };
    snapshot.balance = response.ok ? parsed : snapshot.balance?.source === request.source ? snapshot.balance : null;
    snapshot.fetchedAt = parsed === null ? retrySoon() : Date.now();
  } catch {
    // A transient failure keeps the last known balance and retries sooner.
    if (snapshots.get(provider) === snapshot) snapshot.fetchedAt = retrySoon();
  } finally {
    snapshot.pending = false;
  }
  return balanceNow(provider);
}
