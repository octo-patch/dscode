/**
 * tui-host: the Host half of the terminal. It provides the `dscodeRemote`
 * registry and registers the terminal operations that run where the session
 * lives, so the same terminal works in process or as a separate client over
 * the local carrier (docs/runtime-client-design.md).
 *
 * @module dsh-code/host
 */

import type { Context } from '@deepseek-ai/cordis'
import { DscodeRemoteRegistry } from './registry.ts'
import { registerCatalog } from './catalog.ts'
import { registerChildren } from './children.ts'
import { registerCommands } from './commands.ts'
import { registerDelivery } from './delivery.ts'
import { registerModels } from './models.ts'
import { registerNotices } from './notices.ts'
import { registerProviders } from './providers.ts'
import { registerSessions } from './sessions.ts'
import { registerStatus } from './status.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-host'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dscodeRemote: DscodeRemoteRegistry
  }
}

/** Mount the registry and every terminal operation group. */
export function apply(ctx: Context): void {
  const registry = new DscodeRemoteRegistry()
  ctx.provide('dscodeRemote', registry)
  const groups = [registerNotices, registerCommands, registerModels, registerProviders, registerSessions, registerCatalog, registerDelivery, registerStatus, registerChildren]
  for (const register of groups) ctx.effect(() => {
    const disposers = register(ctx, registry)
    return () => { for (const dispose of disposers) dispose() }
  })
}
