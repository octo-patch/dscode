/**
 * Session catalog operations on the Host: the /resume directory, /delete,
 * transcripts, /search, /usage, /title and resume-id resolution. They read
 * the Host's persistence and session query engine, which a separate terminal
 * cannot reach.
 *
 * @module dsh-code/host/sessions
 */

import type { Context } from '@deepseek-ai/cordis'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { deriveTurnTokenUsage } from '@deepseek-ai/dsh-token-meter/client'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-title'
import { turnCostsFor } from '../../../../plugins/session-metrics/view.mjs'
import { buildExportMarkdown } from '../render/export.ts'
import { turnUsages, type UsageView } from '../render/usage.ts'
import { createTranscriptStore } from '../store.ts'
import type { SearchRow } from '../kernel-panels.ts'
import {
  isSessionArtifactName, isSubagentSession, jsonlSessionRoot, mergeSessionTitles, planSessionDeletion, projectSessionRows,
  searchHitToRow, sessionArtifactDirectory, sessionDirectoryFor,
  type SessionDirectoryOptions, type SessionQueryService, type SessionRow,
} from '../session-directory.ts'
import { RemoteFailure, type DscodeRemoteRegistry } from './registry.ts'

export function registerSessions(ctx: Context, registry: DscodeRemoteRegistry): (() => void)[] {
  const query = (): SessionQueryService => {
    const service = (ctx as unknown as { get(name: string): unknown }).get('sessionQuery') as SessionQueryService | undefined
    if (service === undefined) throw new RemoteFailure('dscode/session-query-unavailable', 'session query is unavailable in this profile')
    return service
  }
  const persistence = (): SessionPersistence | undefined => ctx.get('sessionPersistence')

  const list = async (options: SessionDirectoryOptions, signal?: AbortSignal): Promise<readonly SessionRow[]> => {
    const sessionQuery = query()
    const records = await sessionQuery.listSessions(signal)
    // Last-activity timestamps for sorting: the newest generation artifact's
    // mtime under the JSONL layout. Backends without a JSONL config (or
    // vanished directories) fall back to createdAt inside the projection.
    const root = jsonlSessionRoot(persistence())
    const updated = new Map<string, number>()
    if (root !== undefined) {
      await Promise.all(records.map(async record => {
        try {
          const dir = sessionDirectoryFor(root, record.header.cwd, record.header.id)
          const entries = await readdir(dir, { withFileTypes: true })
          const stats = await Promise.all(entries.filter(entry => entry.isFile() && isSessionArtifactName(entry.name)).map(entry => stat(join(dir, entry.name))))
          const newest = Math.max(...stats.map(info => info.mtimeMs))
          if (Number.isFinite(newest)) updated.set(record.header.id, newest)
        } catch {
          // Artifact gone or unreadable: the projection falls back to createdAt.
        }
      }))
    }
    const projected = projectSessionRows(records, options, updated)
    // Titles are the expensive fold: only the first bounded picker page.
    const page = projected.slice(0, 32)
    if (page.length === 0) return projected
    const observations = await sessionQuery.readTitleSnapshots(page.map(row => row.id), signal)
    return mergeSessionTitles(projected, observations)
  }

  /**
   * Delete one session subtree (/delete; subagent threads go with their root).
   * The persistence seam has no deletion API by design, so this is the
   * controlled external removal: plan the subtree and refuse when any member is
   * live, derive and layout-check every artifact directory before the first
   * rm, then remove children first.
   */
  const remove = async (id: string, currentId: string | undefined): Promise<string> => {
    const sessionQuery = query()
    if (currentId !== undefined && currentId === id) return 'cannot delete the session you are using — switch or /new first'
    const records = await sessionQuery.listSessions()
    const plan = planSessionDeletion(records, id)
    if (!plan.ok) return plan.reason
    const root = jsonlSessionRoot(persistence())
    if (root === undefined) return 'session backend exposes no deletable artifact (deletion is unsupported on this backend)'
    const byId = new Map(records.map(record => [record.header.id as string, record]))
    const dirs = new Map<string, string>()
    for (const node of plan.nodes) {
      const record = byId.get(node.id)
      if (record === undefined) return `no persisted session matches "${node.id}"`
      const dir = sessionArtifactDirectory(sessionDirectoryFor(root, record.header.cwd, node.id), node.id)
      if (dir === undefined) return `refusing to delete: unexpected artifact layout for ${node.id.slice(-12)}`
      dirs.set(node.id, dir)
    }
    let removed = 0
    for (const node of plan.nodes) {
      const dir = dirs.get(node.id)!
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isFile() && isSessionArtifactName(entry.name)) await rm(join(dir, entry.name), { force: true })
        }
        await rm(dir, { force: true, recursive: false }).catch(() => {})
        removed += 1
      } catch (error: unknown) {
        return `delete failed for ${node.id.slice(-12)} after ${removed} of ${plan.nodes.length}: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    return `deleted ${removed} session${removed === 1 ? '' : 's'}`
  }

  const search = async (text: string, signal?: AbortSignal): Promise<readonly SearchRow[]> => {
    const sessionQuery = query()
    const page = await sessionQuery.searchSessions({ query: text, limit: 30 }, signal === undefined ? undefined : { signal })
    const rows = page.items.map(hit => searchHitToRow(hit))
    // Best-effort title enrichment; a failure keeps the short-id labels.
    try {
      const observations = await sessionQuery.readTitleSnapshots(rows.map(row => row.id), signal)
      const titles = new Map<string, string>()
      for (const observation of observations) {
        if (observation.status !== 'fulfilled') continue
        const title = observation.value?.title?.title
        if (title !== undefined && title.trim() !== '') titles.set(observation.sessionId, title)
      }
      return rows.map(row => titles.has(row.id) ? { ...row, label: titles.get(row.id)! } : row)
    } catch {
      return rows
    }
  }

  return [
    registry.method('sessions/list', ({ options }: { options: SessionDirectoryOptions }, { signal }) => list(options, signal)),
    registry.method('sessions/subagents', async ({ sessionId, cwd }: { sessionId: string; cwd: string }) => {
      const rows = await list({ sessions: 'all', cwd: 'all', sort: 'newest', currentCwd: cwd, query: '' })
      return rows.filter(row => row.parent === sessionId && row.subagent)
    }),
    registry.method('sessions/delete', ({ id, currentId }: { id: string; currentId?: string }) => remove(id, currentId)),
    registry.method('sessions/transcript', async ({ id }: { id: string }, { signal }) => {
      const snapshot = await query().readSession(id, signal)
      return buildExportMarkdown(createTranscriptStore(snapshot.events).getView(), snapshot.session.id)
    }),
    registry.method('sessions/search', ({ query: text }: { query: string }, { signal }) => search(text, signal)),
    // The meter says what each turn billed; the cost ledger what it cost. A
    // deployment without the projection registry reports totals as unavailable.
    registry.method('sessions/usage', ({ sessionId }: { sessionId?: string }): UsageView => {
      const session = sessionId === undefined ? undefined : ctx.get('sessions')?.get(SessionId(sessionId))
      if (session === undefined) return { turns: [] }
      const values = ctx.get('sessionProjections')?.snapshot(session, ['tokenUsage']).values
      const events = session.snapshotEvents()
      return { totals: values?.tokenUsage, turns: turnUsages(events, deriveTurnTokenUsage, turnCostsFor(session.id, events)) }
    }),
    // A user title pins the session and stops automatic generation.
    registry.method('sessions/rename', ({ sessionId, title }: { sessionId: string; title: string }) => {
      const service = ctx.get('sessionTitle')
      if (service === undefined) return 'session titles are unavailable in this profile'
      const session = ctx.get('sessions')?.get(SessionId(sessionId))
      if (session === undefined) return 'no session yet — submit a message to start'
      try {
        service.rename(session, title)
        return `title → ${title}`
      } catch (error: unknown) {
        return `rename failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }),
    // `allowLive`: a protocol client attaches to a live Host session instead of
    // composing a second owner, so only the in-process terminal refuses one.
    registry.method('sessions/resolveResume', async ({ wanted, currentId, allowLive }: { wanted: string; currentId?: string; allowLive?: boolean }) => {
      if (wanted === '') throw new RemoteFailure('dscode/usage', 'usage: /resume <id|prefix>')
      const records = await query().listSessions()
      const exact = records.filter(record => record.header.id === wanted)
      const matches = exact.length > 0 ? exact : records.filter(record => record.header.id.startsWith(wanted))
      if (matches.length === 0) throw new RemoteFailure('dscode/not-found', `no session matches "${wanted}"`)
      if (matches.length > 1) throw new RemoteFailure('dscode/ambiguous', `session prefix "${wanted}" is ambiguous (${matches.length} matches)`)
      const matched = matches[0]
      // Same lineage gate as the CLI --resume path and the picker.
      if (isSubagentSession(matched.header)) throw new RemoteFailure('dscode/read-only', 'subagent conversations are read-only; resume a root session')
      if (allowLive !== true && currentId !== undefined && ctx.get('agents')?.get(SessionId(matched.header.id)) !== undefined && matched.header.id !== currentId) {
        throw new RemoteFailure('dscode/live-elsewhere', 'that session is already live in another owner')
      }
      return matched.header.id
    }),
  ]
}
