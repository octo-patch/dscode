/**
 * Next-turn queue edits and the queue-preserving interrupt, shared by the
 * in-process runner and the Host operations that serve a separate terminal.
 *
 * @module dsh-code/queue
 */

import type { AgentStatus, Inbox } from '@deepseek-ai/dsh-agent'
import { createUserMessage, MessageId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { QueueMutation } from './app.ts'

/** What one requested queue mutation did; the runner maps it to one notice. */
export type QueueMutationOutcome =
  | 'removed'
  | 'edited'
  | 'steered'
  | 'unavailable'
  | 'empty'
  | 'steerUnavailable'

/**
 * Replace one queued message's text while keeping its attachments. A queue
 * edit rewrites what the user typed, not what they attached: image and file
 * blocks ride through in delivery order (text first, then attachments, the
 * shape {@link deliverLine} submits). Dropping them here would silently strip
 * an attachment the user already confirmed, so this is the edit's single
 * definition and the panel's read-only marker only mirrors it.
 */
export function queueEditContent(content: readonly ContentBlock[], text: string): ContentBlock[] {
  const attachments = content.filter(block => block.type !== 'text')
  return [{ type: 'text', text }, ...attachments]
}

/**
 * Apply one terminal queue mutation to the live inbox. The decision and the
 * inbox change are pure over the supplied handles so every branch is testable
 * without an agent; steering itself is injected because it wakes the driver
 * rather than mutating the inbox. The durable inbox splices remain the UI's
 * single source of truth — this helper never reports a state the inbox did not
 * actually reach.
 * @param inbox - the live agent inbox (pending lists plus its mutators).
 * @param status - the agent's lifecycle status; steering needs `running`.
 * @param messageId - identity of the queued message to mutate.
 * @param action - the requested mutation.
 * @param steer - submits the removed message as next-step steering.
 * @returns the outcome the caller reports.
 */
export function applyQueueMutation(
  inbox: Pick<Inbox, 'nextTurn' | 'append' | 'remove' | 'replace'>,
  status: AgentStatus,
  messageId: string,
  action: QueueMutation,
  steer: (message: UserMessage) => void,
): QueueMutationOutcome {
  const id = MessageId(messageId)
  const message = inbox.nextTurn.find(candidate => candidate.id === id)
  if (message === undefined) return 'unavailable'
  switch (action.kind) {
    case 'remove':
      return inbox.remove(id) ? 'removed' : 'unavailable'
    case 'edit':
      if (action.text.trim() === '') return 'empty'
      inbox.replace(id, createUserMessage({
        content: queueEditContent(message.content, action.text),
        source: message.source,
      }))
      return 'edited'
    case 'steer':
      if (status !== 'running') return 'steerUnavailable'
      // Steer promotes the message out of next-turn, so a failing submit must
      // put it back: the row the user was looking at never just disappears.
      if (!inbox.remove(id)) return 'unavailable'
      try {
        steer(message)
      } catch (error: unknown) {
        inbox.append('next-turn', message)
        throw error
      }
      return 'steered'
  }
}

/**
 * Cancel the active turn while keeping the next-turn queue, then wake the
 * driver again so the preserved messages actually run. `cancel` clears
 * pending work by default and never wakes the driver on its own, so the queue
 * is captured first and re-submitted afterwards: a waking submission latches
 * the wake while the aborted activity converges to idle, which is what turns
 * "preserved" into "sent next" instead of "parked forever". Next-step
 * steering is deliberately dropped — it belonged to the cancelled turn.
 * @param session - the live runtime session.
 * @returns how many queued messages were preserved across the abort.
 */
export function cancelPreservingQueue(session: { readonly queue: Pick<Inbox, 'nextTurn'>; cancel(): void; followup(message: UserMessage): void }): number {
  const queued = [...session.queue.nextTurn]
  session.cancel()
  for (const message of queued) session.followup(message)
  return queued.length
}

