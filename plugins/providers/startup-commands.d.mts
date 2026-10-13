import type { Context } from '@deepseek-ai/cordis';
import type { CommandDefinition, CommandDescriptor } from '@deepseek-ai/dsh-commands';
/** Register a global Host command whose metadata is safe to show before a session exists. */
export function registerStartupCommand(ctx: Context, definition: CommandDefinition): () => void;
export function startupCommands(ctx: Context): readonly CommandDescriptor[];
export function watchStartupCommands(ctx: Context, listener: () => void): () => void;
