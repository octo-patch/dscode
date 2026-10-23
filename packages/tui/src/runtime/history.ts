import type { SessionEvent } from '@deepseek-ai/dsh-session'

export interface HistoryPage { records: readonly { event: SessionEvent }[]; hasMore: boolean }
export function historyFailure(message: string): Error {
  return Object.assign(new Error(`invalid session history: ${message}`), { code: 'dscode/history-invalid' })
}

/** Pages must cover a contiguous prefix ending at the requested exclusive bound. */
export function historyPage(page: HistoryPage, before: number): SessionEvent[] {
  if (!Array.isArray(page.records) || typeof page.hasMore !== 'boolean' || !Number.isSafeInteger(before) || before < 0) throw historyFailure('malformed page')
  const events = page.records.map(record => record?.event)
  for (let i = 0; i < events.length; i++) {
    const seq = events[i]?.seq
    if (!Number.isSafeInteger(seq) || seq < 0 || (i > 0 && seq !== events[i - 1].seq + 1)) throw historyFailure('unordered, duplicate or missing sequence')
  }
  if (events.length === 0) {
    if (before !== 0 || page.hasMore) throw historyFailure('empty page did not reach the requested boundary')
  } else if (events.at(-1)!.seq !== before - 1 || page.hasMore !== (events[0].seq > 0)) {
    throw historyFailure('page boundary or hasMore disagrees with its records')
  }
  return events
}
