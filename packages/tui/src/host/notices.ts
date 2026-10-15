/**
 * Host-originated notices for every attached terminal (for example the
 * capability sync's warnings). Notices are best effort and not replayed: a
 * terminal attaching later sees only newer ones.
 *
 * @module dsh-code/host/notices
 */

import type { Context } from '@deepseek-ai/cordis'
import type { DscodeRemoteRegistry } from './registry.ts'

export type NoticeTone = 'info' | 'warning' | 'error'
export interface HostNotice { readonly text: string; readonly tone?: NoticeTone }

const listeners = new WeakMap<object, Set<(notice: HostNotice) => void>>()
const channel = (ctx: Context): Set<(notice: HostNotice) => void> => {
  const root = ctx.root as object
  let set = listeners.get(root)
  if (set === undefined) { set = new Set(); listeners.set(root, set) }
  return set
}

/** Send one notice to every attached terminal. */
export function publishNotice(ctx: Context, text: string, tone?: NoticeTone): void {
  for (const listener of channel(ctx)) listener({ text, ...(tone === undefined ? {} : { tone }) })
}

export function registerNotices(ctx: Context, registry: DscodeRemoteRegistry): (() => void)[] {
  return [
    registry.stream('notices/watch', (_args, { signal }) => (async function* () {
      const queue: HostNotice[] = []
      let wake: (() => void) | undefined
      const listener = (notice: HostNotice): void => { queue.push(notice); wake?.() }
      channel(ctx).add(listener)
      const aborted = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      try {
        while (!signal.aborted) {
          while (queue.length > 0) yield queue.shift()!
          await Promise.race([new Promise<void>(resolve => { wake = resolve }), aborted])
        }
      } finally { channel(ctx).delete(listener) }
    })()),
  ]
}
