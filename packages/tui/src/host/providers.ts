/**
 * Provider configuration on the Host: model-provider settings and credentials,
 * provider login flows (interactive, over a stream), the OpenRouter account
 * panel and DSCODE custom providers. Credential values are resolved here and
 * never sent to the terminal.
 *
 * @module dsh-code/host/providers
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { AuthorizationDeclinedError, type AuthorizationNotice, type AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import {
  MANAGEMENT_REF, loadOpenRouterAccount, verifyManagementKey,
} from '../../../../plugins/providers/openrouter-account.mjs'
import { getCustomProviders } from '../../../../plugins/custom/index.mjs'
import {
  beginProviderAuthorization, cancelProviderAuthorization, loadProviderAuthorizations, logoutProviderAuthorization,
  subscribeProviderAuthorizations, type ProviderAuthorizationRow,
} from '../authorization.ts'
import {
  discoverProviderModels, loadProviderSettings, removeProviderSettings, saveProviderConfiguration, saveProviderCredential,
  subscribeProviderSettings, unsetProviderCredential, type ProviderConfiguration, type ProviderTargetView,
} from '../provider-settings.ts'
import { RemoteFailure, type DscodeRemoteRegistry } from './registry.ts'

/** Items of the `authorization/begin` stream (Host to terminal). */
export type AuthorizationStreamItem =
  | { readonly type: 'notify'; readonly notice: AuthorizationNotice }
  | { readonly type: 'prompt'; readonly id: number; readonly prompt: AuthorizationPrompt }
  | { readonly type: 'done'; readonly status: string }

/** Uplink items of the `authorization/begin` stream (terminal to Host). */
export type AuthorizationUplinkItem =
  | { readonly type: 'answer'; readonly id: number; readonly value: string }
  | { readonly type: 'decline'; readonly id: number }

async function secret(ctx: Context, ref: string): Promise<string | undefined> {
  const hit = await ctx.get('credentials')?.resolve(credentialRef(ref))
  return typeof hit?.value === 'string' && hit.value.length > 0 ? hit.value : undefined
}

/** A revision counter that advances on every change `subscribe` reports. */
function revisions(subscribe: (push: () => void) => () => void, signal: AbortSignal): AsyncIterable<number> {
  return (async function* () {
    let revision = 0, seen = -1
    let wake: (() => void) | undefined
    const off = subscribe(() => { revision += 1; wake?.() })
    const aborted = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    try {
      while (!signal.aborted) {
        if (revision !== seen) { seen = revision; yield revision; continue }
        await Promise.race([new Promise<void>(resolve => { wake = resolve }), aborted])
      }
    } finally { off() }
  })()
}

function custom(ctx: Context) {
  const client = getCustomProviders(ctx)
  if (client === undefined) throw new RemoteFailure('dscode/custom-unavailable', 'custom providers are not mounted')
  return client
}

