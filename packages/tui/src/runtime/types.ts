/**
 * The terminal's view of the runtime. The runner reaches sessions only through
 * these interfaces so the same UI can drive an in-process Harness or a Host
 * over the Typert protocol (docs/runtime-client-design.md).
 *
 * Reads are synchronous over a local mirror (the in-process implementation
 * reads the live objects; a protocol implementation folds its follow stream),
 * because the React app renders from them. Every other operation — delivery,
 * queue edits, interrupts, catalogs, settings — is a DSCODE Host operation
 * reached through `call` and `stream`, which run the same code in either case.
 *
 * @module dsh-code/runtime/types
 */

import type { AgentStatus, AssistantStreamFrame, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'

/** Route recorded on an assembled request header. */
export interface RequestConfig {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Mutable model choice shared between the runner and the session it opened. */
export interface SelectionCell {
  /** The explicit pick, if the user made one for this session. */
  picked?: ModelSelection
}

/** What to open: a fresh session, a resume, or a seeded fork. */
export interface OpenSessionRequest {
  readonly sessionId: string
  readonly resume: boolean
  /** Working directory for a new session; a resume follows its header. */
  readonly cwd: string
  /** Agent preset composed into the session. */
  readonly preset: string
  readonly parentSession?: string
  readonly origin?: 'subagent'
  /** Inherited event prefix for a fork. */
  readonly seed?: readonly SessionEvent[]
  /** Explicit model pick that outranks the session header and the default. */
  readonly selection: SelectionCell
  /** Permission preset chosen before this new session existed. */
  readonly permission?: string
  /** Aborts an in-flight composition (quit). */
  readonly signal: AbortSignal
}

/** One open session as the terminal drives it. */
export interface RuntimeSession {
  readonly id: SessionId
  /** Identity of the driving agent: matches approval, question and stream subjects. */
  readonly agentId: string
  readonly header: SessionHeader
  /** Every committed event of this session, oldest first. */
  snapshotEvents(): readonly SessionEvent[]
  /** The model configuration of the last assembled request, if any. */
  requestConfig(): RequestConfig | undefined
  readonly status: AgentStatus
  /** Resolves once the driver is idle (immediately when it already is). */
  whenIdle(): Promise<void>
  /** Wait until every committed event is durable. */
  flush(): Promise<void>
  /** Release the session's agent; the durable log stays. */
  dispose(): Promise<void>
  /** Apply an explicit model pick from the next assembled step. */
  selectModel(selection: ModelSelection): void
}

/** One approval the runtime is waiting on, without in-process objects. */
export interface ApprovalAsk {
  /** The asking agent; an answerer claims only the agents it drives. */
  readonly agentId: string
  readonly toolName: string
  /** Matches the `tool/call` event carrying the operation's arguments. */
  readonly callId?: string
  readonly reason?: string
  /** Aborted when the runtime withdraws the ask (the turn ended or another client answered). */
  readonly signal?: AbortSignal
}

/**
 * Claims an approval by returning its eventual outcome, or passes it to the
 * next answerer by returning undefined.
 */
export type ApprovalAnswerer = (ask: ApprovalAsk) => Promise<ApprovalOutcome> | undefined

/** One ask_user_question request (or plan review), without in-process objects. */
export type QuestionAsk = Omit<AskUserQuestionRequest, 'agent'> & {
  /** The asking agent; absent for an agent-less ask, which any answerer may take. */
  readonly agentId?: string
}

/** Claims a question by returning its answer, or passes it on by returning undefined. */
export type QuestionAnswerer = (ask: QuestionAsk) => Promise<AskUserQuestionAnswer> | undefined

/** Header-only facts of a persisted session. */
export type PersistedSession = SessionHeader

/** A fork of an existing session at an optional event sequence. */
export interface ForkSessionRequest extends Omit<OpenSessionRequest, 'resume' | 'seed' | 'parentSession' | 'sessionId'> {
  readonly sourceSessionId: string
  /** Fork after this event sequence; the whole log when absent. */
  readonly atSeq?: number
  /** Identity for the fork; a protocol Host may mint its own. */
  readonly sessionId: string
}

/** The runtime operations the terminal runner uses. */
export interface RuntimeClient {
  /** `in-process` drives this process's Harness; `protocol` reaches a Host through its carrier. */
  readonly kind: 'in-process' | 'protocol'
  /** Open (create, resume or fork) one session and compose its agent. */
  open(request: OpenSessionRequest): Promise<RuntimeSession>
  /** Fork a session and open the fork. */
  fork(request: ForkSessionRequest): Promise<RuntimeSession>
  /** Persisted session headers; empty when the composition has no persistence. */
  persistedSessions(): Promise<readonly PersistedSession[] | undefined>
  /** Whether a session is currently driven by a live agent in this runtime. */
  isLive(sessionId: string): boolean
  /**
   * Committed events of every session this runtime observes, root and child.
   * @returns an unsubscribe function.
   */
  onSessionEvent(listener: (subject: { readonly id: string; readonly header: SessionHeader }, event: SessionEvent) => void): () => void
  /**
   * Live, uncommitted assistant presentation frames keyed by agent identity.
   * @returns an unsubscribe function.
   */
  onAssistantStream(listener: (agentId: string, frame: AssistantStreamFrame) => void): () => void
  /**
   * Answer approvals the runtime asks; unclaimed asks reach the next answerer.
   * @returns an unsubscribe function.
   */
  onApprovalRequest(answerer: ApprovalAnswerer): () => void
  /**
   * Answer ask_user_question requests; unclaimed asks reach the next answerer.
   * @returns an unsubscribe function.
   */
  onQuestionRequest(answerer: QuestionAnswerer): () => void
  /**
   * Invoke one DSCODE Host operation (packages/tui/src/host). Arguments and the
   * result are JSON; a failure throws an error carrying its `code`.
   */
  call<T = unknown>(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<T>
  /** Open one DSCODE Host stream; `uplink` items reach the Host in order. */
  stream<T = unknown>(name: string, args?: Record<string, unknown>, signal?: AbortSignal, uplink?: AsyncIterable<unknown>): AsyncIterable<T>
}
