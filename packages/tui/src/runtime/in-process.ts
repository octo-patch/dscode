/**
 * In-process RuntimeClient: today's behaviour behind the runtime interfaces.
 * It composes Agents through the core registry with the DSCODE preset, installs
 * the session's model selection (explicit pick > session header > deployment
 * default) and applies a pre-session permission choice, exactly as the runner
 * did inline before the split.
 *
 * @module dsh-code/runtime/in-process
 */

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionLogOffset, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { registerStatusSelection } from '../../../../plugins/status/selection.mjs'
import { mountDscodePreset } from '../dscode/preset.ts'
import { selectForkSeed } from '../fork.ts'
import { resolveEffectiveSelection } from '../models.ts'
import { applyPendingPermission, type PermissionPresetsService } from '../permissions.ts'
import type { AgentPresetsService } from '../presets.ts'
import type { DscodeRemoteRegistry } from '../host/registry.ts'
import type { OpenSessionRequest, RuntimeClient, RuntimeSession } from './types.ts'

/** Services the in-process client reads; resolved by the caller from the plugin context. */
export interface InProcessServices {
  readonly ctx: Context
  readonly presets: AgentPresetsService
  readonly permissionPresets?: PermissionPresetsService
  /** Live deployment default, read on every use so a saved /model pick applies to later sessions. */
  readonly defaults: () => ModelSelection
}

function wrap(handle: AgentHandle, flush: (session: Session) => Promise<void>, selection: OpenSessionRequest['selection']): RuntimeSession {
  const agent: Agent = handle.agent
  const session = agent.session
  return {
    id: session.id,
    agentId: agent.id,
    get header() { return session.header },
    snapshotEvents: () => session.snapshotEvents(),
    requestConfig: () => session.requestHeader()?.config,
    get status() { return agent.status },
    whenIdle: () => agent.whenIdle(),
    flush: () => flush(session),
    dispose: () => handle.dispose(),
    selectModel: picked => { selection.picked = picked },
  }
}

/** Create the in-process client over the host services of this process. */
export function createInProcessRuntime(services: InProcessServices): RuntimeClient {
  const { ctx, presets, permissionPresets, defaults } = services
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  if (agents === undefined || sessions === undefined) throw new Error('agents and sessions services are required')
  const flush = (session: Session): Promise<void> => sessions.flush(session).then(() => {})
  // Read on use: the tui-host plugin mounts as a sibling of the runner.
  const registry = (): DscodeRemoteRegistry => {
    const found = ctx.get('dscodeRemote')
    if (found === undefined) throw new Error('the tui-host plugin is not mounted in this composition')
    return found
  }

  return {
    kind: 'in-process',
    sharesFilesystem: true,
    async open(request: OpenSessionRequest): Promise<RuntimeSession> {
      const { selection } = request
      // AgentSetup passes the composed agent as its second argument; the preset
      // mount needs the agent-scoped context.
      const setup = async (agentCtx: Context, agent: Agent): Promise<void> => {
        await mountDscodePreset(presets, agentCtx, agent.session)
        const ref: ModelSelectionRef = {
          get current(): ModelSelection | undefined {
            return resolveEffectiveSelection(selection.picked, agent.session.requestHeader()?.config, defaults())
          },
          set current(value: ModelSelection | undefined) { selection.picked = value },
          assembled: undefined,
        }
        installModelSelection(agentCtx, ref)
        registerStatusSelection(agent, () => ref.current)
      }
      // AgentOptions seed the loop's fallback route; effort rides the selection
      // ref, so only the provider/model pair is seeded.
      const seed = selection.picked ?? defaults()
      const agentOptions = { provider: seed.provider, model: seed.model }
      const handle = request.resume
        ? await agents.resume({ resumeSessionId: SessionId(request.sessionId), agentOptions, signal: request.signal, setup })
        : await agents.create({
          sessionId: SessionId(request.sessionId),
          meta: {
            cwd: request.cwd,
            agentPreset: request.preset,
            ...(request.parentSession === undefined ? {} : { parentSession: SessionId(request.parentSession) }),
            ...(request.origin === undefined ? {} : { origin: request.origin }),
            // Fork lineage: the seed marker lives on the metadata and the
            // inherited prefix length on the top-level option.
            ...(request.seed === undefined ? {} : { isSeeded: true }),
          },
          ...(request.seed === undefined ? {} : { inheritedEventCount: SessionLogOffset(request.seed.length), seed: request.seed }),
          agentOptions,
          signal: request.signal,
          setup,
        })
      if (!request.resume && permissionPresets !== undefined) {
        applyPendingPermission(permissionPresets, handle.agent.session, request.permission)
      }
      return wrap(handle, flush, selection)
    },
    async fork(request) {
      const source = sessions.get(SessionId(request.sourceSessionId))
      if (source === undefined) throw new Error(`session ${request.sourceSessionId} is not live`)
      const seed = selectForkSeed(source.snapshotEvents(), request.atSeq)
      return this.open({ ...request, resume: false, seed: seed.events, parentSession: request.sourceSessionId })
    },
    async persistedSessions() {
      const persistence = ctx.get('sessionPersistence')
      return persistence === undefined ? undefined : (await persistence.list()).map(snapshot => snapshot.header)
    },
    isLive: sessionId => agents.get(SessionId(sessionId)) !== undefined,
    onSessionEvent(listener) {
      return ctx.on('session/event', (subject: Session, event: SessionEvent) => listener(subject, event))
    },
    onAssistantStream(listener) {
      return ctx.on('agent/assistant-stream', ({ agent, frame }) => listener(agent.id, frame))
    },
    onApprovalRequest(answerer) {
      return ctx.on('approval/request', (request, next) => answerer({
        agentId: request.agent.id,
        toolName: request.toolName,
        ...(request.callId === undefined ? {} : { callId: request.callId }),
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }) ?? next())
    },
    call(name, args = {}, signal) {
      return registry().invoke(name, args, signal) as Promise<never>
    },
    stream(name, args = {}, signal = new AbortController().signal, uplink) {
      return registry().open(name, args, uplink ?? (async function* () {})(), signal) as AsyncIterable<never>
    },
    onQuestionRequest(answerer) {
      return ctx.on('user-questions/request', (request, next) => {
        const { agent, ...rest } = request
        return answerer({ ...rest, ...(agent === undefined ? {} : { agentId: agent.id }) }) ?? next()
      })
    },
  }
}
