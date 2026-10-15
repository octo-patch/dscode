/**
 * Footer status for a separate terminal: the Host's per-session metrics,
 * service-speed label and delegation board, sampled while the stream is open
 * and pushed when they change. The in-process terminal reads the same
 * sources directly.
 *
 * @module dsh-code/host/status
 */

import type { Context } from '@deepseek-ai/cordis'
import { metricData } from '../../../../plugins/session-metrics/view.mjs'
import { speedLabel } from '../../../../plugins/openai/speed.mjs'
import { delegateBoardFor } from '../../../../plugins/dscode/board.mjs'
import type { DscodeRemoteRegistry } from './registry.ts'

/** One status sample. */
export interface StatusState {
  readonly metrics?: unknown
  readonly speed: string
  readonly board?: unknown
}

const SAMPLE_MS = 500

export function registerStatus(_ctx: Context, registry: DscodeRemoteRegistry): (() => void)[] {
  return [
    registry.stream('status/watch', ({ sessionId, modelLabel }: { sessionId: string; modelLabel: string }, { signal }) => (async function* () {
      let last: string | undefined
      while (!signal.aborted) {
        const state: StatusState = { metrics: metricData(sessionId), speed: speedLabel(sessionId, modelLabel), board: delegateBoardFor(sessionId) }
        const text = JSON.stringify(state)
        if (text !== last) { last = text; yield state }
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, SAMPLE_MS)
          signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
        })
      }
    })()),
  ]
}
