/**
 * Client half of a Host "watch" stream: keeps the latest pushed value,
 * notifies subscribers, and reopens the stream when its arguments change.
 *
 * @module dsh-code/runtime/watch
 */

import type { RuntimeClient } from './types.ts'

export interface RemoteWatch<T> {
  readonly value: T
  /** Settles with the first pushed value, or rejects when the stream fails before one. */
  readonly ready: Promise<void>
  subscribe(listener: () => void): () => void
  /** Reopen with new arguments (for example after a session switch). */
  retarget(args: Record<string, unknown>): void
  dispose(): void
}

export function remoteWatch<T>(
  runtime: RuntimeClient,
  name: string,
  initial: T,
  args: Record<string, unknown>,
  onError: (error: unknown) => void = () => {},
): RemoteWatch<T> {
  let value = initial
  let controller: AbortController | undefined
  let settleReady: { resolve(): void; reject(error: unknown): void } | undefined
  const ready = new Promise<void>((resolve, reject) => { settleReady = { resolve, reject } })
  ready.catch(() => {})
  const listeners = new Set<() => void>()
  const open = (next: Record<string, unknown>): void => {
    controller?.abort()
    const current = new AbortController()
    controller = current
    void (async () => {
      for await (const item of runtime.stream<T>(name, next, current.signal)) {
        if (current.signal.aborted) return
        value = item
        settleReady?.resolve()
        for (const listener of listeners) listener()
      }
    })().catch((error: unknown) => { settleReady?.reject(error); if (!current.signal.aborted) onError(error) })
  }
  open(args)
  return {
    get value() { return value },
    ready,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    retarget: open,
    dispose() { controller?.abort(); listeners.clear() },
  }
}
