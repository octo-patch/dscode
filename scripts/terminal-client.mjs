// Process entry of the separate terminal client (packages/tui/src/client.ts):
// the launcher starts it with DSCODE_RUNTIME_SOCKET naming the Host socket.
import { main } from 'dsh-code/client';

main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
