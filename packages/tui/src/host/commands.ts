/**
 * Slash commands on the Host: the descriptor list a session (or the
 * pre-session terminal) offers, pushed on every change, and execution through
 * the native registry.
 *
 * @module dsh-code/host/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import { startupCommands, watchStartupCommands } from '../../../../plugins/providers/startup-commands.mjs'
import { liveAgent, requireAgent } from './agents.ts'
import { RemoteFailure, watch, type DscodeRemoteRegistry } from './registry.ts'

/** What `commands/watch` pushes. */
export interface CommandsState {
  readonly descriptors: readonly CommandDescriptor[]
  readonly error?: string
}

export function registerCommands(ctx: Context, registry: DscodeRemoteRegistry): (() => void)[] {
  const read = (sessionId: string | undefined): CommandsState => {
    const commands = ctx.get('commands')
    if (commands === undefined) return { descriptors: [] }
    const agent = liveAgent(ctx, sessionId)
    try {
      return { descriptors: agent === undefined ? startupCommands(ctx) : commands.list(agent) }
    } catch (cause: unknown) {
      return { descriptors: [], error: cause instanceof Error ? cause.message : String(cause) }
    }
  }
  return [
    registry.stream('commands/watch', ({ sessionId }: { sessionId?: string }, { signal }) => watch(signal, () => read(sessionId), push => {
      const offChange = ctx.on('commands/change', push)
      const offStartup = watchStartupCommands(ctx, push)
      return () => { offChange(); offStartup?.() }
    })),
    // Resolves whether a command owned the line; an unowned line is the
    // caller's to send verbatim (a user-invocable skill gesture).
    registry.method('commands/execute', async ({ sessionId, line }: { sessionId: string; line: string }, { signal }) => {
      const commands = ctx.get('commands')
      if (commands === undefined) throw new RemoteFailure('dscode/commands-unavailable', 'the command registry is not mounted')
      // The third parameter admits submitted attachments; the composer never
      // attaches to a slash line, so every invocation is the empty batch.
      const execution = await commands.execute(requireAgent(ctx, sessionId), line, [], signal)
      return { handled: execution !== undefined }
    }),
  ]
}
