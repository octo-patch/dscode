/**
 * @deepseek-ai/dsh-code — the interactive terminal driver. The bundle patch
 * rides over dsh-base without Host, HTTP, or browser plugins; this runner
 * creates or resumes preset-composed Agents through the core registry, keeps
 * one Ink owner while the active session changes, folds submitted prompts
 * into the selected durable session, answers approval asks with a y/n bar,
 * dispatches slash commands, and on quit flushes and requests process exit.
 *
 * @module @deepseek-ai/dsh-code
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { terminalStateDirectory } from '../../../plugins/i18n/messages.mjs'
import { appendFile as appendFileAsync, mkdir, writeFile as writeFileAsync } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, FileBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type SessionHeader, type UserMessage } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
// Type-only: carries the ctx.sessionTitle service merge for /title.
import type {} from '@deepseek-ai/dsh-session-title'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import { App, type BudgetDecision, type NoticeTone, type QueueMutation } from './app.ts'
import { evaluateBudget, parseBudget } from '../../../plugins/session-metrics/turns.mjs'
import { sessionSpend } from '../../../plugins/session-metrics/view.mjs'
import { mountApprovalAnswerer, type ApprovalStore } from './approval.ts'
import { isSlashLine, submissionPayload, watchCommands, type CommandsView } from './commands.ts'
import { internals, type TuiMount } from './internals.ts'
import { grokStatusSnapshot } from '../../../plugins/grok/status.mjs'
import type { DscodeCompactionPreview } from './app.ts'
import { buildModelSelection, modelSelectionLabel, pendingModelSelection, resolveEffectiveSelection, type ModelDirectory, type ModelRow } from './models.ts'
import type { discoverProviderModels, ProviderSettingsDirectory } from './provider-settings.ts'
import type { MentionsApi } from './mentions.ts'
import { mountQuestionProvider, type QuestionStore } from './questions.ts'
// Type-only import merges the settings Events declarations ('settings/updated',
// 'settings/document-updated') into this program's Cordis bus typing.
import type {} from '@deepseek-ai/dsh-settings'
import { createTranscriptStore, type TranscriptStore } from './store.ts'
import { createSubagentFeed, type SubagentFeedView } from './subagents.ts'
import { createCommunicationFeed, foldCommunication, type CommunicationView } from './communication.ts'
import { createBtwFeed, type BtwFeed } from './btw.ts'
import { parseStatuslineItems } from './render/status.ts'
import { historyLine, HISTORY_MAX_ENTRIES, needsCompaction, parseHistoryFile, serializeHistoryList } from './history.ts'
import { toolArgumentsPreview } from './render/tool-preview.ts'
import { buildExportMarkdown } from './render/export.ts'
import type { FilePathInspection, ImagePathInspection } from './attachments.ts'
import { copyText, latestAssistantText } from './editor.ts'
import { applyCtrlRPassthrough, resolveEditorKeysStartupHint, type EditorKeysEnv } from './editor-keys.ts'
import { openAuthorizationUrl, type ProviderAuthorizationDirectory } from './authorization.ts'
import { selectForkSeed } from './fork.ts'
import { buildReviewPrompt, type ReviewSelection } from './git-workflow.ts'
import type { TuiStartup } from './startup.ts'
import { SessionSwitchQueue } from './session-switch.ts'
import { agentPresetsFrom } from './presets.ts'
import { DSCODE_PRESET, requireDscodePreset } from './dscode/preset.ts'
import { createInProcessRuntime } from './runtime/in-process.ts'
import { createTypertRuntime, type CarrierTarget } from './runtime/typert.ts'
import { describeTarget, targetFromEnv } from '../../../plugins/local-carrier/client.mjs'
import type { RuntimeClient, RuntimeSession, SelectionCell } from './runtime/types.ts'
import { remoteWatch } from './runtime/watch.ts'
import {
  attachmentClient, beginAuthorization, customClient, followNotices, mirrorStatusSources, remoteMentions, subscribeRevisions, watchRemoteSkills,
  workspaceClient, type RemoteSkillsView,
} from './runtime/views.ts'
import { permissionPresetsFrom, type PermissionRow } from './permissions.ts'
import type { PluginRow } from './plugin-inventory.ts'
import { applyLauncherUpdate, probeLauncherUpdate } from './update.ts'
import { parseAnimationsPref } from './render/animations.ts'
import { parseThemeName, setTheme, type ThemeName } from './theme.ts'
import { parseLanguageName, setLanguage, t, type LanguageName } from './i18n.ts'
import {
  isSubagentSession,
  matchSessionId,
  newestRootForCwd,
  sessionFolderMatches,
  type SessionDirectoryOptions,
  type SessionRow,
} from './session-directory.ts'
import type { JobRow, SearchRow } from './kernel-panels.ts'
import type { ScheduleRow } from './render/projection.ts'
import { createUserSettingsPersistence, writeFileAtomically } from './settings-file.ts'
import { turnUsages, type UsageView } from './render/usage.ts'
// Type-only import: merges the projection registry into the Context type so
// `ctx.get('sessionProjections')` is typed (the service itself is mounted by
// dsh-base at runtime).
import type {} from '@deepseek-ai/dsh-session-projection'

/** Stable Cordis plugin name. */
export const name = 'tui-runner'

/** Core services required before the interactive session can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** Plugin config: the startup resolved from this app's injected provider service. */
export interface Config {
  /** How this invocation obtains its session identity (validated loosely; narrowed in {@link apply}). */
  startup: { kind: string; sessionId?: string; mode?: string; theme?: string; prompt?: string; images?: string[] }
}

export const Config: z<Config> = z.object({
  startup: z.object({
    kind: z.string().required(),
    sessionId: z.string(),
    mode: z.string(),
    theme: z.string(),
    prompt: z.string(),
    images: z.array(z.string()),
  }),
})

/** Process-facing effects of the runner: the Ink mount plus the launcher's exit request. */
interface TuiIo {
  mount: typeof internals.mount
  exit: (code: number) => void
}

/** Report an unexpected direct-driver failure and request a failing exit. */
/** A Host method that answers `null` (nothing to report), for props that expect `void`. */
const done = (pending: Promise<unknown>): Promise<void> => pending.then(() => {})

function fail(io: TuiIo, error: unknown): void {
  internals.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
  io.exit(1)
}

/**
 * Read one user-level settings file as a plain object. The callers all treat a
 * missing file as "unset" and a corrupt one as "warn and fall back", so this
 * helper owns the one distinction they share: readable JSON that is not an
 * object is corruption, not an absent preference, and must not surface as a
 * cryptic property access on `null`.
 * @param path - absolute path of the settings file.
 * @returns the parsed object; the caller narrows each field itself.
 */
function readSettingsObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${basename(path)} must contain a JSON object`)
  }
  return parsed as Record<string, unknown>
}

/**
 * Resolve the working directory's git branch for the status line.
 * @param cwd - the session's working directory.
 * @returns the branch name, or '' outside a repository or on a detached HEAD.
 */
function gitBranch(cwd: string): string {
  try {
    const ref = readFileSync(join(cwd, '.git', 'HEAD'), 'utf8').trim().match(/^ref: refs\/heads\/(.+)$/)
    return ref?.[1] ?? ''
  } catch {
    // Only the single HEAD read is attempted, so the sole reachable failure is
    // a missing repository (or unreadable HEAD file): the branch group drops out.
    return ''
  }
}

/** The session identity this invocation will run, plus whether it is resumed. */
interface Target {
  sessionId: string
  resume: boolean
  mode?: string
  cwd?: string
  /** Fork this session (after `atSeq`, or its whole log) instead of opening `sessionId` fresh. */
  forkOf?: { readonly sessionId: string; readonly atSeq?: number }
  parentSession?: SessionId
  /** Marks the session as a subagent conversation in the durable header. */
  origin?: 'subagent'
}

/**
 * Reduce a session id to a filename-safe /export default-name suffix. Session
 * ids are normally minted `session-<uuid>`, but `--session` accepts arbitrary
 * user text: path separators must never leak into the default export filename
 * (which would escape the session cwd).
 * @param id - the session id.
 * @returns at most the last 8 filename-safe characters.
 */
export function exportSessionIdSuffix(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/gu, '_').slice(-8)
}

/** One ordered step of the terminal quit cleanup. */
export interface QuitCleanupStep {
  /** Step label used in diagnostics and tests. */
  readonly name: string
  /** The step's async work; a rejection is contained by the sequence. */
  readonly run: () => Promise<void>
}

/**
 * Run the ordered quit cleanup, then request exit. Every step rejection is
 * contained (reported through `onError`) so a failed flush or dispose never
 * skips the remaining cleanup; the exit request is always reached exactly
 * once.
 * @param steps - the cleanup steps in dependency order (settle the visible
 * session, await the final in-flight composition, await durable recall).
 * @param exit - the terminal exit request (code 0).
 * @param onError - optional failure sink; called once per failing step and
 * itself contained, so a throwing sink cannot abort the sequence.
 * @returns the names of the steps that started, in order (for tests).
 */
export async function runQuitSequence(
  steps: readonly QuitCleanupStep[],
  exit: (code: number) => void,
  onError?: (name: string, error: unknown) => void,
): Promise<readonly string[]> {
  const started: string[] = []
  for (const step of steps) {
    started.push(step.name)
    try {
      await step.run()
    } catch (error) {
      try {
        onError?.(step.name, error)
      } catch {
        // The failure sink must never abort the cleanup sequence.
      }
    }
  }
  try {
    exit(0)
  } catch {
    // The exit request itself must not become an unhandled rejection.
  }
  return started
}

/** One composer submission waiting behind the startup delivery. */
export interface QueuedSubmission {
  readonly text: string
  /** `steer` inserts into the running turn; `followup` waits for the next one. */
  readonly mode: 'followup' | 'steer'
  readonly images: readonly ContentBlock[]
}

export { applyQueueMutation, cancelPreservingQueue, queueEditContent, type QueueMutationOutcome } from './queue.ts'
import type { QueueMutationOutcome } from './queue.ts'

/**
 * Whether a tagged submission still belongs to the active session. Attachment
 * prepares resolve on the microtask timeline, while a queued session switch
 * remounts the app asynchronously — the composing instance's unmount cleanup
 * runs too late to abort, so the delivery itself carries the composing
 * session's full id and the runner drops it here when the world moved on.
 * An untagged (synchronous) or pending-session ('') submission always passes.
 */
export function submissionBelongsToSession(origin: string | undefined, activeSessionId: string | undefined): boolean {
  return origin === undefined || origin === '' || origin === activeSessionId
}

/**
 * Root-log catalog facts a resumed session must replay into the subagent
 * feed: constructor seeds never fire on the live bus, so without this the
 * children of a resumed session vanish behind a restart. The empty-child
 * placeholder row (childId '') is a placeholder, not a child, and stays out.
 */
export function subagentCatalogSeed(events: readonly SessionEvent[]): readonly SessionEvent<'subagent/catalog'>[] {
  return events.filter((event): event is SessionEvent<'subagent/catalog'> =>
    event.type === 'subagent/catalog' && event.data.childId !== '')
}

export { searchHitToRow } from './session-directory.ts'

/** One Shift+Tab station decision for the mode cycle. */
export type ModeCycleDecision =
  | { readonly kind: 'permission'; readonly preset: string }
  | { readonly kind: 'plan-on' }
  | { readonly kind: 'plan-off'; readonly preset: string }

/**
 * Decide the next Shift+Tab station. The cycle keeps the preset table's
 * own order (most restrictive first) and inserts ONE plan station between
 * the most restrictive preset and the wrap target: with the shipped three
 * presets the user sees workspace-write → danger-full-access → read-only
 * → plan → workspace-write. Plan IS the most restrictive preset plus the
 * plan prompt layer — entering it switches nothing (the cycle is already
 * parked on read-only), and leaving it lands on the next preset after the
 * most restrictive one. Without the /plan command the cycle is exactly the
 * preset table.
 *
 * `planIntent` covers the committed fold's commit lag: upstream queues a
 * plan switch during an open turn (and the command pipeline is async even
 * idle), so the durable plan/mode event lands AFTER the press that chose
 * it. While an intent from an earlier press is in flight it — not the
 * stale committed fold — decides the station, so repeated presses advance
 * the cycle instead of re-issuing the same plan transition (the stuck
 * plan-on/plan-off toggle). Undefined falls back to the committed fold.
 */
export function planCycleDecision(input: {
  readonly names: readonly string[]
  readonly current: string
  readonly inPlan: boolean
  readonly planAvailable: boolean
  readonly planIntent?: boolean
}): ModeCycleDecision | undefined {
  const names = input.names
  if (names.length === 0) return undefined
  const first = names[0]
  if ((input.planIntent ?? input.inPlan) === true) return { kind: 'plan-off', preset: names[1] ?? first }
  const at = names.indexOf(input.current)
  if (at === 0 && input.planAvailable) return { kind: 'plan-on' }
  return { kind: 'permission', preset: names[(at + 1) % names.length] ?? first }
}

/**
 * Order-preserving gate for composer input while the startup prompt/images
 * are still preparing. Anything submitted before the startup delivery settles
 * queues and flushes afterwards in submit order, so the initial request can
 * never be overtaken by typing that raced a slow image preparation. The flush
 * also runs when the startup delivery fails: user input is never stranded.
 */
export class StartupInputGate {
  private readonly queued: QueuedSubmission[] = []
  private pending = false
  private readonly deliver: (submission: QueuedSubmission) => void
  constructor(deliver: (submission: QueuedSubmission) => void) {
    this.deliver = deliver
  }

  /** Submit one line: delivered now while idle, queued behind the startup delivery otherwise. */
  submit(submission: QueuedSubmission): void {
    if (this.pending) this.queued.push(submission)
    else this.deliver(submission)
  }

  /**
   * Run the startup delivery — the callback receives the direct-delivery sink
   * for the startup prompt itself — then flush everything that queued behind
   * it, in order, even when the callback rejects.
   */
  async run(startup: (deliver: (submission: QueuedSubmission) => void) => Promise<void>): Promise<void> {
    this.pending = true
    try {
      await startup(submission => this.deliver(submission))
    } finally {
      this.pending = false
      const queued = this.queued.splice(0)
      for (const submission of queued) this.deliver(submission)
    }
  }
}

/**
 * The warning for a resume that leaves the launch folder, or undefined when
 * it stays. A session binds to one folder when it is created, and the
 * workspace, the shell and the durable log all follow that header cwd — so a
 * cross-folder resume works, but the user must be told the window moved.
 * @param pinnedCwd - the header's project directory, when it has one.
 * @param launchCwd - the directory DSCODE was launched in.
 * @returns the warning text, or undefined when the folders already agree.
 */
export function resumeFolderWarning(pinnedCwd: string | undefined, launchCwd: string): string | undefined {
  if (sessionFolderMatches(pinnedCwd, launchCwd)) return undefined
  return t('notice.resumedOtherFolder', { folder: pinnedCwd!, launch: launchCwd })
}

/**
 * Resolve the invocation's target session against the persisted headers.
 * @param startup - the parsed startup flags.
 * @param persistence - the persistence service; required for resume/latest.
 * @param cwd - the working directory `--continue` filters by.
 * @returns the target identity.
 * @throws with a user-facing message when the flags name nothing resolvable.
 */
export async function resolveTarget(startup: TuiStartup, persistence: SessionPersistence | undefined, cwd: string): Promise<Target> {
  if (startup.kind === 'fresh') return { sessionId: `session-${randomUUID()}`, resume: false, mode: startup.mode }
  if (startup.kind === 'named') {
    // The id must not exist yet: reject before any Agent composition when the
    // backend can tell us (a live collision is still caught by the session
    // store at create time).
    if (persistence !== undefined) {
      const headers: readonly SessionHeader[] = (await persistence.list()).map(snapshot => snapshot.header)
      if (headers.some(header => header.id === startup.sessionId)) {
        throw new Error(`session "${startup.sessionId}" already exists; use --resume to continue it`)
      }
    }
    return { sessionId: startup.sessionId, resume: false, mode: startup.mode }
  }
  if (persistence === undefined) {
    throw new Error('cannot resolve the requested session: session persistence is not configured')
  }
  const headers: readonly SessionHeader[] = (await persistence.list()).map(snapshot => snapshot.header)
  if (startup.kind === 'resume') {
    const matched = matchSessionId(headers, startup.sessionId)
    // Subagent conversations are read-only everywhere else; the CLI must not
    // be a back door into appending root turns to a child's durable log.
    if (isSubagentSession(matched)) {
      throw new Error('subagent conversations are read-only; resume a root session')
    }
    return { sessionId: matched.id, resume: true }
  }
  // --continue: the newest persisted ROOT session whose header pins this cwd.
  const newest = newestRootForCwd(headers, cwd)
  if (newest === undefined) throw new Error(`no persisted session for this directory (${cwd}); start one without --continue`)
  return { sessionId: newest.id, resume: true }
}

/**
 * Resolve a bounded command preview for one pending approval: the request
 * contract carries no arguments, so the bar self-serves from the transcript
 * projection via `callId` (mirrors the web ApprovalPanel's argsRaw lookup).
 * @param events - the transcript entries to search.
 * @param callId - the tool call the question is about, when the asker had one.
 * @param toolName - the tool the question is about.
 * @returns a bounded preview line, '' when nothing useful resolves.
 */
function approvalCommandPreview(events: readonly { kind: string }[], callId: string | undefined, toolName: string): string {
  if (callId === undefined) return ''
  const entry = events.find(candidate =>
    candidate.kind === 'tool' && (candidate as { callId?: string }).callId === callId)
  if (entry === undefined) return ''
  const args = (entry as { arguments?: string }).arguments ?? ''
  return toolArgumentsPreview(args, toolName)
}

/** The runner's connection between the React app and the process side. */
interface AppBridge {
  /** Post one local notice line (feedback the transcript does not carry). */
  notify: (text: string, tone?: NoticeTone) => void
  /**
   * Park a submission on the budget confirmation panel instead of delivering
   * it. The runner owns delivery, so it passes the line back once the user
   * confirms; `undefined` clears the panel.
   */
  confirmBudget: (pending: { decision: BudgetDecision; text: string; images: readonly ContentBlock[]; mode: 'followup' | 'steer' } | undefined) => void
}

/**
 * Run the interactive terminal session: resolve the target session, create or
 * resume one Agent, mount the app, and keep the process alive until the user
 * quits.
 * @param ctx - plugin context carrying the Agent, default model, Session, and launcher IO services.
 * @param startup - the parsed invocation flags.
 * @param io - process-facing effects.
 */
/** Routes asynchronous runtime failures to the terminal once it can show notices. */
export interface RuntimeErrorSink {
  report(error: unknown): void
  /** A plain notice about the runtime itself (the connection dropped, it is back). */
  announce(text: string, tone: 'info' | 'warning' | 'error'): void
  attach(notify: (text: string, tone: 'info' | 'warning' | 'error') => void): void
}

export function runtimeErrorSink(): RuntimeErrorSink {
  type Tone = 'info' | 'warning' | 'error'
  let notify: ((text: string, tone: Tone) => void) | undefined
  const pending: [string, Tone][] = []
  const send = (text: string, tone: Tone): void => {
    if (notify === undefined) pending.push([text, tone])
    else notify(text, tone)
  }
  return {
    report(error) {
      send(`runtime request failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    },
    announce: send,
    attach(next) {
      notify = next
      for (const [text, tone] of pending.splice(0)) next(text, tone)
    },
  }
}

/** What the runner needs from its surroundings. */
export interface RunnerEnvironment {
  /** The runtime every session operation goes through. */
  readonly runtime: RuntimeClient
  /** No Host runs in this process, so the footer mirrors the Host's sources. */
  readonly detached: boolean
  /** Receives the protocol runtime's asynchronous failures. */
  readonly errors?: RuntimeErrorSink
  /**
   * Folder for new sessions and `--continue` when it is not this process's
   * own: a remote runtime's folder is a path on the server.
   */
  readonly cwd?: string
}

