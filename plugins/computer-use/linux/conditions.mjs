export function validateCondition(condition) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) throw Error('A postcondition is required.');
  const strings = ['name', 'role', 'value', 'contains'];
  const booleans = ['exists', 'enabled', 'focused'];
  for (const [key, value] of Object.entries(condition)) {
    if (strings.includes(key) ? typeof value !== 'string' || (key !== 'value' && !value.length) || value.length > 512 : booleans.includes(key) ? typeof value !== 'boolean' : true) throw Error(`Invalid postcondition field: ${key}`);
  }
  if (!condition.name && !condition.role) throw Error('Postcondition needs an exact element name or role.');
  return condition;
}

export function checkCondition(observation, condition) {
  validateCondition(condition);
  const candidates = observation.elements.filter(row => (!condition.name || row.title === condition.name || row.label === condition.name)
    && (!condition.role || row.role === condition.role));
  if (condition.exists === false) return { matched: !observation.tree.truncated && candidates.length === 0,
    reason: observation.tree.truncated ? 'absence-unproven-truncated' : candidates.length ? 'still-present' : 'absent' };
  const matches = candidates.filter(row => (condition.value === undefined || row.value === condition.value)
    && (condition.contains === undefined || (row.value ?? '').includes(condition.contains))
    && (condition.enabled === undefined || row.enabled === condition.enabled)
    && (condition.focused === undefined || row.focused === condition.focused));
  return { matched: matches.length > 0, reason: matches.length ? 'condition-met' : 'condition-not-met', matches: matches.map(row => row.index) };
}

export const conditionSchema = { type: 'object', additionalProperties: false, properties: {
  name: { type: 'string' }, role: { type: 'string' }, value: { type: 'string' }, contains: { type: 'string' },
  exists: { type: 'boolean' }, enabled: { type: 'boolean' }, focused: { type: 'boolean' },
} };
export const scopeSchema = { type: 'object', additionalProperties: false, properties: {
  name: { type: 'string' }, role: { type: 'string' }, exact: { type: 'boolean' }, windowTitle: { type: 'string' },
  rootObservationId: { type: 'string' }, rootElementIndex: { type: 'integer' },
  limit: { type: 'integer', description: 'Maximum returned elements, 1–500.' }, maxDepth: { type: 'integer', description: 'Depth relative to the selected root, 0–32.' },
  maxScanNodes: { type: 'integer', description: 'Maximum scanned nodes, 10–5000.' },
  streamId: { type: 'string' },
} };

export function validateScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw Error('Scope must be an object.');
  for (const [key, value] of Object.entries(scope)) {
    if (!Object.hasOwn(scopeSchema.properties, key)) throw Error(`Unknown scope field: ${key}`);
    const type = scopeSchema.properties[key].type;
    if (type === 'integer' ? !Number.isInteger(value) : typeof value !== type) throw Error(`Invalid scope field: ${key}`);
    if (type === 'string' && (!value.length || value.length > 512)) throw Error(`Invalid scope text: ${key}`);
  }
  for (const [key, min, max] of [['limit', 1, 500], ['maxDepth', 0, 32], ['maxScanNodes', 10, 5000], ['rootElementIndex', 0, 5000]]) {
    if (scope[key] !== undefined && (scope[key] < min || scope[key] > max)) throw Error(`${key} must be between ${min} and ${max}.`);
  }
  return scope;
}
