// Breaking changes between two versions of protocol/dscode-runtime.schema.json:
// what a client built against `previous` could no longer do against `next`.
//
// Direction matters. What a client sends (arguments, uplink items, waterfall
// answers) must still be accepted, so `next` has to accept every value
// `previous` accepted. What a client receives (results, stream items,
// waterfall payloads) must still be readable, so every value `next` may send
// has to be one `previous` described. The check is conservative: it reports
// what it cannot prove compatible, and the cure is a major version bump.

const TABLES = {
  'x-dscode-methods': { args: 'send', result: 'receive' },
  'x-dscode-streams': { args: 'send', item: 'receive', uplink: 'send' },
  'x-typert-methods': { args: 'send', result: 'receive' },
  'x-typert-streams': { args: 'send', item: 'receive' },
  'x-typert-waterfalls': { request: 'receive', value: 'send' },
};
const ANNOTATIONS = new Set(['description', 'title', '$comment', 'markdownDescription', 'examples', 'default', 'deprecated']);

/** @returns sentences naming each change a client of `previous` could break on. */
export function breakingChanges(previous, next) {
  const problems = [];
  for (const [table, parts] of Object.entries(TABLES)) {
    for (const [name, operation] of Object.entries(previous[table] ?? {})) {
      const current = next[table]?.[name];
      if (current === undefined) { problems.push(`${table} ${name}: removed`); continue; }
      for (const [part, direction] of Object.entries(parts)) {
        if (operation[part] === undefined) continue;
        if (current[part] === undefined) { problems.push(`${table} ${name}.${part}: removed`); continue; }
        const oldSchema = { $ref: `#/definitions/${operation[part]}` };
        const newSchema = { $ref: `#/definitions/${current[part]}` };
        const found = direction === 'send'
          ? new Checker(next, previous).covers(newSchema, oldSchema)
          : new Checker(previous, next).covers(oldSchema, newSchema);
        for (const problem of found) problems.push(`${table} ${name}.${part} (${direction})${problem}`);
      }
    }
  }
  return problems;
}

/** Whether every value `narrow` admits is admitted by `wide`; definitions resolve in their own schema. */
class Checker {
  constructor(wideRoot, narrowRoot) {
    this.wideRoot = wideRoot;
    this.narrowRoot = narrowRoot;
    this.memo = new Map();
  }

  resolve(root, schema) {
    let seen = 0;
    while (schema?.$ref !== undefined && seen++ < 50) {
      const { $ref, ...rest } = schema;
      const target = root.definitions?.[decodeURIComponent($ref.replace('#/definitions/', ''))] ?? {};
      schema = Object.keys(rest).some(key => !ANNOTATIONS.has(key)) ? { ...target, ...rest } : target;
    }
    return schema ?? {};
  }

  /** @returns problems, each prefixed by the path where it occurs. */
  covers(wide, narrow, path = '') {
    const key = `${JSON.stringify(wide)}\u0000${JSON.stringify(narrow)}`;
    if (this.memo.has(key)) return this.memo.get(key).map(problem => path + problem);
    this.memo.set(key, []); // a cycle is assumed compatible while it is being checked
    const found = this.compare(this.resolve(this.wideRoot, wide), this.resolve(this.narrowRoot, narrow));
    this.memo.set(key, found);
    return found.map(problem => path + problem);
  }

  compare(wide, narrow) {
    if (wide === true || isUnconstrained(wide)) return [];
    if (narrow === true || isUnconstrained(narrow)) return [': was any value, is now constrained'];
    // Every alternative the narrow side allows must be covered.
    const narrowMembers = narrow.anyOf ?? narrow.oneOf;
    if (narrowMembers !== undefined) {
      const { anyOf, oneOf, ...shared } = narrow;
      void anyOf; void oneOf;
      return narrowMembers.flatMap((member, index) => this.covers(wide, merge(shared, member), `[alternative ${index}]`));
    }
    // One alternative of the wide side has to cover the narrow value.
    const wideMembers = wide.anyOf ?? wide.oneOf;
    if (wideMembers !== undefined) {
      const { anyOf, oneOf, ...shared } = wide;
      void anyOf; void oneOf;
      const attempts = wideMembers.map(member => this.covers(merge(shared, member), narrow));
      if (attempts.some(attempt => attempt.length === 0)) return [];
      return [`: matches no alternative (${shortest(attempts)})`];
    }
    const problems = [];
    const wideTypes = types(wide);
    const narrowTypes = types(narrow);
    if (wideTypes !== undefined) {
      if (narrowTypes === undefined) problems.push(`: type was unconstrained, is now ${wideTypes.join('|')}`);
      else for (const type of narrowTypes) if (!wideTypes.includes(type) && !(type === 'integer' && wideTypes.includes('number'))) problems.push(`: type ${type} is no longer allowed`);
    }
    const wideValues = values(wide);
    if (wideValues !== undefined) {
      const narrowValues = values(narrow);
      if (narrowValues === undefined) problems.push(`: was one of ${wideValues.map(v => JSON.stringify(v)).join(', ')}, is now open`);
      else for (const value of narrowValues) if (!wideValues.some(allowed => JSON.stringify(allowed) === JSON.stringify(value))) problems.push(`: value ${JSON.stringify(value)} is new`);
    }
    if ((narrowTypes ?? []).includes('object') || narrow.properties !== undefined) {
      const narrowRequired = new Set(narrow.required ?? []);
      for (const field of wide.required ?? []) if (!narrowRequired.has(field)) problems.push(`.${field}: required, but no longer always present`);
      for (const [field, schema] of Object.entries(wide.properties ?? {})) {
        if (narrow.properties?.[field] !== undefined) problems.push(...this.covers(schema, narrow.properties[field], `.${field}`));
      }
      if (wide.additionalProperties === false) {
        for (const field of Object.keys(narrow.properties ?? {})) if (wide.properties?.[field] === undefined) problems.push(`.${field}: not allowed before`);
      }
    }
    if (wide.items !== undefined && narrow.items !== undefined && !Array.isArray(wide.items) && !Array.isArray(narrow.items)) {
      problems.push(...this.covers(wide.items, narrow.items, '[]'));
    }
    return problems;
  }
}

const isUnconstrained = schema => Object.keys(schema).every(key => ANNOTATIONS.has(key));
const types = schema => schema.type === undefined ? (schema.const !== undefined || schema.enum !== undefined ? valueTypes(values(schema)) : undefined) : [schema.type].flat();
const values = schema => schema.const !== undefined ? [schema.const] : schema.enum;
const valueTypes = list => [...new Set(list.map(value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' ? 'number' : typeof value))];
const merge = (shared, member) => Object.keys(shared).some(key => !ANNOTATIONS.has(key)) ? { ...shared, ...member } : member;
const shortest = attempts => attempts.reduce((best, attempt) => attempt.length < best.length ? attempt : best)[0] ?? 'no detail';
