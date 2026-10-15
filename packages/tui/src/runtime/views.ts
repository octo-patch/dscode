/**
 * Terminal-side adapters over the DSCODE Host operations (packages/tui/src/host).
 * Each returns the shape the React app already consumes, so the app does not
 * know whether the Host runs in this process or behind the local carrier.
 *
 * @module dsh-code/runtime/views
 */

import type { AuthorizationInteraction, AuthorizationStatus } from '@deepseek-ai/dsh-authorization'
import { formatSessionReferenceMention, parseSessionReferenceText } from '@deepseek-ai/dsh-session-reference'
import { newCustomProfile } from '../../../../plugins/custom/config.mjs'
import { setMetricSource } from '../../../../plugins/session-metrics/view.mjs'
import { setSpeedSource } from '../../../../plugins/openai/speed.mjs'
import { setBoardSource } from '../../../../plugins/dscode/board.mjs'
import type { CustomClient } from '../custom-provider-panel.ts'
import type { SkillsState } from '../host/catalog.ts'
import type { AuthorizationStreamItem, AuthorizationUplinkItem } from '../host/providers.ts'
import type { StatusState } from '../host/status.ts'
import type { MentionCandidate, MentionsApi, PreparedMention } from '../mentions.ts'
import type { SkillRow } from '../skills.ts'
import type { RuntimeClient } from './types.ts'
import { remoteWatch } from './watch.ts'

/**
 * Subscribe to a Host revision stream; the listener runs on every change after
 * the opening revision, matching the in-process subscribe contract.
 */
export function subscribeRevisions(runtime: RuntimeClient, name: string, listener: () => void): () => void {
  const controller = new AbortController()
  void (async () => {
    let first = true
    for await (const _revision of runtime.stream(name, {}, controller.signal)) {
      if (first) { first = false; continue }
      listener()
    }
  })().catch(() => {})
  return () => controller.abort()
}

/** An async queue usable as a stream uplink. */
function uplinkQueue<T>(): { push(item: T): void; close(): void; iterable: AsyncIterable<T> } {
  const items: T[] = []
  let wake: (() => void) | undefined
  let closed = false
  return {
    push(item) { items.push(item); wake?.() },
    close() { closed = true; wake?.() },
    iterable: (async function* () {
      while (true) {
        while (items.length > 0) yield items.shift()!
        if (closed) return
        await new Promise<void>(resolve => { wake = resolve })
        wake = undefined
      }
    })(),
  }
}

/** Run one provider login on the Host, answering its prompts through `interaction`. */
export async function beginAuthorization(
  runtime: RuntimeClient,
  key: unknown,
  method: string,
  interaction: AuthorizationInteraction,
  signal?: AbortSignal,
): Promise<AuthorizationStatus> {
  const uplink = uplinkQueue<AuthorizationUplinkItem>()
  try {
    for await (const item of runtime.stream<AuthorizationStreamItem>('authorization/begin', { key, method }, signal, uplink.iterable)) {
      if (item.type === 'notify') interaction.notify(item.notice)
      else if (item.type === 'prompt') {
        const id = item.id
        interaction.prompt(item.prompt).then(
          value => uplink.push({ type: 'answer', id, value }),
          () => uplink.push({ type: 'decline', id }),
        )
      } else return item.status as AuthorizationStatus
    }
    throw new Error('provider login ended without a result')
  } finally { uplink.close() }
}

/** Custom-provider panel client over the Host; drafting a profile stays local. */
export function customClient(runtime: RuntimeClient): CustomClient {
  return {
    list: () => runtime.call('custom/list'),
    newProfile: () => newCustomProfile(),
    save: (profile, key, revision) => runtime.call('custom/save', { profile, key, revision }),
    remove: (id, revision) => runtime.call('custom/remove', { id, revision }),
    discover: (profile, key, signal) => runtime.call('custom/discover', { profile, key }, signal),
    test: (profile, model, key, signal) => runtime.call('custom/test', { profile, model, key }, signal),
  }
}

/** @-mention completion and session-reference preparation for one session (or the pre-session workspace). */
export function remoteMentions(runtime: RuntimeClient, sessionId: string | undefined, cwd: string): MentionsApi {
  const scope = { ...(sessionId === undefined ? {} : { sessionId }), cwd }
  return {
    candidates: (query, signal) => runtime.call<readonly MentionCandidate[]>('mentions/candidates', { ...scope, query }, signal),
    parse: text => parseSessionReferenceText(text),
    prepare: (parsed, signal) => runtime.call<PreparedMention>('mentions/prepare', { ...scope, parsed }, signal),
    sessionMention: candidate => formatSessionReferenceMention({ sessionId: candidate.sessionId, label: candidate.label }),
  }
}

/** The skills panel's live view; follows a session once one exists. */
export interface RemoteSkillsView {
  readonly rows: readonly SkillRow[]
  readonly count?: number
  readonly error?: string
  subscribe(listener: () => void): () => void
  setSession(sessionId: string | undefined, cwd: string): void
}

export function watchRemoteSkills(runtime: RuntimeClient, cwd: string): RemoteSkillsView {
  const state = remoteWatch<SkillsState>(runtime, 'skills/watch', { rows: [] }, { cwd })
  return {
    get rows() { return state.value.rows },
    get count() { return state.value.count },
    get error() { return state.value.error },
    subscribe: listener => state.subscribe(listener),
    setSession: (sessionId, nextCwd) => state.retarget({ cwd: nextCwd, ...(sessionId === undefined ? {} : { sessionId }) }),
  }
}

/**
 * Mirror the Host's footer sources for a terminal running without a Host in
 * its process: the metrics, service-speed and delegation-board modules read
 * this cache, fed by `status/watch` for the active session.
 * @returns controls to follow another session and to stop mirroring.
 */
export function mirrorStatusSources(runtime: RuntimeClient): { follow(sessionId: string | undefined): void; dispose(): void } {
  let sessionId: string | undefined
  let label = ''
  let state: StatusState | undefined
  let controller: AbortController | undefined
  const open = (): void => {
    controller?.abort()
    state = undefined
    if (sessionId === undefined) return
    const current = new AbortController()
    controller = current
    void (async () => {
      for await (const item of runtime.stream<StatusState>('status/watch', { sessionId, modelLabel: label }, current.signal)) state = item
    })().catch(() => {})
  }
  const disposers = [
    setMetricSource((id: string) => id === sessionId ? state?.metrics : undefined),
    setSpeedSource((id: string, modelLabel: string) => {
      if (id !== sessionId) return undefined
      if (modelLabel !== label) { label = modelLabel; open() }
      return state?.speed
    }),
    setBoardSource((id: string) => id === sessionId ? state?.board : undefined, undefined),
  ]
  return {
    follow(next) { if (next !== sessionId) { sessionId = next; open() } },
    dispose() { controller?.abort(); for (const dispose of disposers) dispose() },
  }
}

/** Show Host-originated notices (for example capability-sync warnings) as terminal notices. */
export function followNotices(runtime: RuntimeClient, notify: (text: string, tone?: 'info' | 'warning' | 'error') => void): () => void {
  const controller = new AbortController()
  void (async () => {
    for await (const notice of runtime.stream<{ text: string; tone?: 'info' | 'warning' | 'error' }>('notices/watch', {}, controller.signal)) notify(notice.text, notice.tone)
  })().catch(() => {})
  return () => controller.abort()
}
