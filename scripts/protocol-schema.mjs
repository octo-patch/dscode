import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
  DEFAULT_CONFIG, ExposeNodeParser, InterfaceAndClassNodeParser, NumberType, SchemaGenerator, StringType, UnknownType,
  createFormatter, createParser, symbolAtNode,
} from 'ts-json-schema-generator';

// The DSCODE operations' wire contract lives in TypeScript
// (packages/tui/src/host/protocol.ts), where the Host registry is checked
// against it. This script turns that table into JSON Schema for clients written
// in other languages; the Rust desktop client generates its types from the
// output. Run it after changing the table and commit the result:
//
//   node scripts/protocol-schema.mjs          # write protocol/dscode-runtime.schema.json
//   node scripts/protocol-schema.mjs --check  # exit 1 when the committed file is stale
//
// Every operation gets named definitions, `<Operation>Args` and
// `<Operation>Result` (methods) or `<Operation>Item` (streams), unless its
// schema already is a named definition; `x-dscode-methods` and
// `x-dscode-streams` map each wire name to those definition names.

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const SOURCE = 'packages/tui/src/host/protocol.ts';
export const OUTPUT = 'protocol/dscode-runtime.schema.json';

/** `models/compactionPreview` → `ModelsCompactionPreview`. */
const pascal = name => name.split(/[/_-]/).filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join('');

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
    definitions[name] = {
      ...(description ? { description } : {}),
      anyOf: [
        { $ref: `#/definitions/${name}Known` },
        {
          title: `${name}Other`,
          description: `A ${name} member this contract does not describe; \`${discriminator}\` names it.`,
          type: 'object',
          properties: { [discriminator]: { type: 'string' } },
          required: [discriminator],
          additionalProperties: true,
        },
      ],
    };
  }
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
  for (const [table, parts] of [['DscodeMethods', ['args', 'result']], ['DscodeStreams', ['args', 'item', 'uplink']]]) {
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
        const typeName = ref ?? pascal(name) + pascal(part);
        if (ref === undefined) definitions[typeName] = partSchema;
        entry[part] = typeName;
      }
      operations[name] = entry;
    }
    tables[table === 'DscodeMethods' ? 'x-dscode-methods' : 'x-dscode-streams'] = operations;
  }
  restoreNaming();
  replaceNonJson(definitions);
  openUnions(definitions);
  assertNoFunctions(definitions);
  return sortKeys({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $comment: `Generated by scripts/protocol-schema.mjs from ${SOURCE}; do not edit.`,
    title: 'DSCODE runtime operations',
    ...tables,
    definitions,
  });
}

export const render = schema => JSON.stringify(schema, null, 2) + '\n';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = render(buildSchema());
  const target = join(root, OUTPUT);
  if (process.argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(target, 'utf8'); } catch { /* missing counts as stale */ }
    if (current !== text) {
      console.error(`${OUTPUT} is stale; run node scripts/protocol-schema.mjs`);
      process.exit(1);
    }
    console.log(`${OUTPUT} is current`);
  } else {
    writeFileSync(target, text);
    console.log(`wrote ${OUTPUT}`);
  }
}
