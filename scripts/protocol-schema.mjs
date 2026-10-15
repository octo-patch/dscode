import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
  DEFAULT_CONFIG, ExposeNodeParser, InterfaceAndClassNodeParser, NumberType, SchemaGenerator, StringType, UnknownType,
  createFormatter, createParser, symbolAtNode,
} from 'ts-json-schema-generator';
import { PROTOCOL, formatProtocol } from '../plugins/local-carrier/protocol.mjs';
import { breakingChanges } from './protocol-compat.mjs';

// The DSCODE operations' wire contract lives in TypeScript
// (packages/tui/src/host/protocol.ts), where the Host registry is checked
// against it. This script turns that table into JSON Schema for clients written
// in other languages; the Rust desktop client generates its types from the
// output. Run it after changing the table and commit the result:
//
//   node scripts/protocol-schema.mjs           # write protocol/dscode-runtime.schema.json
//   node scripts/protocol-schema.mjs --record  # also record the protocol version (after a bump)
//   node scripts/protocol-schema.mjs --check   # exit 1 when the files or the version are out of date
//
// The schema carries the protocol version (plugins/local-carrier/protocol.mjs).
// protocol/versions.json records each version's schema fingerprint, so any
// change to the contract needs a version bump; protocol/baseline.schema.json is
// the first schema of the current major, and a later schema of the same major
// must not break a client of it (scripts/protocol-compat.mjs).
//
// Every operation gets named definitions, `<Operation>Args` and
// `<Operation>Result` (methods) or `<Operation>Item` (streams), unless its
// schema already is a named definition; `x-dscode-methods` and
// `x-dscode-streams` map each wire name to those definition names.

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const SOURCE = 'packages/tui/src/host/protocol.ts';
export const OUTPUT = 'protocol/dscode-runtime.schema.json';
export const VERSIONS = 'protocol/versions.json';
export const BASELINE = 'protocol/baseline.schema.json';

/** `models/compactionPreview` → `ModelsCompactionPreview`; `$events/result` → `EventsResult`. */
const pascal = name => name.split(/[^A-Za-z0-9]+/).filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join('');

/** Stable output: object keys sorted, array order kept. */
const sortKeys = value => Array.isArray(value)
  ? value.map(sortKeys)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]))
    : value;

// Upstream ids are brands, `Branded<'X'>` (a string on the wire) or
// `BrandedNumber<'X'>`, and each shares its name with a constructor function.
// The generator resolves such a name to the function, so this parser claims
// every reference to a brand first and emits the wire primitive.
class BrandNodeParser {
  constructor(checker) { this.checker = checker; }

  brandOf(node) {
    if (node.kind !== ts.SyntaxKind.TypeReference) return undefined;
    return brandOfSymbol(this.checker, this.checker.getSymbolAtLocation(node.typeName));
  }

  supportsNode(node) { return this.brandOf(node) !== undefined; }

  createType(node) { return brandType(this.brandOf(node)); }
}

const BRANDS = { Branded: 'string', BrandedNumber: 'number' };
const brandType = primitive => primitive === 'number' ? new NumberType() : new StringType();

/** `'string'` or `'number'` when the symbol names a brand, else undefined. */
function brandOfSymbol(checker, symbol) {
  if (symbol === undefined) return undefined;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  if (BRANDS[symbol.name]) return BRANDS[symbol.name];
  const alias = symbol.declarations?.find(ts.isTypeAliasDeclaration);
  if (alias === undefined || !ts.isTypeReferenceNode(alias.type)) return undefined;
  return BRANDS[alias.type.typeName.getText()];
}

// Declaration files refer to types as `import('pkg').Name`, which the
// generator does not parse; resolve the name and parse its declaration.
class ImportTypeNodeParser {
  constructor(checker, chain) { this.checker = checker; this.chain = chain; }

  supportsNode(node) { return ts.isImportTypeNode(node); }

