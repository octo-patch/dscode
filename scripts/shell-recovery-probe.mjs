import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

export async function probeShellRecovery(ctx) {
  const cwd = mkdtempSync(join(tmpdir(), 'dscode-shell-recovery-'));
  const provider = `shell-recovery-${randomUUID()}`;
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 } }; }
    async *stream() { yield { type: 'finish', reason: { kind: 'stop' } }; }
  }
  ctx.llm.registerAdapter([provider], new Adapter());
  const handle = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd, agentPreset: 'dscode' },
    agentOptions: { provider, model: 'fixture' }, setup: async scope => { await ctx.agentPresets.mount(scope, 'dscode'); } });
  const run = async (command, signal = AbortSignal.timeout(15000)) => {
    const result = await ctx.tools.execute({ name: 'bash', arguments: { command }, agent: handle.agent, callId: randomUUID(), signal });
    const text = result.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '';
    return { result, text };
  };
  const finished = ({ result, text }, pattern, code = 0) => {
    assert.equal(result.isError, false, text);
    assert.match(text, pattern);
    assert(text.includes(`[Command finished with exit code ${code}]`), text);
  };
  try {
    writeFileSync(join(cwd, 'reader.cjs'), `process.stdout.write('WAITING_FOR_INPUT\\n');
process.stdin.on('data', () => process.stdout.write('SWALLOWED_NEXT_COMMAND\\n'));
process.stdin.on('end', () => process.exit(0));
`);
    const started = Date.now();
    const reader = await run('node reader.cjs');
    const next = await run("printf 'NEXT_COMMAND_OK\\n'");
    console.log('SHELL_RECOVERY_READER ' + JSON.stringify({ elapsedMs: Date.now() - started, reader: reader.text, next: next.text }));
    finished(reader, /WAITING_FOR_INPUT/);
    finished(next, /NEXT_COMMAND_OK/);
    assert(!next.text.includes('SWALLOWED_NEXT_COMMAND'));

    finished(await run("export DSCODE_RECOVERY_STATE=retained; mkdir nested; cd nested; false"), /exit code 1/, 1);
    finished(await run("printf 'state=%s cwd=%s\\n' \"$DSCODE_RECOVERY_STATE\" \"$PWD\""), /state=retained cwd=.*\/nested/);
    finished(await run("cat <<'INPUT'\nheredoc input\nINPUT"), /heredoc input/);
    finished(await run('printf pipe-input | cat'), /pipe-input/);
    finished(await run('cat'), /exit code 0/);
    finished(await run("printf 'STARTED\\n'; sleep 7; printf 'COMPLETED\\n'"), /STARTED[\s\S]*COMPLETED/);
    finished(await run("sleep 7; printf 'SILENT_COMPLETED\\n'"), /SILENT_COMPLETED/);

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 500);
    try { await run("trap '' INT; sleep 30", abort.signal); }
    finally { clearTimeout(timer); }
    finished(await run("printf 'after_cancel=%s\\n' \"${DSCODE_RECOVERY_STATE-unset}\""), /after_cancel=unset/);
    const exited = await run('exit 7');
    assert.match(exited.text, /shell exited: code 7/);
    finished(await run("printf 'AFTER_EXIT\\n'"), /AFTER_EXIT/);
    return { shellRecovery: 'stdin EOF, subsequent command, nonzero exit, cwd/env, heredoc/pipe, silent and output-first waits, cancellation and shell exit passed' };
  } finally {
    await handle.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
}
