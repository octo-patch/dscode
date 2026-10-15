/**
 * Message delivery on the Host: one readable message (text plus attachment
 * blocks committed to the Host's attachment store), optionally preceded by the
 * model-facing context a session reference prepared, plus next-turn queue
 * edits and the queue-preserving interrupt.
 *
 * @module dsh-code/host/delivery
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { QueueMutation } from '../app.ts'
import { applyQueueMutation, cancelPreservingQueue } from '../queue.ts'
import { requireAgent } from './agents.ts'
import type { DscodeRemoteRegistry } from './registry.ts'

export function registerDelivery(ctx: Context, registry: DscodeRemoteRegistry): (() => void)[] {
  return [
    // Session snapshots ride the inbox as model-facing context ahead of the
    // readable message: inject before the followup/steer that wakes the driver.
    registry.method('session/deliver', ({ sessionId, content, mode, context }: { sessionId: string; content: ContentBlock[]; mode: 'followup' | 'steer'; context?: UserMessage }) => {
      const agent = requireAgent(ctx, sessionId)
      if (context !== undefined) agent.inject(context)
      const message = createUserMessage({ content, source: { kind: 'user' } })
      if (mode === 'steer') agent.steer(message)
      else agent.followup(message)
      return null
    }),
    registry.method('session/updateQueued', ({ sessionId, messageId, action }: { sessionId: string; messageId: string; action: QueueMutation }) => {
      const agent = requireAgent(ctx, sessionId)
      return applyQueueMutation(agent.inbox, agent.status, messageId, action, message => agent.steer(message))
    }),
    // Cancel the running turn but keep (and re-wake) the next-turn queue.
    registry.method('session/interrupt', ({ sessionId }: { sessionId: string }) => {
      const agent = requireAgent(ctx, sessionId)
      if (agent.status !== 'running') return { cancelled: false, preserved: 0 }
      const preserved = cancelPreservingQueue({ queue: agent.inbox, cancel: () => agent.cancel({ kind: 'user' }), followup: message => agent.followup(message) })
      return { cancelled: true, preserved }
    }),
  ]
}
