import test from 'node:test';
import assert from 'node:assert/strict';
import { breakingChanges } from '../scripts/protocol-compat.mjs';

/** One method `op` with the given argument and result definitions. */
const schema = (args, result, extra = {}) => ({
  'x-dscode-methods': { op: { args: 'Args', result: 'Result' } },
  definitions: { Args: args, Result: result, ...extra },
});
const object = (properties, required = []) => ({ type: 'object', properties, required });
const str = { type: 'string' };

test('an identical schema has no breaking changes', () => {
  const s = schema(object({ id: str }, ['id']), object({ name: str }, ['name']));
  assert.deepEqual(breakingChanges(s, s), []);
});

test('additive changes are not breaking', () => {
  const before = schema(object({ id: str }, ['id']), object({ name: str }, ['name']));
  const after = schema(object({ id: str, hint: str }, ['id']), object({ name: str, extra: str }, ['name', 'extra']));
  after['x-dscode-methods'].added = { args: 'Args', result: 'Result' };
  assert.deepEqual(breakingChanges(before, after), []);
});

test('removing an operation or a result field a client relied on is breaking', () => {
  const before = schema(object({}), object({ name: str, size: { type: 'number' } }, ['name', 'size']));
  const after = schema(object({}), object({ name: str }, ['name']));
  assert.deepEqual(breakingChanges(before, after), ['x-dscode-methods op.result (receive).size: required, but no longer always present']);
  assert.deepEqual(breakingChanges(before, { 'x-dscode-methods': {}, definitions: {} }), ['x-dscode-methods op: removed']);
});

test('a newly required argument is breaking; a newly optional one is not', () => {
  const before = schema(object({ id: str }, ['id']), str);
  assert.deepEqual(breakingChanges(before, schema(object({ id: str, mode: str }, ['id', 'mode']), str)), ['x-dscode-methods op.args (send).mode: required, but no longer always present']);
  assert.deepEqual(breakingChanges(before, schema(object({ id: str }), str)), []);
});

test('a new value in a received enum is breaking; in a sent enum it is not', () => {
  const before = schema({ enum: ['a', 'b'] }, { enum: ['x'] });
  assert.deepEqual(breakingChanges(before, schema({ enum: ['a', 'b', 'c'] }, { enum: ['x'] })), []);
  assert.deepEqual(breakingChanges(before, schema({ enum: ['a', 'b'] }, { enum: ['x', 'y'] })), ['x-dscode-methods op.result (receive): value "y" is new']);
  assert.deepEqual(breakingChanges(before, schema({ enum: ['a'] }, { enum: ['x'] })), ['x-dscode-methods op.args (send): value "b" is new']);
});

test('a type change is breaking; widening what is sent is not', () => {
  const before = schema(object({ n: { type: 'number' } }, ['n']), object({ n: { type: 'number' } }, ['n']));
  const after = schema(object({ n: { type: ['number', 'string'] } }, ['n']), object({ n: str }, ['n']));
  assert.deepEqual(breakingChanges(before, after), ['x-dscode-methods op.result (receive).n: type string is no longer allowed']);
});

test('a new member of a received union must fit an existing member', () => {
  const tagged = tag => object({ type: { const: tag, type: 'string' } }, ['type']);
  const open = { type: 'object', properties: { type: str }, required: ['type'], additionalProperties: true };
  const closed = schema(object({}), { anyOf: [tagged('a')] });
  assert.equal(breakingChanges(closed, schema(object({}), { anyOf: [tagged('a'), tagged('b')] })).length, 1);
  // An open union already admits a new tag through its "other" member.
  const before = schema(object({}), { oneOf: [{ anyOf: [tagged('a')] }, open] });
  assert.deepEqual(breakingChanges(before, schema(object({}), { oneOf: [{ anyOf: [tagged('a'), tagged('b')] }, open] })), []);
});

test('recursive definitions terminate', () => {
  const node = { type: 'object', properties: { children: { type: 'array', items: { $ref: '#/definitions/Node' } } } };
  const s = schema(object({}), { $ref: '#/definitions/Node' }, { Node: node });
  assert.deepEqual(breakingChanges(s, s), []);
});
