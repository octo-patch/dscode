import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import Credentials from '../plugins/credentials/index.mjs';
import * as plugin from '../plugins/openai/index.mjs';
import { OpenAIStore } from '../plugins/openai/store.mjs';
import { OpenAIAuth } from '../plugins/openai/auth.mjs';
import { IdentityVerifier, transaction, authorizationUrl, callbackServer, exchangeCode, SCOPES } from '../plugins/openai/oauth.mjs';
import { OpenAILogin } from '../plugins/openai/command.mjs';
import { OpenAIModels, FALLBACK_MODELS, parseModels, resolveSpeed } from '../plugins/openai/models.mjs';
import { requestBody, translate } from '../plugins/openai/wire.mjs';
import { OpenAIAdapter } from '../plugins/openai/adapter.mjs';
import { speedCommand, selectedSpeed, speedState } from '../plugins/openai/speed.mjs';
import { sseData } from '../plugins/providers/chat-stream.mjs';
import { compactionPreview, effectiveContextWindow } from '../plugins/compaction/threshold.mjs';
import { DscodeCompactionEngine } from '../plugins/compaction/engine.mjs';
const collect = async stream => { const out = []; for await (const c of stream) out.push(c); return out; };
const model = FALLBACK_MODELS[0];
const credential = { mode: 'chatgpt', token: 'fake', key: 'test-account' };
const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
const options = () => ({ provider: 'openai', model: model.id, messages: [user('hello')], tools: [{ name: 'read', description: 'Read file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }], reasoningEffort: 'high' });
const message = text => ({ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', namespace: 'dscode', name: 'read', arguments: '{"file_path":"sample.txt"}', status: 'completed' };
const done = (output = [message('ok')], extras = {}) => ({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output, service_tier: 'ultrafast', ...extras } });
const sse = packets => new Response(packets.map(p => 'data: ' + JSON.stringify(p) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
const stream = packets => translate(sseData(sse(packets).body), { model: model.id, account: credential.key, requested: 'ultrafast' });
const grant = () => ({ clientId: 'oaiapp_test', subject: 'user1', email: 'test@example.com', access: 'fake-access', refresh: 'fake-refresh', idToken: 'fake-id', expires: Date.now() + 3600000, scopes: SCOPES.split(' ') });
async function stored(t, account = grant()) {
 const dir = await mkdtemp(join(tmpdir(), 'dscode-openai-')); t.after(() => rm(dir, { recursive: true, force: true }));
 const store = new OpenAIStore(dir), data = await store.initialize(); data.accounts.push(account); data.active = account.clientId; store.write(data); return store;
}
const token = { access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 3600, scope: SCOPES };
const makeAuth = (store, fetch = async () => Response.json(token)) => new OpenAIAuth({ store, fetch, apiKey: async () => 'api-key', verifier: { verify: async () => {}, discovery: async () => ({ revocation_endpoint: 'https://auth.openai.com/revoke' }) } });

test('OpenAI dynamic registration uses persistent host, fresh PKCE and nonce, and no client secret', async t => {
 const store = await stored(t), data = store.read(), tx = transaction(data); tx.redirectUri = 'http://127.0.0.1:1234/auth/callback';
 const url = new URL(authorizationUrl(tx)), next = transaction(data);
 assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client'); assert.equal(url.searchParams.get('agent_name_hint'), 'DSCODE');
 assert.equal(url.searchParams.get('ext_agent_host_id'), data.hostId); assert.notEqual(tx.nonce,tx.state); assert.notEqual(tx.verifier,next.verifier);
 assert(!url.searchParams.has('client_secret')); assert(!url.toString().includes(tx.verifier));
 const returning = new URL(authorizationUrl({ ...transaction(data, grant()), redirectUri: tx.redirectUri }));
 assert.equal(returning.searchParams.get('client_id'), 'oaiapp_test'); assert(!returning.searchParams.has('id_token_hint')); assert(!returning.searchParams.has('agent_name_hint'));
 assert.equal((await store.initialize()).hostId,data.hostId); assert.equal((await stat(store.path)).mode & 0o777,0o600);
});

test('OpenAI loopback accepts only matching state and an issued client, retaining exact callback URI', async () => {
 const tx = transaction({hostId:'urn:uuid:test',revision:0}); const listener = await callbackServer(tx);
 try {
  const url = new URL(tx.redirectUri); url.searchParams.set('code','fake-code'); url.searchParams.set('client_id','oaiapp_issued'); url.searchParams.set('state','bad');
  assert.equal((await fetch(url)).status,400); url.searchParams.set('state',tx.state);
  const response = await fetch(url); assert.equal(response.status,200); assert(!(await response.text()).includes('fake-code'));
  assert.deepEqual(await listener.result,{code:'fake-code',clientId:'oaiapp_issued'}); assert(tx.redirectUri.startsWith('http://127.0.0.1:'));
 } finally { listener.close(); }
});

test('returning login refuses a changed client and callback cancellation releases its port', async () => {
 const tx = transaction({hostId:'host',revision:0},grant()), listener = await callbackServer(tx);
 await fetch(tx.redirectUri+'?state='+tx.state+'&code=x&client_id=oaiapp_other'); await assert.rejects(listener.result);
 const next = await callbackServer(transaction({hostId:'host',revision:0}), {port:Number(new URL(tx.redirectUri).port)}); next.close(); await assert.rejects(next.result,/cancelled/);
});

test('ID token signature, issuer, audience, expiry, nonce and returning identity are verified', async () => {
 const { publicKey, privateKey } = await generateKeyPair('RS256'); const jwk = {...await exportJWK(publicKey),kid:'test'};
 const verifier = new IdentityVerifier(async url => Response.json(url.includes('openid') ? {issuer:'https://auth.openai.com',jwks_uri:'https://auth.openai.com/jwks',revocation_endpoint:'https://auth.openai.com/revoke'} : {keys:[jwk]}));
 const jwt = overrides => new SignJWT({sub:'user1',nonce:'nonce',...overrides}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer('https://auth.openai.com').setAudience('oaiapp_test').setIssuedAt().setExpirationTime('5m').sign(privateKey);
 const signed = await jwt({}), tx={clientId:'oaiapp_test',nonce:'nonce',subject:'user1'};
 assert.equal((await verifier.verify(signed,tx)).sub,'user1');
 for (const change of [{nonce:'other'},{clientId:'other'},{subject:'other'}]) await assert.rejects(verifier.verify(signed,{...tx,...change}), e=>e.code==='AUTH');
 const wrongIssuer = await new SignJWT({sub:'user1',nonce:'nonce'}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer('https://evil.example').setAudience('oaiapp_test').setIssuedAt().setExpirationTime('5m').sign(privateKey);
 const expired = await new SignJWT({sub:'user1',nonce:'nonce'}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer('https://auth.openai.com').setAudience('oaiapp_test').setIssuedAt().setExpirationTime(1).sign(privateKey);
 for (const bad of [wrongIssuer,expired,signed.slice(0,-5)+'AAAAA']) await assert.rejects(verifier.verify(bad,tx),e=>e.code==='AUTH');
});

test('code exchange uses callback client and exact redirect, preserving denied plan scope', async () => {
 let body; const tx={clientId:'dynamic_agent_client',nonce:'n',verifier:'v',redirectUri:'http://127.0.0.1:4567/auth/callback'};
 const account=await exchangeCode({code:'secret-code',clientId:'oaiapp_new'},tx,{verify:async(_id,p)=>{assert.equal(p.clientId,'oaiapp_new');return {sub:'one'};}},async (_url,init)=>{body=init.body;return Response.json({...token,id_token:'fake',scope:'openid profile'});});
 assert.equal(body.get('redirect_uri'),tx.redirectUri); assert.equal(body.get('client_id'),'oaiapp_new'); assert.equal(body.get('code_verifier'),'v'); assert(!account.scopes.includes('chatgpt.tokens.use.direct'));
});

test('concurrent Hosts serialize rotating token refresh and keep registration after logout', async t => {
 const store=await stored(t,{...grant(),expires:1}); let refreshes=0;
 const fetcher=async(url)=>{if(url.includes('revoke'))return new Response('');refreshes++;await new Promise(r=>setTimeout(r,25));return Response.json(token);};
 const a=makeAuth(store,fetcher),b=makeAuth(new OpenAIStore(store.directory),fetcher);
 const results=await Promise.all([a.acquire(),b.acquire()]);assert.equal(refreshes,1);assert(results.every(r=>r.token==='new-access'));
 const before=store.read();assert(await a.logout());const after=store.read();assert.equal(after.hostId,before.hostId);assert.equal(after.accounts[0].clientId,'oaiapp_test');assert(!after.accounts[0].refresh);assert(!after.accounts[0].idToken);
 await assert.rejects(a.acquire(),e=>e.code==='MISSING_CREDENTIAL');
});

test('refresh terminal errors clear tokens, transient failures preserve them, API billing is explicit', async t => {
 const store=await stored(t,{...grant(),expires:1});const auth=makeAuth(store,async()=>Response.json({error:'temporarily_unavailable'},{status:503}));
 await assert.rejects(auth.acquire(),e=>e.code==='SERVER');assert(store.read().accounts[0].refresh);
 auth.fetch=async()=>Response.json({error:'invalid_grant'},{status:400});await assert.rejects(auth.acquire());assert(!store.read().accounts[0].refresh);
 await auth.select('api-key');const result=await auth.acquire();assert.equal(result.mode,'api-key');assert.equal(result.token,'api-key');assert(!result.key.includes('api-key:api-key'));
});

test('account change or cancellation cannot be undone by a delayed sign-in', async t => {
 const store=await stored(t); const auth=makeAuth(store);const tx=transaction(store.read(),grant()); await auth.select('api-key');assert.equal(await auth.save(grant(),tx),false);
 let resolve; const waiting=new Promise(r=>resolve=r);const login=new OpenAILogin({auth,models:{clear(){}},open:async()=>{},callback:async()=>({url:'https://auth.openai.com/?state=fake',result:Promise.resolve({}),close(){}}),exchange:()=>waiting});
 await login.login('new');login.cancel();resolve(grant());await new Promise(r=>setImmediate(r));assert.equal(auth.status().mode,'api-key');
});

test('catalog preserves account tiers/efforts, hides unsupported models, and treats empty discovery as authoritative', async () => {
 const rows=parseModels({models:[{slug:model.id,visibility:'list',supported_reasoning_levels:[{effort:'high'}],service_tiers:[{id:'priority'}]}, {slug:'gpt-image-1'}, {slug:'gpt-hidden',visibility:'hide'}]});
 assert.equal(rows.length,1);assert.equal(resolveSpeed(rows[0],'fast'),'priority');assert.throws(()=>resolveSpeed(rows[0],'ultrafast'));
 assert.deepEqual(rows[0].efforts,['high']);
 const models=new OpenAIModels({acquire:async()=>credential},async()=>Response.json({models:[]}));assert.deepEqual(await models.list(),[]);assert(models.discovered);await assert.rejects(models.get(model.id),e=>e.code==='MODEL_NOT_FOUND');
});

test('Responses request separates effort and speed, scopes tools, and follows ChatGPT field restrictions', () => {
 const body=requestBody({...options(),maxTokens:10,temperature:0.5},model,credential,'ultrafast');
 assert.equal(body.reasoning.effort,'high');assert.equal(body.service_tier,'ultrafast');assert.equal(body.store,false);assert.equal(body.stream,true);assert.equal(body.tools[0].type,'namespace');
 for(const key of ['max_output_tokens','temperature','previous_response_id','metadata'])assert(!(key in body));
 const api=requestBody(options(),model,{...credential,mode:'api-key'},'fast');assert.equal(api.max_output_tokens,128000);assert.equal(api.service_tier,'fast');
});

test('streaming commits each block once, preserves encrypted reasoning and actual speed through JSON replay', async () => {
 const reasoning={type:'reasoning',id:'rs_1',encrypted_content:'opaque',summary:[{type:'summary_text',text:'Thinking'}]};
 const chunks=await collect(stream([{type:'response.reasoning_summary_text.delta',output_index:0,delta:'Thinking'},done([reasoning,call],{usage:{input_tokens:100,output_tokens:20,input_tokens_details:{cached_tokens:80},output_tokens_details:{reasoning_tokens:10}}})]));
 const ends=chunks.filter(c=>c.type==='block-end'); assert.equal(ends.length,2);assert.equal(chunks.filter(c=>c.type==='block-start').length,2);
 assert.equal(chunks.at(-1).reason.kind,'tool-calls');assert.equal(chunks.at(-1).replayState.response.actualTier,'ultrafast');assert.equal(chunks.find(c=>c.type==='usage').usage.inputTokens,20);
 const assistant=JSON.parse(JSON.stringify({role:'assistant',source:{provider:'openai',model:model.id,replayState:chunks.at(-1).replayState},content:ends.map(c=>c.block)}));
 const opts={...options(),messages:[user('read'),assistant,{role:'tool',toolCallId:'call_1',content:[{type:'text',text:'contents'}]}]};
 const body=requestBody(opts,model,credential,'fast');assert.deepEqual(body.input[1],reasoning);assert(body.input.some(i=>i.type==='function_call_output'&&i.output==='contents'));
 const changed=requestBody(opts,model,{...credential,key:'other-account'},'fast');assert(!JSON.stringify(changed.input).includes('encrypted_content'));
});

for (const [label,packets] of [
 ['disconnect',[{type:'response.output_item.done',output_index:0,item:call}]],
 ['incomplete',[{type:'response.incomplete',response:{output:[call]}}]],
 ['malformed tool',[done([{...call,arguments:'bad'}])]],
 ['unknown namespace',[done([{...call,namespace:'foreign'}])]],
 ['empty completion',[done([])]],
 ['quota',[{type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded',message:'secret'}}}]],
]) test('no tool commit after '+label,async()=>{
 const out=[];await assert.rejects((async()=>{for await(const c of stream(packets))out.push(c);})());assert(!out.some(c=>c.type==='block-end'||c.type==='finish'));
});

function adapter(fetcher) { return new OpenAIAdapter({auth:{acquire:async()=>credential},models:{get:async()=>model},speed:()=> 'fast',options:()=>({headerTimeoutMs:20,streamIdleTimeoutMs:20}),fetch:fetcher}); }
test('header timeout and cancellation stop the request without poisoning subsequent streams',async()=>{
 let stalled=true;const route=adapter(async(_url,init)=>stalled?new Promise((_r,reject)=>{init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});}):sse([done()]));
 const keepAlive=setInterval(()=>{},1000);
 try {
 await assert.rejects(collect(route.stream(options())),e=>e.code==='TIMEOUT');
 const controller=new AbortController();const p=collect(route.stream({...options(),signal:controller.signal}));setTimeout(()=>controller.abort(),1);await assert.rejects(p,e=>e.code==='ABORTED');
 stalled=false;assert.equal((await collect(route.stream(options()))).at(-1).reason.kind,'stop');
 } finally {clearInterval(keepAlive);}
});

test('native command records preserve speed across serialization and exclude failed changes', async () => {
 let events=[]; const session={snapshotEvents:()=>events,requestHeader:()=>({config:{provider:'openai',model:model.id}})};
 const command=speedCommand({models:{get:async()=>model},options:()=>({serviceTier:'default'})});
 const execute=async(args,status='idle')=>{
  const commandId=String(events.length);events.push({seq:events.length,type:'command/run',data:{commandId,name:'speed',args}});
  const result=await command.handler({agent:{session,status},rawInput:args});
  events.push({seq:events.length,type:'command/done',data:{commandId,...result}});return result;
 };
 assert.equal((await execute('ultrafast')).kind,'success');events=JSON.parse(JSON.stringify(events));assert.equal(selectedSpeed(session),'ultrafast');
 events.push({seq:events.length,type:'assistant/message',data:{message:{source:{provider:'openai',model:model.id,replayState:{response:{kind:'dscode-openai',requestedTier:'ultrafast',actualTier:'default'}}}}}});
 assert.deepEqual(speedState(session,model.id),{requested:'ultrafast',actual:'default'});
 assert.equal((await execute('fast','running')).kind,'error');assert.equal(selectedSpeed(session),'ultrafast');
 await execute('');assert.equal(selectedSpeed(session),'ultrafast');
});

test('Codex compacts exactly at 272k without shrinking real capacity or breaking tail retention',()=>{
 const context=effectiveContextWindow({contextWindow:1050000},{defaultMaxTokens:128000});assert.equal(context,922000);
 const policy={target:{provider:'openai',model:model.id},thresholdRatio:0.8,retainRatio:0.16};
 const spec=DscodeCompactionEngine.prototype.dscodeCompactSpec(policy,context);assert.equal(spec.thresholdTokens,272000);assert(spec.retainTokens<272000);
 for(const [used,compacts] of [[271999,false],[272000,true],[272001,true]])assert.equal(compactionPreview({provider:'openai',model:model.id,used,contextWindow:context,thresholdRatio:0.8}).compacts,compacts);
 assert.equal(DscodeCompactionEngine.prototype.dscodeCompactSpec(policy,24000).thresholdTokens,19200);
 assert.equal(DscodeCompactionEngine.prototype.dscodeCompactSpec({...policy,target:{provider:'antigravity',model:'gemini'}},context).thresholdTokens,737600);
});

test('real Harness registry uses selected billing and preserves provider response metadata',async t=>{
 const home=await mkdtemp(join(tmpdir(),'dscode-openai-host-')),ctx=new Context();t.after(async()=>{await ctx.fiber.dispose();await rm(home,{recursive:true,force:true});});
 ctx.provide('launchEnvironment',createLaunchEnvironmentSnapshot([{source:'process',values:{}}]));await ctx.plugin(LlmRuntime);await ctx.plugin(Credentials,{path:join(home,'shared','credentials.yaml'),dshHome:home,watch:false});await ctx.plugin(plugin);
 const service=ctx.get('dscodeOpenAI');let request;
 service.fetch=async(url,init)=>url.endsWith('/models')?Response.json({data:[{id:model.id}]}):(request=JSON.parse(init.body),sse([done()]));
 await service.auth.select('api-key');await ctx.credentials.set('OPENAI_API_KEY','test-key');assert((await ctx.credentials.describe('OPENAI_API_KEY')).writable);
 const chunks=await collect(ctx.llm.stream(options()));assert.equal(chunks.at(-1).reason.kind,'stop');assert.equal(request.service_tier,'default');assert.equal(request.reasoning.effort,'high');
 await service.auth.select('chatgpt');assert.equal((await ctx.credentials.describe('OPENAI_API_KEY')).writable,false);const failure=(await collect(ctx.llm.stream(options()))).at(-1);assert.equal(failure.reason.kind,'error');assert(JSON.stringify(failure).includes('MISSING_CREDENTIAL'));
});


test('real HTTP stalled body and cancellation recover without committing partial tools', async () => {
 let attempt = 0;
 const server = createServer((_req, res) => {
  res.writeHead(200, {'content-type':'text/event-stream'});
  if (++attempt < 3) res.write('data: '+JSON.stringify({type:'response.output_text.delta',output_index:0,delta:'partial'})+'\n\n');
  else res.end('data: '+JSON.stringify(done())+'\n\n');
 });
 server.listen(0,'127.0.0.1'); await once(server,'listening');
 const route = adapter((_url, init) => fetch('http://127.0.0.1:'+server.address().port, init));
 route.config.options = () => ({headerTimeoutMs:2000,streamIdleTimeoutMs:40});
 try {
  const chunks=[];
  await assert.rejects((async()=>{for await(const c of route.stream(options()))chunks.push(c);})(),e=>e.code==='TIMEOUT');
  assert(!chunks.some(c=>c.type==='block-end'||c.type==='finish'));
  const controller = new AbortController();
  await assert.rejects((async()=>{for await(const c of route.stream({...options(),signal:controller.signal}))if(c.type==='text-delta')controller.abort();})(),e=>e.code==='ABORTED');
  assert.equal((await collect(route.stream(options()))).at(-1).reason.kind,'stop');
 } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});

test('durable user and tool-result images reach Responses as input images', async () => {
 const home = await mkdtemp(join(tmpdir(),'openai-images-')), ctx = new Context();
 const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==','base64');
 try {
  await ctx.plugin(LocalAttachmentStore,{dshHome:home});
  const image={type:'image',attachment:await ctx.attachments.saveImage({data:png,mediaType:'image/png'})};
  let body; const route=adapter(async(_url,init)=>{body=JSON.parse(init.body);return sse([done()]);});
  route.config.resolveAttachments=()=>ctx.attachments;
  await collect(route.stream({...options(),messages:[{role:'user',content:[image]},
   {role:'assistant',content:[{type:'tool-call',id:'call_image',name:'screenshot',arguments:'{}'}]},
   {role:'user',content:[{type:'tool-result',toolCallId:'call_image',content:[image]}]}]}));
  const images=body.input.flatMap(i=>i.content??[]).filter(i=>i.type==='input_image');
  assert.equal(images.length,2);assert(images.every(i=>i.image_url.startsWith('data:image/png;base64,')));
  assert(body.input.some(i=>i.type==='function_call_output'&&i.call_id==='call_image'));
 } finally {await ctx.fiber.dispose();await rm(home,{recursive:true,force:true});}
});

test('invalid_grant retains only a registration hint and retries with fresh PKCE after restart', async t => {
 const store = await stored(t); const initial = store.read();
 initial.accounts = []; delete initial.active; store.write(initial);
 const urls = []; let exchanges = 0, previousChallenge;
 const { publicKey, privateKey } = await generateKeyPair('RS256');
 const jwk = { ...await exportJWK(publicKey), kid: 'recovery' };
 let currentUrl;
 const fetcher = async (url, init) => {
  if (url.includes('openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/jwks', revocation_endpoint: 'https://auth.openai.com/revoke' });
  if (url.endsWith('/jwks')) return Response.json({ keys: [jwk] });
  const body = new URLSearchParams(init.body);
  const { createHash } = await import('node:crypto');
  assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), currentUrl.searchParams.get('code_challenge'));
  assert.equal(body.get('redirect_uri'), currentUrl.searchParams.get('redirect_uri'));
  assert.equal(body.get('client_id'), 'oaiapp_recovery');
  assert.equal(body.get('resource'), 'https://api.openai.com/v1');
  if (++exchanges === 1) return Response.json({ error: 'invalid_grant' }, { status: 400 });
  assert.notEqual(currentUrl.searchParams.get('code_challenge'), previousChallenge);
  const id = await new SignJWT({ sub: 'recovered-user', nonce: currentUrl.searchParams.get('nonce') }).setProtectedHeader({ alg: 'RS256', kid: 'recovery' }).setIssuer('https://auth.openai.com').setAudience('oaiapp_recovery').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  return Response.json({ ...token, id_token: id });
 };
 const auth = new OpenAIAuth({ store, fetch: fetcher, verifier: new IdentityVerifier(fetcher) });
 const open = async value => {
  currentUrl = new URL(value); urls.push(currentUrl);
  const callback = new URL(currentUrl.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', currentUrl.searchParams.get('state'));
  callback.searchParams.set('code', 'single-use-' + urls.length);
  if (urls.length === 1) callback.searchParams.set('client_id', 'oaiapp_recovery');
  await fetch(callback);
 };
 let login = new OpenAILogin({ auth, models: { clear() {} }, open });
 await login.login(); if (login.attempt) await login.attempt.done;
 assert.equal(exchanges, 1); assert.match(login.status(), /Authorization code rejected/);
 assert.equal(auth.status().configured, false);
 assert.deepEqual(store.read().accounts, initial.accounts);
 assert.equal(store.read().active, initial.active);
 assert.deepEqual(store.read().pendingRegistration, { clientId: 'oaiapp_recovery', revision: initial.revision });
 assert(!JSON.stringify(store.read()).includes('single-use'));
 previousChallenge = currentUrl.searchParams.get('code_challenge');
 login.dispose(); login = new OpenAILogin({ auth, models: { clear() {} }, open });
 await login.login(); if (login.attempt) await login.attempt.done;
 assert.equal(exchanges, 2);
 assert.equal(urls[1].searchParams.get('client_id'), 'oaiapp_recovery');
 assert.equal(urls[1].searchParams.get('ext_agent_host_id'), urls[0].searchParams.get('ext_agent_host_id'));
 assert.notEqual(urls[1].searchParams.get('state'), urls[0].searchParams.get('state'));
 assert.equal(auth.status().configured, true); assert.equal(store.read().pendingRegistration, undefined);
 assert.match(login.status(), /ChatGPT sign-in completed/); login.dispose();
});

test('concurrent login commands open one attempt and account switches discard stale retry hints', async t => {
 const store = await stored(t); const auth = makeAuth(store); let callbacks = 0, opens = 0;
 let finishInit; const initialize = store.initialize.bind(store);
 store.initialize = async () => { await new Promise(resolve => { finishInit = resolve; }); return initialize(); };
 const login = new OpenAILogin({ auth, models: { clear() {} }, open: async () => { opens++; }, callback: async () => { callbacks++; return { url: 'https://auth.openai.com', result: new Promise(() => {}), close() {} }; } });
 const first = login.login(); await login.login(); finishInit(); await first;
 assert.equal(callbacks, 1); assert.equal(opens, 1); login.dispose();
 const tx = transaction(store.read());
 await auth.rememberRegistration('oaiapp_pending', tx);
 assert(store.read().pendingRegistration);
 await auth.select('api-key'); assert.equal(store.read().pendingRegistration, undefined);
 await auth.rememberRegistration('oaiapp_stale', tx); assert.equal(store.read().pendingRegistration, undefined);
 assert.equal(auth.status().mode, 'api-key');
});

test('headerless HTTP SSE completes normally, while truncated and explicitly non-SSE bodies commit no tools', async t => {
 let responseKind = 'complete';
 const server = createServer((_req, res) => {
  if (responseKind === 'json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(done([call]))); return; }
  res.writeHead(200, responseKind === 'mixed-case' ? { 'content-type': 'Text/Event-Stream; Charset=UTF-8' } : {});
  res.end('event: response.output_item.done\ndata: ' + JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: call }) + '\n\n'
   + (responseKind === 'truncated' ? '' : 'event: response.completed\ndata: ' + JSON.stringify(done([call])) + '\n\n'));
 });
 server.listen(0, '127.0.0.1'); await once(server, 'listening');
 t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
 const route = adapter(async (_url, init) => {
  assert.equal(JSON.parse(init.body).stream, true);
  const response = await fetch(`http://127.0.0.1:${server.address().port}`, init);
  if (responseKind === 'complete' || responseKind === 'truncated') assert.equal(response.headers.get('content-type'), null);
  return response;
 });
 route.config.options = () => ({ headerTimeoutMs: 2000, streamIdleTimeoutMs: 2000 });
 const chunks = await collect(route.stream(options()));
 assert(chunks.some(c => c.type === 'block-end' && c.block.type === 'tool-call'));
 assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
 responseKind = 'mixed-case'; assert.equal((await collect(route.stream(options()))).at(-1).reason.kind, 'tool-calls');
 for (const kind of ['truncated', 'json']) {
  responseKind = kind; const observed = [];
  await assert.rejects((async () => { for await (const c of route.stream(options())) observed.push(c); })(), error => kind === 'truncated'
   ? error.code === 'TRANSPORT' : error.code === 'MALFORMED_RESPONSE' && /HTTP 200; application\/json/.test(error.message));
  assert(!observed.some(c => c.type === 'block-end' || c.type === 'finish'));
 }
});

test('empty terminal output uses completed items for text, tools and encrypted replay only after completion', async () => {
 const reasoning = { type: 'reasoning', id: 'rs_direct', summary: [], encrypted_content: 'opaque-direct' };
 const items = [reasoning, message('OK'), call];
 const packets = [
  { type: 'response.output_text.delta', output_index: 1, delta: 'OK' },
  ...items.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })),
 ];
 const chunks = await collect(stream([...packets, done([])]));
 assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
 assert.deepEqual(chunks.at(-1).replayState.response.items, items);
 assert.equal(chunks.filter(c => c.type === 'block-end' && c.block.type === 'tool-call').length, 1);
 assert.equal(chunks.find(c => c.type === 'block-end' && c.block.type === 'text').block.text, 'OK');
 for (const tail of [[], [{ type: 'response.incomplete', response: { output: [] } }], [{ type: 'response.failed', response: { error: { code: 'failed' } } }]]) {
  const observed = [];
  await assert.rejects((async () => { for await (const c of stream([...packets, ...tail])) observed.push(c); })());
  assert(!observed.some(c => c.type === 'block-end' || c.type === 'finish'));
 }
 for (const packet of [
  { type: 'response.output_item.done', output_index: 1, item: call },
  { type: 'response.output_item.done', output_index: 0, item: { ...call, status: 'in_progress' } },
  { type: 'response.output_item.done', output_index: 0, item: { ...call, arguments: '{' } },
 ]) {
  const observed = [];
  await assert.rejects((async () => { for await (const c of stream([packet, done([])])) observed.push(c); })());
  assert(!observed.some(c => c.type === 'block-end' || c.type === 'finish'));
 }
});
