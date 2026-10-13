import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { loadProviderSettings } from '../packages/tui/src/provider-settings.ts';
// Called only by the isolated verification Host; all Google HTTP is synthetic.
export async function probeAntigravity(ctx) {
  const login = ctx.get('dscodeAntigravityLogin');
  assert(login, 'Packaged Host must load Antigravity');
  const row = (await loadProviderSettings(ctx)).rows.find(r => r.provider === 'antigravity');
  assert(row?.active); assert.equal(row.credentialRef, 'ANTIGRAVITY_OAUTH');
  assert.equal(row.credential.writable, false);
  assert.equal(await login.session.current(), undefined, 'Use an isolated credential store');
  const workspace = mkdtempSync(join(tmpdir(), 'dscode-antigravity-files-'));
  const originalFetch = login.client.fetch;
  const handles = [];
  try {
    let calls = 0;
    const bodies = [];
    login.client.fetch = async (url, init) => {
      if (url.includes('fetchAvailableModels')) return Response.json({models:{'gemini-3.8-flash-low':{model:'FIXTURE'}}});
      assert(url.includes('streamGenerateContent'));
      assert.equal(init.headers.authorization ?? init.headers.Authorization, 'Bearer fake-access');
      const body = JSON.parse(init.body);
      const isAgent = body.request.tools?.some(t => t.functionDeclarations?.some(f => f.name === 'read'));
      if (isAgent) bodies.push(body);
      assert.equal(body.model, 'gemini-3.8-flash-low');
      const parts = isAgent && calls++ === 0 ? [{functionCall:{name:'read',args:{file_path:'sample.txt'}},thoughtSignature:'fixture-signature'}] : [{text:'PACKAGED_ANTIGRAVITY_OK'}];
      return new Response(`data: ${JSON.stringify({response:{candidates:[{content:{role:'model',parts},finishReason:'STOP'}]}})}\n\n`, {headers:{'content-type':'text/event-stream'}});
    };
    await login.session.save({version:1,access:'fake-access',refresh:'fake-refresh',projectId:'fake-project',expires:Date.now()+3600000});
    const setup = async (scope, agent) => {
      await ctx.agentPresets.mount(scope, 'dscode');
      installModelSelection(scope, {get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled:undefined});
    };
    writeFileSync(join(workspace, 'sample.txt'), 'ANTIGRAVITY_REAL_FILE_CONTENT\n');
    const handle = await ctx.agents.create({sessionId:'antigravity-candidate',meta:{cwd:workspace,agentPreset:'dscode'},agentOptions:{provider:'antigravity',model:'gemini-3.8-flash',reasoningEffort:'low'},setup});
    handles.push(handle);
    ctx.permissionPresets.apply(handle.agent.session, 'workspace-write');
    for (const tool of ['read','edit','write','bash']) assert(ctx.tools.schemas(handle.agent).some(t => t.name === tool));
    const follow = async agent => { agent.followup(createUserMessage({content:[{type:'text',text:'Read sample.txt and report.'}],source:{kind:'user'}})); await agent.whenIdle(); };
    await follow(handle.agent);
    assert.equal(calls, 2, JSON.stringify(handle.agent.session.snapshotEvents()));
    const verify = body => {
      const parts = body.request.contents.flatMap(c => c.parts);
      assert(parts.some(p => p.functionCall?.name === 'read' && p.thoughtSignature === 'fixture-signature'));
      assert(parts.some(p => p.functionResponse?.name === 'read' && JSON.stringify(p).includes('ANTIGRAVITY_REAL_FILE_CONTENT')));
    };
    verify(bodies[1]);
    await ctx.sessions.flush(handle.agent.session); await handle.dispose(); handles.pop();
    const resumed = await ctx.agents.resume({resumeSessionId:'antigravity-candidate',setup});
    handles.push(resumed);
    await follow(resumed.agent); assert.equal(calls,3); verify(bodies[2]);
    assert(JSON.stringify(resumed.agent.session.snapshotEvents()).includes('PACKAGED_ANTIGRAVITY_OK'));
    await resumed.dispose(); handles.pop(); await login.logout('en');
    assert.equal(await login.session.current(), undefined);
    return { providerSettings: true, readToolRoundTrip: true, signedReplayAfterResume: true, logout: true, syntheticHttp: true };
  } finally {
    for (const handle of handles) await handle.dispose();
    await login.logout('en'); login.client.fetch = originalFetch;
    rmSync(workspace, { recursive: true, force: true });
  }
}
