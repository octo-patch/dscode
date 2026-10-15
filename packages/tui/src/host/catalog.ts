/**
 * Catalog and composition operations on the Host: background jobs, reminders,
 * the plugin inventory, permission presets, plan availability, skills,
 * @-mention candidates and session-reference preparation, and attachment
 * intake from local paths (the terminal and Host share a machine).
 *
 * @module dsh-code/host/catalog
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JobView } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-schedule'
import { SessionId } from '@deepseek-ai/dsh-session'
import { isUserInvocable } from '@deepseek-ai/dsh-skill'
import {
  inspectFileFacts, inspectFilePaths, inspectImageFacts, inspectImagePaths, saveFileData, saveFilePaths, saveImageData, saveImagePaths,
} from '../attachments.ts'
import { DSCODE_PRESET } from '../dscode/preset.ts'
import type { JobRow } from '../kernel-panels.ts'
import { createMentions, type MentionsApi, type ParsedSessionReferenceText } from '../mentions.ts'
import { effectivePermission, listPermissionRows, permissionPresetsFrom, selectPermission } from '../permissions.ts'
import { listPluginRows } from '../plugin-inventory.ts'
import { agentPresetsFrom } from '../presets.ts'
import { scheduleRows } from '../schedules.ts'
import { liveAgent } from './agents.ts'
import { RemoteFailure, watchAsync, type DscodeRemoteRegistry } from './registry.ts'

/** What `skills/watch` pushes. */
export interface SkillsState {
  readonly rows: readonly { name: string; description: string; modelInvocable: boolean }[]
  readonly count?: number
  readonly error?: string
}

