import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { loadProviderSettings } from '../packages/tui/src/provider-settings.ts';
import { watchCommands } from '../packages/tui/src/commands.ts';
import { completionCandidates } from '../packages/tui/src/app.ts';
import { SCOPES } from '../plugins/openai/oauth.mjs';
import { selectedSpeed, speedLabel } from '../plugins/openai/speed.mjs';
// Real packaged Host and local tools; all OpenAI HTTP is synthetic.
export async function probeOpenAI(ctx) {
  const service = ctx.get('dscodeOpenAI');
  assert(service, 'Packaged Host must load OpenAI');
  const commands = watchCommands(ctx);
  assert(completionCandidates('/ope', commands.descriptors, []).some(row => row.label === '/openai' && row.description.includes('login')), 'OpenAI must complete before creating an Agent');
  assert(commands.descriptors.some(row => row.name === 'speed'));
  assert(commands.descriptors.some(row => row.name === 'antigravity'));
  assert.equal(service.auth.status().accounts.length, 0, 'Use isolated credentials');
  const workspace = mkdtempSync(join(tmpdir(), 'dscode-openai-files-'));
  const originalFetch = service.fetch, handles = [], bodies = [];
  try {
    let calls = 0;
    service.fetch = async (url, init) => {
      if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'gpt-6.1-sol', display_name: 'Fixture' }] });
      assert(url.endsWith('/responses'));
      assert.equal(init.headers.authorization, 'Bearer fixture-access');
      const body = JSON.parse(init.body);
      const isAgent = body.tools?.some(t => t.tools?.some(f => f.name === 'read'));
      if (isAgent) { bodies.push(body); assert.equal(body.service_tier, 'ultrafast'); }
      const output = isAgent && calls++ === 0 ? [
        { type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'encrypted-fixture' },
        { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', namespace: 'dscode', name: 'read', arguments: JSON.stringify({ file_path: 'sample.txt' }), status: 'completed' },
      ] : [{ type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'PACKAGED_OPENAI_OK', annotations: [] }] }];
      const packets = [...output.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })),
        { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [], service_tier: 'default' } }];
      // Match the observed direct-route transport: headerless SSE and completed
      // items preceding an empty terminal output envelope.
      return new Response(new TextEncoder().encode(packets.map(packet => 'data: ' + JSON.stringify(packet) + '\n\n').join('')));
    };
    const data = await service.auth.store.initialize();
    assert(await service.auth.save({ clientId: 'oaiapp_fixture', subject: 'fixture-user', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600000, scopes: SCOPES.split(' ') }, data));
    const row = (await loadProviderSettings(ctx)).rows.find(r => r.provider === 'openai');
    assert(row?.active); assert.equal(row.credentialRef, 'OPENAI_API_KEY');
    assert.equal(row.credential.writable, false); assert.equal(row.credential.configured, true);
    const setup = async (scope, agent) => {
      await ctx.agentPresets.mount(scope, 'dscode');
      installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined });
    };
    writeFileSync(join(workspace, 'sample.txt'), 'OPENAI_REAL_FILE_CONTENT\n');
    const handle = await ctx.agents.create({ sessionId: 'openai-candidate', meta: { cwd: workspace, agentPreset: 'dscode' }, agentOptions: { provider: 'openai', model: 'gpt-6.1-sol', reasoningEffort: 'high' }, setup });
    handles.push(handle);
    ctx.permissionPresets.apply(handle.agent.session, 'workspace-write');
    assert.equal((await ctx.commands.execute(handle.agent, '/speed ultrafast', [], new AbortController().signal)).result.kind, 'success');
    for (const tool of ['read', 'edit', 'write', 'bash']) assert(ctx.tools.schemas(handle.agent).some(t => t.name === tool));
    const follow = async agent => { agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read sample.txt and report.' }], source: { kind: 'user' } })); await agent.whenIdle(); };
    await follow(handle.agent);
    assert.equal(calls, 2, JSON.stringify(handle.agent.session.snapshotEvents()));
    const verify = body => {
      assert(body.input.some(p => p.type === 'reasoning' && p.encrypted_content === 'encrypted-fixture'));
      assert(body.input.some(p => p.type === 'function_call_output' && p.output.includes('OPENAI_REAL_FILE_CONTENT')));
      assert.equal(body.reasoning.effort, 'high'); assert(!('max_output_tokens' in body));
    };
    verify(bodies[1]);
    assert.equal(speedLabel(handle.agent.id, 'gpt-6.1-sol'), 'ultrafast → default');
    await ctx.sessions.flush(handle.agent.session); await handle.dispose(); handles.pop();
    const resumed = await ctx.agents.resume({ resumeSessionId: 'openai-candidate', setup }); handles.push(resumed);
    assert.equal(selectedSpeed(resumed.agent.session), 'ultrafast');
    await follow(resumed.agent); assert.equal(calls, 3); verify(bodies[2]);
    assert(JSON.stringify(resumed.agent.session.snapshotEvents()).includes('PACKAGED_OPENAI_OK'));
    await resumed.dispose(); handles.pop();
    await service.auth.select('api-key');
    const keyRow = (await loadProviderSettings(ctx)).rows.find(r => r.provider === 'openai');
    assert.equal(keyRow.credential.writable, true);
    return { startupCompletion: true, providerSettings: true, readToolRoundTrip: true, encryptedReplayAfterResume: true, savedSpeed: true, actualTierDisplay: true, explicitBilling: true, syntheticHttp: true };
  } finally {
    for (const handle of handles) await handle.dispose();
    service.fetch = originalFetch; rmSync(workspace, { recursive: true, force: true });
  }
}
