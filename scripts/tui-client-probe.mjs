// Separate terminal client with the verification probe installed: the launcher
// starts it in place of terminal-client.mjs when DSCODE_TERMINAL_CLIENT names it.
import { runProbe } from './tui-runner-probe.mjs';
import { main } from 'dsh-code/client';

runProbe(() => process.exit(1));
main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