  createType(node, context) {
    const qualifier = node.qualifier && (ts.isIdentifier(node.qualifier) ? node.qualifier : node.qualifier.right);
    const symbol = qualifier === undefined ? undefined : this.checker.getSymbolAtLocation(qualifier);
    const brand = brandOfSymbol(this.checker, symbol);
    if (brand !== undefined) return brandType(brand);
    const resolved = symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
    const declaration = resolved?.declarations?.find(d => ts.isTypeAliasDeclaration(d) || ts.isInterfaceDeclaration(d) || ts.isEnumDeclaration(d) || ts.isClassDeclaration(d));
    return declaration === undefined ? new UnknownType() : this.chain.createType(declaration, context);
  }
}

// Runtime objects that ride inside upstream types but have no JSON form: the
// wire carries what JSON.stringify makes of them.
const NON_JSON = {
  'global.AbortSignal': ['AbortSignalWire', { type: 'object', description: 'An AbortSignal on the Host; it serializes as an empty object and carries nothing.' }],
};

function replaceNonJson(definitions) {
  for (const [name, [replacement, schema]] of Object.entries(NON_JSON)) {
    if (!(name in definitions)) continue;
    delete definitions[name];
    definitions[replacement] = schema;
  }
  const refs = Object.fromEntries(Object.entries(NON_JSON).map(([name, [replacement]]) => [`#/definitions/${name}`, `#/definitions/${replacement}`]));
  const rewrite = value => Array.isArray(value) ? value.map(rewrite)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, key === '$ref' && refs[inner] ? refs[inner] : rewrite(inner)]))
      : value;
  for (const name of Object.keys(definitions)) definitions[name] = rewrite(definitions[name]);
}

// Upstream event and message-source unions are merge-extensible: packages add
// members to `SessionEventMap` and `MessageSourceMap` by declaration merging.
// A program rooted at the contract alone sees only the base members, so every
// upstream declaration file that extends either map becomes a root too.
const EXTENSIBLE = /\binterface (SessionEventMap|MessageSourceMap)\b/;

// The generator reads one declaration of an interface; these collect the
// properties of all of them, the way the type checker merges them.
class MergedInterfaceNodeParser extends InterfaceAndClassNodeParser {
  supportsNode(node) {
    return ts.isInterfaceDeclaration(node) && EXTENSIBLE.test(`interface ${node.name.text}`);
  }

  getProperties(node, context) {
    const declarations = this.typeChecker.getSymbolAtLocation(node.name)?.declarations?.filter(ts.isInterfaceDeclaration) ?? [node];
    const merged = new Map();
    for (const declaration of declarations) {
      for (const property of super.getProperties(declaration, context) ?? []) merged.set(property.getName(), property);
    }
    return [...merged.values()];
  }
}

function extensionFiles() {
  const scope = join(root, 'node_modules/@deepseek-ai');
  const files = [];
  const visit = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.d.ts') && EXTENSIBLE.test(readFileSync(path, 'utf8'))) files.push(path);
    }
  };
  for (const pkg of readdirSync(scope).sort()) {
    try { visit(join(scope, pkg, 'lib/types')); } catch { /* no declarations */ }
  }
  return files.sort();
}

// Definitions are keyed by bare type name, so two modules that each declare a
// `ModelSelection` would collide. A name with more than one distinct symbol in
// the program is qualified by its package (`DshAgentModelSelection`); unique
// names stay bare. Distinct symbols, not declarations: an interface merged
// across files is one symbol.
function collidingNames(program) {
  const checker = program.getTypeChecker();
  const symbols = new Map();
  for (const file of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(file)) continue;
    for (const statement of file.statements) {
      if (!(ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isClassDeclaration(statement))) continue;
      if (statement.name === undefined) continue;
      const symbol = checker.getSymbolAtLocation(statement.name);
      if (symbol === undefined) continue;
      const set = symbols.get(statement.name.text) ?? new Set();
      set.add(symbol);
      symbols.set(statement.name.text, set);
    }
  }
  return new Set([...symbols].filter(([, set]) => set.size > 1).map(([name]) => name));
}

/** `…/node_modules/@deepseek-ai/dsh-agent/…` → `DshAgent`; this repository → `Dscode`. */
function packagePrefix(fileName) {
  const match = /node_modules\/(?:@[^/]+\/)?([^/]+)\//.exec(fileName.slice(fileName.lastIndexOf('node_modules/')));
  return match === null ? 'Dscode' : pascal(match[1]);
}

