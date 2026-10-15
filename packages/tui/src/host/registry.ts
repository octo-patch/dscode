/**
 * DSCODE remote registry: terminal operations that upstream Typert does not
 * cover, executed on the Host. The local carrier serves them to a separate
 * terminal process; the in-process runtime invokes them directly. Arguments,
 * results and stream items are JSON in both cases, so an operation that works
 * in process also works across the carrier.
 *
 * @module dsh-code/host/registry
 */

import type { MethodArgs, MethodName, MethodResult, StreamArgs, StreamItem, StreamName } from './protocol.ts'

/** Per-invocation facts. */
export interface RemoteCall {
  readonly signal: AbortSignal
}

/** Per-stream facts; `uplink` carries the client's items after the opening request. */
export interface RemoteStreamCall extends RemoteCall {
  readonly uplink: AsyncIterable<unknown>
}

export type RemoteMethod = (args: any, call: RemoteCall) => unknown
export type RemoteStream = (args: any, call: RemoteStreamCall) => AsyncIterable<unknown>

/** A method listed in the wire contract ({@link DscodeMethods}) must match it; any other name is untyped. */
export type MethodFor<N extends string> = N extends MethodName
  ? (args: MethodArgs<N>, call: RemoteCall) => MethodResult<N> | Promise<MethodResult<N>>
  : RemoteMethod
/** A stream listed in the wire contract ({@link DscodeStreams}) must match it; any other name is untyped. */
export type StreamFor<N extends string> = N extends StreamName
  ? (args: StreamArgs<N>, call: RemoteStreamCall) => AsyncIterable<StreamItem<N>>
  : RemoteStream

/** A failure that crosses the carrier with a stable code. */
export class RemoteFailure extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'RemoteFailure'
    this.code = code
  }
}

/** Wire form of a failure. */
export function failureOf(error: unknown): { code: string; message: string } {
  if (error instanceof RemoteFailure) return { code: error.code, message: error.message }
  return { code: 'dscode/internal', message: error instanceof Error ? error.message : String(error) }
}

const json = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T

/** Name-keyed methods and streams; later registrations of a name replace earlier ones. */
export class DscodeRemoteRegistry {
  private readonly methods = new Map<string, RemoteMethod>()
  private readonly streams = new Map<string, RemoteStream>()

  method<N extends string>(name: N, fn: MethodFor<N>): () => void {
    const method = fn as RemoteMethod
    this.methods.set(name, method)
    return () => { if (this.methods.get(name) === method) this.methods.delete(name) }
  }

  stream<N extends string>(name: N, fn: StreamFor<N>): () => void {
    const stream = fn as RemoteStream
    this.streams.set(name, stream)
    return () => { if (this.streams.get(name) === stream) this.streams.delete(name) }
  }

  has(name: string): boolean {
    return this.methods.has(name) || this.streams.has(name)
  }

  /** Invoke one method with JSON-normalized arguments and result. */
  async invoke(name: string, args: unknown, signal: AbortSignal = new AbortController().signal): Promise<unknown> {
    const fn = this.methods.get(name)
    if (fn === undefined) throw new RemoteFailure('dscode/unknown-method', `unknown DSCODE method ${name}`)
    return json(await fn(json(args) ?? {}, { signal }))
  }

  /** Open one stream with JSON-normalized arguments, uplink and items. */
  async *open(name: string, args: unknown, uplink: AsyncIterable<unknown>, signal: AbortSignal): AsyncIterable<unknown> {
    const fn = this.streams.get(name)
    if (fn === undefined) throw new RemoteFailure('dscode/unknown-stream', `unknown DSCODE stream ${name}`)
    const normalizedUplink = (async function* () { for await (const item of uplink) yield json(item) })()
    for await (const item of fn(json(args) ?? {}, { signal, uplink: normalizedUplink })) yield json(item)
  }
}

/**
 * Stream values pushed by `subscribe` until the call is aborted: the shape
 * every host-side "watch" uses. `initial` is sent first.
 */
export function watch<T>(signal: AbortSignal, initial: () => T, subscribe: (push: () => void) => () => void): AsyncIterable<T> {
  return watchAsync(signal, async () => initial(), subscribe)
}

/** {@link watch} over an asynchronous read; reads never overlap, and a change during one schedules another. */
export async function* watchAsync<T>(signal: AbortSignal, initial: () => Promise<T>, subscribe: (push: () => void) => () => void): AsyncIterable<T> {
  let wake: (() => void) | undefined
  let dirty = true
  const unsubscribe = subscribe(() => { dirty = true; wake?.() })
  const aborted = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  try {
    let last: string | undefined
    while (!signal.aborted) {
      if (dirty) {
        dirty = false
        const value = await initial()
        if (signal.aborted) return
        const text = JSON.stringify(value)
        if (text !== last) { last = text; yield value }
        continue
      }
      await Promise.race([new Promise<void>(resolve => { wake = resolve }), aborted])
      wake = undefined
    }
  } finally {
    unsubscribe()
  }
}
