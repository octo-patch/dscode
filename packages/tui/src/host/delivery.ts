/**
 * Message delivery on the Host: one readable message (text plus attachment
 * blocks committed to the Host's attachment store), optionally preceded by the
 * model-facing context a session reference prepared, plus next-turn queue
 * edits and the queue-preserving interrupt.
 *
 * @module dsh-code/host/delivery
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { QueueMutation } from '../app.ts'
import { applyQueueMutation, cancelPreservingQueue } from '../queue.ts'
import { requireAgent, resolveAgent } from './agents.ts'
import { RemoteFailure, type DscodeRemoteRegistry } from './registry.ts'

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item !== null && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')

/** Receipts live in ordinary message sources, including canceled/edited inbox insertions. */
function receipts(agent: ReturnType<typeof requireAgent>): string[] {
  const messages: UserMessage[] = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'user/message') messages.push(event.data as UserMessage)
    if (event.type === 'agent/inbox/spliced') messages.push(...(event.data as { inserted: UserMessage[] }).inserted)
  }
  return messages.flatMap(message => 'rpcId' in message.source && typeof message.source.rpcId === 'string' ? [message.source.rpcId] : [])
}

export function registerDelivery(ctx: Context, registry: DscodeRemoteRegistry): (() => void)[] {
  return [
    // Session snapshots ride the inbox as model-facing context ahead of the
    // readable message: inject before the followup/steer that wakes the driver.
    registry.method('session/deliver', async ({ sessionId, content, mode, context, requestId }: { sessionId: string; content: ContentBlock[]; mode: 'followup' | 'steer'; context?: UserMessage; requestId?: string }, { signal }) => {
      const agent = await resolveAgent(ctx, sessionId, signal)
      const key = requestId === undefined ? undefined : `dscode-delivery:${hash([sessionId, requestId])}:`
      const receipt = key === undefined ? undefined : `${key}${hash({ content, mode, context })}`
      const seen = key === undefined ? [] : receipts(agent)
      if (key !== undefined && seen.some(value => value.startsWith(key) && value !== receipt && value !== `${receipt}:context`)) {
        throw new RemoteFailure('dscode/idempotency-conflict', 'requestId was already used for a different delivery')
      }
      // Admission is synchronous through the durable inbox splice: concurrent
      // callers see its receipt before either caller yields for the flush.
      if (receipt === undefined || !seen.includes(receipt)) {
        if (context !== undefined && (receipt === undefined || !seen.includes(`${receipt}:context`))) {
          const source = { kind: 'user' as const, rpcId: `${receipt}:context` }
          agent.inject(receipt === undefined ? context : { ...context, source })
        }
        const message = createUserMessage({ content, source: receipt === undefined ? { kind: 'user' } : { kind: 'user', rpcId: receipt } })
        if (mode === 'steer') agent.steer(message)
        else agent.followup(message)
      }
      // Retries also flush: a failed durability barrier must not be acknowledged
      // merely because the accepted message is still visible in memory.
      if (receipt !== undefined) await ctx.get('sessions')?.flush(agent.session)
      return null
    }),
    registry.method('session/updateQueued', async ({ sessionId, messageId, action }: { sessionId: string; messageId: string; action: QueueMutation }, { signal }) => {
      const agent = await resolveAgent(ctx, sessionId, signal)
      const outcome = applyQueueMutation(agent.inbox, agent.status, messageId, action, message => agent.steer(message))
      if (['removed', 'edited', 'steered'].includes(outcome)) await ctx.get('sessions')?.flush(agent.session)
      return outcome
    }),
    // Cancel the running turn but keep (and re-wake) the next-turn queue.
    registry.method('session/interrupt', async ({ sessionId, expectedTurnSeq }: { sessionId: string; expectedTurnSeq?: number }) => {
      const agent = requireAgent(ctx, sessionId)
      if (agent.status !== 'running') return { cancelled: false, preserved: 0 }
      if (expectedTurnSeq !== undefined && agent.session.snapshotEvents().findLast(event => event.type === 'turn/start')?.seq !== expectedTurnSeq) {
        throw new RemoteFailure('dscode/conflict', 'the active turn changed; refresh the session before interrupting')
      }
      const preserved = cancelPreservingQueue({ queue: agent.inbox, cancel: () => agent.cancel({ kind: 'user' }), followup: message => agent.followup(message) })
      await ctx.get('sessions')?.flush(agent.session)
      return { cancelled: true, preserved }
    }),
  ]
}