function qualifyCollisions(program) {
  const colliding = collidingNames(program);
  const original = ExposeNodeParser.prototype.getDefinitionName;
  ExposeNodeParser.prototype.getDefinitionName = function (node, context) {
    const name = original.call(this, node, context);
    const base = name.replace(/<.*$/, '');
    if (!colliding.has(base)) return name;
    const declaration = symbolAtNode(node)?.declarations?.[0] ?? node;
    return packagePrefix(declaration.getSourceFile().fileName) + name;
  };
  return () => { ExposeNodeParser.prototype.getDefinitionName = original; };
}

function createProgram(config) {
  const raw = ts.readConfigFile(config.tsconfig, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, dirname(config.tsconfig), {}, config.tsconfig);
  return ts.createProgram({ rootNames: [config.path, ...extensionFiles()], options: { ...parsed.options, noEmit: true } });
}

// Plugins add event kinds and message sources at runtime, some from untyped
// JavaScript, so these unions stay open: a client decodes the members it knows
// (`<Name>Known`) and keeps anything else as an object with the discriminator.
const OPEN_UNIONS = { SessionEvent: 'type', MessageSource: 'kind' };

function openUnions(definitions) {
  for (const [name, discriminator] of Object.entries(OPEN_UNIONS)) {
    const known = definitions[name];
    if (known === undefined) continue;
    nameEventData(definitions, known, discriminator);
    const { description, ...members } = known;
    definitions[`${name}Known`] = { ...members, description: `The ${name} members the contract knows.` };
    // Exactly one applies: a known member, or an object whose discriminator is not a known value.
    const tags = [...new Set(knownTags(definitions, members, discriminator))].sort();
    definitions[name] = {
      ...(description ? { description } : {}),
      oneOf: [
        { $ref: `#/definitions/${name}Known` },
        {
          title: `${name}Other`,
          description: `A ${name} member this contract does not describe; \`${discriminator}\` names it.`,
          type: 'object',
          properties: { [discriminator]: { type: 'string', not: { enum: tags } } },
          required: [discriminator],
          additionalProperties: true,
        },
      ],
    };
  }
}

/** Discriminator values of a union's members, following one level of `$ref`. */
function knownTags(definitions, union, discriminator) {
  return (union.anyOf ?? []).flatMap(member => {
    const resolved = member.$ref ? definitions[member.$ref.slice('#/definitions/'.length)] : member;
    const property = resolved?.properties?.[discriminator];
    if (typeof property?.const === 'string') return [property.const];
    if (Array.isArray(property?.enum)) return property.enum;
    return resolved?.anyOf ? knownTags(definitions, resolved, discriminator) : [];
  });
}

// Each event carries its own inline `data` object. Anonymous objects get
// generated names in other languages, and typify gives all of them the same
// one; name each after its event (`permission/preset` → `PermissionPresetEventData`).
function nameEventData(definitions, union, discriminator) {
  for (const member of union.anyOf ?? []) {
    const kind = member.properties?.[discriminator]?.const;
    const data = member.properties?.data;
    if (typeof kind !== 'string' || data === undefined || data.$ref !== undefined) continue;
    const name = `${pascal(kind)}EventData`;
    if (definitions[name] !== undefined) throw Error(`${name} already defined`);
    definitions[name] = data;
    member.properties.data = { $ref: `#/definitions/${name}` };
  }
}

// `SessionSeq | -1` becomes `anyOf: [number, const -1]`, which says no more
// than `number`, but code generators turn it into a union a plain number cannot
// decode into. A union whose bare-typed member admits every other member
// collapses to that member.
function collapseRedundantUnions(value) {
  if (Array.isArray(value)) return value.map(collapseRedundantUnions);
  if (value === null || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, collapseRedundantUnions(inner)]));
  const members = result.anyOf;
  if (Array.isArray(members)) {
    const bare = members.find(member => typeof member.type === 'string' && Object.keys(member).every(key => key === 'type' || key === 'description'));
    const covered = member => member === bare || (member.type === bare?.type && Object.keys(member).every(key => ['type', 'const', 'enum', 'description'].includes(key)));
    if (bare !== undefined && members.every(covered)) {
      const { anyOf, ...rest } = result;
      void anyOf;
      return { ...rest, type: bare.type };
    }
  }
  return result;
}

