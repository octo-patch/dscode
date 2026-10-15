/**
 * Entry point of the separate terminal client: parse the terminal arguments
 * and attach to the Host whose local carrier socket the launcher names in
 * DSCODE_RUNTIME_SOCKET.
 *
 * @module dsh-code/client
 */

import { runTerminalClient } from './index.ts'
import { startupFromArgv } from './startup.ts'

export { runTerminalClient }

/** Run the client for this process's arguments; resolves when the terminal has mounted. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const socketPath = process.env.DSCODE_RUNTIME_SOCKET
  if (socketPath === undefined || socketPath === '') throw new Error('DSCODE_RUNTIME_SOCKET must name the Host socket')
  await runTerminalClient({ socketPath, startup: startupFromArgv(argv) })
}
