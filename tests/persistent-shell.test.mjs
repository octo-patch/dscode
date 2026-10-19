import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createTestRuntime } from '../scripts/test-runtime.mjs';

const runtime = createTestRuntime({ runtime: true });
after(runtime.close);
const { apply } = await import(pathToFileURL(runtime.root + '/node_modules/@deepseek-ai/dsh-tool-bash-persistent/lib/index.js'));

function fixture({ timeoutMs = 1000, waits = false } = {}) {
  let tool, snapshot = '', submissions = 0, polls = 0, mode = 'partial', start, end;
  const live = new Set(), closed = [], commands = [];
  const owner = { session: { header: { cwd: '/fixture' } }, ctx: { effect() {} } };
  apply({
    effect() {}, tools: { register: value => { tool = value; } },
    workingDirectory: { ensure: async agent => agent.session.header.cwd },
    terminals: {
      list: () => [...live].map(sessionId => ({ sessionId, status: { kind: 'running' } })),
      spawn: async () => { const sessionId = `shell-${++submissions}`; live.add(sessionId); return { sessionId }; },
      kill: async (_owner, id) => { closed.push(id); live.delete(id); },
      read: () => ({ text: snapshot, truncated: false }),
      startSend: (_owner, _id, request) => {
        const result = () => ({ viewport: snapshot, truncated: false, waitReason: 'stdin_read', sessionStatus: { kind: 'running' } });
        if (request.text === 'stty -echo') return { done: Promise.resolve(result()), readOutput: () => ({ delta: '', truncated: false }) };
        if (request.text) {
          commands.push(request.text);
          start = request.text.match(/__DSH_PERSISTENT_BASH_START_[\w-]+__/)[0];
          end = request.text.match(/__DSH_PERSISTENT_BASH_END_[\w-]+:/)[0];
          snapshot = `${start}\npartial output\n`;
        } else polls++;
        if (mode === 'complete' || (!waits && !request.text)) snapshot += `finished output\n${end}0\n`;
        const done = waits && mode !== 'complete'
          ? new Promise(resolve => request.signal.addEventListener('abort', () => resolve(result()), { once: true }))
          : Promise.resolve(result());
        return { done, readOutput: () => ({ delta: '', truncated: false }) };
      },
    },
  }, { timeoutMs });
  return { closed, commands, get polls() { return polls; }, complete: () => { mode = 'complete'; },
    run: (command = 'fixture', signal = new AbortController().signal) => tool.execute({ command }, { agent: owner, signal }) };
}

test('a stdin-read hint with partial output does not finish the command', async () => {
  const f = fixture();
  const output = await f.run();
  assert.match(output, /partial output[\s\S]*finished output/);
  assert.match(output, /Command finished with exit code 0/);
  assert.equal(f.polls, 1);
  assert.deepEqual(f.closed, []);
});

test('commands receive EOF by default without changing their explicit input', async () => {
  const f = fixture();
  f.complete();
  await f.run("cat <<'INPUT'\ncontent\nINPUT");
  assert.match(f.commands[0], /eval -- .* < \/dev\/null;/);
  assert.match(f.commands[0], /cat <<.*INPUT/);
});

test('a timeout returns partial output, closes the old shell and permits another call', async () => {
  const f = fixture({ timeoutMs: 40, waits: true });
  const output = await f.run();
  assert.match(output, /timed out/);
  assert.match(output, /partial output/);
  assert.match(output, /shell was reset/);
  assert.deepEqual(f.closed, ['shell-1']);
  f.complete();
  assert.match(await f.run(), /Command finished with exit code 0/);
});

test('cancellation closes the old shell and permits another call', async () => {
  const f = fixture({ waits: true });
  const abort = new AbortController();
  const pending = f.run('waiting', abort.signal);
  const timer = setTimeout(() => abort.abort(), 20);
  try { await pending; } finally { clearTimeout(timer); }
  assert.deepEqual(f.closed, ['shell-1']);
  f.complete();
  assert.match(await f.run(), /Command finished with exit code 0/);
});
