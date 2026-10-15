/**
 * Entry point of the separate terminal client: parse the terminal arguments
 * and attach to the Host the launcher names, either this machine's local
 * carrier socket (DSCODE_RUNTIME_SOCKET) or a remote `dscode server`
 * (DSCODE_RUNTIME_URL with DSCODE_RUNTIME_TOKEN and the server-side folder in
 * DSCODE_RUNTIME_CWD).
 *
 * @module dsh-code/client
 */

import { targetFromEnv } from '../../../plugins/local-carrier/client.mjs'
import { runTerminalClient } from './index.ts'
import type { CarrierTarget } from './runtime/typert.ts'
import { startupFromArgv } from './startup.ts'

export { runTerminalClient }

/** Run the client for this process's arguments; resolves when the terminal has mounted. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const target = targetFromEnv() as CarrierTarget | undefined
  if (target === undefined) throw new Error('DSCODE_RUNTIME_SOCKET or DSCODE_RUNTIME_URL must name the Host')
  // Held in memory from here on, so processes this terminal starts (an editor) do not inherit it.
  delete process.env.DSCODE_RUNTIME_TOKEN
  const cwd = process.env.DSCODE_RUNTIME_CWD
  const label = process.env.DSCODE_RUNTIME_ALIAS
  await runTerminalClient({
    target,
    startup: startupFromArgv(argv),
    ...(cwd === undefined || cwd === '' ? {} : { cwd }),
    ...(label === undefined || label === '' ? {} : { label }),
  })
}
