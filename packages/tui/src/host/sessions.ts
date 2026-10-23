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
import { SessionAlreadyOwnedError, SessionPersistenceNotFoundError, type SessionHandle, type SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
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
  const remove = async (id: string, currentId: string | undefined, signal: AbortSignal): Promise<string> => {
    const sessionQuery = query()
    if (currentId === id) throw new RemoteFailure('dscode/conflict', 'cannot delete the session you are using — switch or /new first')
    const records = await sessionQuery.listSessions(signal)
    const plan = planSessionDeletion(records, id)
    if (!plan.ok) throw new RemoteFailure(records.some(record => record.header.id === id) ? 'dscode/conflict' : 'dscode/not-found', plan.reason)
    const backend = persistence()
    const root = jsonlSessionRoot(backend)
    if (root === undefined || backend === undefined) throw new RemoteFailure('dscode/unsupported', 'deletion is unsupported on this backend')
    const byId = new Map(records.map(record => [record.header.id as string, record]))
    const handles: SessionHandle[] = []
    const dirs = new Map<string, string>()
    let removed = 0
    try {
      // Use the backend's own write ownership, not a separate deletion mutex:
      // create/resume in any process must contend on exactly the same lock.
      // Acquire every member before deleting anything; never wait on contention.
      for (const node of [...plan.nodes].sort((a, b) => a.id.localeCompare(b.id))) {
        signal.throwIfAborted()
        const handle = await backend.open(SessionId(node.id), 'write', { signal })
        handles.push(handle)
        const record = byId.get(node.id)!
        if (handle.header.cwd !== record.header.cwd || handle.header.parentSession !== record.header.parentSession) {
          throw new RemoteFailure('dscode/conflict', 'session metadata changed during deletion; refresh the session list')
        }
        const dir = sessionArtifactDirectory(sessionDirectoryFor(root, handle.header.cwd, node.id), node.id)
        if (dir === undefined) throw new RemoteFailure('dscode/conflict', `unexpected artifact layout for ${node.id}`)
        dirs.set(node.id, dir)
      }
      // Cancellation is honored before the first removal. Once destructive work
      // begins, finish the subtree even if the HTTP caller disconnects.
      signal.throwIfAborted()
      for (const node of plan.nodes) {
        const dir = dirs.get(node.id)!
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isFile() && isSessionArtifactName(entry.name)) await rm(join(dir, entry.name), { force: true })
        }
        // Keep session.lock and its inode. Removing it defeats the writer lease.
        removed += 1
      }
      return `deleted ${removed} session${removed === 1 ? '' : 's'}`
    } catch (error: unknown) {
      if (error instanceof RemoteFailure || signal.aborted && removed === 0) throw error
      if (error instanceof SessionAlreadyOwnedError) throw new RemoteFailure('dscode/conflict', 'cannot delete a live session; it was opened during deletion preflight', { cause: error })
      if (error instanceof SessionPersistenceNotFoundError) throw new RemoteFailure('dscode/not-found', 'session disappeared during deletion preflight', { cause: error })
      throw new RemoteFailure('dscode/delete-failed', `delete failed after ${removed} of ${plan.nodes.length}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    } finally {
      await closeHandles(handles)
    }
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
    registry.method('sessions/delete', ({ id, currentId }: { id: string; currentId?: string }, { signal }) => remove(id, currentId, signal)),
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
    registry.method('sessions/rename', async ({ sessionId, title }: { sessionId: string; title: string }) => {
      const service = ctx.get('sessionTitle')
      if (service === undefined) throw new RemoteFailure('dscode/session-title-unavailable', 'session titles are unavailable in this profile')
      const session = ctx.get('sessions')?.get(SessionId(sessionId))
      if (session === undefined) throw new RemoteFailure('dscode/session-not-live', 'no live session to rename')
      try {
        service.rename(session, title)
        await ctx.get('sessions')?.flush(session)
        return `title → ${title}`
      } catch (error: unknown) {
        throw new RemoteFailure('dscode/rename-failed', `rename failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
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
      if (allowLive !== true && ctx.get('agents')?.get(SessionId(matched.header.id)) !== undefined && matched.header.id !== currentId) {
        throw new RemoteFailure('dscode/live-elsewhere', 'that session is already live in another owner')
      }
      return matched.header.id
    }),
  ]
}

/** Close every acquired handle even when one release fails. */
async function closeHandles(handles: readonly SessionHandle[]): Promise<void> {
  const results = await Promise.allSettled([...handles].reverse().map(handle => handle.close()))
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
  if (errors.length > 0) throw new AggregateError(errors, 'failed to release session deletion ownership')
}
