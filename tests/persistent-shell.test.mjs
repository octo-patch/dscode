import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createTestRuntime } from '../scripts/test-runtime.mjs';
import { spillCaptured } from '../scripts/output-spill.mjs';

const runtime = createTestRuntime({ runtime: true });
after(runtime.close);
const { apply } = await import(pathToFileURL(runtime.root + '/node_modules/@deepseek-ai/dsh-tool-bash-persistent/lib/index.js'));

function fixture({ timeoutMs = 1000, waits = false, commandOutput = 'partial output', maxOutputChars, store, exitCode = 0 } = {}) {
  let tool, snapshot = '', submissions = 0, polls = 0, mode = 'partial', start, end;
  const live = new Set(), closed = [], commands = [];
  const owner = { session: { header: { cwd: '/fixture', id: 'spill-session' } }, ctx: { effect() {} } };
  apply({
    effect() {}, tools: { register: value => { tool = value; } },
    get: name => name === 'spillStore' ? store : undefined,
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
          snapshot = `${start}\n${commandOutput}\n`;
        } else polls++;
        if (mode === 'complete' || (!waits && !request.text)) snapshot += `finished output\n${end}${exitCode}\n`;
        const done = waits && mode !== 'complete'
          ? new Promise(resolve => request.signal.addEventListener('abort', () => resolve(result()), { once: true }))
          : Promise.resolve(result());
        return { done, readOutput: () => ({ delta: '', truncated: false }) };
      },
    },
  }, { timeoutMs, maxOutputChars });
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

test('persistent shell saves the captured result before truncation, including failure status', async () => {
  const saved = [];
  const f = fixture({ commandOutput: 'HEAD\n' + 'x'.repeat(30000) + '\nMIDDLE_SENTINEL\nTAIL', maxOutputChars: 1000, exitCode: 7,
    store: { saveText: async input => { saved.push(input); return { locator: '/private/log.txt', retrievalHint: 'Use read with offset/limit.' }; } } });
  const result = await f.run();
  assert(result.length < 1500); assert.match(result, /Full captured output: \/private\/log.txt/);
  assert.match(result, /exit code 7/); assert.equal(saved.length, 1);
  assert.match(saved[0].content, /MIDDLE_SENTINEL\nTAIL/);
  assert.match(saved[0].content, /exit code 7/);
  assert(!saved[0].content.includes('__DSH_PERSISTENT_BASH'));
  assert.equal(saved[0].owner.sessionId, 'spill-session');
});

test('timeout spill retains partial output and small output does not create a file', async () => {
  const saved = [];
  const store = { saveText: async input => { saved.push(input); return { locator: '/log', retrievalHint: 'Read it.' }; } };
  const short = fixture({ store }); short.complete(); await short.run(); assert.equal(saved.length, 0);
  const timeout = fixture({ timeoutMs: 40, waits: true, commandOutput: 'timeout-data\n'.repeat(100), maxOutputChars: 100, store });
  const result = await timeout.run();
  assert.match(result, /timed out/); assert.match(result, /\/log/); assert.equal(saved.length, 1);
  assert.match(result, /Partial captured output/);
  assert.match(saved[0].content, /Partial capture: command completion was not observed/);
  assert(saved[0].content.length > 1000);
});

test('spill failures keep bounded output and incomplete captures never claim to be complete', async () => {
  const render = (value, cap) => value.text.slice(0, cap) + '[exit 1]';
  const owner = { session: { header: { id: 's' } } };
  const output = { text: 'x'.repeat(200), incomplete: true, exitCode: 1 };
  const saved = [];
  const ctx = { get: () => ({ saveText: async input => { saved.push(input); return { locator: '/saved', retrievalHint: 'Read it.' }; } }) };
  assert.match(await spillCaptured(ctx, owner, output, 20, render), /earlier bytes were lost/);
  assert.equal(saved[0].content, render(output, 1000));
  const failed = await spillCaptured({ get: () => ({ saveText: async () => { throw Error('disk full'); } }) }, owner, output, 20, render);
  assert.match(failed, /could not be saved/); assert.match(failed, /exit 1/);
  assert.match(await spillCaptured({}, owner, output, 20, render), /could not be saved/);
});
