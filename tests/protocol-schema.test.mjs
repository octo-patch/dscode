import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OUTPUT, buildSchema, render, versionProblems } from '../scripts/protocol-schema.mjs';
import { PROTOCOL } from '../plugins/local-carrier/protocol.mjs';

const schema = buildSchema();
const definitions = schema.definitions;

test('the committed protocol schema matches the TypeScript wire contract', () => {
  assert.equal(readFileSync(OUTPUT, 'utf8'), render(schema), `${OUTPUT} is stale; run node scripts/protocol-schema.mjs`);
});

test('the protocol version is recorded and keeps clients of its major baseline working', () => {
  assert.deepEqual(schema['x-protocol-version'], { ...PROTOCOL });
  assert.deepEqual(versionProblems(schema), []);
});

test('every operation names definitions that exist', () => {
  for (const table of ['x-dscode-methods', 'x-dscode-streams', 'x-typert-methods', 'x-typert-streams', 'x-typert-waterfalls']) {
    for (const [name, operation] of Object.entries(schema[table])) {
      for (const part of ['args', 'result', 'item', 'uplink', 'request', 'value']) {
        if (operation[part] === undefined) continue;
        assert.ok(definitions[operation[part]], `${table} ${name}.${part} → ${operation[part]}`);
      }
    }
  }
  assert.equal(schema['x-dscode-streams']['authorization/begin'].uplink, 'AuthorizationUplinkItem');
});

test('branded upstream ids are their wire primitive, not their constructor', () => {
  assert.deepEqual(definitions.DshAgentModelSelection.properties.reasoningEffort.type, 'string');
  assert.ok(!JSON.stringify(schema).includes('namedArgs'));
  assert.ok(!JSON.stringify(schema).includes('global.'), 'runtime-only types are replaced by their JSON form');
});

test('session events include the members upstream packages merge in, and stay open', () => {
  const kinds = definitions.SessionEventKnown.anyOf.map(member => member.properties.type.const);
  for (const kind of ['turn/start', 'tool/call', 'approval/asked', 'permission/preset', 'session/title', 'agent/inbox/spliced']) assert.ok(kinds.includes(kind), kind);
  assert.equal(new Set(kinds).size, kinds.length);
  // Exactly one applies: a known member, or an object whose discriminator is not a known value.
  assert.deepEqual(definitions.SessionEvent.oneOf[0], { $ref: '#/definitions/SessionEventKnown' });
  assert.deepEqual(definitions.SessionEvent.oneOf[1].required, ['type']);
  assert.ok(definitions.SessionEvent.oneOf[1].properties.type.not.enum.includes('approval/asked'));
  assert.deepEqual(definitions.MessageSource.oneOf[1].required, ['kind']);
  // Each event's data is a named definition, so generated types cannot merge them.
  assert.deepEqual(definitions.SessionEventKnown.anyOf.find(m => m.properties.type.const === 'permission/preset').properties.data, { $ref: '#/definitions/PermissionPresetEventData' });
});

test('a type name declared by two modules is qualified by package', () => {
  assert.ok(definitions.DshAgentModelSelection && definitions.DshApiSessionControllerModelSelection);
  assert.equal(definitions.ModelSelection, undefined);
});

test('the Typert session core and the answered waterfalls are in the contract', () => {
  assert.equal(schema['x-typert-methods']['session/create'].result, 'SessionCreateValue');
  assert.equal(schema['x-typert-streams']['session/follow'].item, 'SessionFollowFrame');
  assert.equal(schema['x-typert-waterfalls']['approval/request'].request, 'ApprovalRequestPayload');
  // The gateway strips the live agent and signal; neither is on the wire.
  assert.deepEqual(Object.keys(definitions.ApprovalRequestPayload.properties).sort(), ['callId', 'displayReason', 'reason', 'toolName']);
  // Inline members of a mixed union are named after their tag.
  assert.deepEqual(definitions.SessionFollowFrame.anyOf.map(member => member.title ?? member.$ref), ['SessionFollowFrameSnapshot', '#/definitions/SessionEventEntry', 'SessionFollowFrameAssistantStream']);
});

test('a union that says no more than its bare member collapses to it', () => {
  assert.deepEqual(definitions.SessionSeqCursor.type, 'number');
  assert.equal(definitions.SessionSeqCursor.anyOf, undefined);
});
