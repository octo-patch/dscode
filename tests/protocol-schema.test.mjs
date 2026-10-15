import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OUTPUT, buildSchema, render } from '../scripts/protocol-schema.mjs';

const schema = buildSchema();
const definitions = schema.definitions;

test('the committed protocol schema matches the TypeScript wire contract', () => {
  assert.equal(readFileSync(OUTPUT, 'utf8'), render(schema), `${OUTPUT} is stale; run node scripts/protocol-schema.mjs`);
});

test('every operation names definitions that exist', () => {
  for (const table of ['x-dscode-methods', 'x-dscode-streams']) {
    for (const [name, operation] of Object.entries(schema[table])) {
      for (const part of ['args', 'result', 'item', 'uplink']) {
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
  assert.deepEqual(definitions.SessionEvent.anyOf[0], { $ref: '#/definitions/SessionEventKnown' });
  assert.deepEqual(definitions.SessionEvent.anyOf[1].required, ['type']);
  assert.deepEqual(definitions.MessageSource.anyOf[1].required, ['kind']);
  // Each event's data is a named definition, so generated types cannot merge them.
  assert.deepEqual(definitions.SessionEventKnown.anyOf.find(m => m.properties.type.const === 'permission/preset').properties.data, { $ref: '#/definitions/PermissionPresetEventData' });
});

test('a type name declared by two modules is qualified by package', () => {
  assert.ok(definitions.DshAgentModelSelection && definitions.DshApiSessionControllerModelSelection);
  assert.equal(definitions.ModelSelection, undefined);
});
