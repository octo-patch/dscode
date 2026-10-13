import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';

// Exercise the shipped preset and Host guards, rather than rebuilding their
// composition in a unit fixture. Shared by terminal and installed Desktop probes.
export async function probeFileTools(ctx, verifyPresentation = () => {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'dscode-file-tools-'));
  const provider = `file-tools-${randomUUID()}`;
  const handles = [];
  const requests = [];
  let pending;
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 } }; }
    async *stream(options) {
      requests.push(options);
      const action = pending;
      pending = undefined;
      const block = action ? { type: 'tool-call', id: randomUUID(), name: action.name, arguments: JSON.stringify(action.args) }
        : { type: 'text', text: 'File tool fixture complete.' };
      yield { type: 'block-start', index: 0, blockType: block.type };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: action ? 'tool-calls' : 'stop' } };
    }
  }
  ctx.llm.registerAdapter([provider], new Adapter());
  const setup = async (scope, agent) => {
    await ctx.agentPresets.mount(scope, 'dscode');
    installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined });
  };
  const create = async meta => {
    const handle = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd, agentPreset: 'dscode', ...meta },
      agentOptions: { provider, model: 'fixture' }, setup });
    handles.push(handle);
    return handle.agent;
  };
  const run = (agent, name, args) => ctx.tools.execute({ name, arguments: args, agent, callId: randomUUID(), signal: AbortSignal.timeout(10000) });
  const ok = result => { assert.equal(result.isError, false, JSON.stringify(result)); return result; };
  const fails = (result, pattern) => { assert.equal(result.isError, true, JSON.stringify(result)); assert.match(JSON.stringify(result), pattern); };
  const text = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  const message = () => createUserMessage({ content: [{ type: 'text', text: 'Run the local file tool fixture.' }], source: { kind: 'user' } });
  try {
    const agent = await create();
    ctx.permissionPresets.apply(agent.session, 'workspace-write');
    for (const name of ['read', 'edit', 'write', 'bash']) assert(ctx.tools.schemas(agent).some(tool => tool.name === name), `Missing ${name}`);
    const file = join(cwd, 'sample.txt');
    writeFileSync(file, 'one\ntarget\ntarget\nfour\n');
    const edit = { file_path: 'sample.txt', old_string: 'one', new_string: 'ONE' };
    fails(await run(agent, 'edit', edit), /not been read/);
    fails(await run(agent, 'write', { file_path: file, content: 'clobber' }), /not been read/);
    ok(await run(agent, 'bash', { command: "mkdir nested; cd nested; cat ../sample.txt" }));
    fails(await run(agent, 'edit', edit), /not been read/);
    const read = ok(await run(agent, 'read', { file_path: 'sample.txt', offset: 2, limit: 2 }));
    assert.match(text(read), /target/);
    assert.match(text(read), /offset=4/);
    assert.deepEqual(read.meta.lines.map(line => line.number), [2, 3]);
    assert.equal(read.meta.totalLines, 4);
    assert.equal(read.meta.offset, 2);
    fails(await run(agent, 'edit', { ...edit, old_string: 'target' }), /FS_AMBIGUOUS_EDIT/);
    fails(await run(agent, 'edit', { ...edit, old_string: 'missing' }), /not found|no match/i);
    assert.equal(readFileSync(file, 'utf8'), 'one\ntarget\ntarget\nfour\n');
    const changed = ok(await run(agent, 'edit', edit));
    assert(changed.meta.diffs.some(diff => diff.oldText.includes('one') && diff.newText.includes('ONE')), JSON.stringify(changed));
    verifyPresentation(read, changed);
    ok(await run(agent, 'edit', { ...edit, old_string: 'target', new_string: 'TARGET', replace_all: true }));
    assert.equal(readFileSync(file, 'utf8'), 'ONE\nTARGET\nTARGET\nfour\n');
    writeFileSync(file, 'external\nONE\nTARGET\nTARGET\nfour\n');
    fails(await run(agent, 'edit', { ...edit, old_string: 'ONE', new_string: 'updated' }), /re-read/);
    fails(await run(agent, 'write', { file_path: file, content: 'clobber' }), /re-read/);
    assert.match(readFileSync(file, 'utf8'), /^external/);
    ok(await run(agent, 'read', { file_path: file }));
    ok(await run(agent, 'edit', { ...edit, old_string: 'ONE', new_string: 'updated' }));
    assert.match(readFileSync(file, 'utf8'), /^external\nupdated/);
    const created = ok(await run(agent, 'write', { file_path: 'created.txt', content: 'new\n' }));
    assert.equal(created.meta.operation, 'create');
    ok(await run(agent, 'edit', { file_path: 'created.txt', old_string: 'new', new_string: 'edited' }));
    const overwritten = ok(await run(agent, 'write', { file_path: 'created.txt', content: 'replaced\n' }));
    assert(overwritten.meta.diffs.some(diff => diff.oldText.includes('edited') && diff.newText.includes('replaced')));
    assert.equal(readFileSync(join(cwd, 'created.txt'), 'utf8'), 'replaced\n');

    const peer = await create({ origin: 'subagent', parentSession: agent.session.id });
    fails(await run(peer, 'edit', { ...edit, old_string: 'updated' }), /not been read/);
    ok(await run(peer, 'read', { file_path: file }));
    ok(await run(peer, 'edit', { ...edit, old_string: 'updated', new_string: 'peer' }));
    fails(await run(agent, 'edit', { ...edit, old_string: 'peer' }), /re-read/);

    const reset = await ctx.commands.execute(agent, '/shell reset', [], AbortSignal.timeout(10000));
    assert.equal(reset.result.kind, 'success');
    ctx.permissionPresets.apply(agent.session, 'read-only');
    ok(await run(agent, 'read', { file_path: file }));
    fails(await run(agent, 'edit', { ...edit, old_string: 'peer' }), /sandbox|denied/i);
    fails(await run(agent, 'write', { file_path: 'denied.txt', content: 'denied' }), /sandbox|denied/i);
    let approvals = 0;
    const dispose = ctx.on('approval/request', (req, next) => {
      if (req.agent !== agent || req.toolName !== 'edit') return next();
      approvals++;
      return Promise.resolve('rejected');
    }, { prepend: true });
    try {
      pending = { name: 'edit', args: { ...edit, old_string: 'peer', sandbox_permissions: 'workspace-write', justification: 'Verify file escalation rejection.' } };
      agent.followup(message());
      await agent.whenIdle();
      assert.equal(approvals, 1);
      assert.match(readFileSync(file, 'utf8'), /^external\npeer/);
    } finally { dispose(); }
    const prompt = JSON.stringify(requests[0].messages);
    assert.match(prompt, /Use read to inspect text files/);
    assert(!prompt.includes('Use bash as the persistent shell for reading, searching and modifying files'));
    assert(!prompt.includes('try \'sed -n 10,25p'));
    ctx.permissionPresets.apply(agent.session, 'workspace-write');
    await ctx.sessions.flush(agent.session);
    const sessionId = agent.session.id;
    await handles[0].dispose();
    handles.shift();
    const resumed = await ctx.agents.resume({ resumeSessionId: sessionId, setup });
    handles.push(resumed);
    fails(await run(resumed.agent, 'edit', { ...edit, old_string: 'peer' }), /not been read/);
    ok(await run(resumed.agent, 'read', { file_path: file }));
    ok(await run(resumed.agent, 'edit', { ...edit, old_string: 'peer', new_string: 'resumed' }));
    assert.match(readFileSync(file, 'utf8'), /^external\nresumed/);

    // Another workspace with the same relative path must resolve independently.
    const otherCwd = join(cwd, 'other');
    mkdirSync(otherCwd);
    writeFileSync(join(otherCwd, 'sample.txt'), 'other workspace\n');
    const other = await create({ cwd: otherCwd });
    assert.match(text(ok(await run(other, 'read', { file_path: 'sample.txt' }))), /other workspace/);
    return { fileTools: 'read windows, literal edits, replace-all, create and overwrite, diff metadata, shell cwd independence, stale rejection and recovery, session and workspace isolation, resume, read-only and rejected escalation passed' };
  } finally {
    for (const handle of handles.reverse()) await handle.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
}
