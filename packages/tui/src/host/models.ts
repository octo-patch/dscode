/**
 * Model operations on the Host: the deployment default, the /model directory,
 * persisting a pick, the compaction preview, the /subagent override and the
 * subagent route it steers, plus the background capability sync.
 *
 * @module dsh-code/host/models
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ensureProviderRoute, migrateOpenRouterProfile } from '../../../../plugins/providers/catalog.mjs'
import { statusSelection } from '../../../../plugins/status/selection.mjs'
import {
  compactionPreview, effectiveContextWindow, pricedThresholdRatio,
} from '../../../../plugins/compaction/threshold.mjs'
import { syncModelCapabilities } from '../model-capabilities.ts'
import { applyModelSelectionToConfig, loadModelDirectory, resolveEffectiveSelection, type ModelRow } from '../models.ts'
import { liveAgent } from './agents.ts'
import { publishNotice } from './notices.ts'
import { RemoteFailure, watch, type DscodeRemoteRegistry } from './registry.ts'

export function registerModels(ctx: Context, registry: DscodeRemoteRegistry): (() => void)[] {
  const defaultModel = () => {
    const service = ctx.get('agentDefaultModel')
    if (service === undefined) throw new RemoteFailure('dscode/models-unavailable', 'the default model service is not mounted')
    return service
  }
  const defaults = (): ModelSelection => defaultModel().currentSelection()

  // /subagent: one Host-wide override for delegated agents; undefined follows the root.
  let subagentOverride: ModelSelection | undefined

  // Subagent model routing. The kernel seeds child agents from the parent's
  // CREATE-TIME options, which a mid-session /model switch never touches, so
  // delegated work would keep the launch-time route. The explicit /subagent
  // override wins; otherwise a child follows its root's effective selection
  // (explicit pick > request header > options). Effort rides the selection.
  // A child's options inherit the root's create-time options, so a value that
  // differs from the root's was chosen for the child itself (the subagent
  // tool's model or reasoning_effort) and is kept.
  const offReroute = ctx.on('agent/request', (payload, next) => {
    const subject = payload.agent
    const header = subject.session.header
    if (header.parentSession === undefined && header.origin !== 'subagent') return next()
    const root = header.parentSession === undefined ? undefined : liveAgent(ctx, header.parentSession)
    const own = subject.options as Partial<ModelSelection>
    const rootOptions = root?.options as Partial<ModelSelection> | undefined
    if (subagentOverride === undefined && rootOptions !== undefined && (own.provider !== rootOptions.provider || own.model !== rootOptions.model)) return next()
    let picked = subagentOverride
      ?? (root === undefined
        ? resolveEffectiveSelection(undefined, subject.session.requestHeader()?.config, defaults())
        : statusSelection(root) as ModelSelection)
    if (subagentOverride === undefined && own.reasoningEffort !== undefined && own.reasoningEffort !== rootOptions?.reasoningEffort) {
      picked = { ...picked, reasoningEffort: own.reasoningEffort }
    }
    return next().then(resolved => applyModelSelectionToConfig(resolved, picked))
  })

  // Same-id capability inheritance, materialized over the settings path; the
  // debounce coalesces the settings/adapters event pair.
  let syncTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleSync = (): void => {
    if (syncTimer !== undefined) clearTimeout(syncTimer)
    syncTimer = setTimeout(() => {
      syncTimer = undefined
      void syncModelCapabilities(ctx, (text, tone) => publishNotice(ctx, text, tone))
    }, 400)
  }
  const offSync = [ctx.on('settings/document-updated', scheduleSync), ctx.on('llm/adapters-updated', scheduleSync)]
  scheduleSync()

  return [
    offReroute,
    ...offSync,
    () => { if (syncTimer !== undefined) clearTimeout(syncTimer) },
    registry.stream('models/defaults', (_args, { signal }) => watch(signal, defaults, push => {
      const offs = [ctx.on('settings/document-updated', push), ctx.on('llm/adapters-updated', push)]
      return () => { for (const off of offs) off() }
    })),
    registry.method('models/directory', async () => {
      await migrateOpenRouterProfile(ctx.get('settings'))
      return loadModelDirectory(ctx)
    }),
    registry.method('models/ensureRoute', ({ provider }: { provider: string }) => ensureProviderRoute(ctx.get('settings'), provider)),
    // Persist a pick as the deployment default (web selectModel parity) and run
    // the request pipeline's local resolution, so a withdrawn effort surfaces now.
    registry.method('models/save', async ({ selection }: { selection: ModelSelection }) => {
      let saveError: string | undefined
      let rejected: string | undefined
      try { await defaultModel().saveSelection(selection) } catch (error) { saveError = error instanceof Error ? error.message : String(error) }
      const llm = ctx.get('llm') as { resolveCallConfig?: (this: unknown, config: ModelSelection) => Promise<unknown> } | undefined
      if (llm !== undefined && typeof llm.resolveCallConfig === 'function') {
        try { await llm.resolveCallConfig.call(llm, selection) } catch (error) { rejected = error instanceof Error ? error.message : String(error) }
      }
      return { ...(saveError === undefined ? {} : { saveError }), ...(rejected === undefined ? {} : { rejected }) }
    }),
    // Measure the picked route against the live context so /model can ask
    // before a switch that would compact the conversation.
    registry.method('models/compactionPreview', async ({ sessionId, row }: { sessionId: string; row: ModelRow }) => {
      const meter = ctx.get('tokenMeter') as { measure?: (session: unknown) => { totalTokens: number } } | undefined
      const llm = ctx.get('llm') as { resolveModelInfo?: (provider: string, model: string) => Promise<{ context?: { contextWindow?: number }; defaultMaxTokens?: number } | undefined> } | undefined
      const session = ctx.get('sessions')?.get(SessionId(sessionId))
      if (session === undefined || typeof meter?.measure !== 'function' || typeof llm?.resolveModelInfo !== 'function') return null
      const info = await llm.resolveModelInfo(row.provider, row.model)
      return compactionPreview({
        provider: row.provider,
        model: row.model,
        used: meter.measure(session).totalTokens,
        contextWindow: effectiveContextWindow(info?.context, info),
        thresholdRatio: await pricedThresholdRatio(row.provider, row.model),
        label: row.provider + '/' + row.model,
      })
    }),
    registry.method('models/subagentOverride', ({ selection }: { selection?: ModelSelection | null }) => {
      subagentOverride = selection ?? undefined
      return null
    }),
  ]
}