export function registerCatalog(ctx: Context, registry: DscodeRemoteRegistry): (() => void)[] {
  const session = (sessionId: string | undefined) => sessionId === undefined ? undefined : ctx.get('sessions')?.get(SessionId(sessionId))
  const presets = () => {
    const service = permissionPresetsFrom(ctx)
    if (service === undefined || service.names.length === 0) throw new RemoteFailure('dscode/permissions-unavailable', 'permission presets are not mounted in this composition')
    return service
  }
  // Mention sources keep a short-lived file index per workspace; one instance
  // per session (or pre-session workspace) keeps that cache warm across calls.
  const mentionSources = new Map<string, MentionsApi>()
  const mentions = (sessionId: string | undefined, cwd: string): MentionsApi => {
    const agent = liveAgent(ctx, sessionId)
    const key = agent === undefined ? `cwd:${cwd}` : `session:${agent.session.id}`
    let source = mentionSources.get(key)
    if (source === undefined) {
      source = createMentions(ctx, agent, agent?.session.header.cwd ?? cwd)
      mentionSources.set(key, source)
    }
    return source
  }
  const toSkillRows = async (sessionId: string | undefined, cwd: string): Promise<SkillsState> => {
    const skills = ctx.get('skills')
    if (skills === undefined) return { rows: [] }
    const agent = liveAgent(ctx, sessionId)
    try {
      const summaries = await skills.list(agent === undefined ? { cwd } : { cwd: agent.session.header.cwd ?? cwd, scope: agent })
      const rows = summaries
        .filter(skill => isUserInvocable(skill))
        .map(skill => ({ name: skill.name, description: skill.description, modelInvocable: skill.invocation.modelInvocable === true }))
        .sort((left, right) => left.name < right.name ? -1 : 1)
      return { rows, count: summaries.length }
    } catch (cause: unknown) {
      return { rows: [], error: cause instanceof Error ? cause.message : String(cause) }
    }
  }

  return [
    () => mentionSources.clear(),
    // Jobs are fenced by the owning session id; a missing registry is the
    // documented empty panel, not an error.
    registry.method('jobs/list', ({ sessionId }: { sessionId?: string }): readonly JobRow[] => {
      const jobs = ctx.get('jobs')
      if (jobs === undefined) return []
      try {
        return jobs.list(sessionId === undefined ? undefined : SessionId(sessionId)).map((job: JobView) => ({
          id: job.id, kind: job.kind, label: job.label, status: job.status, detail: job.detail, startedAt: job.startedAt, finishedAt: job.finishedAt,
        }))
      } catch {
        return []
      }
    }),
    registry.method('schedules/list', async ({ sessionId }: { sessionId: string }) => {
      const schedule = ctx.get('schedule')
      if (schedule === undefined) throw new RemoteFailure('dscode/schedule-unavailable', 'Reminders are not available in this composition')
      return scheduleRows(await schedule.list({ sessionId: SessionId(sessionId) }))
    }),
    registry.method('plugins/list', () => listPluginRows(ctx)),

    registry.method('permissions/rows', () => listPermissionRows(presets())),
    registry.method('permissions/names', () => permissionPresetsFrom(ctx)?.names ?? []),
    registry.method('permissions/effective', ({ sessionId, pending }: { sessionId?: string; pending?: string }) => effectivePermission(presets(), session(sessionId), pending)),
    registry.method('permissions/select', ({ sessionId, id }: { sessionId?: string; id: string }) => selectPermission(presets(), session(sessionId), id)),
    // Whether the DSCODE composition offers plan mode before a session exists.
    registry.method('presets/planAvailable', async () => {
      const service = agentPresetsFrom(ctx)
      if (service === undefined) return false
      const inventory = await service.compositionInventory()
      return inventory.some(composition => composition.id === DSCODE_PRESET
        && composition.rows.some(row => row.moduleName === '@deepseek-ai/dsh-plan-mode' && row.enabled !== false))
    }),

    registry.stream('skills/watch', ({ sessionId, cwd }: { sessionId?: string; cwd: string }, { signal }) =>
      watchAsync(signal, () => toSkillRows(sessionId, cwd), push => ctx.on('skills/change', push))),

    registry.method('mentions/candidates', ({ sessionId, cwd, query }: { sessionId?: string; cwd: string; query: string }, { signal }) =>
      mentions(sessionId, cwd).candidates(query, signal)),
    registry.method('mentions/prepare', ({ sessionId, cwd, parsed }: { sessionId?: string; cwd: string; parsed: ParsedSessionReferenceText }, { signal }) =>
      mentions(sessionId, cwd).prepare(parsed, signal)),

    registry.method('attachments/inspectImages', ({ paths, cwd }: { paths: readonly string[]; cwd: string }) => inspectImagePaths(paths, ctx.get('attachments'), cwd)),
    registry.method('attachments/saveImages', ({ paths }: { paths: readonly string[] }, { signal }) => saveImagePaths(paths, ctx.get('attachments'), signal)),
    registry.method('attachments/inspectFiles', ({ paths, cwd }: { paths: readonly string[]; cwd: string }) => inspectFilePaths(paths, ctx.get('attachments'), cwd)),
    registry.method('attachments/saveFiles', ({ paths }: { paths: readonly string[] }, { signal }) => saveFilePaths(paths, ctx.get('attachments'), signal)),
    // A remote terminal's local files: it sends what it read (bytes as base64),
    // the Host applies the same limits and stores them.
    registry.method('attachments/inspectImageData', ({ items }: { items: { path: string; name: string; bytes: number; signature: string }[] }) =>
      inspectImageFacts(items.map(item => ({ ...item, signature: Buffer.from(item.signature, 'base64') })), ctx.get('attachments'))),
    registry.method('attachments/saveImageData', ({ items }: { items: { name: string; data: string }[] }, { signal }) =>
      saveImageData(items.map(item => ({ name: item.name, data: Buffer.from(item.data, 'base64') })), ctx.get('attachments'), signal)),
    registry.method('attachments/inspectFileData', ({ items }: { items: { path: string; name: string; bytes: number }[] }) =>
      inspectFileFacts(items, ctx.get('attachments'))),
    registry.method('attachments/saveFileData', ({ items }: { items: { name: string; data: string }[] }, { signal }) =>
      saveFileData(items.map(item => ({ name: item.name, data: Buffer.from(item.data, 'base64') })), ctx.get('attachments'), signal)),
  ]
}
