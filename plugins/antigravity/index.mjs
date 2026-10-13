import { registerStartupCommand } from '../providers/startup-commands.mjs';
import z from '@deepseek-ai/schemastery';
import { RetryPolicySchema, resolveRetryPolicy, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
import { plainConfig } from '../cordis-config/plain.mjs';
import { readLanguage } from '../i18n/messages.mjs';
import { AntigravityClient } from './client.mjs';
import { AntigravitySession, GRANT_REF } from './oauth.mjs';
import { AntigravityModels, PROVIDER } from './models.mjs';
import { AntigravityAdapter } from './adapter.mjs';
import { AntigravityLogin, antigravityCommand } from './command.mjs';

export const name = 'dscode-antigravity';
export const inject = ['llm', 'credentials'];
export const Config = z.object({
  apiKeyEnv: z.union([GRANT_REF]).role('credential-ref').default(GRANT_REF).volatile(),
  headerTimeoutMs: z.number().min(1).default(30000).volatile(),
  streamIdleTimeoutMs: z.number().min(1).default(120000).volatile(),
  retryPolicy: RetryPolicySchema.volatile(),
});
export function resolveOptions(config = {}) {
  const headerTimeoutMs = config.headerTimeoutMs ?? 30000, streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 120000;
  if (![headerTimeoutMs, streamIdleTimeoutMs].every(n => Number.isFinite(n) && n > 0)) throw new Error('Antigravity timeouts must be positive');
  return { headerTimeoutMs, streamIdleTimeoutMs, retryPolicy: resolveRetryPolicy(config.retryPolicy, name) };
}
export function apply(ctx, config = {}) {
  ctx.inject(['settings'], scoped => scoped.effect(() => scoped.settings.configure({ auto: false }, ctx.fiber)));
  const session = new AntigravitySession({
    read: async () => (await ctx.credentials.resolve(GRANT_REF))?.value,
    write: value => ctx.credentials.set(GRANT_REF, value), remove: () => ctx.credentials.unset(GRANT_REF),
  });
  const client = new AntigravityClient(), models = new AntigravityModels(session, client);
  let last = resolveOptions(plainConfig(config));
  const options = () => { try { last = resolveOptions(plainConfig(config)); } catch { /* retain last valid options */ } return last; };
  const adapter = new AntigravityAdapter({ session, client, models, options,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, path => ctx.get('fs')?.processPathFromHostPath(path), ref),
  });
  const login = new AntigravityLogin({ session, client, models });
  ctx.provide('dscodeAntigravityLogin', login);
  ctx.effect(() => () => login.dispose());
  ctx.inject(['commands'], scoped => registerStartupCommand(scoped, antigravityCommand(login, () => readLanguage())));
  ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: 'Antigravity', settingsNs: ctx.fiber.entry?.options.id ?? name, settingsPath: [] }]);
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
  let policy = JSON.stringify(options().retryPolicy);
  ctx.on('loader/volatile-update', () => {
    const next = JSON.stringify(options().retryPolicy);
    if (next !== policy) { registration.replace([PROVIDER]); policy = next; }
  });
}
