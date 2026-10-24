import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const helperPath = fileURLToPath(new URL('./helper.py', import.meta.url));
const MAX_BYTES = 4 * 1024 * 1024;

/** One bounded, serial helper connection per Host. An interrupted command is
 * never retried: input may already have reached the desktop. */
export class LinuxHelperClient {
  constructor({ launch = spawn, timeoutMs = 15000, executable = '/usr/bin/python3' } = {}) {
    Object.assign(this, { launch, timeoutMs, executable });
    this.sequence = 0; this.tail = Promise.resolve(); this.stopping = Promise.resolve(); this.closed = false;
  }
  stop(child) {
    if (!child || child === this.retiring) return;
    this.retiring = child;
    if (this.child === child) this.child = undefined;
    this.stopping = new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('close', () => { clearTimeout(timer); this.retiring = undefined; resolve(); });
      child.kill('SIGTERM');
    });
  }
  start() {
    if (this.closed) throw Error('Linux Computer Use has been disposed.');
    if (this.child) return;
    const child = this.launch(this.executable, ['-u', helperPath], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    this.child = child;
    let buffer = Buffer.alloc(0), diagnostics = '';
    const fail = error => {
      if (this.child === child) this.child = undefined;
      if (this.pending?.child === child) this.pending.reject(error);
    };
    child.stderr.on('data', data => { diagnostics = (diagnostics + data.toString()).slice(-2000); });
    child.stdout.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > MAX_BYTES) { this.stop(child); fail(Error('Linux helper response exceeds 4 MiB.')); return; }
      let end;
      while ((end = buffer.indexOf(10)) >= 0) {
        const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
        try {
          const response = JSON.parse(line.toString());
          if (this.pending?.child !== child || response.id !== this.pending.id) throw Error('Unexpected Linux helper response.');
          if (response.error) this.pending.reject(Object.assign(Error(response.error.message), { code: response.error.code }));
          else this.pending.resolve(response.result);
        } catch (error) { this.stop(child); fail(error); }
      }
    });
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.on('exit', () => fail(Error(`Linux desktop helper exited. Observe again before retrying any action. ${diagnostics}`)));
  }
  invoke(command, signal, timeoutMs = this.timeoutMs) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const run = this.tail.catch(() => {}).then(async () => {
      await this.stopping;
      signal?.throwIfAborted(); this.start();
      const child = this.child, id = ++this.sequence;
      const bytes = JSON.stringify({ id, ...command }) + '\n';
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw Error('Linux helper request exceeds 4 MiB.');
      let timer, abort;
      try {
        return await new Promise((resolve, reject) => {
          this.pending = { child, id, resolve, reject };
          const cancel = error => {
            // Cancel the transport before another action can enter it.
            this.stop(child); reject(error);
          };
          abort = () => cancel(signal.reason);
          signal?.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => cancel(Error('Linux desktop command timed out; its result may be uncertain. Observe before retrying.')), timeoutMs);
          child.stdin.write(bytes);
        });
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (this.pending?.id === id) this.pending = undefined;
      }
    });
    this.tail = run.catch(() => {});
    // A queued cancellation must not wait for the preceding operation.
    if (!signal) return run;
    let abort;
    const cancelled = new Promise((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
    return Promise.race([run, cancelled]).finally(() => signal.removeEventListener('abort', abort));
  }
  async dispose() {
    this.closed = true;
    this.pending?.reject(Error('Linux Computer Use has been disposed.'));
    this.stop(this.child);
    await this.tail; await this.stopping;
  }
}
