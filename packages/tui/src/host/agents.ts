/**
 * Session lookup shared by the Host operations: every operation names its
 * session by id and resolves the live Agent here.
 *
 * @module dsh-code/host/agents
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteFailure } from './registry.ts'

/** The live Agent of a session, or undefined when none is composed. */
export function liveAgent(ctx: Context, sessionId: string | undefined): Agent | undefined {
  if (sessionId === undefined || sessionId === '') return undefined
  return ctx.get('agents')?.get(SessionId(sessionId))
}

/** The live Agent of a session; throws a stable failure when it is not live. */
export function requireAgent(ctx: Context, sessionId: string): Agent {
  const agent = liveAgent(ctx, sessionId)
  if (agent === undefined) throw new RemoteFailure('dscode/session-not-live', `session ${sessionId} has no live agent on this Host`)
  return agent
}

/** Resume cold ordinary sessions through the same owner used by Typert writes. */
export async function resolveAgent(ctx: Context, sessionId: string, signal: AbortSignal): Promise<Agent> {
  signal.throwIfAborted()
  const controller = ctx.get('sessionController')
  if (controller === undefined) return requireAgent(ctx, sessionId)
  const result = await controller.resolveAgent(SessionId(sessionId))
  signal.throwIfAborted()
  if ('error' in result) {
    const code = result.error.code === 'session/not-found' ? 'dscode/not-found'
      : result.error.code === 'session/writer-held' ? 'dscode/conflict'
      : result.error.code === 'session/agent-busy' ? 'dscode/conflict' : 'dscode/resume-failed'
    throw new RemoteFailure(code, result.error.message, { cause: result.error })
  }
  return result.agent
}
