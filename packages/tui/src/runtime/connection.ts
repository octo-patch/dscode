/** Persistent connection identity for a remote terminal, independent of session switches. */
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'unauthorized' | 'incompatible' | 'failed'

export interface ConnectionIdentity {
  readonly label: string
  readonly state: ConnectionState
}

export function connectionStatus(label: string) {
  let state: ConnectionState = 'connecting'
  const listeners = new Set<() => void>()
  return {
    get value(): ConnectionIdentity { return { label, state } },
    set(next: ConnectionState): void {
      if (next === state) return
      state = next
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

export type ConnectionStatus = ReturnType<typeof connectionStatus>

/** Both carrier unary errors and stream errors retain the Host's failure code. */
export function failureCode(error: unknown): string | undefined {
  const failure = error as { code?: string; remote?: { code?: string } } | undefined
  return failure?.remote?.code ?? failure?.code
}

export function connectionFailure(error: unknown): Error & { code?: string } {
  const code = failureCode(error)
  const message = code === 'dscode/unauthorized'
    ? 'the runtime refused the token; update it with `dscode config --alias NAME --token TOKEN`, then restart dscode'
    : error instanceof Error ? error.message : String(error)
  return Object.assign(new Error(message), { code })
}
