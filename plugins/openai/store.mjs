import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock';

/** One stable host identity and atomic account records, serialized across Hosts. */
export class OpenAIStore {
  constructor(directory) { this.directory = directory; this.path = join(directory, 'accounts.json'); }
  read() {
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.accounts) || typeof data.hostId !== 'string') throw Error();
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw new Error('Cannot read OpenAI account storage', { cause: error });
    }
  }
  write(data) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temp = join(this.directory, '.' + randomUUID());
    try { writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' }); renameSync(temp, this.path); }
    finally { try { unlinkSync(temp); } catch { /* renamed or not created */ } }
  }
  async locked(action, signal) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const fd = openSync(join(this.directory, '.guard'), 'a', 0o600), deadline = Date.now() + 45000;
    try {
      for (;;) {
        signal?.throwIfAborted();
        try { await tryLockExclusive(fd); break; }
        catch (error) {
          if (!['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) throw error;
          if (Date.now() >= deadline) throw Error('OpenAI account storage is busy; retry', { cause: error });
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
      signal?.throwIfAborted();
      const data = this.read() ?? { version: 1, hostId: 'urn:uuid:' + randomUUID(), mode: 'chatgpt', revision: 0, accounts: [] };
      return await action(data);
    } finally { closeSync(fd); }
  }
  initialize() { return this.locked(data => { this.write(data); return data; }); }
}
