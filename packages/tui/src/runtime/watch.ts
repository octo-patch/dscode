/**
 * Client half of a Host "watch" stream: keeps the latest pushed value,
 * notifies subscribers, and reopens the stream when its arguments change or
 * the connection to the Host drops.
 *
 * @module dsh-code/runtime/watch
 */

import type { WatchArgs, WatchItem } from '../host/protocol.ts'
import type { RuntimeClient } from './types.ts'

/** Reconnect delays; the last one repeats until the Host answers again. */
const RETRY_MS = [250, 500, 1000, 2000, 5000]
export const retryDelay = (attempt: number): number => RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!

/**
 * Wait, or stop early when the signal aborts. The timer never keeps the
 * process alive: a terminal that is shutting down while its runtime goes away
 * must exit rather than wait to reconnect.
 */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const timer = setTimeout(done, ms)
    timer.unref?.()
    function done(): void { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * Whether a stream failure is the connection rather than the operation: a
 * Host-side failure carries a code (`dscode/...`) or a Remote failure, and
 * reopening would only fail the same way.
 */
export function retryable(error: unknown): boolean {
  const failure = error as { remote?: unknown; code?: unknown } | undefined
  return failure?.remote === undefined && !String(failure?.code ?? '').startsWith('dscode/')
}

/**
 * Iterate a stream that should stay open for the client's lifetime, reopening
 * it with backoff after a connection failure or an unexpected end.
 * @param onItem - receives each item; `reopened` marks the first item after a reopen.
 * @throws the first failure that is not the connection's.
 */
export async function resilient<T>(open: (signal: AbortSignal) => AsyncIterable<T>, signal: AbortSignal, onItem: (item: T, reopened: boolean) => void): Promise<void> {
  let reopened = false
  for (let attempt = 0; !signal.aborted;) {
    try {
      for await (const item of open(signal)) {
        onItem(item, reopened)
        reopened = false
        attempt = 0
      }
    } catch (error: unknown) {
      if (signal.aborted) return
      if (!retryable(error)) throw error
    }
    if (signal.aborted) return
    reopened = true
    await pause(retryDelay(attempt++), signal)
  }
}

export interface RemoteWatch<T, A = Record<string, unknown>> {
  readonly value: T
  /** Settles with the first pushed value, or rejects when the stream fails before one. */
  readonly ready: Promise<void>
  subscribe(listener: () => void): () => void
  /** Reopen with new arguments (for example after a session switch). */
  retarget(args: A): void
  dispose(): void
}

export function remoteWatch<N extends string>(runtime: RuntimeClient, name: N, initial: WatchItem<N>, args: WatchArgs<N>, onError?: (error: unknown) => void): RemoteWatch<WatchItem<N>, WatchArgs<N>>
export function remoteWatch<N extends string>(runtime: RuntimeClient, name: N, initial: undefined, args: WatchArgs<N>, onError?: (error: unknown) => void): RemoteWatch<WatchItem<N> | undefined, WatchArgs<N>>
export function remoteWatch<N extends string>(
  runtime: RuntimeClient,
  name: N,
  initial: WatchItem<N> | undefined,
  args: WatchArgs<N>,
  onError: (error: unknown) => void = () => {},
): RemoteWatch<WatchItem<N> | undefined, WatchArgs<N>> {
  type T = WatchItem<N> | undefined
  let value = initial
  let controller: AbortController | undefined
  let settleReady: { resolve(): void; reject(error: unknown): void } | undefined
  const ready = new Promise<void>((resolve, reject) => { settleReady = { resolve, reject } })
  ready.catch(() => {})
  const listeners = new Set<() => void>()
  const open = (next: WatchArgs<N>): void => {
    controller?.abort()
    const current = new AbortController()
    controller = current
    void resilient(signal => runtime.stream(name, next, signal), current.signal, item => {
      if (current.signal.aborted) return
      value = item
      settleReady?.resolve()
      for (const listener of listeners) listener()
    }).catch((error: unknown) => { settleReady?.reject(error); if (!current.signal.aborted) onError(error) })
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
