/**
 * Child sessions on the Host: /btw side questions (a seeded, read-only child
 * that answers into its own panel) and a stream of every child event and live
 * assistant frame under one root session, which a separate terminal folds into
 * its subagent feed and /btw panel.
 *
 * @module dsh-code/host/children
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, ModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { effortFor } from '../../../../plugins/providers/effort.mjs'
import { statusSelection } from '../../../../plugins/status/selection.mjs'
import { btwBrief, btwSeed } from '../btw.ts'
import { permissionPresetsFrom, selectPermission } from '../permissions.ts'
import { agentPresetsFrom } from '../presets.ts'
import { requireAgent } from './agents.ts'
import { RemoteFailure, type DscodeRemoteRegistry } from './registry.ts'

/** Items of `sessions/children`. */
export type ChildStreamItem =
  | { readonly kind: 'event'; readonly sessionId: string; readonly header: Session['header']; readonly event: SessionEvent }
  | { readonly kind: 'stream'; readonly agentId: string; readonly frame: unknown }

export function registerChildren(ctx: Context, registry: DscodeRemoteRegistry): (() => void)[] {
  const btwHandles = new Map<string, AgentHandle>()
  const disposeBtw = (id: string): void => {
    const handle = btwHandles.get(id)
    btwHandles.delete(id)
    void handle?.dispose().catch(() => {})
  }
  return [
    () => { for (const id of [...btwHandles.keys()]) disposeBtw(id) },
    // The terminal mints the child id so its panel can show the question at once.
    registry.method('btw/start', async ({ sessionId, childId, question, mode }: { sessionId: string; childId: string; question: string; mode: string }, { signal }) => {
      const parentAgent = requireAgent(ctx, sessionId)
      const parent = parentAgent.session
      const agents = ctx.get('agents')
      const presets = agentPresetsFrom(ctx)
      if (agents === undefined || presets === undefined) throw new RemoteFailure('dscode/btw-unavailable', 'side questions are unavailable in this composition')
      const selection = statusSelection(parentAgent) as ModelSelection
      const seed = btwSeed(parent.snapshotEvents())
      const brief = seed.inherited ? '' : btwBrief(parent.snapshotEvents())
      const effort = await effortFor(ctx.get('llm'), { provider: selection.provider, model: selection.model }, 'low', signal)
      const handle = await agents.create({
        sessionId: SessionId(childId),
        parentAgent,
        meta: {
          cwd: parent.header.cwd,
          agentPreset: mode,
          parentSession: parent.id,
          origin: 'subagent',
          delegationDepth: (parent.header.delegationDepth ?? 0) + 1,
          // An inherited prefix needs the seeded marker, or the session store
          // rejects a non-zero inherited event count.
          ...(seed.inherited ? { isSeeded: true } : {}),
        },
        ...(seed.inherited ? { seed: seed.events, inheritedEventCount: SessionLogOffset(seed.events.length) } : {}),
        agentOptions: { provider: selection.provider, model: selection.model, ...(effort === undefined ? {} : { reasoningEffort: effort }) },
        signal,
        // Setup composes the child's world; it never drives it.
        setup: async childCtx => { await presets.mount(childCtx, mode) },
      })
      const permissions = permissionPresetsFrom(ctx)
      if (permissions !== undefined && permissions.names.includes('read-only')) selectPermission(permissions, handle.agent.session, 'read-only')
      btwHandles.set(childId, handle)
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: brief === '' ? question : `${brief}\n\nQuestion: ${question}` }],
        source: { kind: 'user' },
      }))
      return { agentId: handle.agent.id }
    }),
    registry.method('btw/dispose', ({ ids }: { ids: string[] }) => { for (const id of ids) disposeBtw(id); return null }),
    // Child sessions of one root: committed events plus live assistant frames.
    registry.stream('sessions/children', ({ sessionId }: { sessionId: string }, { signal }) => (async function* () {
      const queue: ChildStreamItem[] = []
      let wake: (() => void) | undefined
      const push = (item: ChildStreamItem): void => { queue.push(item); wake?.() }
      const isChild = (session: Session): boolean => session.header.parentSession === sessionId && session.header.origin === 'subagent'
      const offEvent = ctx.on('session/event', (subject: Session, event: SessionEvent) => {
        if (isChild(subject)) push({ kind: 'event', sessionId: subject.id, header: subject.header, event })
      })
      const offStream = ctx.on('agent/assistant-stream', ({ agent, frame }) => {
        if (isChild(agent.session)) push({ kind: 'stream', agentId: agent.id, frame })
      })
      const aborted = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      try {
        while (!signal.aborted) {
          while (queue.length > 0) yield queue.shift()!
          await Promise.race([new Promise<void>(resolve => { wake = resolve }), aborted])
        }
      } finally { offEvent(); offStream() }
    })()),
  ]
}
