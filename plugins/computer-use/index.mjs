/** Mount the compatible upstream provider with DSCODE interaction defaults. */
import ComputerUseBundle from '@anionex/dsh-computer-use';

export const name = 'dscode-computer-use';
export async function apply(ctx, config = {}) {
  if (process.platform === 'linux') await ctx.plugin(await import('./linux/index.mjs'), config);
  else ctx.plugin(ComputerUseBundle, config);
}