// A union that mixes named members with inline objects gets positional names
// for the inline ones in generated code (`Variant0`). Title each inline member
// after its discriminator (and `form`, when members of one kind differ by it):
// `SessionFollowFrame` + `snapshot` → `SessionFollowFrameSnapshot`.
function titleInlineMembers(definitions) {
  for (const [name, definition] of Object.entries(definitions)) {
    const members = definition.anyOf;
    if (!Array.isArray(members) || !members.some(member => member.$ref) || !members.some(member => !member.$ref)) continue;
    const seen = new Map();
    for (const member of members) {
      if (member.$ref || member.title) continue;
      const tags = [member.properties?.type?.const ?? member.properties?.kind?.const, member.properties?.form?.const].filter(tag => typeof tag === 'string');
      if (tags.length === 0) continue;
      const title = name + tags.map(pascal).join('');
      const count = (seen.get(title) ?? 0) + 1;
      seen.set(title, count);
      member.title = count === 1 ? title : `${title}${count}`;
    }
  }
}

/** Fail on anything function-shaped: the generator read a value where a type was meant. */
function assertNoFunctions(definitions) {
  const misread = Object.entries(definitions).filter(([, schema]) => /^\(.*\) =>/.test(schema.$comment ?? '') || JSON.stringify(schema).includes('"namedArgs"'));
  if (misread.length > 0) throw Error(`generator read functions instead of types: ${misread.map(([name]) => name).join(', ')}`);
}

export function buildSchema() {
  const config = {
    ...DEFAULT_CONFIG,
    path: join(root, SOURCE),
    tsconfig: join(root, 'packages/tui/tsconfig.json'),
    expose: 'export',
    topRef: false,
    jsDoc: 'extended',
    // `npm run typecheck` checks the source; the generator only needs its types.
    skipTypeCheck: true,
    additionalProperties: true,
  };
  const program = createProgram(config);
  const restoreNaming = qualifyCollisions(program);
  const checker = program.getTypeChecker();
  const parser = createParser(program, config, chain => chain
    .addNodeParser(new BrandNodeParser(checker))
    .addNodeParser(new ImportTypeNodeParser(checker, chain))
    .addNodeParser(new MergedInterfaceNodeParser(checker, chain, config.additionalProperties)));
  const generator = new SchemaGenerator(program, parser, createFormatter(config), config);
  const definitions = {};
  const tables = {};
  const tableKeys = {
    DscodeMethods: ['x-dscode-methods', ['args', 'result']],
    DscodeStreams: ['x-dscode-streams', ['args', 'item', 'uplink']],
    TypertMethods: ['x-typert-methods', ['args', 'result']],
    TypertStreams: ['x-typert-streams', ['args', 'item']],
    TypertWaterfalls: ['x-typert-waterfalls', ['request', 'value'], { request: 'Payload', value: 'Answer' }],
  };
  for (const [table, [key, parts, suffixes = {}]] of Object.entries(tableKeys)) {
    const schema = generator.createSchema(table);
    Object.assign(definitions, schema.definitions);
    const operations = {};
    for (const [name, operation] of Object.entries(schema.properties ?? {})) {
      const entry = {};
      if (operation.description) entry.description = operation.description;
      for (const part of parts) {
        const partSchema = operation.properties[part];
        if (partSchema === undefined) continue;
        const ref = partSchema.$ref?.startsWith('#/definitions/') && Object.keys(partSchema).length === 1
          ? decodeURIComponent(partSchema.$ref.slice('#/definitions/'.length))
          : undefined;
        const typeName = ref ?? pascal(name) + (suffixes[part] ?? pascal(part));
        if (ref === undefined) {
          if (definitions[typeName] !== undefined) throw Error(`${key} ${name}.${part}: ${typeName} is already defined`);
          definitions[typeName] = partSchema;
        }
        entry[part] = typeName;
      }
      operations[name] = entry;
    }
    tables[key] = operations;
  }
  restoreNaming();
  replaceNonJson(definitions);
  openUnions(definitions);
  titleInlineMembers(definitions);
  for (const name of Object.keys(definitions)) definitions[name] = collapseRedundantUnions(definitions[name]);
  assertNoFunctions(definitions);
  return sortKeys({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $comment: `Generated by scripts/protocol-schema.mjs from ${SOURCE}; do not edit.`,
    title: 'DSCODE runtime operations',
    'x-protocol-version': { ...PROTOCOL },
    ...tables,
    definitions,
  });
}

