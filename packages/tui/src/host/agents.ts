/**
 * Session lookup shared by the Host operations: every operation names its
 * session by id and resolves the live Agent here.
 *
 * @module dsh-code/host/agents
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
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