async function run(env: RunnerEnvironment, startup: TuiStartup, io: TuiIo): Promise<void> {
  const { runtime } = env
  if (startup.kind === 'fresh' || startup.kind === 'named') requireDscodePreset(startup.mode)
  const cwd = env.cwd ?? process.cwd()
  const attachments = attachmentClient(runtime, () => session?.header.cwd ?? cwd)
  const workspace = workspaceClient(runtime)
  // The status-line branch: read directly when this process sees the folder,
  // otherwise asked of the Host and refreshed at most every few seconds.
  const remoteBranches = new Map<string, { value: string; at: number }>()
  const branchOf = (dir: string): string => {
    if (runtime.sharesFilesystem) return gitBranch(dir)
    const known = remoteBranches.get(dir)
    if (known === undefined || Date.now() - known.at > 5000) {
      remoteBranches.set(dir, { value: known?.value ?? '', at: Date.now() })
      void workspace.gitBranch(dir).then(value => {
        if (value === remoteBranches.get(dir)?.value) return
        remoteBranches.set(dir, { value, at: Date.now() })
        renderCurrent()
      }, () => {})
    }
    return known?.value ?? ''
  }
  // Live deployment default (web selectModel parity), pushed by the Host on
  // every change, so a /model pick saved anywhere applies to later sessions.
  const defaultsWatch = remoteWatch(runtime, 'models/defaults', undefined, {})
  await defaultsWatch.ready
  const currentDefaults = (): ModelSelection => defaultsWatch.value!
  // The preset table is static for the process; the effective preset of a live
  // session is its committed permission fold (the transcript view).
  const permissionNames: readonly string[] = await runtime.call('permissions/names')
  const defaultPermission = permissionNames.length === 0 ? undefined : await runtime.call('permissions/effective', {})
  const effectivePermissionNow = (): string | undefined => session === undefined
    ? pendingPermission ?? defaultPermission
    : store.getView().permission ?? sessionPermission ?? defaultPermission
  /** Last preset this terminal selected for the live session, until its event lands. */
  let sessionPermission: string | undefined
  const persistence = {
    list: async () => ((await runtime.persistedSessions()) ?? []).map(header => ({ header })),
  } as unknown as SessionPersistence

  // A bare fresh launch stays transient: no Agent or session is composed, and
  // nothing is persisted, until the user's first real input. Explicit flags
  // (--resume/--continue/--session/--mode) keep the eager create/resume path.
  const lazy = startup.kind === 'fresh' && startup.mode === undefined

  interface ActiveSession {
    runtime: RuntimeSession
    store: ReturnType<typeof createTranscriptStore>
    mentions: MentionsApi
    mode: string
    selection: SelectionCell
    resumed: boolean
    /**
     * Set when this session is bound to a folder other than the launch
     * directory: the workspace follows the header, and the user is told once
     * through a notice when the session reaches the screen.
     */
    folderWarning?: string
    /**
     * Root-log `subagent/catalog` facts (resume path): constructor seeds
     * never fire on the live bus, so activation replays them into the
     * subagent feed after its reset — a resumed session's children stay
     * visible instead of vanishing behind a restart.
     */
    catalogSeed: readonly SessionEvent<'subagent/catalog'>[]
  }

  /** Prepare a complete next session before disturbing the currently visible one. */
  const prepare = async (next: Target): Promise<ActiveSession> => {
    const nextCwd = next.cwd ?? cwd
    // A bare launch can pick a model before any session exists: the process
    // keeps that explicit choice and every prepared session starts from it
    // (the documented precedence: explicit pick > session header > default).
    const selectionState: SelectionCell = pendingSelection === undefined
      ? {}
      : { picked: pendingSelection }
    const mode = requireDscodePreset(next.mode)
    let folderWarning: string | undefined
    if (next.resume) {
      // The header is the only durable folder binding; the resumed session
      // works in that folder whichever entry point got here — the CLI
      // --resume flag, the /resume picker, /search or a queued switch. Only
      // the notice differs, so it is prepared here and displayed once the
      // session is actually on screen.
      const pinned = (await runtime.persistedSessions())?.find(header => header.id === next.sessionId)?.cwd
      folderWarning = resumeFolderWarning(pinned, cwd)
    }
    const common = {
      sessionId: next.sessionId,
      cwd: nextCwd,
      preset: mode,
      selection: selectionState,
      ...(pendingPermission === undefined ? {} : { permission: pendingPermission }),
      // Quit aborts an in-flight composition so the exit wait never hangs on a
      // prepare that cannot settle; upstream rolls the creation back.
      signal: quitAbort.signal,
    }
    const opened = next.forkOf !== undefined
      ? await runtime.fork({ ...common, sourceSessionId: next.forkOf.sessionId, ...(next.forkOf.atSeq === undefined ? {} : { atSeq: next.forkOf.atSeq }) })
      : await runtime.open({
        ...common,
        resume: next.resume,
        ...(next.parentSession === undefined ? {} : { parentSession: next.parentSession }),
        ...(next.origin === undefined ? {} : { origin: next.origin }),
      })
    const seedEvents = opened.snapshotEvents()
    // Resume precedence, middle layer: the log's unconsumed `model/selection`
    // (a pick the web host recorded that no request ever assembled) outranks
    // the older request header; an in-process pick still outranks both.
    if (next.resume && selectionState.picked === undefined) {
      const pending = pendingModelSelection(seedEvents)
      if (pending !== undefined) selectionState.picked = pending
    }
    return {
      runtime: opened,
      store: createTranscriptStore(seedEvents),
      mentions: remoteMentions(runtime, opened.id, opened.header.cwd ?? nextCwd),
      mode,
      selection: selectionState,
      resumed: next.resume,
      ...(folderWarning === undefined ? {} : { folderWarning }),
      catalogSeed: subagentCatalogSeed(seedEvents),
    }
  }

  let active: ActiveSession | undefined
  /** The active session, reached only through the runtime. */
  let session: RuntimeSession | undefined
  let store: TranscriptStore = createTranscriptStore()
  // Live subagent activity (child sessions of the current root): one bounded
  // row per child, folded from the same event bus the transcript feeds on.
  const subagents: SubagentFeedView & { apply(sessionId: string, event: SessionEvent): void; reset(): void } = createSubagentFeed()
  // The bridge the React app registers on mount: local notices from the
  // process side (unknown commands, switch confirmations, cancels).
  const bridge: AppBridge = { notify: () => {}, confirmBudget: () => {} }
  /**
   * Notices emitted before the App mounted and registered its bridge; the
   * first registration flushes them in order. Nothing else can drop a startup
   * notice: the stub above is running before any React effect has committed.
   */
  const pendingNotices: { text: string; tone?: NoticeTone }[] = []
  /** True from the FIRST bridge registration: a startup notice must land on it,
   * never on the instance a later session switch is about to replace. */
  let bridgeReady = false
  /**
   * The session whose over-budget submission the user already approved. The
   * gate asks once per session: a second prompt in the same session does not
   * re-ask, and a new session starts with the question unanswered again.
   */
  let budgetAcknowledgedFor: string | undefined

  // dscode: live cross-session communication of the CURRENT root session. The
  // feed is advisory display state rebuilt from the root log, so a resumed
  // session re-derives its history instead of replaying stale notices.
  let communication: CommunicationView = createCommunicationFeed()
  /** Row ids already reported through a notice, so a re-fold never repeats one. */
  const communicationNoticed = new Set<string>()

  /**
   * A peer's readable label: a bridge relay labels its source `session:<id>`,
   * which is shortened to the tail the session directory shows.
   */
  const dscodePeerLabel = (peer: string): string =>
    peer.startsWith('session:') ? `session ${peer.slice('session:'.length).slice(-12)}` : peer

  /**
   * Fold one root event into the cross-session feed and announce what is new.
   * The activity line reads the view; a notice is the durable, scrollable
   * record. Both use the relay tone and the ⇄ family, so this traffic never
   * reads as the session's own shell or model output.
   */
  const observeCommunication = (event: SessionEvent): void => {
    const previous = communication
    const next = foldCommunication(previous, event)
    if (next === previous) return
    communication = next
    for (const row of next.rows) {
      if (row.pending || communicationNoticed.has(row.id)) continue
      communicationNoticed.add(row.id)
      if (row.direction === 'received') {
        bridge.notify(`← ${dscodePeerLabel(row.peer)}${row.preview === '' ? '' : ` · ${row.preview}`}`, 'relay')
        continue
      }
      const kind = row.kind === undefined ? '' : ` ${row.kind}`
      const status = row.failed ? ' — failed' : ''
      bridge.notify(`→ ${dscodePeerLabel(row.peer)}${kind}${status}`, 'relay')
    }
  }
  // Side-question runs (/btw): a seeded read-only child whose answer renders in
  // its own panel and never in this transcript or its model context.
  const btw: BtwFeed = createBtwFeed()
  /** Live side-question children, disposed with the session that spawned them. */
  const btwIds = new Set<string>()
  /** Stop every live side question; the panel keeps the answers it already has. */
  const disposeBtw = (): void => {
    for (const id of btwIds) btw.drop(id)
    if (btwIds.size > 0) void runtime.call('btw/dispose', { ids: [...btwIds] }).catch(() => {})
    btwIds.clear()
  }
  // Pre-session @file completion runs the official search over the launch
  // cwd (model- and session-independent); the prepare/activate paths replace
  // this with the agent-scoped instance once a session exists.
  let mentions: MentionsApi = remoteMentions(runtime, undefined, cwd)
  /** Explicit model pick made before any session exists (a bare launch). */
  let pendingSelection: ModelSelection | undefined
  /** Permission preset selected before the first session exists. */
  let pendingPermission: string | undefined
  /**
   * Plan-mode choice made before the first session exists: materialized as a
   * /plan registry command delivered ahead of the first queued input when the
   * session composes, so the first assembled step already plans.
   */
  let pendingPlan = false
  /**
   * In-flight mid-session plan choice from the Shift+Tab cycle. Upstream
   * queues a plan switch during an open turn (and the command pipeline is
   * async even idle), so the committed plan/mode fold lags the press that
   * chose it; the cycle reads this intent until the durable event lands,
   * then the session/event funnel clears it.
   */
  let planIntent: boolean | undefined
  /**
   * Whether the pre-session effective preset composes plan mode, answered by
   * the presets service composition inventory (minimal does not). Cached and
   * refreshed whenever the pending mode moves; unknown reads as unavailable
   * so one keypress at most lands before the answer arrives.
   */
  let preSessionPlanAvailable = false
  let preSessionPlanKnown = false
  const refreshPreSessionPlan = (): void => {
    preSessionPlanKnown = false
    void runtime.call('presets/planAvailable').then(available => {
      preSessionPlanAvailable = available
      preSessionPlanKnown = true
    }, () => {
      preSessionPlanAvailable = false
      preSessionPlanKnown = true
    })
  }
  refreshPreSessionPlan()
  /**
   * Monotonic session epoch: bumped on every successful activation, on every
   * first-session creation, and on quit. Async callbacks (mention prepares,
   * command executions) capture it at call time and drop their result when it
   * changed, so a stale callback can never deliver to an agent that is no
   * longer on screen.
   */
  let epoch = 0
  /** Aborted on quit: an in-flight agent composition (create/resume) races this signal. */
  const quitAbort = new AbortController()
  /** In-flight mention-prepare / command-execute controllers, aborted on any session transition. */
  const pendingControllers = new Set<AbortController>()
  const abortPendingControllers = (): void => {
    for (const controller of [...pendingControllers]) {
      pendingControllers.delete(controller)
      controller.abort()
    }
  }
  /** The in-flight session-composition turn (create/resume/activate), if any. */
  let composing: Promise<void> | undefined
  /**
   * Run one session composition exclusively: concurrent compositions wait
   * their turn, so a bare-launch first-session creation and a /resume
   * activation can never compose agents in parallel (the loser would leak its
   * agent or mis-deliver). Errors propagate to the caller; the shared slot
   * always continues.
   */
  const compose = (work: () => Promise<void>): Promise<void> => {
    const turn = (composing ?? Promise.resolve()).catch(() => {}).then(work)
    composing = turn.catch(() => {})
    return turn
  }

  /** The initial session's folder warning, held until the App can show it. */
  let startupFolderWarning: string | undefined
  if (!lazy) {
    const target = await resolveTarget(startup, persistence, cwd)
    const prepared = await prepare(target)
    startupFolderWarning = prepared.folderWarning
    active = prepared
    session = prepared.runtime
    store = prepared.store
    mentions = prepared.mentions
    // Replayed catalog facts rebuild the resumed session's child rows before
    // the first render (the live handler only folds events from now on).
    for (const event of prepared.catalogSeed) subagents.apply(event.data.childId, event)
  }

  // The resumed root's own cross-session history is folded here, but its rows
  // are marked seen: a restart reports new traffic, never the whole past.
  if (session !== undefined) {
    communication = session.snapshotEvents().reduce((view, event) => foldCommunication(view, event), createCommunicationFeed())
    for (const row of communication.rows) communicationNoticed.add(row.id)
  }

  // Seed the transcript from the full session log: constructor seeds never
  // fire on `session/event`, so a resumed session paints its history once
  // before the first render. The handler reads the current session/store, so
  // the deferred first session of a bare launch is covered by the same feed.
  const off = runtime.onSessionEvent((subject, event) => {
    if (session === undefined) return
    if (subject.id === session.id) {
      store.apply(event)
      // The committed plan fold caught up (or diverged via a typed /plan or
      // an approved plan review): the durable event is the live truth again,
      // so the cycle's in-flight intent retires.
      if (event.type === 'plan/mode') planIntent = undefined
      // The parent-owned subagent catalog rides the ROOT log (0.1.5); each
      // fact describes one child, so it feeds that child's live row.
      if (event.type === 'subagent/catalog' && event.data.childId !== '') subagents.apply(event.data.childId, event)
      observeCommunication(event)
      return
    }
    // Child sessions (subagent conversations this root spawned) fold into
    // the bounded live-activity feed, never the transcript: the root stays
    // the only durable transcript truth while a running subagent remains
    // visible. Lineage comes from the child header, same field the session
    // directory uses to tag `↳` rows.
    if (subject.header.parentSession === session.id && subject.header.origin === 'subagent') {
      subagents.apply(subject.id, event)
      // A side question folds into its own run store and settles at turn end.
      if (btw.store(subject.id) !== undefined) {
        btw.apply(subject.id, event)
        if (event.type === 'turn/end') btw.settle(subject.id, 'done')
      }
    }
  })

  // Live assistant typing (session-log v2+): durable logs are settlement-only,
  // so the streaming tails ride the process-local `agent/assistant-stream`
  // frames of the current root agent. Settlement events clear the tails when
  // they land (always before a committed end frame); an abandoned attempt's
  // partial tail is dropped by the store on its end frame.
  runtime.onAssistantStream((agentId, frame) => {
    if (session !== undefined && agentId === session.agentId) {
      store.applyStreamFrame(frame)
      return
    }
    // A side question streams into its own panel transcript, never the main one.
    btw.applyStreamFrame(agentId, frame)
  })

  const commands: CommandsView = watchCommands(runtime)
  if (session !== undefined) commands.setSession(session.id)

  const skills: RemoteSkillsView = watchRemoteSkills(runtime, cwd)
  if (session !== undefined) skills.setSession(session.id, session.header.cwd ?? cwd)

  // Approval answerer: renders the ask as a y/n bar; only this TUI's agent is
  // claimed, every other ask falls through to the fail-closed waterfall. The
  // owner predicate is empty until the first session exists.
  const approval: ApprovalStore = mountApprovalAnswerer(
    answerer => runtime.onApprovalRequest(answerer),
    agentId => session !== undefined && agentId === session.agentId,
    request => approvalCommandPreview(store.getView().entries, request.callId, request.toolName),
  )

  // Subagent model routing lives on the Host (host/models.ts); /subagent sets
  // its override there and this label mirrors it.
  let subagentOverride: ModelSelection | undefined

  // ask_user_question answerer: one waterfall listener, one request on
  // screen at a time. Plan reviews (exit_plan_mode) arrive through this same
  // pipe; sibling answerers stay usable through the claim/defer split.
  const questions: QuestionStore = mountQuestionProvider(
    answerer => runtime.onQuestionRequest(answerer),
    agentId => session !== undefined && agentId === session.agentId,
  )

  env.errors?.attach((text, tone) => bridge.notify(text, tone))
  // Host notices (for example the background capability sync's warnings).
  const offNotices = followNotices(runtime, (text, tone) => bridge.notify(text, tone))
  // A separate terminal mirrors the Host's footer sources for the active session.
  const statusMirror = env.detached ? mirrorStatusSources(runtime) : undefined
  statusMirror?.follow(session?.id)

  // /statusline persistence: one user-level JSON file under the DSH home.
  // Missing file means defaults; a corrupt file degrades to defaults with a
  // surfaced warning (the customization is user-authored, never silent).
  const statuslinePath = join(terminalStateDirectory(), 'statusline.json')
  let statuslineWarning: string | undefined
  let statuslineItems: readonly string[] = []
  try {
    statuslineItems = parseStatuslineItems(readSettingsObject(statuslinePath).items)
  } catch (error) {
    statuslineItems = parseStatuslineItems(undefined)
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      statuslineWarning = error instanceof Error ? error.message : String(error)
    }
  }
  // Serialized, crash-atomic writes for the user-level JSON files: the chain
  // orders rapid consecutive saves (the LAST snapshot wins on disk), each
  // write goes through a sibling temp file + rename, and quit waits for the
  // flush exactly like it waits for the recall history.
  const settingsPersistence = createUserSettingsPersistence()
  const saveStatusline = (items: readonly string[]): void => {
    statuslineItems = [...items]
    void settingsPersistence.save(statuslinePath, JSON.stringify({ items }, null, 2) + '\n')
      .catch((writeError: unknown) => {
        bridge.notify(t('notice.statuslineSaveFailed', { message: writeError instanceof Error ? writeError.message : String(writeError) }), 'error')
      })
  }

  // /vscode-keys: detect the hosting editor's user keybindings.json and pass
  // Ctrl+R through the workbench. One marker file under the DSH home keeps
  // the startup hint a once-per-install event.
  const editorKeysEnv: EditorKeysEnv = {
    env: process.env,
    paths: { homedir: homedir(), appdata: process.env.APPDATA, platform: process.platform },
    flagPath: join(terminalStateDirectory(), 'editor-keys.json'),
  }
  const applyEditorKeys = (): Promise<string> => applyCtrlRPassthrough(editorKeysEnv)

  // /theme persistence: one user-level JSON file under the DSH home, mirroring
  // the statusline file. A missing file means the dark default; a corrupt file
  // degrades to dark with a surfaced warning. Precedence: CLI --theme > file >
  // auto detection > dark (auto detection itself is a later enhancement and
  // currently falls back to dark inside theme.ts).
  const themePath = join(terminalStateDirectory(), 'theme.json')
  let themeWarning: string | undefined
  if (startup.theme === undefined) {
    try {
      setTheme(parseThemeName(readSettingsObject(themePath).theme))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        themeWarning = error instanceof Error ? error.message : String(error)
      }
    }
  } else {
    setTheme(startup.theme)
  }
  const saveTheme = (name: ThemeName): void => {
    setTheme(name)
    void settingsPersistence.save(themePath, JSON.stringify({ theme: name }, null, 2) + '\n')
      .catch((writeError: unknown) => {
        bridge.notify(t('notice.themeSaveFailed', { message: writeError instanceof Error ? writeError.message : String(writeError) }), 'error')
      })
  }

  // /language persistence: one user-level JSON file beside theme.json. A
  // missing file means English; a corrupt file degrades to English with a
  // surfaced warning.
  const languagePath = join(terminalStateDirectory(), 'language.json')
  let languageWarning: string | undefined
  try {
    setLanguage(parseLanguageName(readSettingsObject(languagePath).language))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      languageWarning = error instanceof Error ? error.message : String(error)
    }
  }
  const saveLanguage = (name: LanguageName): void => {
    setLanguage(name)
    void settingsPersistence.save(languagePath, JSON.stringify({ language: name }, null, 2) + '\n')
      .catch((writeError: unknown) => {
        bridge.notify(t('notice.languageSaveFailed', { message: writeError instanceof Error ? writeError.message : String(writeError) }), 'error')
      })
  }

  // /animation persistence: one user-level JSON file under the DSH home,
  // mirroring the theme file. A missing file means animations are on; a
  // corrupt file degrades to on with a surfaced warning. Only an explicit
  // `false` disables (parseAnimationsPref), so hand-edited or partial files
  // never silently freeze the UI.
  const animationsPath = join(terminalStateDirectory(), 'animations.json')
  let animationsEnabled = true
  let animationsWarning: string | undefined
  try {
    // A literal `null` file reads as corruption and surfaces the warning the
    // block above promises, instead of a property access on `null`.
    animationsEnabled = parseAnimationsPref(readSettingsObject(animationsPath).animations)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      animationsWarning = error instanceof Error ? error.message : String(error)
    }
  }
  const saveAnimations = (enabled: boolean): void => {
    void settingsPersistence.save(animationsPath, JSON.stringify({ animations: enabled }, null, 2) + '\n')
      .catch((writeError: unknown) => {
        bridge.notify(t('notice.animationsSaveFailed', { message: writeError instanceof Error ? writeError.message : String(writeError) }), 'error')
      })
  }

  // Global input recall (Codex composer-history contract): one JSONL file
  // under the DSH home. A missing file means an empty history; unreadable or
  // corrupt content degrades to the valid lines it could parse, silently —
  // recall is a convenience surface, never a gate.
  const historyPath = join(terminalStateDirectory(), 'history.jsonl')
  let inputHistory: readonly string[] = []
  let historyWriteChain: Promise<void> = Promise.resolve()
  try {
    const rawHistory = readFileSync(historyPath, 'utf8')
    inputHistory = parseHistoryFile(rawHistory)
    // Stale lines (adjacent duplicates, dropped garbage, an over-cap tail)
    // accumulate in an append-only file; rewrite the canonical form once
    // per boot. The rewrite rides the same chain, so it lands before any
    // submission the user types next. An entry another terminal appends
    // inside the read-to-rename window is dropped — a millisecond-scale
    // gap at boot that recall tolerates by design.
    if (needsCompaction(rawHistory)) {
      historyWriteChain = historyWriteChain
        .then(() => writeFileAtomically(historyPath, serializeHistoryList(inputHistory)))
        .catch(() => {})
    }
  } catch {
    inputHistory = []
  }
  /**
   * Serialized history writes: each submission appends one JSON line at the
   * end of the file, so concurrent terminals add entries after each other
   * instead of overwriting snapshots they read at their own boot. A
   * multi-line draft still occupies one physical line (JSON escapes the
   * newline), and a regular-length line reaches the disk as one positioned
   * write; an oversized paste may interleave mid-line, which the next
   * parse simply drops.
   */
  const recordHistory = (text: string): void => {
    if (text === '') return
    inputHistory = [...inputHistory, text].slice(-HISTORY_MAX_ENTRIES)
    historyWriteChain = historyWriteChain
      .then(() => mkdir(dirname(historyPath), { recursive: true }))
      .then(() => appendFileAsync(historyPath, historyLine(text), 'utf8'))
      .catch((writeError: unknown) => {
        bridge.notify(t('notice.historySaveFailed', { message: writeError instanceof Error ? writeError.message : String(writeError) }), 'error')
      })
  }

  /** Mutate one next-turn inbox item on the Host; durable inbox splices remain the UI truth. */
  const updateQueued = (messageId: string, action: QueueMutation): void => {
    const current = session
    if (current === undefined) return
    void runtime.call('session/updateQueued', { sessionId: current.id, messageId, action }).then(outcome => {
      switch (outcome) {
        case 'removed': bridge.notify(t('notice.queueCancelled')); return
        case 'edited': bridge.notify(t('notice.queueEdited')); return
        case 'steered': bridge.notify(t('notice.queueSteered')); return
        case 'empty': bridge.notify(t('notice.queueEditEmpty'), 'warning'); return
        case 'steerUnavailable': bridge.notify(t('notice.queueSteerUnavailable'), 'warning'); return
        case 'unavailable': bridge.notify(t('notice.queueUnavailable'), 'warning'); return
      }
    }, (error: unknown) => {
      bridge.notify(t('notice.queueActionFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
    })
  }

  // The mount handle lives in a box: quit closes over it, while the mount
  // itself is created after quit (the App element needs quit as a prop).
  const mountRef: { current?: TuiMount } = {}
  let quitting = false
  const quit = (fast = false): void => {
    if (quitting) return
    quitting = true
    switchQueue.cancel()
    // Stale prepares/commands die with the session they were for. Aborting
    // the composition signal lets a never-settling prepare reject, so the
    // exit wait below cannot hang (upstream rolls the creation back).
    abortPendingControllers()
    quitAbort.abort()
    disposeBtw()
    epoch += 1
    off()
    offNotices()
    statusMirror?.dispose()
    const currentSession = session
    const currentActive = active
    const report = (name: string, error: unknown): void => {
      internals.stderr.write(`dsh: quit ${name} failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    // A throwing unmount must not strand the terminal (stdin tap alive,
    // keyboard protocol stacks unpopped) or skip the exit sequence below.
    try {
      mountRef.current?.unmount()
    } catch (error: unknown) {
      report('unmount', error)
    }
    // One ordered cleanup: settle the visible session (if any — a bare launch
    // that never composed one resolves immediately), then wait for the final
    // in-flight composition (its work swallows errors and the quitting guard
    // disposes any half-prepared agent), then flush the durable recall and
    // the queued user-level settings writes, then request exit. `composing`
    // and `historyWriteChain` are read at step run
    // time, so a turn that was still being queued when quit ran is included.
    // A failing step must never skip the remaining cleanup.
    const steps: QuitCleanupStep[] = [
      ...(currentSession === undefined || currentActive === undefined
        ? []
        : [
          { name: 'flush', run: async () => { await currentSession.flush(); internals.stderr.write('\nResume this session: dscode resume ' + currentSession.id + '\n') } },
          { name: 'dispose', run: () => currentActive.runtime.dispose() },
        ]),
      { name: 'composing', run: () => composing ?? Promise.resolve() },
      { name: 'history', run: () => historyWriteChain },
      { name: 'settings', run: () => settingsPersistence.flush() },
    ]
    if (fast) setTimeout(() => process.exit(0), 250)
    void runQuitSequence(steps, io.exit, report)
  }

  /** Run one slash line through the command registry (closed namespace). */
  const runSlash = (line: string): void => {
    const currentSession = session
    if (currentSession === undefined) return
    if (line.startsWith('/resume ')) {
      requestResume(line.slice(8).trim())
      return
    }
    const controller = new AbortController()
    const atEpoch = epoch
    pendingControllers.add(controller)
    const finish = (): void => {
      pendingControllers.delete(controller)
    }
    // The Host runs the line through the native registry; a line no command
    // owns comes back unhandled and falls through below.
    void runtime.call('commands/execute', { sessionId: currentSession.id, line }, controller.signal).then((execution) => {
      finish()
      // A switch/quit landed while the command ran: its fall-through must not
      // reach an agent that is no longer on screen.
      if (epoch !== atEpoch || session !== currentSession) return
      if (!execution.handled) {
        // No command owns this line: send it verbatim so a user-invocable
        // skill gesture (`/skill-name`) reaches the host's tool-skill
        // pre-step injection — the web composer's same fall-through.
        void runtime.call('session/deliver', { sessionId: currentSession.id, content: [{ type: 'text', text: line }], mode: 'followup' }).catch((error: unknown) => {
          bridge.notify(t('notice.commandFallbackFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
        })
      }
    }, (error: unknown) => {
      finish()
      if (epoch !== atEpoch || session !== currentSession) return
      // A failed plan switch never appends the plan/mode event the cycle's
      // intent retirement waits for, so the in-flight choice dies here too —
      // otherwise every later Shift+Tab reads a phantom plan state.
      if (line === '/plan' || line === '/plan off') planIntent = undefined
      bridge.notify(t('notice.commandFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
    })
  }

  /** Delivery serialization state: the chain's epoch pins it to one session. */
  let deliveryChain: { epoch: number; tail: Promise<void> } = { epoch: 0, tail: Promise.resolve() }

  /** Deliver one trimmed line to the live session, expanding mentions first. */
  const deliverLine = (line: string, images: readonly ContentBlock[] = [], mode: 'followup' | 'steer' = 'followup'): void => {
    const currentSession = session!
    const currentMentions = mentions
    // The command registry is a closed namespace: slash lines run out of
    // band and never reach the model through this path.
    if (images.length === 0 && isSlashLine(line)) {
      runSlash(line)
      return
    }
    let parsed: ReturnType<MentionsApi['parse']>
    try {
      parsed = currentMentions.parse(line)
    } catch (error: unknown) {
      bridge.notify(`invalid session reference: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return
    }
    // Ordered delivery: the inbox order IS the user's message order. A line
    // with session mentions prepares asynchronously, and a later plain line
    // used to deliver synchronously past it. Every line now waits for the
    // previous line of the same session; an epoch change (switch/quit)
    // abandons the chain instead of gating the next session on the old one.
    if (deliveryChain.epoch !== epoch) deliveryChain = { epoch, tail: Promise.resolve() }
    const enqueueDelivery = (run: () => void | Promise<void>): void => {
      deliveryChain.tail = deliveryChain.tail.then(run)
    }
    const atEpoch = epoch
    const deliver = async (readable: string, context?: UserMessage): Promise<void> => {
      // A switch/quit landed while the snapshot was being prepared: never
      // deliver to an agent that is no longer on screen.
      if (epoch !== atEpoch || session !== currentSession) return
      // Session snapshots ride the inbox as model-facing context ahead of the
      // readable message; steering is consumed at the next step boundary of
      // the running turn, a followup becomes its own turn.
      const content: ContentBlock[] = [
        ...(readable === '' ? [] : [{ type: 'text' as const, text: readable }]),
        ...images,
      ]
      try {
        await runtime.call('session/deliver', { sessionId: currentSession.id, content, mode, ...(context === undefined ? {} : { context }) })
      } catch (error: unknown) {
        bridge.notify(`${mode === 'steer' ? 'steering' : 'message'} failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    }
    if (parsed.references.length === 0) {
      enqueueDelivery(() => deliver(parsed.text))
      return
    }
    const controller = new AbortController()
    pendingControllers.add(controller)
    // `enqueueDelivery` returns nothing; the delivery chain only orders the
    // work, so the promise is consumed here with an explicit void.
    enqueueDelivery(() => {
      return currentMentions.prepare(parsed, controller.signal).then((prepared) => {
        pendingControllers.delete(controller)
        return deliver(prepared.text, prepared.additionalContext)
      }, (error: unknown) => {
        pendingControllers.delete(controller)
        if (controller.signal.aborted || epoch !== atEpoch) return
        bridge.notify(`session reference failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      })
    })
  }

  // Deferred first-session creation for a bare launch: the session is composed
  // only when the user submits real input (or /new), and every line that
  // arrives during creation is delivered in order afterwards. A creation
  // failure reports and clears the queue, leaving the transient state ready
  // for the next attempt.
  const pendingInputs: Array<{ text: string; mode: 'followup' | 'steer'; images: readonly ContentBlock[] }> = []
  // A creation is queued/running: further submissions must not mint more
  // fresh sessions (their lines queue into pendingInputs instead).
  let creating = false
  const ensureSession = (mode?: string): void => {
    if (creating) return
    creating = true
    void compose(async () => {
      try {
        // Another composition (e.g. a /resume activated while this creation
        // waited its turn) may have published a session already: deliver the
        // queued lines there instead of minting a competing fresh session
        // (which would orphan the live one without a dispose).
        if (session !== undefined) {
          const queued = pendingInputs.splice(0)
          for (const item of queued) deliverLine(item.text, item.images, item.mode)
          return
        }
        const next = await prepare({
          sessionId: `session-${randomUUID()}`,
          resume: false,
          ...(mode === undefined ? {} : { mode }),
        })
        if (quitting) {
          void next.runtime.dispose().catch(() => {})
          return
        }
        const previous = { active, session, store, mentions }
        try {
          active = next
          session = next.runtime
          store = next.store
          mentions = next.mentions
          subagents.reset()
          for (const event of next.catalogSeed) subagents.apply(event.data.childId, event)
          pendingPermission = undefined
          commands.setSession(session.id)
          skills.setSession(session.id, session.header.cwd ?? cwd)
          statusMirror?.follow(session.id)
          sessionPermission = undefined
          // The App mounts with a placeholder key until the first input; the
          // key-change remount below must start from a clean screen or the ghost
          // static header stays visible above the new one (same source-backed
          // clear the session-switch path performs).
          process.stdout.emit('dscode:frame-reset')
          process.stdout.write('\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[H')
          renderCurrent()
        } catch (error: unknown) {
          // The session composed but the screen handoff threw (stdout EPIPE,
          // a render-time failure). Roll the published state back exactly
          // like the switch path does — otherwise the runner reports "session
          // creation failed" while the new session is actually live, clears
          // the queued inputs, and every later line lands in the ghost. The
          // queued inputs are KEPT for the next attempt.
          active = previous.active
          session = previous.session
          store = previous.store === undefined ? createTranscriptStore() : previous.store
          mentions = previous.mentions === undefined ? remoteMentions(runtime, undefined, cwd) : previous.mentions
          // First-session creation only runs with no session, so the rollback target has none.
          commands.setSession(undefined)
          skills.setSession(undefined, cwd)
          await next.runtime.dispose().catch(() => {})
          if (!quitting) renderCurrent()
          bridge.notify(`session activation failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
          return
        }
        abortPendingControllers()
        epoch += 1
        const queued = pendingInputs.splice(0)
        if (pendingPlan) {
          pendingPlan = false
          // A pre-session plan choice materializes as the registry command
          // delivered AHEAD of the queued lines, so the first assembled step
          // of the user's opening message already runs in plan mode.
          deliverLine('/plan')
        }
        for (const item of queued) deliverLine(item.text, item.images, item.mode)
      } finally {
        creating = false
      }
    }).catch((error: unknown) => {
      pendingInputs.length = 0
      bridge.notify(`session creation failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    })
  }

  /** Deliver one readable line to the agent, expanding session mentions first. */
  const sendNow = (text: string, images: readonly ContentBlock[] = [], mode: 'followup' | 'steer' = 'followup'): void => {
    // Blank check on the trimmed form; the payload itself keeps the draft's
    // exact whitespace unless the line is a syntactic slash command.
    const line = submissionPayload(text)
    if (line.trim() === '' && images.length === 0) return
    if (images.length === 0 && (line === '/mode' || line.startsWith('/mode '))) {
      bridge.notify('DSCODE mode is fixed to dscode.', 'info')
      return
    }
    if (images.length === 0 && line.startsWith('/permission ')) {
      try {
        const selected = setPermissionAction(line.slice(12).trim())
        bridge.notify(`permission → ${selected}`)
      } catch (error: unknown) {
        bridge.notify(`permission change failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      }
      return
    }
    if (session === undefined) {
      // The delivery mode rides the buffered line: a steer picked before the
      // first session exists must still steer once that session composes.
      pendingInputs.push({ text: line, mode, images })
      ensureSession()
      return
    }
    // dscode: the budget gate stops exactly one submission per session when the
    // recorded spend has reached `DSCODE_SESSION_BUDGET_USD`. The user decides;
    // an approval is remembered for the rest of the session, and a session with
    // no limit (or an unparseable one) never reaches this branch.
    const limit = parseBudget(process.env.DSCODE_SESSION_BUDGET_USD)
    if (limit !== null && budgetAcknowledgedFor !== session.id) {
      const decision = evaluateBudget(sessionSpend(session.id).cost, limit)
      if (decision.state === 'over') {
        bridge.confirmBudget({
          decision: { spent: decision.spent, limit: decision.limit, percent: decision.percent },
          text: line, images, mode,
        })
        return
      }
    }
    deliverLine(line, images, mode)
  }

  // Startup serialization: input submitted while the startup prompt/images
  // are still preparing queues behind the initial request.
  const inputGate = new StartupInputGate(({ text, mode, images }) => sendNow(text, images, mode))
  const send = (text: string, images: readonly ContentBlock[] = [], mode: 'followup' | 'steer' = 'followup'): void => {
    inputGate.submit({ text, mode, images })
  }

  /** Dispatch one submitted line: slash commands to the registry, other text to the agent. */
  const dispatch = (text: string, images: readonly ContentBlock[] = [], origin?: string): void => {
    // An attachment prepare resolved after the app remounted onto another
    // session (queued switch): the composing session is gone, so the stale
    // delivery is dropped instead of landing in the new session's inbox.
    if (!submissionBelongsToSession(origin, session?.id)) return
    send(text, images)
  }

  /**
   * Deliver one line as steering: a running driver consumes it at its next
   * step boundary, an idle one starts a turn with it. The composer's Tab
   * toggle picks this over {@link dispatch} for the next submission.
   */
  const steer = (text: string, images: readonly ContentBlock[] = [], origin?: string): void => {
    if (!submissionBelongsToSession(origin, session?.id)) return
    send(text, images, 'steer')
  }

  /**
   * Interrupt the running turn (Esc); true when a turn was actually
   * cancelled. {@link cancelPreservingQueue} keeps the next-turn queue alive
   * AND re-wakes the driver, so the preserved messages run instead of
   * parking; next-step steering dies with the turn.
   */
  const interrupt = (): boolean => {
    if (session === undefined || session.status !== 'running') return false
    void runtime.call('session/interrupt', { sessionId: session.id }).then(result => {
      if (result.cancelled) bridge.notify(t(result.preserved > 0 ? 'notice.turnCancelledKeepQueue' : 'notice.turnCancelled'))
    }, (error: unknown) => {
      bridge.notify(`cancel failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    })
    return true
  }

  /**
   * Select one permission preset before the first session or on the active
   * one. Validated against the Host's preset table so the reply is immediate;
   * the Host applies it and a failure arrives as a notice.
   */
  const choosePermission = (id: string): string => {
    if (!permissionNames.includes(id)) throw new Error(`unknown permission preset "${id}" (known: ${permissionNames.join(', ')})`)
    if (session === undefined) return id
    const target = session
    sessionPermission = id
    void runtime.call('permissions/select', { sessionId: target.id, id }).catch((error: unknown) => {
      if (session === target) sessionPermission = undefined
      bridge.notify(`permission change failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      renderCurrent()
    })
    return id
  }

  const setPermissionAction = (id: string): string => {
    if (permissionNames.length === 0) throw new Error('permission presets are not mounted in this composition')
    if (id === '') throw new Error('usage: /permission <preset>')
    const selected = choosePermission(id)
    if (session === undefined) pendingPermission = selected
    renderCurrent()
    return selected
  }

  /**
   * Shift+Tab mode cycle: permission presets in table order, then the plan
   * station when the composition offers the /plan command (preset-mounted,
   * so minimal sessions and the pre-session state cycle permissions only).
   * Plan transitions submit the upstream registry command — it stays the
   * single owner of plan state; the TUI renders the durable plan/mode event
   * it appends. Because that event lags the press (upstream queues the
   * switch during an open turn), each mid-session plan decision records the
   * choice in `planIntent` and the next press reads it back, so the cycle
   * advances stations instead of re-issuing one transition. Returns the
   * notice label, or '' when nothing changed.
   */
  const cycleMode = (): string => {
    if (permissionNames.length === 0) {
      bridge.notify('permission presets are not mounted in this composition', 'warning')
      return ''
    }
    try {
      // Pre-session the plan station rides the pending choice; once a
      // session exists the scoped /plan command descriptor decides, and the
      // durable plan/mode event is the live truth.
      const preSession = session === undefined
      if (preSession && !preSessionPlanKnown) refreshPreSessionPlan()
      const decision = planCycleDecision({
        names: permissionNames,
        current: effectivePermissionNow() ?? permissionNames[0],
        inPlan: preSession ? pendingPlan : store.getView().plan === true,
        ...(preSession ? {} : { planIntent }),
        planAvailable: preSession ? preSessionPlanAvailable : commands.descriptors.some(descriptor => descriptor.name === 'plan'),
      })
      if (decision === undefined) return ''
      if (decision.kind === 'permission') {
        const next = choosePermission(decision.preset)
        if (preSession) pendingPermission = next
        renderCurrent()
        return `permission → ${next}`
      }
      if (decision.kind === 'plan-on') {
        // Plan IS the most restrictive preset plus the plan prompt layer:
        // the cycle arrives here from that preset, so permission needs no
        // switch — only the plan mode itself toggles.
        if (preSession) {
          pendingPlan = true
          renderCurrent()
          return 'plan → on (applies to the first session)'
        }
        planIntent = true
        send('/plan')
        return 'plan → on'
      }
      // Leaving plan lands on the station after the most restrictive
      // preset (workspace-write with the shipped table).
      if (preSession) {
        pendingPlan = false
        pendingPermission = decision.preset
        renderCurrent()
        return `plan → off · permission → ${decision.preset}`
      }
      planIntent = false
      send('/plan off')
      choosePermission(decision.preset)
      return `plan → off · permission → ${decision.preset}`
    } catch (error: unknown) {
      bridge.notify(`mode change failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return ''
    }
  }

  /**
   * Apply one /model selection: takes effect from the next assembled step.
   * The optional reasoning effort must be one the row advertises (the picker
   * only offers those), so an unsupported value cannot reach the request
   * pipeline; an absent effort restores the model's own default.
   */
  const selectModel = (row: ModelRow, effortId?: string): string => {
    const selection = buildModelSelection(row, effortId)
    if (active === undefined) {
      // A bare launch has no session yet: keep the pick process-wide so the
      // first composed session starts from it.
      pendingSelection = selection
    } else {
      active.selection.picked = selection
      active.runtime.selectModel(selection)
    }
    // Every pick is persisted as the deployment default (web selectModel
    // parity), and the Host runs the request pipeline's local resolution so a
    // withdrawn effort surfaces now. Neither rolls the in-session switch back.
    void runtime.call('models/save', { selection }).then(result => {
      if (result.saveError !== undefined) bridge.notify(`model switch applies to this session but was not saved as the default: ${result.saveError}`, 'warning')
      if (result.rejected !== undefined) bridge.notify(`model selection rejected: ${result.rejected} — reopen /model to pick again`, 'error')
    }, (error: unknown) => {
      bridge.notify(`model switch applies to this session but was not saved as the default: ${error instanceof Error ? error.message : String(error)}`, 'warning')
    })
    return `${row.provider}/${row.model}`
  }

  // dscode: measure the picked route against the live context so /model can ask
  // before a switch that would compact the conversation.
  const dscodeCompactionPreviewFor = async (row: ModelRow): Promise<DscodeCompactionPreview | undefined> => {
    if (active === undefined) return undefined
    return (await runtime.call('models/compactionPreview', { sessionId: active.runtime.id, row })) ?? undefined
  }

  /** The /subagent override label, '' when delegated agents follow the current model. */
  const subagentModelLabel = (): string => subagentOverride === undefined ? '' : modelSelectionLabel(subagentOverride)

  const sendSubagentOverride = (): void => {
    void runtime.call('models/subagentOverride', { selection: subagentOverride ?? null }).catch((error: unknown) => {
      bridge.notify(`subagent model change failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    })
  }

  /** Apply one /subagent model pick; returns the override label. */
  const setSubagentModel = (row: ModelRow, effortId?: string): string => {
    subagentOverride = buildModelSelection(row, effortId)
    sendSubagentOverride()
    renderCurrent()
    return modelSelectionLabel(subagentOverride)
  }

  /** Drop the /subagent override: delegated agents follow the current model again. */
  const clearSubagentModel = (): void => {
    subagentOverride = undefined
    sendSubagentOverride()
    renderCurrent()
  }

  /**
   * Export the folded transcript to a markdown file (/export). The default
   * target sits beside the session's cwd so the file lands in the user's
   * workspace; an absolute or cwd-relative argument overrides it.
   */
  const exportTranscript = async (argument: string): Promise<void> => {
    if (session === undefined) {
      bridge.notify('no session yet — submit a message to start', 'warning')
      return
    }
    const wanted = argument.trim()
    const sessionCwd = session.header.cwd ?? cwd
    // The default name derives from the session id, which `--session` lets the
    // user spell freely: reduce it to filename-safe characters first so the
    // default target can never escape the session cwd.
    const defaultName = `dsh-session-${exportSessionIdSuffix(session.id)}.md`
    const target = wanted === ''
      ? join(sessionCwd, defaultName)
      : /^[a-zA-Z]:[\\/]/u.test(wanted) || wanted.startsWith('/')
        ? wanted
        : join(sessionCwd, wanted)
    const markdown = buildExportMarkdown(store.getView(), session.id)
    try {
      // The session's folder is on the Host's machine, which a remote terminal cannot write.
      if (runtime.sharesFilesystem) await writeFileAsync(target, `${markdown}\n`, 'utf8')
      else await runtime.call('workspace/writeText', { path: target, text: `${markdown}\n` })
      bridge.notify(`exported to ${target}`)
    } catch (error: unknown) {
      bridge.notify(`export failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  /**
   * Rename the session (/title): a user title pins the session and stops
   * automatic generation. The appended `session/title` event flows back
   * through the store into the status line; a refusal arrives as a notice.
   */
  const renameTitle = (argument: string): string => {
    const title = argument.trim()
    if (title === '') return 'usage: /title <text>'
    if (session === undefined) return 'no session yet — submit a message to start'
    void runtime.call('sessions/rename', { sessionId: session.id, title }).then(outcome => {
      if (outcome !== `title → ${title}`) bridge.notify(outcome, 'warning')
    }, (error: unknown) => bridge.notify(`rename failed: ${error instanceof Error ? error.message : String(error)}`, 'error'))
    return `title → ${title}`
  }

  const loadSessions = (options: SessionDirectoryOptions, signal?: AbortSignal): Promise<readonly SessionRow[]> =>
    runtime.call('sessions/list', { options }, signal)

  /** Delete one session subtree (/delete); the Host plans and refuses live members. */
  const deleteSession = (id: string): Promise<string> =>
    runtime.call('sessions/delete', { id, ...(session === undefined ? {} : { currentId: session.id }) })

  const loadSessionTranscript = (id: string, signal?: AbortSignal): Promise<string> =>
    runtime.call('sessions/transcript', { id }, signal)

  /** The /usage panel: the Host's token projection plus per-turn costs. */
  const loadUsage = (current: RuntimeSession | undefined): Promise<UsageView> =>
    runtime.call('sessions/usage', current === undefined ? {} : { sessionId: current.id })

  interface PendingSwitch { readonly target: Target; readonly label: string }

  const activate = (nextTarget: Target): Promise<void> => {
    if (quitting) return Promise.resolve()
    // Serialized with every other composition (bare-launch creation, queued
    // switches): at most one agent is composed at a time.
    return compose(async () => {
      const previous = active
      const next = await prepare(nextTarget)
      // Quit landed while the next session was being composed: dispose the
      // half-ready agent and leave the current session untouched.
      if (quitting) {
        await next.runtime.dispose().catch(() => {})
        return
      }
      active = next
      session = next.runtime
      store = next.store
      mentions = next.mentions
      // Cross-session rows belong to the previous root. The incoming session's
      // own history is re-derived from its log and marked seen, so the activity
      // line keeps an unanswered request visible while only NEW traffic is
      // announced.
      communication = next.runtime.snapshotEvents().reduce((view, event) => foldCommunication(view, event), createCommunicationFeed())
      communicationNoticed.clear()
      for (const row of communication.rows) communicationNoticed.add(row.id)
      commands.setSession(session.id)
      skills.setSession(session.id, session.header.cwd ?? cwd)
      statusMirror?.follow(session.id)
      sessionPermission = undefined
      try {
        // Reseed the feed BEFORE the first frame of the new session so no
        // stale row from the previous one flashes; a rolled-back handoff
        // re-seeds the previous session's catalog the same way.
        subagents.reset()
        for (const event of next.catalogSeed) subagents.apply(event.data.childId, event)
        process.stdout.emit('dscode:frame-reset')
        process.stdout.write('\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[H')
        renderCurrent()
        // Only a successful handoff may clear the transient per-session
        // surfaces: a rolled-back switch keeps the previous session's
        // subagent feed plus the user's pre-session model and permission
        // picks (the bare-launch promise: explicit choices survive until
        // composition takes them). The in-flight cycle intent belonged to
        // the previous session's presses; the new session's committed fold
        // decides from here.
        pendingPermission = undefined
        pendingPlan = false
        planIntent = undefined
      } catch (error: unknown) {
        active = previous
        session = previous?.runtime
        store = previous === undefined ? createTranscriptStore() : previous.store
        mentions = previous === undefined ? remoteMentions(runtime, undefined, cwd) : previous.mentions
        commands.setSession(session?.id)
        skills.setSession(session?.id, session?.header.cwd ?? cwd)
        statusMirror?.follow(session?.id)
        subagents.reset()
        if (previous !== undefined) {
          for (const event of previous.catalogSeed) subagents.apply(event.data.childId, event)
        }
        // The failed handoff disposed the incoming session; the restored
        // store's committed plan fold is the truth, so any cycle intent
        // collected against the switch churn retires too.
        planIntent = undefined
        await next.runtime.dispose()
        if (!quitting) renderCurrent()
        throw error
      }
      // From here the new session is live: in-flight prepares/commands for
      // the previous agent are stale and must be aborted and ignored.
      abortPendingControllers()
      epoch += 1
      // No previous session (a bare launch switched straight into a resume):
      // nothing to flush or dispose, so just confirm the activation.
      if (previous === undefined) {
        // The key-change remount above swaps the App in this same synchronous
        // continuation; the new App registers its bridge.notify in a passive
        // effect AFTER it, so an immediate notice reaches the UNMOUNTED
        // instance and React drops it silently. Defer past the commit.
        setTimeout(() => {
          bridge.notify(`${next.resumed ? 'resumed' : 'created'} ${next.runtime.id.slice(-12)} · mode ${next.mode}`)
          if (next.folderWarning !== undefined) bridge.notify(next.folderWarning, 'warning')
        }, 0)
        return
      }
      let cleanupWarning: string | undefined
      try {
        await previous.runtime.flush()
      } catch (error: unknown) {
        cleanupWarning = `previous session flush failed: ${error instanceof Error ? error.message : String(error)}`
      }
      disposeBtw()
      try {
        await previous.runtime.dispose()
      } catch (error: unknown) {
        cleanupWarning = `${cleanupWarning === undefined ? '' : `${cleanupWarning}; `}previous agent release failed: ${error instanceof Error ? error.message : String(error)}`
      }
      bridge.notify(cleanupWarning === undefined
        ? `${next.resumed ? 'resumed' : 'created'} ${next.runtime.id.slice(-12)} · mode ${next.mode}`
        : `switched to ${next.runtime.id.slice(-12)}, but ${cleanupWarning}`,
      cleanupWarning === undefined ? 'info' : 'warning')
      if (next.folderWarning !== undefined) bridge.notify(next.folderWarning, 'warning')
    })
  }

  const switchQueue = new SessionSwitchQueue<PendingSwitch>(
    async request => { if (!quitting) await activate(request.target) },
    error => bridge.notify(`session switch failed: ${error instanceof Error ? error.message : String(error)}`, 'error'),
  )

  const requestSwitch = (request: PendingSwitch): void => {
    if (session === undefined) {
      // No session yet (a bare launch using /resume before any input): activate
      // the target directly — there is no running turn to wait on and nothing
      // to flush.
      void activate(request.target).catch((error: unknown) => {
        bridge.notify(`session switch failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      })
      return
    }
    if (request.target.sessionId === session.id) {
      bridge.notify('that session is already active', 'warning')
      return
    }
    const outcome = switchQueue.request(session, request)
    if (outcome === 'queued') {
      bridge.notify(`will switch to ${request.label} when the current turn finishes · /resume cancel to abort`)
    }
  }

  const resolveResumeId = (wanted: string): Promise<string> => runtime.call('sessions/resolveResume', {
    wanted,
    ...(session === undefined ? {} : { currentId: session.id }),
    // A protocol client attaches to a live Host session instead of composing a second owner.
    allowLive: runtime.kind === 'protocol',
  })

  const requestResume = (wanted: string): void => {
    void resolveResumeId(wanted).then(id => {
      requestSwitch({ target: { sessionId: id, resume: true }, label: id.slice(-12) })
    }, (error: unknown) => bridge.notify(`resume failed: ${error instanceof Error ? error.message : String(error)}`, 'error'))
  }

  const createSession = (mode?: string): void => {
    try { requireDscodePreset(mode) }
    catch (error) { bridge.notify(error instanceof Error ? error.message : String(error), 'error'); return }
    // /new before any input is the first-session creation itself, not a switch.
    if (session === undefined) {
      ensureSession(mode)
      return
    }
    const nextCwd = session.header.cwd ?? cwd
    const id = `session-${randomUUID()}`
    requestSwitch({ target: { sessionId: id, resume: false, mode, cwd: nextCwd }, label: id.slice(-12) })
  }

  const reviewChanges = (selection: ReviewSelection): void => {
    // Works from a bare launch too: with no session yet the read-only
    // choice goes to pendingPermission (materialized when the first
    // session composes) and the review prompt queues behind that
    // creation exactly like a typed first submission. The identity guard
    // below still aborts a load that outlives a mid-flight switch —
    // including one landing on an undefined agent.
    const currentSession = session
    // The diff loads from the CALLING session's cwd; capture that
    // workspace and this turn's identity so a switch mid-load can neither
    // flip the new session read-only nor send the old workspace's review
    // into it. The controller rides pendingControllers, so a switch/quit
    // kills the git subprocess itself instead of only ignoring its result.
    const atEpoch = epoch
    const reviewCwd = session?.header.cwd ?? cwd
    const controller = new AbortController()
    pendingControllers.add(controller)
    const finish = (): void => {
      pendingControllers.delete(controller)
    }
    // Branch reviews diff from the precomputed merge base (what would
    // actually land), commit reviews the commit's own patch, everything
    // else reviews the uncommitted working tree.
    const load = selection.kind === 'commit'
      ? workspace.commitDiff(reviewCwd, selection.sha, controller.signal)
      : selection.kind === 'base-branch'
        ? workspace.mergeBase(reviewCwd, selection.branch, controller.signal)
          .then(base => workspace.gitDiff(reviewCwd, base ?? selection.branch, controller.signal))
        : workspace.gitDiff(reviewCwd, '', controller.signal)
    const note = selection.kind === 'custom' ? selection.instructions : undefined
    void load.then(({ title, files }) => {
      finish()
      if (controller.signal.aborted || epoch !== atEpoch || session !== currentSession) return
      try {
        setPermissionAction('read-only')
      } catch (error: unknown) {
        bridge.notify(t('notice.reviewUnavailable', { message: error instanceof Error ? error.message : String(error) }), 'error')
        return
      }
      send(buildReviewPrompt(files.flatMap(file => file.lines).join('\n'), title, note))
      bridge.notify(t('notice.reviewStarted'))
    }, (error: unknown) => {
      finish()
      if (controller.signal.aborted || epoch !== atEpoch) return
      bridge.notify(t('notice.reviewFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
    })
  }

  /**
   * Run one side question beside the main conversation: a child session that
   * inherits this log (or a bounded brief when the log is too long), runs
   * read-only on the cheapest supported effort, and answers into the /btw
   * panel. The exchange never enters this transcript or its model context.
   * @param question - the typed side question.
   */
  const startBtw = (question: string): void => {
    const text = question.trim()
    if (text === '' || active === undefined || session === undefined) return
    const id = `session-${randomUUID()}`
    btw.begin({ id: SessionId(id), question: text, at: Date.now() })
    btwIds.add(id)
    void runtime.call('btw/start', { sessionId: session.id, childId: id, question: text, mode: active.mode }).catch((error: unknown) => {
      btwIds.delete(id)
      btw.settle(SessionId(id), quitAbort.signal.aborted ? 'cancelled' : 'failed', error instanceof Error ? error.message : String(error))
    })
  }

  const forkSession = (argument: string): void => {
    if (session === undefined || active === undefined) {
      bridge.notify('no session yet - submit a message to start', 'warning')
      return
    }
    try {
      const text = argument.trim()
      const atSeq = text === '' ? undefined : Number(text)
      if (text !== '' && (!Number.isSafeInteger(atSeq) || (atSeq ?? -1) < 0)) {
        throw new Error('usage: /fork [event-seq]')
      }
      // Validate the fork point here so a bad sequence is reported before any switch.
      selectForkSeed(session.snapshotEvents(), atSeq)
      const id = `session-${randomUUID()}`
      requestSwitch({
        target: {
          sessionId: id,
          resume: false,
          mode: active.mode,
          cwd: session.header.cwd ?? cwd,
          forkOf: { sessionId: session.id, ...(atSeq === undefined ? {} : { atSeq }) },
        },
        label: id.slice(-12),
      })
    } catch (error: unknown) {
      bridge.notify(`fork failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  const switchSession = (row: SessionRow): void => {
    if (!row.resumable) {
      bridge.notify('subagent conversations are read-only', 'warning')
      return
    }
    requestSwitch({ target: { sessionId: row.id, resume: true }, label: row.title ?? row.id.slice(-12) })
  }

  // /search reads the SAME in-process engine the model's session_search
  // tools use (the bundle's skip-tolerant subclass). The row may be disabled
  // by a deployment; /search then degrades to a notice instead of a panel.
  const searchSessions = (query: string, signal?: AbortSignal): Promise<readonly SearchRow[]> =>
    runtime.call('sessions/search', { query }, signal)

  const cancelSessionSwitch = (): boolean => {
    return switchQueue.cancel()
  }

  // Custom providers are a Host plugin; the panel only appears when it is mounted.
  const customAvailable = await runtime.call('custom/available').catch(() => false)
  const dscodeCustom = customClient(runtime)

  const appElement = (): ReturnType<typeof createElement> => {
    // A bare launch mounts with pending/default model, mode, and permission
    // facts until the first input composes the real session. These choices stay
    // process-local and create no durable state before that composition.
    const sessionCwd = session?.header.cwd ?? cwd
    const currentView = store.getView()
    const defaults = currentDefaults()
    const selection = resolveEffectiveSelection(
      active?.selection.picked ?? pendingSelection,
      session?.requestConfig(),
      defaults,
    )
    const model = `${selection.provider}/${selection.model}`
    const effort = selection.reasoningEffort
    const permission = (permissionNames.length === 0 ? currentView.permission : effectivePermissionNow()) ?? ''
    return createElement(App, {
      key: session?.id ?? 'pending',
      sessionKey: session?.id ?? '',
      store,
      approval,
      questions,
      subagents,
      communication,
      btw,
      startBtw,
      commands,
      skills,
      model,
      effort,
      cwd: basename(sessionCwd),
      workspaceRoot: sessionCwd,
      branch: branchOf(sessionCwd),
      sessionId: session === undefined ? '' : session.id.slice(-8),
      resumed: active?.resumed ?? false,
      mode: active?.mode ?? DSCODE_PRESET,
      permission,
      /** Pre-session plan choice for the status badge until a session composes. */
      pendingPlan: session === undefined && pendingPlan,
      dispatch,
      /** dscode: the budget gate's approval covers the rest of the session. */
      dscodeAcknowledgeBudget: (sessionKey: string) => { budgetAcknowledgedFor = sessionKey },
      steer,
      interrupt,
      quit,
      loadModels: () => runtime.call('models/directory'),
      dscodeEnsureProviderRoute: (provider: string) => runtime.call('models/ensureRoute', { provider }),
      dscodeGrokStatus: () => grokStatusSnapshot(),
      dscodeManagementKeyStatus: () => runtime.call('openrouter/managementKeyStatus'),
      dscodeSaveManagementKey: (key: string) => done(runtime.call('openrouter/saveManagementKey', { key })),
      dscodeLoadOpenRouterAccount: () => runtime.call('openrouter/account'),
      ...(customAvailable ? { dscodeCustom } : {}),
      loadModelProviders: () => runtime.call('providers/directory'),
      subscribeModelProviders: listener => subscribeRevisions(runtime, 'providers/watch', listener),
      saveModelProviderCredential: (target, key) => done(runtime.call('providers/saveCredential', { target, key })),
      saveModelProviderConfiguration: (target, configuration) => done(runtime.call('providers/saveConfiguration', { target, configuration })),
      discoverModelProvider: (target, request, signal) => runtime.call('providers/discover', { target, request }, signal),
      unsetModelProviderCredential: target => done(runtime.call('providers/unsetCredential', { target })),
      removeModelProvider: target => done(runtime.call('providers/remove', { target })),
      loadProviderAuthorizations: () => runtime.call('authorization/directory'),
      subscribeProviderAuthorizations: listener => subscribeRevisions(runtime, 'authorization/watch', listener),
      beginProviderAuthorization: (row, method, interaction, signal) => beginAuthorization(runtime, row.key, method, interaction, signal),
      cancelProviderAuthorization: row => { void runtime.call('authorization/cancel', { key: row.key }).catch(() => {}) },
      logoutProviderAuthorization: row => done(runtime.call('authorization/logout', { row })),
      openAuthorizationUrl,
      copyTextValue: copyText,
      loadMentions: (query: string, signal?: AbortSignal) => mentions.candidates(query, signal),
      inspectImages: paths => attachments.inspectImages(paths),
      prepareImages: (paths, signal) => attachments.prepareImages(paths, signal),
      inspectFiles: paths => attachments.inspectFiles(paths),
      prepareFiles: (paths, signal) => attachments.prepareFiles(paths, signal),
      cycleMode,
      setPermission: setPermissionAction,
      selectModel,
      dscodeCompactionPreview: dscodeCompactionPreviewFor,
      subagentModel: subagentModelLabel(),
      setSubagentModel,
      clearSubagentModel,
      deleteSession,
      exportTranscript,
      renameTitle,
      copyLastResponse,
      loadGitDiff: (argument: string) => workspace.gitDiff(session?.header.cwd ?? cwd, argument),
      listReviewBranches: (signal?: AbortSignal) => workspace.reviewBranches(session?.header.cwd ?? cwd, signal),
      listReviewCommits: (signal?: AbortSignal) => workspace.reviewCommits(session?.header.cwd ?? cwd, signal),
      reviewChanges,
      loadPermissions: () => runtime.call('permissions/rows'),
      createSession,
      forkSession,
      loadSessions,
      loadSessionTranscript,
      loadUsage: () => loadUsage(session),
      loadSubagents: () => {
        const current = session
        if (current === undefined) return Promise.resolve([])
        return runtime.call('sessions/subagents', { sessionId: current.id, cwd: current.header.cwd ?? cwd })
      },
      switchSession,
      searchSessions,
      cancelSessionSwitch,
      loadPlugins: () => runtime.call('plugins/list'),
      // The launcher owns every update decision; the TUI only drives its
      // read-only probe and streamed apply as child processes.
      probeUpdate: () => probeLauncherUpdate(),
      applyUpdate: (onLine, plan) => applyLauncherUpdate(onLine, undefined, plan),
      loadJobs: () => runtime.call('jobs/list', session === undefined ? {} : { sessionId: session.id }),
      loadSchedules: async () => session === undefined ? [] : runtime.call('schedules/list', { sessionId: session.id }),
      statusline: statuslineItems,
      saveStatusline,
      applyEditorKeys,
      saveTheme,
      saveLanguage,
      animations: animationsEnabled,
      saveAnimations,
      history: inputHistory,
      recordHistory,
      updateQueued,
      onBridgeReady: (instance: AppBridge) => {
        bridge.notify = instance.notify
        if (bridgeReady) return
        bridgeReady = true
        for (const notice of pendingNotices.splice(0)) bridge.notify(notice.text, notice.tone)
      },
    })
  }

  const renderCurrent = (): void => {
    mountRef.current?.rerender(appElement())
  }

  // Hold the cross-folder notice until a bridge exists: a resume that left the
  // launch folder says so once, on the first window that can show it.
  if (startupFolderWarning !== undefined) pendingNotices.push({ text: startupFolderWarning, tone: 'warning' })
  mountRef.current = io.mount(appElement())

  // Startup prompt/images use the same durable delivery path as composer
  // submissions. Image bytes are committed before the user/message event, and
  // input typed during that preparation queues behind the initial request so
  // the agent always receives the startup prompt first.
  if (startup.prompt !== undefined || (startup.images?.length ?? 0) > 0) {
    if ((startup.images?.length ?? 0) > 0) {
      bridge.notify(`processing ${startup.images!.length} startup image${startup.images!.length === 1 ? '' : 's'}…`)
    }
    void inputGate.run(async deliver => {
      const images: ContentBlock[] = [...await attachments.prepareImages(startup.images ?? [])]
      if (images.length > 0) bridge.notify(`${images.length} startup image${images.length === 1 ? '' : 's'} attached`)
      deliver({ text: startup.prompt ?? '', mode: 'followup', images })
    }).catch((error: unknown) => {
      bridge.notify(`initial prompt failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    })
  }

  async function copyLastResponse(): Promise<string> {
    const text = latestAssistantText(store.getView())
    if (text === undefined) return 'nothing to copy yet'
    await copyText(text)
    return 'copied latest response'
  }

  // A corrupt statusline config must not vanish silently: surface it once
  // the notice channel is live, after the first frame settles.
  if (statuslineWarning !== undefined) {
    setTimeout(() => {
      bridge.notify('statusline config unreadable, using defaults: ' + statuslineWarning, 'warning')
    }, 50)
  }
  // Same one-shot surface for a corrupt theme file (dark fallback stays live).
  if (languageWarning !== undefined) {
    setTimeout(() => {
      bridge.notify(t('notice.languageConfigUnreadable', { message: languageWarning }), 'warning')
    }, 0)
  }
  if (themeWarning !== undefined) {
    setTimeout(() => {
      bridge.notify('theme config unreadable, using dark: ' + themeWarning, 'warning')
    }, 50)
  }
  // And for a corrupt animations file (on-by-default fallback stays live).
  if (animationsWarning !== undefined) {
    setTimeout(() => {
      bridge.notify('animations config unreadable, animations stay on: ' + animationsWarning, 'warning')
    }, 50)
  }

  // One-shot VS Code Ctrl+R hint: resolveEditorKeysStartupHint checks the
  // marker file and the live keybindings config; surfacing waits for the
  // notice channel like the other startup warnings. A failed probe stays
  // silent — the hint is cosmetic and /vscode-keys remains discoverable.
  void resolveEditorKeysStartupHint(editorKeysEnv).then(hint => {
    if (hint === undefined) return
    setTimeout(() => {
      bridge.notify(hint)
    }, 50)
  }, () => {})
}

/** Options for a terminal running as a separate client of a Host. */
export interface TerminalClientOptions {
  /** The Host's local carrier socket, or a remote `dscode server`. */
  readonly target: CarrierTarget
  /** Folder for new sessions on a remote runtime (a path on the server). */
  readonly cwd?: string
  /** The runtime's alias, for connection notices. */
  readonly label?: string
  readonly startup: TuiStartup
  /** Process exit request; defaults to `process.exit`. */
  readonly exit?: (code: number) => void
}

/**
 * Run the terminal as a separate client of a Host: no Harness runs in this
 * process, every operation crosses the local carrier, and the footer mirrors
 * the Host's sources.
 * @param options - the Host socket and parsed startup.
 */
export async function runTerminalClient(options: TerminalClientOptions): Promise<void> {
  if (options.startup.theme !== undefined) setTheme(options.startup.theme)
  const io: TuiIo = { mount: element => internals.mount(element), exit: options.exit ?? (code => process.exit(code)) }
  const errors = runtimeErrorSink()
  const name = options.label ?? describeTarget(options.target)
  const runtime = createTypertRuntime({
    target: options.target,
    onError: errors.report,
    onConnection: state => state === 'lost'
      ? errors.announce(`lost the connection to runtime ${name}; reconnecting…`, 'warning')
      : errors.announce(`reconnected to runtime ${name}`, 'info'),
  })
  try {
    await run({ runtime, detached: true, errors, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) }, options.startup, io)
  } catch (error: unknown) {
    fail(io, error)
  }
}

/**
 * Mount the interactive terminal driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated startup config resolved from the tuiStartup provider.
 */
export function apply(ctx: Context, config: Config): void {
  // The CLI validated --theme at parse time; the loose config schema falls
  // back to dark for anything unexpected.
  const theme = config.startup.theme === undefined ? undefined : parseThemeName(config.startup.theme)
  const input = {
    ...(theme === undefined ? {} : { theme }),
    ...(config.startup.prompt === undefined ? {} : { prompt: config.startup.prompt }),
    ...(config.startup.images === undefined ? {} : { images: config.startup.images }),
  }
  const startup: TuiStartup =
    config.startup.kind === 'resume' && config.startup.sessionId !== undefined
      ? { kind: 'resume', sessionId: config.startup.sessionId, ...input }
      : config.startup.kind === 'latest'
        ? { kind: 'latest', ...input }
        : config.startup.kind === 'named' && config.startup.sessionId !== undefined
          ? { kind: 'named', sessionId: config.startup.sessionId, ...config.startup.mode === undefined ? {} : { mode: config.startup.mode }, ...input }
          : { kind: 'fresh', ...config.startup.mode === undefined ? {} : { mode: config.startup.mode }, ...input }
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  // Read at mount time, not here: a test harness may replace the seam after this plugin applies.
  const io: TuiIo = { mount: element => internals.mount(element), exit }
  void (async () => {
    // Loader siblings mount concurrently. Await the complete application before
    // creating an Agent so its scoped tools and adapters are not half-composed.
    await ctx.get('loader')?.await()
    // Early process shutdown can dispose the tree while settlement is pending.
    const defaultModel = ctx.get('agentDefaultModel')
    if (ctx.get('agents') === undefined || defaultModel === undefined || ctx.get('sessions') === undefined) return
    const presets = agentPresetsFrom(ctx)
    if (presets === undefined) throw new Error('agent preset service is unavailable; check the dsh-code bundle patch')
    const permissionPresets = permissionPresetsFrom(ctx)
    // DSCODE_RUNTIME_SOCKET selects the protocol client over a Host's local
    // carrier; without it the terminal drives this process's Harness directly.
    const target = targetFromEnv() as CarrierTarget | undefined
    const errors = runtimeErrorSink()
    const runtime: RuntimeClient = target !== undefined
      ? createTypertRuntime({ target, onError: errors.report })
      : createInProcessRuntime({
        ctx, presets, defaults: () => defaultModel.currentSelection(),
        ...(permissionPresets === undefined ? {} : { permissionPresets }),
      })
    await run({ runtime, detached: false, errors }, startup, io)
  })().catch((error: unknown) => { fail(io, error) })
}