export function registerProviders(ctx: Context, registry: DscodeRemoteRegistry): (() => void)[] {
  return [
    registry.method('providers/directory', () => loadProviderSettings(ctx)),
    registry.stream('providers/watch', (_args, { signal }) => revisions(push => subscribeProviderSettings(ctx, push), signal)),
    registry.method('providers/saveCredential', ({ target, key }: { target: ProviderTargetView; key: string }) => saveProviderCredential(ctx, target, key).then(() => null)),
    registry.method('providers/saveConfiguration', ({ target, configuration }: { target: ProviderTargetView; configuration: ProviderConfiguration }) => saveProviderConfiguration(ctx, target, configuration).then(() => null)),
    registry.method('providers/discover', ({ target, request }: { target: ProviderTargetView; request: Parameters<typeof discoverProviderModels>[2] }, { signal }) => discoverProviderModels(ctx, target, request, signal)),
    registry.method('providers/unsetCredential', ({ target }: { target: ProviderTargetView }) => unsetProviderCredential(ctx, target).then(() => null)),
    registry.method('providers/remove', ({ target }: { target: ProviderTargetView }) => removeProviderSettings(ctx, target).then(() => null)),

    registry.method('authorization/directory', () => loadProviderAuthorizations(ctx)),
    registry.stream('authorization/watch', (_args, { signal }) => revisions(push => subscribeProviderAuthorizations(ctx, push), signal)),
    registry.method('authorization/cancel', ({ key }: { key: ProviderAuthorizationRow['key'] }) => { cancelProviderAuthorization(ctx, key); return null }),
    registry.method('authorization/logout', ({ row }: { row: ProviderAuthorizationRow }) => logoutProviderAuthorization(ctx, row).then(() => null)),
    // One login attempt: notices and prompts flow down, answers flow up.
    registry.stream('authorization/begin', ({ key, method }: { key: ProviderAuthorizationRow['key']; method: string }, { signal, uplink }) => (async function* () {
      const out: AuthorizationStreamItem[] = []
      let wake: (() => void) | undefined
      const emit = (item: AuthorizationStreamItem): void => { out.push(item); wake?.() }
      const answers = new Map<number, { resolve(value: string): void; reject(error: Error): void }>()
      let nextId = 0
      void (async () => {
        for await (const raw of uplink) {
          const item = raw as AuthorizationUplinkItem
          const waiting = answers.get(item.id)
          if (waiting === undefined) continue
          answers.delete(item.id)
          if (item.type === 'answer') waiting.resolve(item.value)
          else waiting.reject(new AuthorizationDeclinedError())
        }
      })().catch(() => {})
      let done = false
      const attempt = beginProviderAuthorization(ctx, { key }, method, {
        notify: notice => emit({ type: 'notify', notice }),
        prompt: prompt => new Promise<string>((resolve, reject) => {
          const id = nextId++
          answers.set(id, { resolve, reject })
          emit({ type: 'prompt', id, prompt })
        }),
      }, signal).then(status => { emit({ type: 'done', status: String(status) }) }).finally(() => { done = true; wake?.() })
      const aborted = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      while (!signal.aborted) {
        while (out.length > 0) {
          const item = out.shift()!
          yield item
          if (item.type === 'done') return
        }
        if (done) { await attempt; return }
        await Promise.race([new Promise<void>(resolve => { wake = resolve }), aborted])
      }
    })()),

    registry.method('openrouter/managementKeyStatus', async () => {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) return { state: 'unavailable' }
      try {
        const facts = await credentials.describe(MANAGEMENT_REF)
        if (facts?.configured) return { state: facts.source === 'env' ? 'env' : 'saved' }
        return { state: facts?.writable === false ? 'readonly' : 'missing' }
      } catch {
        return { state: 'error' }
      }
    }),
    registry.method('openrouter/saveManagementKey', async ({ key }: { key: string }) => {
      const credentials = ctx.get('credentials')
      if (typeof credentials?.set !== 'function') throw new RemoteFailure('dscode/credentials-unavailable', 'Credential storage is unavailable.')
      await verifyManagementKey(key)
      await credentials.set(MANAGEMENT_REF, key)
      return null
    }),
    registry.method('openrouter/account', async () => {
      const [apiKey, managementKey] = await Promise.all(['OPENROUTER_API_KEY', MANAGEMENT_REF].map(ref => secret(ctx, ref)))
      return loadOpenRouterAccount({ apiKey, managementKey })
    }),

    registry.method('custom/available', () => getCustomProviders(ctx) !== undefined),
    registry.method('custom/list', () => custom(ctx).list()),
    registry.method('custom/save', ({ profile, key, revision }) => custom(ctx).save(profile, key, revision)),
    registry.method('custom/remove', ({ id, revision }) => custom(ctx).remove(id, revision)),
    registry.method('custom/discover', ({ profile, key }, { signal }) => custom(ctx).discover(profile, key, signal)),
    registry.method('custom/test', ({ profile, model, key }, { signal }) => custom(ctx).test(profile, model, key, signal)),
  ]
}
