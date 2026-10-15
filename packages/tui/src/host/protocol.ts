/**
 * Wire contract between a client and the Host: the DSCODE operations (for each
 * method its arguments and result, for each stream its arguments, items and,
 * when it reads one, uplink), and the upstream Typert calls a client makes for
 * the session core, with the interactive requests it answers on `$events`.
 * The registry checks every registration of a listed name against this table,
 * and `scripts/protocol-schema.mjs` turns it into the JSON Schema that clients
 * in other languages generate their types from
 * (`protocol/dscode-runtime.schema.json`).
 *
 * Values are JSON: optional fields may be absent, and a method that returns
 * nothing answers `null`. A result typed `unknown` is produced by an untyped
 * JavaScript module and is passed through as is.
 *
 * @module dsh-code/host/protocol
 */

import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { RemoteEventDownlinkFrame, RemoteEventResult } from '@deepseek-ai/dsh-api-gateway/stream-protocol'
import type {
  SessionCancelRequest, SessionCancelValue, SessionCreateRequest, SessionCreateValue, SessionFollowFrame, SessionFollowRequest,
  SessionForkRequest, SessionForkValue, SessionListRequest, SessionListValue, SessionPage, SessionPageRequest,
  SessionPromptRequest, SessionPromptValue, SessionSelectModelRequest, SessionSelectModelValue,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionAnswer, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import type { ContentBlock, FileBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { QueueMutation } from '../app.ts'
import type { FilePathInspection, ImagePathInspection } from '../attachments.ts'
import type { ProviderAuthorizationDirectory, ProviderAuthorizationRow } from '../authorization.ts'
import type { CustomModel, CustomProbeStage, CustomProfile, CustomSnapshot } from '../custom-provider-panel.ts'
import type { GitDiffView, ReviewBranch, ReviewCommit } from '../git-workflow.ts'
import type { JobRow, SearchRow } from '../kernel-panels.ts'
import type { MentionCandidate, ParsedSessionReferenceText, PreparedMention } from '../mentions.ts'
import type { ModelDirectory, ModelRow } from '../models.ts'
import type { PermissionRow } from '../permissions.ts'
import type { PluginRow } from '../plugin-inventory.ts'
import type { DiscoveredModelView, ProviderConfiguration, ProviderSettingsDirectory, ProviderTargetView } from '../provider-settings.ts'
import type { QueueMutationOutcome } from '../queue.ts'
import type { ScheduleRow } from '../render/projection.ts'
import type { UsageView } from '../render/usage.ts'
import type { SessionDirectoryOptions, SessionRow } from '../session-directory.ts'
import type { SkillsState } from './catalog.ts'
import type { ChildStreamItem } from './children.ts'
import type { CommandsState } from './commands.ts'
import type { HostNotice } from './notices.ts'
import type { AuthorizationStreamItem, AuthorizationUplinkItem } from './providers.ts'
import type { StatusState } from './status.ts'

/** Arguments of an operation that takes none. */
export type NoArgs = Record<string, never>

/** `host/status`: who answers, and whether it is the release a client speaks. */
/** The wire protocol version (plugins/local-carrier/protocol.mjs): same major is compatible. */
export interface ProtocolVersion {
  major: number
  minor: number
}

export interface HostStatus {
  version: string
  /** Negotiated instead of `version`. Absent on DSCODE 0.7.48 and older, which only match their own release. */
  protocol: ProtocolVersion
  pid: number
  startedAt: number
  socketPath: string
  /** Attached clients: open `$events` streams. */
  clients: number
  /** All open streams. */
  streams: number
  /** Live agents. */
  sessions: number
  /** Agents running a turn. */
  running: number
  /** 0 when the Host never exits for being idle. */
  idleExitMs: number
  /** The folder a remote client uses when it names none. */
  defaultCwd: string
  /** Present on `dscode server`. */
  tcp?: { port: number; bind: string }
}

/** `models/save`: what went wrong, if anything; both absent means the pick was saved and resolves. */
export interface ModelSaveResult {
  /** Persisting the selection failed. */
  saveError?: string
  /** The request pipeline refused the selection (for example a withdrawn effort). */
  rejected?: string
}

/** `models/compactionPreview`: whether switching to a route would compact the current context. */
export interface CompactionPreview {
  /** `provider/model` of the measured route. */
  label: string
  /** Tokens the session's context uses now. */
  used: number
  /** The route's effective context window. */
  contextWindow: number
  /** Fraction of the window at which compaction starts. */
  thresholdRatio: number
  /** Token count at which compaction starts. */
  threshold: number
  /** The next step on this route would compact. */
  compacts: boolean
  /** The context does not fit the route's window at all. */
  overflows: boolean
}

/** `session/interrupt`: whether a turn was cancelled and how many queued messages were kept. */
export interface InterruptResult {
  cancelled: boolean
  preserved: number
}

/** Model discovery against an endpoint the user is configuring. */
export interface ProviderDiscoveryRequest {
  apiKey?: string
  baseURL?: string
}

/** `openrouter/managementKeyStatus`. */
export interface ManagementKeyStatus {
  state: 'unavailable' | 'env' | 'saved' | 'readonly' | 'missing' | 'error'
}

/** A local image a remote terminal read: its facts, with the first 16 bytes as base64. */
export interface ImageFactsWire {
  path: string
  name: string
  bytes: number
  signature: string
}

/** A local file a remote terminal read: its facts. */
export interface FileFactsWire {
  path: string
  name: string
  bytes: number
}

/** File content a remote terminal sends, as base64. */
export interface NamedData {
  name: string
  data: string
}

/** Unary methods: `POST /dscode/<name>` with `{args}`, answering `{ok, value}`. */
export interface DscodeMethods {
  // Host
  'host/status': { args: NoArgs; result: HostStatus }
  /** The Host exits about 50 ms after answering. */
  'host/shutdown': { args: NoArgs; result: { stopping: true } }

  // Delivery
  /** `followup` queues for the next turn (or starts one); `steer` goes into the running turn. `context` is injected ahead of the message. */
  'session/deliver': { args: { sessionId: string; content: ContentBlock[]; mode: 'followup' | 'steer'; context?: UserMessage }; result: null }
  'session/updateQueued': { args: { sessionId: string; messageId: string; action: QueueMutation }; result: QueueMutationOutcome }
  /** Cancel the running turn but keep and re-wake the next-turn queue. */
  'session/interrupt': { args: { sessionId: string }; result: InterruptResult }

  // Commands
  /** Run a slash command line; `handled` is false when no command owned it. */
  'commands/execute': { args: { sessionId: string; line: string }; result: { handled: boolean } }

  // Sessions
  'sessions/list': { args: { options: SessionDirectoryOptions }; result: readonly SessionRow[] }
  'sessions/subagents': { args: { sessionId: string; cwd: string }; result: readonly SessionRow[] }
  /** Delete a session subtree; the result is the message to show. */
  'sessions/delete': { args: { id: string; currentId?: string }; result: string }
  /** The session as exported Markdown. */
  'sessions/transcript': { args: { id: string }; result: string }
  'sessions/search': { args: { query: string }; result: readonly SearchRow[] }
  'sessions/usage': { args: { sessionId?: string }; result: UsageView }
  /** The result is the message to show. */
  'sessions/rename': { args: { sessionId: string; title: string }; result: string }
  /** Resolve an id or id prefix to one root session id. */
  'sessions/resolveResume': { args: { wanted: string; currentId?: string; allowLive?: boolean }; result: string }

  // Children and /btw
  /** Start a side-question child session; the client mints `childId`. */
  'btw/start': { args: { sessionId: string; childId: string; question: string; mode: string }; result: { agentId: string } }
  'btw/dispose': { args: { ids: string[] }; result: null }

  // Models
  'models/directory': { args: NoArgs; result: ModelDirectory }
  /** Prepare a provider route before switching to it; true when settings changed. */
  'models/ensureRoute': { args: { provider: string }; result: boolean }
  /** Persist a pick as the deployment default. */
  'models/save': { args: { selection: ModelSelection }; result: ModelSaveResult }
  /** Null when the session, the meter or the route's window is unknown. */
  'models/compactionPreview': { args: { sessionId: string; row: ModelRow }; result: CompactionPreview | null }
  /** Set (or with null, clear) the Host-wide model override for delegated agents. */
  'models/subagentOverride': { args: { selection?: ModelSelection | null }; result: null }

  // Providers
  'providers/directory': { args: NoArgs; result: ProviderSettingsDirectory }
  'providers/saveCredential': { args: { target: ProviderTargetView; key: string }; result: null }
  'providers/saveConfiguration': { args: { target: ProviderTargetView; configuration: ProviderConfiguration }; result: null }
  'providers/discover': { args: { target: ProviderTargetView; request: ProviderDiscoveryRequest }; result: readonly DiscoveredModelView[] }
  'providers/unsetCredential': { args: { target: ProviderTargetView }; result: null }
  'providers/remove': { args: { target: ProviderTargetView }; result: null }

  // Login
  'authorization/directory': { args: NoArgs; result: ProviderAuthorizationDirectory }
  'authorization/cancel': { args: { key: ProviderAuthorizationRow['key'] }; result: null }
  'authorization/logout': { args: { row: ProviderAuthorizationRow }; result: null }

  // OpenRouter
  'openrouter/managementKeyStatus': { args: NoArgs; result: ManagementKeyStatus }
  'openrouter/saveManagementKey': { args: { key: string }; result: null }
  /** Account and credit facts from OpenRouter, as its module reports them. */
  'openrouter/account': { args: NoArgs; result: unknown }

  // Custom providers
  'custom/available': { args: NoArgs; result: boolean }
  'custom/list': { args: NoArgs; result: CustomSnapshot }
  /** `revision` must be the snapshot's; a stale one is refused. */
  'custom/save': { args: { profile: CustomProfile; key: string; revision: string }; result: CustomSnapshot }
  'custom/remove': { args: { id: string; revision: string }; result: CustomSnapshot }
  'custom/discover': { args: { profile: CustomProfile; key: string }; result: { backend: string; models: CustomModel[] } }
  'custom/test': { args: { profile: CustomProfile; model: string; key: string }; result: readonly CustomProbeStage[] }

  // Catalogs
  'jobs/list': { args: { sessionId?: string }; result: readonly JobRow[] }
  'schedules/list': { args: { sessionId: string }; result: readonly ScheduleRow[] }
  'plugins/list': { args: NoArgs; result: readonly PluginRow[] }
  /** Whether the DSCODE composition offers plan mode before a session exists. */
  'presets/planAvailable': { args: NoArgs; result: boolean }

  // Permissions
  'permissions/rows': { args: NoArgs; result: readonly PermissionRow[] }
  'permissions/names': { args: NoArgs; result: readonly string[] }
  /** The session's preset, or before a session exists the pending pick or the default. */
  'permissions/effective': { args: { sessionId?: string; pending?: string }; result: string }
  /** Validate a preset and apply it to the session if one exists; answers the preset. */
  'permissions/select': { args: { sessionId?: string; id: string }; result: string }

  // Mentions
  'mentions/candidates': { args: { sessionId?: string; cwd: string; query: string }; result: readonly MentionCandidate[] }
  'mentions/prepare': { args: { sessionId?: string; cwd: string; parsed: ParsedSessionReferenceText }; result: PreparedMention }

  // Attachments: paths the Host reads
  'attachments/inspectImages': { args: { paths: readonly string[]; cwd: string }; result: readonly ImagePathInspection[] }
  'attachments/saveImages': { args: { paths: readonly string[] }; result: readonly ImageBlock[] }
  'attachments/inspectFiles': { args: { paths: readonly string[]; cwd: string }; result: readonly FilePathInspection[] }
  'attachments/saveFiles': { args: { paths: readonly string[] }; result: readonly FileBlock[] }
  // Attachments: content a remote client read
  'attachments/inspectImageData': { args: { items: ImageFactsWire[] }; result: readonly ImagePathInspection[] }
  'attachments/saveImageData': { args: { items: NamedData[] }; result: readonly ImageBlock[] }
  'attachments/inspectFileData': { args: { items: FileFactsWire[] }; result: readonly FilePathInspection[] }
  'attachments/saveFileData': { args: { items: NamedData[] }; result: readonly FileBlock[] }

  // Workspace: git and files on the Host
  'workspace/gitDiff': { args: { cwd: string; argument: string }; result: GitDiffView }
  'workspace/commitDiff': { args: { cwd: string; sha: string }; result: GitDiffView }
  'workspace/mergeBase': { args: { cwd: string; branch: string }; result: string | null }
  'workspace/reviewBranches': { args: { cwd: string }; result: readonly ReviewBranch[] }
  'workspace/reviewCommits': { args: { cwd: string }; result: readonly ReviewCommit[] }
  /** The checked-out branch, or empty when detached or not a repository. */
  'workspace/gitBranch': { args: { cwd: string }; result: string }
  'workspace/writeText': { args: { path: string; text: string }; result: null }
}

/** Streams: endpoint `dscode/<name>` on `POST /stream`. */
export interface DscodeStreams {
  /** Slash commands for the session (or the startup set): the current value first, then each change. */
  'commands/watch': { args: { sessionId?: string }; item: CommandsState }
  /** Committed events and live assistant frames of the root's child sessions, from when the stream opens. */
  'sessions/children': { args: { sessionId: string }; item: ChildStreamItem }
  /** The deployment default model: the current value first, then each change. */
  'models/defaults': { args: NoArgs; item: ModelSelection }
  /** Revision numbers; re-read `providers/directory` when one arrives. */
  'providers/watch': { args: NoArgs; item: number }
  /** Revision numbers; re-read `authorization/directory` when one arrives. */
  'authorization/watch': { args: NoArgs; item: number }
  /** An interactive provider login: notices and prompts, then `done`. Prompts are answered on the uplink. */
  'authorization/begin': { args: { key: ProviderAuthorizationRow['key']; method: string }; item: AuthorizationStreamItem; uplink: AuthorizationUplinkItem }
  /** User-invocable skills for the session or folder: the current value first, then each change. */
  'skills/watch': { args: { sessionId?: string; cwd: string }; item: SkillsState }
  /** Footer metrics, service speed and delegation board, sampled every 500 ms and sent on change. */
  'status/watch': { args: { sessionId: string; modelLabel: string }; item: StatusState }
  /** Host notices from when the stream opens. */
  'notices/watch': { args: NoArgs; item: HostNotice }
}

/**
 * Upstream Typert methods a DSCODE client uses: `POST /api/<name>` with the
 * envelope's `payload.args`, whose keys are the method's parameter names.
 */
export interface TypertMethods {
  /** Without `sessionId` the Host mints one. `cwd` fixes the session's folder. */
  'session/create': { args: { request: SessionCreateRequest }; result: SessionCreateValue }
  'session/selectModel': { args: { request: SessionSelectModelRequest }; result: SessionSelectModelValue }
  'session/fork': { args: { request: SessionForkRequest }; result: SessionForkValue }
  /** Older history while a follow snapshot reports `hasMore`. */
  'session/page': { args: { request: SessionPageRequest }; result: SessionPage }
  'session/list': { args: { _request: SessionListRequest }; result: SessionListValue }
  /** Upstream delivery; DSCODE clients use `session/deliver`, which carries DSCODE behaviour. */
  'session/prompt': { args: { request: SessionPromptRequest }; result: SessionPromptValue }
  'session/cancel': { args: { request: SessionCancelRequest }; result: SessionCancelValue }
  /** Answer, decline (`next`) or fail one `$events` waterfall. The first answer wins. */
  '$events/result': { args: RemoteEventResult; result: null }
}

/** Upstream Typert streams a DSCODE client opens on `POST /stream`. */
export interface TypertStreams {
  /** The forwarded-event stream, open for the client's lifetime: `ready` first, then emits, waterfalls and cancels. */
  '$events': { args: NoArgs; item: RemoteEventDownlinkFrame }
  /** One session: a `snapshot`, then committed events and live assistant frames. Opening it resumes a persisted session. */
  'session/follow': { args: { request: SessionFollowRequest }; item: SessionFollowFrame }
}

/**
 * Waterfalls a DSCODE client answers on `$events`: the `request` it receives
 * (the upstream event without its live `agent` and `signal`, which the gateway
 * strips; the item's `agentId` names the agent) and the `value` it answers with
 * in a `result` outcome. Any other waterfall is passed on with `next`.
 */
export interface TypertWaterfalls {
  'approval/request': { request: Omit<ApprovalRequestEvent, 'agent' | 'signal'>; value: ApprovalOutcome }
  'user-questions/request': { request: Omit<AskUserQuestionRequestEvent, 'agent' | 'signal'>; value: AskUserQuestionAnswer }
}

export type MethodName = keyof DscodeMethods
export type StreamName = keyof DscodeStreams
export type MethodArgs<N extends MethodName> = DscodeMethods[N]['args']
export type MethodResult<N extends MethodName> = DscodeMethods[N]['result']
export type StreamArgs<N extends StreamName> = DscodeStreams[N]['args']
export type StreamItem<N extends StreamName> = DscodeStreams[N]['item']

/** Arguments for any operation name: the contract's for listed names, untyped otherwise. */
export type CallArgs<N extends string> = N extends MethodName ? MethodArgs<N> : Record<string, unknown>
export type CallResult<N extends string> = N extends MethodName ? MethodResult<N> : unknown
export type WatchArgs<N extends string> = N extends StreamName ? StreamArgs<N> : Record<string, unknown>
export type WatchItem<N extends string> = N extends StreamName ? StreamItem<N> : unknown
