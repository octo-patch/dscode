/**
 * Protocol RuntimeClient: drives a Host through upstream Typert methods over
 * the DSCODE local carrier (plugins/local-carrier). Sessions mirror their
 * `session/follow` stream locally so the runner keeps synchronous reads;
 * approvals and questions arrive as `$events` waterfalls and are answered
 * through `$events/result`.
 *
 * Delivery, queue edits, catalogs and settings are DSCODE Host operations on
 * the same carrier (`call`/`stream`); child sessions reach the feeds through
 * the Host's `sessions/children` stream.
 *
 * @module dsh-code/runtime/typert
 */

import type { AgentStatus, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { call, callDscode, openDscodeStream, openStream } from '../../../../plugins/local-carrier/client.mjs'
import type {
  ApprovalAnswerer, OpenSessionRequest, QuestionAnswerer, RequestConfig, RuntimeClient, RuntimeSession,
} from './types.ts'

type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

function value<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

/** A promise with its settle functions (the compiled lib predates Promise.withResolvers). */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

type Listener<A extends unknown[]> = (...args: A) => void
function emitter<A extends unknown[]>(): { add(listener: Listener<A>): () => void; emit(...args: A): void } {
  const listeners = new Set<Listener<A>>()
  return {
    add(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    emit(...args) { for (const listener of listeners) listener(...args) },
  }
}

interface WaterfallFrame { type: 'waterfall'; event: string; eventId: string; agentId: string; request: Record<string, unknown> }

/** Messages per history page when attaching to a session (DSCODE_HISTORY_PAGE lets verification force paging). */
const HISTORY_PAGE = Number.parseInt(process.env.DSCODE_HISTORY_PAGE ?? '', 10) > 0 ? Number.parseInt(process.env.DSCODE_HISTORY_PAGE!, 10) : 1000

/** Options for the protocol client. */
export interface TypertRuntimeOptions {
  /** Absolute path of the Host's local carrier socket. */
  readonly socketPath: string
  /** Receives failures of asynchronous writes (prompt, cancel, model selection). */
  readonly onError: (error: unknown) => void
}

/** Create a RuntimeClient that reaches the Host through its local carrier. */
export function createTypertRuntime(options: TypertRuntimeOptions): RuntimeClient {
  const { socketPath, onError } = options
  const rpc = async <T>(method: string, args: Record<string, unknown>): Promise<T> => value<T>(await call(socketPath, method, args))
  const callStream = (name: string, args: Record<string, unknown>, signal: AbortSignal): AsyncIterable<unknown> => openDscodeStream(socketPath, name, args, signal)
  const sessionEvents = emitter<[{ readonly id: string; readonly header: SessionHeader }, SessionEvent]>()
  const assistantStream = emitter<[string, AssistantStreamFrame]>()
  const approvals: ApprovalAnswerer[] = []
  const questions: QuestionAnswerer[] = []
  const running = new Map<string, boolean>()
  const idleWaiters = new Map<string, (() => void)[]>()
  const live = new Set<string>()
  const setRunning = (sessionId: string, value: boolean): void => {
    running.set(sessionId, value)
    if (value) return
    for (const resolve of idleWaiters.get(sessionId)?.splice(0) ?? []) resolve()
  }

  // One forwarded-event stream per client: approvals and questions arrive as
  // Agent-scoped waterfalls and are answered by event id.
  const events = new AbortController()
  let clientId: string | undefined
  const pending = new Map<string, AbortController>()
  const answer = (eventId: string, outcome: Record<string, unknown>): void => {
    if (clientId === undefined) return
    void call(socketPath, '$events/result', { clientId, eventId, outcome }).then(value, onError)
  }
  const dispatch = (frame: WaterfallFrame): void => {
    const withdraw = new AbortController()
    pending.set(frame.eventId, withdraw)
    const settle = (promise: Promise<unknown> | undefined): void => {
      if (promise === undefined) { pending.delete(frame.eventId); answer(frame.eventId, { kind: 'next' }); return }
      promise.then(result => {
        pending.delete(frame.eventId)
        if (!withdraw.signal.aborted) answer(frame.eventId, { kind: 'result', value: result })
      }, (error: unknown) => {
        pending.delete(frame.eventId)
        if (withdraw.signal.aborted) return
        const failure = error instanceof Error ? error : new Error(String(error))
        answer(frame.eventId, { kind: 'rejected', error: { name: failure.name, message: failure.message, ...('code' in failure ? { code: String(failure.code) } : {}) } })
      })
    }
    const request = frame.request
    if (frame.event === 'approval/request') {
      const ask = {
        agentId: frame.agentId,
        toolName: String(request.toolName),
        ...(typeof request.callId === 'string' ? { callId: request.callId } : {}),
        ...(typeof request.reason === 'string' ? { reason: request.reason } : {}),
        signal: withdraw.signal,
      }
      let claimed: Promise<ApprovalOutcome> | undefined
      for (const answerer of approvals) { claimed = answerer(ask); if (claimed !== undefined) break }
      settle(claimed)
    } else if (frame.event === 'user-questions/request') {
      const ask = { ...request, agentId: frame.agentId, signal: withdraw.signal } as Parameters<QuestionAnswerer>[0]
      let claimed: ReturnType<QuestionAnswerer>
      for (const answerer of questions) { claimed = answerer(ask); if (claimed !== undefined) break }
      settle(claimed)
    } else {
      settle(undefined)
    }
  }
  const eventsReady = (async () => {
    const ready = deferred<void>()
    void (async () => {
      for await (const raw of openStream(socketPath, '$events', { args: {} }, events.signal)) {
        const frame = raw as { type: string; event?: string; args?: unknown[]; eventId?: string; clientId?: string }
        if (frame.type === 'ready') { clientId = frame.clientId; ready.resolve(); continue }
        if (frame.type === 'waterfall') { dispatch(raw as WaterfallFrame); continue }
        if (frame.type === 'cancel' && frame.eventId !== undefined) { pending.get(frame.eventId)?.abort(); pending.delete(frame.eventId); continue }
        if (frame.type !== 'emit') continue
        if (frame.event === 'api-session/status') {
          const [sessionId, isRunning] = frame.args as [string, boolean]
          setRunning(sessionId, isRunning)
        } else if (frame.event === 'api-session/added') {
          const [summary] = frame.args as [{ sessionId: string; agentAvailable: boolean; running: boolean }]
          if (summary.agentAvailable) live.add(summary.sessionId); else live.delete(summary.sessionId)
          setRunning(summary.sessionId, summary.running)
        } else if (frame.event === 'api-session/removed') {
          live.delete(String((frame.args as unknown[])[0]))
        }
      }
    })().catch((error: unknown) => { ready.reject(error); if (!events.signal.aborted) onError(error) })
    return ready.promise
  })()
  eventsReady.catch(() => {})

  const client: RuntimeClient = {
    kind: 'protocol',
    async open(request: OpenSessionRequest): Promise<RuntimeSession> {
      if (request.seed !== undefined) throw new Error('forking is not carried over the protocol yet')
      await eventsReady
      const sessionId = SessionId(request.sessionId)
      if (!request.resume) await rpc('session/create', { request: { sessionId, cwd: request.cwd, agentPreset: request.preset } })
      const picked = request.selection.picked
      if (picked !== undefined) await rpc('session/selectModel', { request: { sessionId, ...picked } })
      if (!request.resume && request.permission !== undefined) await callDscode(socketPath, 'permissions/select', { sessionId, id: request.permission })

      const follow = new AbortController()
      request.signal.addEventListener('abort', () => follow.abort(), { once: true })
      const log: SessionEvent[] = []
      let header: SessionHeader | undefined
      let cursor = -1
      let hasMore = false
      const snapshot = deferred<void>()
      void (async () => {
        const stream = openStream(socketPath, 'session/follow', { args: { request: { address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: HISTORY_PAGE } } }, follow.signal)
        for await (const raw of stream) {
          const frame = raw as { type: string; header?: SessionHeader; cursor?: number; hasMore?: boolean; records?: { event: SessionEvent }[]; event?: SessionEvent; frame?: AssistantStreamFrame }
          if (frame.type === 'snapshot') {
            header = frame.header
            cursor = frame.cursor ?? -1
            hasMore = frame.hasMore === true
            log.push(...(frame.records ?? []).map(record => record.event))
            snapshot.resolve()
          } else if (frame.type === 'event' && frame.event !== undefined && header !== undefined) {
            log.push(frame.event)
            if (frame.event.type === 'turn/start') setRunning(sessionId, true)
            if (frame.event.type === 'turn/end') setRunning(sessionId, false)
            sessionEvents.emit({ id: sessionId, header }, frame.event)
          } else if (frame.type === 'assistant-stream' && frame.frame !== undefined) {
            assistantStream.emit(sessionId, frame.frame)
          }
        }
      })().catch((error: unknown) => { snapshot.reject(error); if (!follow.signal.aborted) onError(error) })
      await snapshot.promise
      // The opening frame carries the newest page; the terminal folds the whole
      // log (transcript, fork points, cross-session history), so page back to
      // the start before showing the session.
      while (hasMore) {
        const page = await rpc<{ records: { event: SessionEvent }[]; hasMore: boolean }>('session/page', {
          request: { address: { kind: 'session', sessionId }, throughSeq: cursor, ...(log[0] === undefined ? {} : { beforeSeq: log[0].seq }), maxMessages: HISTORY_PAGE },
        })
        if (page.records.length === 0) break
        log.unshift(...page.records.map(record => record.event))
        hasMore = page.hasMore
      }
      // Status changes arrive as events; a terminal attaching mid-turn reads the
      // current state once so it can interrupt the turn it joined.
      const listed = await rpc<{ items: { sessionId: string; running: boolean }[] }>('session/list', { _request: {} }).catch(() => undefined)
      const summary = listed?.items.find(item => item.sessionId === sessionId)
      if (summary !== undefined && !running.has(sessionId)) setRunning(sessionId, summary.running)
      // Child sessions (subagents and /btw) reach the feeds through the Host's children stream.
      const children = new AbortController()
      follow.signal.addEventListener('abort', () => children.abort(), { once: true })
      void (async () => {
        for await (const raw of callStream('sessions/children', { sessionId }, children.signal)) {
          const item = raw as { kind: string; sessionId?: string; header?: SessionHeader; event?: SessionEvent; agentId?: string; frame?: AssistantStreamFrame }
          if (item.kind === 'event' && item.sessionId !== undefined && item.header !== undefined && item.event !== undefined) sessionEvents.emit({ id: item.sessionId, header: item.header }, item.event)
          else if (item.kind === 'stream' && item.agentId !== undefined && item.frame !== undefined) assistantStream.emit(item.agentId, item.frame)
        }
      })().catch((error: unknown) => { if (!children.signal.aborted) onError(error) })

      return {
        id: sessionId,
        // The Host addresses scoped waterfalls and stream frames by the root session id.
        agentId: sessionId,
        get header() { return header! },
        snapshotEvents: () => log,
        requestConfig: () => {
          // `request/header` carries the assembled header: { header: { config, tools, ... } }.
          const latest = log.findLast(event => event.type === 'request/header') as { data?: { header?: { config?: RequestConfig } } } | undefined
          return latest?.data?.header?.config
        },
        get status(): AgentStatus { return running.get(sessionId) === true ? 'running' : 'idle' },
        whenIdle: () => running.get(sessionId) === true
          ? new Promise<void>(resolve => { idleWaiters.set(sessionId, [...idleWaiters.get(sessionId) ?? [], resolve]) })
          : Promise.resolve(),
        // The Host owns persistence; there is nothing local to flush.
        flush: () => Promise.resolve(),
        // Detach only: over the protocol the Host keeps the session.
        dispose: () => { follow.abort(); children.abort(); return Promise.resolve() },
        selectModel: selection => { void rpc('session/selectModel', { request: { sessionId, ...selection } }).catch(onError) },
      }
    },
    async fork(request) {
      const forked = await rpc<{ sessionId: string }>('session/fork', { request: { sessionId: SessionId(request.sourceSessionId), ...(request.atSeq === undefined ? {} : { atSeq: request.atSeq }) } })
      return client.open({ ...request, sessionId: forked.sessionId, resume: true })
    },
    async persistedSessions() {
      const listed = await rpc<{ items: { sessionId: string; cwd?: string; updatedAt: number; parentSessionId?: string; origin?: 'subagent' }[] }>('session/list', { _request: {} })
      return listed.items.map(item => ({
        version: 0, id: SessionId(item.sessionId), createdAt: item.updatedAt, isSeeded: false,
        ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
        ...(item.parentSessionId === undefined ? {} : { parentSession: SessionId(item.parentSessionId) }),
        ...(item.origin === undefined ? {} : { origin: item.origin }),
      }) as unknown as SessionHeader)
    },
    isLive: sessionId => live.has(sessionId),
    onSessionEvent: listener => sessionEvents.add(listener),
    onAssistantStream: listener => assistantStream.add(listener),
    call(name, args = {}, signal) {
      return callDscode(socketPath, name, args, signal)
    },
    stream(name, args = {}, signal, uplink) {
      return (async function* () {
        try {
          yield* openDscodeStream(socketPath, name, args, signal, uplink)
        } catch (error) {
          const remote = (error as { remote?: { code?: string; message?: string } }).remote
          throw remote === undefined ? error : Object.assign(new Error(remote.message ?? String(error)), { code: remote.code })
        }
      })()
    },
    onApprovalRequest(answerer) {
      approvals.push(answerer)
      return () => { const at = approvals.indexOf(answerer); if (at !== -1) approvals.splice(at, 1) }
    },
    onQuestionRequest(answerer) {
      questions.push(answerer)
      return () => { const at = questions.indexOf(answerer); if (at !== -1) questions.splice(at, 1) }
    },
  }
  return client
}
