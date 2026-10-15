/**
 * Slash-command bridge: forwards terminal command lines into the shared
 * `ctx.commands` registry (the same surface the web composer dispatches
 * through) and exposes the live descriptor list as completion candidates.
 * The runner keeps only its own TUI-local commands (`/help`, `/quit`,
 * `/clear`, `/model`) ahead of the registry dispatch.
 *
 * @module @deepseek-ai/dsh-tui/commands
 */

import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import type { CommandsState } from './host/commands.ts'
import type { RuntimeClient } from './runtime/types.ts'
import { remoteWatch } from './runtime/watch.ts'

/** Live command descriptors for the composer's suggestions and the help panel. */
export interface CommandsView {
  readonly descriptors: readonly CommandDescriptor[]
  /** Last listing failure, if the registry rejected the current session. */
  readonly error?: string
  subscribe(listener: () => void): () => void
  /** Follow another session's commands; undefined lists the pre-session (startup) commands. */
  setSession(sessionId: string | undefined): void
}

/**
 * Watch the command registry through the Host's `commands/watch` stream. The
 * Host pushes the session's descriptor list (or the startup commands before a
 * session exists) whenever the registry or a startup command changes.
 * @param runtime - the runtime the terminal drives.
 * @returns the live view.
 */
export function watchCommands(runtime: RuntimeClient): CommandsView {
  const state = remoteWatch(runtime, 'commands/watch', { descriptors: [] }, {})
  return {
    get descriptors() { return state.value.descriptors },
    get error() { return state.value.error },
    subscribe: listener => state.subscribe(listener),
    setSession: sessionId => state.retarget(sessionId === undefined ? {} : { sessionId }),
  }
}

export function isSlashLine(line: string): boolean {
  return /^\/[a-z][a-z0-9_-]*(?=$|[\t ])/u.test(line)
}

/**
 * The submission payload for one composer line. Trim is a blank check, not a
 * rewrite: an ordinary prompt keeps its exact leading indentation, inner
 * layout, and trailing spaces (pasted code must reach the model verbatim).
 * Only trailing line terminators are stripped — a draft's final newline is a
 * paste/Enter artifact (an open bracketed paste turns Enter into an inserted
 * newline), never deliberate content. A syntactic slash line still normalizes
 * fully so command routing stays stable (completion inserts a trailing space
 * after `/name`).
 * @param line - the complete draft text.
 * @returns the text to submit verbatim.
 */
export function submissionPayload(line: string): string {
  const withoutTrailingNewlines = line.replace(/[\r\n]+$/u, '')
  const trimmed = withoutTrailingNewlines.trim()
  return isSlashLine(trimmed) ? trimmed : withoutTrailingNewlines
}
