import z from '@deepseek-ai/schemastery';
import { LlmError, RetryPolicySchema, assertUsableApiKey, resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { deepEqualJson } from '@deepseek-ai/dsh-util-values';
import { plainConfig } from '../cordis-config/plain.mjs';
import { AnthropicAdapter } from './adapter.mjs';

export const name = 'dscode-anthropic';
export const inject = ['llm'];
const BASE_URL = 'https://api.anthropic.com/v1';
export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default('ANTHROPIC_API_KEY').volatile(),
  baseURL: z.string().default(BASE_URL).volatile(),
  streamIdleTimeoutMs: z.number().min(1).default(300000).volatile(),
  retryPolicy: RetryPolicySchema.volatile(),
});

export function resolveOptions(config = {}) {
  const url = new URL(config.baseURL || BASE_URL);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Anthropic base URL must use HTTP(S) without credentials, query or fragment');
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 300000;
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) throw Error('Anthropic idle timeout must be positive');
  return { baseURL: url.href.replace(/\/+$/, ''), apiKeyEnv: credentialRef(config.apiKeyEnv || 'ANTHROPIC_API_KEY'),
    streamIdleTimeoutMs, retryPolicy: resolveRetryPolicy(config.retryPolicy, name + ': retryPolicy') };
}

export function apply(ctx, config = {}) {
  ctx.inject(['settings'], scoped => scoped.effect(() => scoped.settings.configure({ auto: false }, ctx.fiber)));
  let lastGood;
  const options = () => {
    try { lastGood = resolveOptions(plainConfig(config)); }
    catch (error) {
      if (!lastGood) throw error;
      ctx.logger.warn('Anthropic: retaining the last valid configuration');
    }
    return lastGood;
  };
  options();
  const adapter = new AnthropicAdapter({ options,
    resolveApiKey: async connection => {
      const credentials = ctx.get('credentials');
      const key = credentials ? (await credentials.resolve(connection.apiKeyEnv))?.value : launchEnvironmentOf(ctx).get(connection.apiKeyEnv)?.value;
      if (key) return assertUsableApiKey(key, name, connection.apiKeyEnv);
      throw new LlmError('Anthropic needs an API key; run /login anthropic or set ANTHROPIC_API_KEY', 'MISSING_CREDENTIAL');
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, path => ctx.get('fs')?.processPathFromHostPath(path), ref),
  });
  ctx.llm.registerConfigurableProviders([{ provider: 'anthropic', displayName: 'Anthropic', settingsNs: ctx.fiber.entry?.options.id ?? 'llm-anthropic', settingsPath: [] }]);
  const registration = ctx.llm.registerAdapter(['anthropic'], adapter);
  let policy = options().retryPolicy;
  ctx.on('loader/volatile-update', () => {
    const next = options().retryPolicy;
    if (!deepEqualJson(policy, next)) { registration.replace(['anthropic']); policy = next; }
  });
}