export const render = schema => JSON.stringify(schema, null, 2) + '\n';

const ANNOTATIONS = new Set(['description', 'title', '$comment', 'markdownDescription', 'examples']);
const stripAnnotations = value => Array.isArray(value) ? value.map(stripAnnotations)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => !ANNOTATIONS.has(key)).map(([key, inner]) => [key, stripAnnotations(inner)]))
    : value;

/** What a protocol version stands for: the schema without its version and wording. */
export function fingerprint(schema) {
  const { 'x-protocol-version': version, ...rest } = schema;
  void version;
  return 'sha256:' + createHash('sha256').update(JSON.stringify(stripAnnotations(rest))).digest('hex');
}

const readJson = (file, fallback) => existsSync(join(root, file)) ? JSON.parse(readFileSync(join(root, file), 'utf8')) : fallback;
const compareVersions = (a, b) => a.major - b.major || a.minor - b.minor;
const parseVersion = key => { const [major, minor] = key.split('.').map(Number); return { major, minor }; };

/**
 * Problems with the protocol version for `schema`: unrecorded, recorded with a
 * different schema, or breaking a client of the current major's baseline.
 * `record` writes what is missing instead of reporting it, where that is allowed.
 */
export function versionProblems(schema, { record = false } = {}) {
  const key = formatProtocol(PROTOCOL);
  const versions = readJson(VERSIONS, {});
  const print = fingerprint(schema);
  const problems = [];
  if (versions[key] !== undefined && versions[key] !== print) {
    problems.push(`the contract changed since protocol ${key} was recorded: bump the minor (additive change) or the major (breaking change) in plugins/local-carrier/protocol.mjs, then run node scripts/protocol-schema.mjs --record`);
    return problems;
  }
  const newer = Object.keys(versions).filter(recorded => compareVersions(parseVersion(recorded), PROTOCOL) > 0);
  if (newer.length > 0) problems.push(`protocol ${key} is older than the recorded ${newer.join(', ')}`);
  const baseline = readJson(BASELINE, undefined);
  const baselineVersion = baseline?.['x-protocol-version'];
  const newMajor = baselineVersion === undefined || baselineVersion.major < PROTOCOL.major;
  if (!newMajor) {
    const breaking = breakingChanges(baseline, schema);
    if (breaking.length > 0) problems.push(`protocol ${key} breaks clients of ${formatProtocol(baselineVersion)}; bump the major in plugins/local-carrier/protocol.mjs and run --record:\n  ${breaking.slice(0, 20).join('\n  ')}${breaking.length > 20 ? `\n  … ${breaking.length - 20} more` : ''}`);
  }
  if (problems.length === 0 && versions[key] === undefined) {
    if (!record) problems.push(`protocol ${key} is not recorded; run node scripts/protocol-schema.mjs --record`);
    else {
      writeFileSync(join(root, VERSIONS), JSON.stringify(Object.fromEntries(Object.entries({ ...versions, [key]: print }).sort(([a], [b]) => compareVersions(parseVersion(a), parseVersion(b)))), null, 2) + '\n');
      if (newMajor) writeFileSync(join(root, BASELINE), render(schema));
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const schema = buildSchema();
  const text = render(schema);
  const target = join(root, OUTPUT);
  if (process.argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(target, 'utf8'); } catch { /* missing counts as stale */ }
    const problems = current === text ? versionProblems(schema) : [`${OUTPUT} is stale; run node scripts/protocol-schema.mjs`];
    if (problems.length > 0) {
      console.error(problems.join('\n'));
      process.exit(1);
    }
    console.log(`${OUTPUT} is current; protocol ${formatProtocol(PROTOCOL)}`);
  } else {
    writeFileSync(target, text);
    console.log(`wrote ${OUTPUT}`);
    if (process.argv.includes('--record')) {
      const problems = versionProblems(schema, { record: true });
      if (problems.length > 0) {
        console.error(problems.join('\n'));
        process.exit(1);
      }
      console.log(`protocol ${formatProtocol(PROTOCOL)} recorded`);
    }
  }
}
