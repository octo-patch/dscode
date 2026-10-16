// Fill a session on a fixture Host with many turns, for testing the desktop
// client on a long transcript. Turns cycle through a medium Markdown reply, a
// tool call and a short reply. Prints FILLED_SESSION <id> when done.
//
//   node clients/desktop/scripts/fill-session.mjs --socket SOCKET [--turns 300] [--kb 2] [--cwd DIR]
import { call, callDscode, openStream } from '../../../plugins/local-carrier/client.mjs';

const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const socket = option('socket');
if (!socket) { console.error('fill-session: --socket is required'); process.exit(2); }
const turns = Number(option('turns', 300));
const kb = Number(option('kb', 2));
const cwd = option('cwd', (await callDscode(socket, 'host/status', {})).defaultCwd ?? process.cwd());

const value = result => { if (result?.ok !== true) throw Error(JSON.stringify(result)); return result.value; };
const { sessionId } = value(await call(socket, 'session/create', { request: { cwd, agentPreset: 'dscode' } }));
value(await call(socket, 'session/selectModel', { request: { sessionId, provider: 'fixture', model: 'fixture' } }));

const controller = new AbortController();
let ended = 0;
void (async () => {
  const args = { request: { address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 1 } };
  for await (const frame of openStream(socket, 'session/follow', { args }, controller.signal)) {
    if (frame.type === 'event' && frame.event.type === 'turn/end') ended++;
  }
})().catch(() => {});

const prompts = [`LONG ${kb} FAST turn`, 'TOOL turn', 'hello turn'];
for (let turn = 0; turn < turns; turn++) {
  const text = `${prompts[turn % prompts.length]} ${turn + 1}`;
  await callDscode(socket, 'session/deliver', { sessionId, mode: 'followup', content: [{ type: 'text', text }] });
  const deadline = Date.now() + 60_000;
  while (ended <= turn) {
    if (Date.now() > deadline) throw Error(`turn ${turn + 1} did not end`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if ((turn + 1) % 50 === 0) console.error(`fill-session: ${turn + 1}/${turns}`);
}
controller.abort();
console.log(`FILLED_SESSION ${sessionId}`);
process.exit(0);
