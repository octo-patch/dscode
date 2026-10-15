// Drives a real headless Harness from a separate process through the local
// carrier, using only upstream Typert methods: create a session, select a
// model, prompt, receive per-token assistant frames, and answer an approval.
// The model is a local deterministic fixture; no paid requests are made.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { root, provision, environment, dshEntry } from './harness.mjs';
import { call, openStream } from '../plugins/local-carrier/client.mjs';

const home = mkdtempSync(join(tmpdir(), 'dscode-carrier-'));
const workspace = join(home, 'workspace'); mkdirSync(workspace);
const socketPath = join(home, 'run', 'host.sock');
// Outside every writable root (temp directories are writable), so the write needs approval; it is rejected.
const outside = join(homedir(), `.dscode-carrier-probe-${randomUUID()}`);
const log = (...args) => process.env.VERBOSE && console.error('[carrier]', ...args);
const until = async (label, predicate, ms = 20000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(r => setTimeout(r, 50)); }
  throw Error(`timed out waiting for ${label}`);
};
const value = result => { assert.equal(result?.ok, true, JSON.stringify(result)); return result.value; };

let host, output = '';
const controller = new AbortController();
try {
  provision(home);
  const patch = join(home, 'carrier.patch.yml');
  writeFileSync(patch, [
    '- id: tui-startup\n  disabled: true', '- id: tui-runner\n  disabled: true',
    '- id: dscode-session-cards\n  config:\n    enabled: false', '- id: dscode-memory\n  config:\n    generate: false',
    '- id: permission\n  config:\n    defaultPreset: workspace-write',
    `- insert:\n    - id: api-remotes\n      name: '@deepseek-ai/dsh-api-remotes'\n    - id: fixture-model\n      name: ${JSON.stringify(join(root, 'scripts/fixture-model.mjs'))}\n    - id: local-carrier\n      name: ${JSON.stringify(join(root, 'plugins/local-carrier/index.mjs'))}\n      config:\n        socketPath: ${JSON.stringify(socketPath)}`,
  ].join('\n') + '\n');
  host = spawn(process.execPath, [dshEntry, '--profile', 'tui', '--patch', patch], {
    cwd: workspace, env: { ...environment(home, workspace), DSCODE_MEMORY_HOME: join(home, 'memories'), FIXTURE_OUTSIDE_PATH: outside }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  host.stdout.on('data', b => { output += b; }); host.stderr.on('data', b => { output += b; });
  const exited = new Promise(resolve => host.once('exit', resolve));
  await Promise.race([until('host socket', () => existsSync(socketPath), 60000), exited.then(code => { throw Error(`host exited ${code}`); })]);

  // Forwarded host events: approvals arrive here as Agent-scoped waterfalls.
  const events = [];
  (async () => {
    for await (const frame of openStream(socketPath, '$events', { args: {} }, controller.signal)) { log('event', JSON.stringify(frame).slice(0, 300)); events.push(frame); }
  })().catch(error => { if (!controller.signal.aborted) events.push({ failed: error.message }); });
  const ready = await until('$events ready', () => {
    const failed = events.find(e => e.failed); if (failed) throw Error(`$events failed: ${failed.failed}`);
    return events.find(e => e.type === 'ready');
  });

  const { sessionId } = value(await call(socketPath, 'session/create', { request: { cwd: workspace, agentPreset: 'dscode' } }));
  value(await call(socketPath, 'session/selectModel', { request: { sessionId, provider: 'fixture', model: 'fixture' } }));

  const frames = [];
  (async () => {
    for await (const frame of openStream(socketPath, 'session/follow', { args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } } }, controller.signal)) { log('follow', JSON.stringify(frame).slice(0, 300)); frames.push(frame); }
  })().catch(error => { if (!controller.signal.aborted) frames.push({ failed: error.message }); });
  await until('follow snapshot', () => frames.length > 0);

  value(await call(socketPath, 'session/prompt', { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: 'hello' }] } }));
  await until('assistant message', () => JSON.stringify(frames).includes('Streaming through the fixture works.'));

  value(await call(socketPath, 'session/prompt', { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: 'APPROVE writing a file' }] } }));
  const approval = await until('approval request', () => events.find(e => e.type === 'waterfall' && e.event === 'approval/request'));
  log('approval frame', JSON.stringify(approval));
  assert.equal(approval.request.toolName, 'write');
  const decided = await call(socketPath, '$events/result', { clientId: ready.clientId, eventId: approval.eventId, outcome: { kind: 'result', value: 'rejected' } });
  log('decision', JSON.stringify(decided));
  value(decided);
  await until('rejected tool result', () => frames.some(f => f.event?.type === 'tool/result' && f.event.data?.message?.toolCallId === 'call-write' && f.event.seq > 0 && JSON.stringify(f).includes('reject')));
  await until('second turn end', () => frames.filter(f => f.event?.type === 'turn/end').length >= 2);
  assert(!existsSync(outside), 'a rejected write must not create the file');
  const deltas = frames.filter(f => f.type === 'assistant-stream' && f.frame?.chunk?.type === 'text-delta');
  assert(deltas.length > 3, 'assistant text arrives as several live deltas');
  const report = { sessionId, ready: true, liveTextDeltas: deltas.length, approval: { toolName: approval.request.toolName, fields: Object.keys(approval.request) }, rejectedWriteCreatedNoFile: true };
  console.log('LOCAL_CARRIER_VERIFIED ' + JSON.stringify(report));
} catch (error) {
  console.error(output.slice(-4000));
  throw error;
} finally {
  controller.abort();
  host?.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 500));
  if (!process.env.KEEP) rmSync(home, { recursive: true, force: true });
  void readFileSync;
}
