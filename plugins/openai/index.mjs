import { registerStartupCommand } from '../providers/startup-commands.mjs';
import z from '@deepseek-ai/schemastery';
import { dirname, join } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { RetryPolicySchema, resolveRetryPolicy, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
import { plainConfig } from '../cordis-config/plain.mjs';
import { currentCharge } from '../session-metrics/attribution.mjs';
import { OpenAIStore } from './store.mjs';
import { IdentityVerifier } from './oauth.mjs';
import { OpenAIAuth } from './auth.mjs';
import { OpenAIModels } from './models.mjs';
import { OpenAIAdapter } from './adapter.mjs';
import { OpenAILogin, openaiCommand } from './command.mjs';
import { speedCommand, selectedSpeed, speedState, canonicalSpeed, setSpeedSource } from './speed.mjs';
export const name = 'dscode-openai';
export const inject = ['llm','credentials'];
export const Config = z.object({
  apiKeyEnv: z.union(['OPENAI_API_KEY']).role('credential-ref').default('OPENAI_API_KEY').volatile(),
  serviceTier: z.union(['default','fast','ultrafast']).default('default').volatile(),
  headerTimeoutMs: z.number().min(1).default(30000).volatile(),
  streamIdleTimeoutMs: z.number().min(1).default(120000).volatile(),
  retryPolicy: RetryPolicySchema.volatile(),
});
export function apply(ctx, config = {}) {
  ctx.inject(['settings'], scoped => scoped.effect(() => scoped.settings.configure({ auto: false }, ctx.fiber)));
  const options = () => { const value = plainConfig(config); return { serviceTier: value.serviceTier ?? 'default', headerTimeoutMs: value.headerTimeoutMs ?? 30000, streamIdleTimeoutMs: value.streamIdleTimeoutMs ?? 120000, retryPolicy: resolveRetryPolicy(value.retryPolicy, name) }; };
  const directory = ctx.credentials.desktop ? resolveDshHome() : dirname(ctx.credentials.sharedConfig?.path ?? join(resolveDshHome(), 'credentials.yaml'));
  const store = new OpenAIStore(join(directory, 'openai'));
  const service = { fetch: (...args) => globalThis.fetch(...args), options };
  const requests = new Set();
  const cancelRequests = () => { for (const controller of requests) controller.abort(); };
  ctx.effect(() => cancelRequests);
  const fetcher = (...args) => service.fetch(...args);
  service.auth = new OpenAIAuth({ store, apiKey: async () => (await ctx.credentials.resolve('OPENAI_API_KEY'))?.value, verifier: new IdentityVerifier(fetcher), fetch: fetcher });
  service.models = new OpenAIModels(service.auth, fetcher);
  service.login = new OpenAILogin({ auth: service.auth, models: service.models, cancelRequests });
  const session = options => ctx.get('agents')?.get(options.sessionId ?? currentCharge()?.sessionId)?.session;
  const adapter = new OpenAIAdapter({ auth: service.auth, models: service.models, options, fetch: fetcher,
    registerRequest: controller => { requests.add(controller); return () => requests.delete(controller); },
    speed: request => selectedSpeed(session(request), options().serviceTier),
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: ref => { const attachments = ctx.get('attachments'); return attachments && resolveImageAttachmentAccess(attachments, path => ctx.get('fs')?.processPathFromHostPath(path), ref); },
  });
  ctx.provide('dscodeOpenAI', service);
  ctx.effect(() => () => service.login.dispose());
  ctx.inject(['commands'], scoped => { registerStartupCommand(scoped, openaiCommand(service.login)); registerStartupCommand(scoped, speedCommand(service)); });
  ctx.inject(['agents'], scoped => scoped.effect(() => setSpeedSource((id, label) => {
    const agent = scoped.agents.get(id); if (!agent) return '';
    const route = agent.session.requestHeader()?.config ?? agent.options;
    if (route.provider !== 'openai' || label && !label.includes(route.model)) return '';
    const state = speedState(agent.session, route.model, options().serviceTier), selected = canonicalSpeed(state.requested);
    return state.actual ? selected === canonicalSpeed(state.actual) ? selected : `${selected} → ${canonicalSpeed(state.actual)}` : `${selected} (unconfirmed)`;
  })));
  ctx.llm.registerConfigurableProviders([{ provider: 'openai', displayName: 'OpenAI / ChatGPT', settingsNs: ctx.fiber.entry?.options.id ?? name, settingsPath: [] }]);
  const registration = ctx.llm.registerAdapter(['openai'], adapter);
  let policy = JSON.stringify(options().retryPolicy);
  ctx.on('loader/volatile-update', () => { const next = JSON.stringify(options().retryPolicy); if (next !== policy) { registration.replace(['openai']); policy = next; } });
}
