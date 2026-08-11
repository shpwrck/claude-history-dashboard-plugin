// FORWARD FENCE for the parser-output -> cache-invalidation seam (#2075).
//
// Run under the ts-resolver loader (the seam consumers reach into .ts modules)
// and with --test:
//   node --import ./scripts/register-ts.mjs --test scripts/parser-output-versions.fence.test.mjs
//
// The seam (scripts/lib/parser-output-versions.mjs) is the SINGLE place that
// says "bump THIS version when THAT parser's output shape changes". Each entry
// carries (a) a `version` baked into a cache key and (b) a `contract`
// fingerprint of that parser's OUTPUT shape. This test recomputes each contract
// FROM THE LIVE CODE and asserts it matches the registered fingerprint.
//
// The point is forward, not backward: today's parity tests
// (signal-descriptor-parity, session-blob-cache-parity, repo-map cache tests)
// prove the CURRENT shape still behaves; none of them fail when a NEW output
// field is added. This fence does. If a parser's output shape drifts — a signal
// column added/removed/reordered, a repo-map envelope field changed — the
// recomputed contract no longer matches the registered one and this test FAILS,
// telling the author to (1) update the contract here AND (2) deliberately bump
// the paired `version`, which is exactly the cache-invalidation step that
// otherwise gets forgotten and ships the change inert.
//
// It does NOT collapse the two caches into one key: each entry is checked
// independently against the shape of its OWN artifact. The genuinely-distinct
// transcript/dataset knobs (PARSER_SIG_VERSION, DATASET_ASSEMBLY_SCHEMA_VERSION)
// are intentionally NOT folded in here — see the seam's header comment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import {
  SESSION_BLOB_OUTPUT,
  REPO_MAP_OUTPUT,
  RELATED_INVALIDATION_KNOBS,
} from './lib/parser-output-versions.mjs';

import { makeSessionSignals } from '../src/lib/signals/index.ts';
import { enforceSizeLimit } from '../src/lib/repo-map/cache.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const REPO_MAP_CACHE_PATH = join(HERE, '../src/lib/repo-map/cache.ts');
const REPO_MAP_PARSER_OUTPUT_PATH = join(
  HERE,
  '../src/lib/repo-map/parser-output.ts'
);
const REPO_MAP_TYPES_PATH = join(HERE, '../src/lib/repo-map/types.ts');
const PARSER_OUTPUT_REGISTRY_PATH = 'scripts/lib/parser-output-versions.mjs';

// Identity stubs: the session-blob output CONTRACT is the column set, which is
// independent of what the parsers return. We only need makeSessionSignals to
// build, so the parsers can be no-ops.
function stubParsers() {
  const noop = () => null;
  return {
    parseSessionJsonl: noop,
    parseToolUsage: noop,
    parseSessionTimeline: noop,
    parseApiErrors: noop,
    parsePermissionData: noop,
    parseAgentSettings: noop,
    parseAttribution: noop,
    parseRuntimeEvents: noop,
    parseChurnGeometry: noop,
    parseValueFlow: noop,
    parseToolInventory: noop,
    parseAssistantFeatures: noop,
    parseDeceitSignals: noop,
    parseTaskSuccess: noop,
    deriveEntries: noop,
  };
}

// ---------------------------------------------------------------------------
// SESSION_BLOB: the output shape is the ORDERED set of signal columns the
// session_blob cache persists (src/lib/signals/index.ts). A column added,
// removed, or reordered is exactly an output-shape change that must move the
// SESSION_BLOB_PARSER_VERSION baked into sessionFileSignature().
// ---------------------------------------------------------------------------
test('session-blob output contract === live signal columns (fence: a column change forces a version bump)', () => {
  const liveColumns = makeSessionSignals(stubParsers()).map((s) => s.column);
  assert.deepEqual(
    SESSION_BLOB_OUTPUT.contract,
    liveColumns,
    'session-blob output shape drifted from the registered contract. If you ' +
      'changed a signal column in src/lib/signals/index.ts, update ' +
      'SESSION_BLOB_OUTPUT.contract in scripts/lib/parser-output-versions.mjs ' +
      'AND bump SESSION_BLOB_OUTPUT.version — otherwise the session_blob cache ' +
      'key does not move and the change ships inert.'
  );
});

test('session-blob version is the value the session_blob cache key actually bakes in', () => {
  // The consumer must read the seam, not redefine its own constant. Asserting
  // the literal string is gone from session-blob-row.mjs keeps the seam the
  // single source of truth (a re-introduced literal would silently diverge).
  const src = readFileSync(join(HERE, 'session-blob-row.mjs'), 'utf8');
  assert.match(
    src,
    /SESSION_BLOB_OUTPUT\.version/,
    'session-blob-row.mjs must derive its parser version from the seam ' +
      '(SESSION_BLOB_OUTPUT.version), not a local literal.'
  );
  assert.doesNotMatch(
    src,
    /SESSION_BLOB_PARSER_VERSION\s*=\s*['"]/,
    'session-blob-row.mjs re-introduced a literal SESSION_BLOB_PARSER_VERSION; ' +
      'the value must come from the seam so the forward fence governs it.'
  );
  assert.equal(typeof SESSION_BLOB_OUTPUT.version, 'string');
});

test('session-blob version turns over for exact git undo path evidence (#3160)', () => {
  // A CONTENT-shape bump the column fingerprint above cannot force: tool_json
  // calls now carry sparse `commandUndoFilePaths`, with no signal column added,
  // removed, or renamed. Pinning the literal keeps the deliberate bump from
  // silently reverting to a cache whose rows cannot attribute undo paths.
  assert.equal(
    SESSION_BLOB_OUTPUT.version,
    'undo-file-paths-v22',
    'tool_json calls now carry exact parser-owned git undo path evidence; the summaryRawLen v21 cache key must not remain current'
  );
});

// ---------------------------------------------------------------------------
// REPO_MAP: the output shape includes both the persisted envelope and the
// RepoMapCacheKey plus the RepoMap / per-file / per-symbol structures nested
// under `map`. The envelope is sampled from the real producer. The nested key
// sets are read from their owning TypeScript interfaces so an optional field
// cannot disappear from the sample and a field added to the type cannot remain
// invisible here.
// ---------------------------------------------------------------------------
function persistedRepoMapSample() {
  const map = {
    root: '/repo',
    generatedAtGitSha: null,
    repository: null,
    files: [
      {
        path: 'sample.ts',
        mtimeMs: 0,
        symbols: [],
        imports: [],
      },
    ],
    fileCount: 1,
    text: '',
    truncated: false,
  };
  const cacheKey = {
    root: '/repo',
    gitSha: null,
    repository: null,
    maxMtimeMs: 0,
    structureSignature: null,
  };
  return enforceSizeLimit(
    map,
    cacheKey,
    () => ({ text: '', truncated: false }),
    1_000_000
  );
}

function directInterfaceFields(sourceText, interfaceName, sourcePath) {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const declarations = sourceFile.statements.filter(
    (statement) =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName
  );
  assert.equal(
    declarations.length,
    1,
    `${interfaceName} must remain one direct interface declaration for the repo-map output fence`
  );

  const declaration = declarations[0];
  assert.equal(
    declaration.heritageClauses?.length ?? 0,
    0,
    `${interfaceName} must not extend an interface without teaching the repo-map output fence to traverse it`
  );

  return declaration.members
    .map((member) => {
      assert.ok(
        ts.isPropertySignature(member),
        `${interfaceName} may only contain property signatures unless the repo-map output fence is updated`
      );
      assert.ok(
        ts.isIdentifier(member.name) || ts.isStringLiteral(member.name),
        `${interfaceName} property names must be static for the repo-map output fence`
      );
      return { name: member.name.text, optional: Boolean(member.questionToken) };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function directInterfaceKeys(sourceText, interfaceName, sourcePath) {
  return directInterfaceFields(sourceText, interfaceName, sourcePath).map(
    (field) => field.name
  );
}

function directStringUnionMembers(sourceText, typeName, sourcePath) {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const declarations = sourceFile.statements.filter(
    (statement) =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === typeName
  );
  assert.equal(
    declarations.length,
    1,
    `${typeName} must remain one direct type alias for the repo-map parser-output fence`
  );
  const type = declarations[0].type;
  assert.ok(
    ts.isUnionTypeNode(type),
    `${typeName} must remain a direct string-literal union for the repo-map parser-output fence`
  );
  return type.types
    .map((member) => {
      assert.ok(
        ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal),
        `${typeName} may contain only string literals unless the repo-map parser-output fence is updated`
      );
      return member.literal.text;
    })
    .sort();
}

function repoSymbolKindSwitchCases(sourceText) {
  const sourceFile = ts.createSourceFile(
    REPO_MAP_PARSER_OUTPUT_PATH,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const functions = sourceFile.statements.filter(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === 'normalizeRepoSymbolKind'
  );
  assert.equal(
    functions.length,
    1,
    'parser-output.ts must declare normalizeRepoSymbolKind exactly once'
  );
  const switches = functions[0].body?.statements.filter(ts.isSwitchStatement) ?? [];
  assert.equal(
    switches.length,
    1,
    'normalizeRepoSymbolKind must contain one static switch'
  );
  assert.ok(
    ts.isIdentifier(switches[0].expression) &&
      switches[0].expression.text === 'value',
    'normalizeRepoSymbolKind must switch directly on value'
  );

  const cases = [];
  let defaults = 0;
  for (const clause of switches[0].caseBlock.clauses) {
    assert.equal(
      clause.statements.length,
      1,
      'every normalizeRepoSymbolKind clause must return directly'
    );
    const statement = clause.statements[0];
    assert.ok(
      ts.isReturnStatement(statement) && statement.expression,
      'every normalizeRepoSymbolKind clause must return a value'
    );
    if (ts.isDefaultClause(clause)) {
      defaults += 1;
      assert.ok(
        ts.isIdentifier(statement.expression) &&
          statement.expression.text === 'INVALID_RESULT',
        'normalizeRepoSymbolKind default must fail closed'
      );
      continue;
    }
    assert.ok(
      ts.isStringLiteral(clause.expression),
      'normalizeRepoSymbolKind cases must be static strings'
    );
    assert.ok(
      ts.isCallExpression(statement.expression) &&
        ts.isIdentifier(statement.expression.expression) &&
        statement.expression.expression.text === 'normalized' &&
        statement.expression.arguments.length === 1 &&
        ts.isIdentifier(statement.expression.arguments[0]) &&
        statement.expression.arguments[0].text === 'value',
      'every normalizeRepoSymbolKind case must return normalized(value)'
    );
    cases.push(clause.expression.text);
  }
  assert.equal(defaults, 1, 'normalizeRepoSymbolKind must have one fail-closed default');
  return cases.sort();
}

function assertDirectArrayElementType(
  sourceText,
  ownerInterfaceName,
  propertyName,
  expectedElementType,
  sourcePath
) {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const owners = sourceFile.statements.filter(
    (statement) =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === ownerInterfaceName
  );
  assert.equal(
    owners.length,
    1,
    `${ownerInterfaceName} must remain one direct interface declaration for the repo-map output fence`
  );
  const properties = owners[0].members.filter(
    (member) =>
      ts.isPropertySignature(member) &&
      (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
      member.name.text === propertyName
  );
  assert.equal(
    properties.length,
    1,
    `${ownerInterfaceName}.${propertyName} must remain one direct property for the repo-map output fence`
  );
  const propertyType = properties[0].type;
  assert.ok(
    propertyType && ts.isArrayTypeNode(propertyType),
    `${ownerInterfaceName}.${propertyName} must remain a direct ${expectedElementType}[] reference for the repo-map output fence`
  );
  const elementType = propertyType.elementType;
  assert.ok(
    ts.isTypeReferenceNode(elementType) &&
      ts.isIdentifier(elementType.typeName) &&
      (elementType.typeArguments?.length ?? 0) === 0,
    `${ownerInterfaceName}.${propertyName} must remain a direct ${expectedElementType}[] reference for the repo-map output fence`
  );
  assert.equal(
    elementType.typeName.text,
    expectedElementType,
    `${ownerInterfaceName}.${propertyName} must remain a direct ${expectedElementType}[] reference for the repo-map output fence`
  );
}

function exactRuleFields(sourceText, declarationName) {
  const sourceFile = ts.createSourceFile(
    REPO_MAP_PARSER_OUTPUT_PATH,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const declarations = sourceFile.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter(
      (declaration) =>
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === declarationName
    );
  assert.equal(
    declarations.length,
    1,
    `parser-output.ts must declare ${declarationName} exactly once`
  );
  const initializer = declarations[0].initializer;
  assert.ok(
    initializer && ts.isObjectLiteralExpression(initializer),
    `parser-output.ts ${declarationName} must remain a static object literal`
  );
  return initializer.properties
    .map((property) => {
      assert.ok(
        ts.isPropertyAssignment(property),
        `parser-output.ts ${declarationName} may only contain explicit property assignments`
      );
      const name = staticPropertyName(property);
      assert.ok(
        ts.isObjectLiteralExpression(property.initializer),
        `parser-output.ts ${declarationName}.${name} must remain a static rule object`
      );
      const rule = property.initializer;
      const ruleKeys = rule.properties.map((ruleProperty) => {
        assert.ok(
          ts.isPropertyAssignment(ruleProperty),
          `parser-output.ts ${declarationName}.${name} may only contain explicit property assignments`
        );
        return staticPropertyName(ruleProperty);
      });
      assert.deepEqual(
        [...ruleKeys].sort(),
        ['normalize', 'optional'],
        `parser-output.ts ${declarationName}.${name} must declare only optional and normalize`
      );
      const optionalProperty = rule.properties.find(
        (ruleProperty) => staticPropertyName(ruleProperty) === 'optional'
      );
      assert.ok(
        ts.isPropertyAssignment(optionalProperty) &&
          (optionalProperty.initializer.kind === ts.SyntaxKind.TrueKeyword ||
            optionalProperty.initializer.kind === ts.SyntaxKind.FalseKeyword),
        `parser-output.ts ${declarationName}.${name}.optional must be a static boolean`
      );
      return {
        name,
        optional: optionalProperty.initializer.kind === ts.SyntaxKind.TrueKeyword,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function assertParserOutputNormalizerParity(typesSource, parserOutputSource) {
  assert.deepEqual(
    exactRuleFields(parserOutputSource, 'REPO_SYMBOL_FIELD_RULES'),
    directInterfaceFields(typesSource, 'RepoSymbol', REPO_MAP_TYPES_PATH),
    'RepoSymbol fields/optionality and the typechecked parser-output rule allowlist diverged; add an exact rule for every direct RepoSymbol field'
  );
  assert.deepEqual(
    exactRuleFields(parserOutputSource, 'FILE_STRUCTURE_FIELD_RULES'),
    directInterfaceFields(typesSource, 'FileStructure', REPO_MAP_TYPES_PATH),
    'FileStructure fields/optionality and the typechecked parser-output rule allowlist diverged; add an exact rule for every direct FileStructure field'
  );
  assert.deepEqual(
    repoSymbolKindSwitchCases(parserOutputSource),
    directStringUnionMembers(
      typesSource,
      'RepoSymbolKind',
      REPO_MAP_TYPES_PATH
    ),
    'RepoSymbolKind union literals and normalizeRepoSymbolKind switch cases diverged; update the fail-closed runtime vocabulary with the type'
  );
  assert.match(
    parserOutputSource,
    /const objectKeys = Object\.keys;/,
    'parser-output normalization must capture Object.keys before reading untrusted getters'
  );
  assert.match(
    parserOutputSource,
    /objectKeys\(rules\)/,
    'normalizeExactObject must validate and project through its exact field rules'
  );
  assert.match(
    parserOutputSource,
    /kind:\s*{\s*optional:\s*false,\s*normalize:\s*normalizeRepoSymbolKind,\s*}/,
    'RepoSymbol.kind must use the fenced static normalizeRepoSymbolKind switch'
  );
  assert.match(
    parserOutputSource,
    /normalizeExactObject\(value, REPO_SYMBOL_FIELD_RULES\)/,
    'normalizeRepoSymbol must consume REPO_SYMBOL_FIELD_RULES'
  );
  assert.match(
    parserOutputSource,
    /normalizeExactObject\(value, FILE_STRUCTURE_FIELD_RULES\)/,
    'normalizeFileStructure must consume FILE_STRUCTURE_FIELD_RULES'
  );
}

function recomputeRepoMapOutputContract(typesSource, cacheSource) {
  const persisted = persistedRepoMapSample();
  assertDirectArrayElementType(
    typesSource,
    'RepoMap',
    'files',
    'RepoFile',
    REPO_MAP_TYPES_PATH
  );
  assertDirectArrayElementType(
    typesSource,
    'RepoFile',
    'symbols',
    'RepoSymbol',
    REPO_MAP_TYPES_PATH
  );
  return [
    ...Object.keys(persisted).map((field) => `envelope.${field}`),
    ...directInterfaceKeys(cacheSource, 'RepoMapCacheKey', REPO_MAP_CACHE_PATH).map(
      (field) => `envelope.cacheKey.${field}`
    ),
    ...directInterfaceKeys(typesSource, 'RepoMap', REPO_MAP_TYPES_PATH).map(
      (field) => `map.${field}`
    ),
    ...directInterfaceKeys(typesSource, 'RepoFile', REPO_MAP_TYPES_PATH).map(
      (field) => `map.files[].${field}`
    ),
    ...directInterfaceKeys(typesSource, 'RepoSymbol', REPO_MAP_TYPES_PATH).map(
      (field) => `map.files[].symbols[].${field}`
    ),
  ].sort();
}

function staticPropertyName(property) {
  if (
    ts.isIdentifier(property.name) ||
    ts.isStringLiteral(property.name) ||
    ts.isNumericLiteral(property.name)
  ) {
    return property.name.text;
  }
  assert.fail('REPO_MAP_OUTPUT property names must remain static');
}

function parseRepoMapOutputRegistry(sourceText, sourceName) {
  const sourceFile = ts.createSourceFile(
    sourceName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const declarations = sourceFile.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter(
      (declaration) =>
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === 'REPO_MAP_OUTPUT'
    );
  assert.equal(
    declarations.length,
    1,
    `${sourceName} must declare REPO_MAP_OUTPUT exactly once`
  );
  const initializer = declarations[0].initializer;
  assert.ok(
    initializer && ts.isObjectLiteralExpression(initializer),
    `${sourceName} REPO_MAP_OUTPUT must remain a static object literal for the version fence`
  );

  const property = (name) => {
    const matches = initializer.properties.filter(
      (candidate) =>
        ts.isPropertyAssignment(candidate) && staticPropertyName(candidate) === name
    );
    assert.equal(
      matches.length,
      1,
      `${sourceName} REPO_MAP_OUTPUT.${name} must be declared exactly once`
    );
    return matches[0].initializer;
  };

  const versionNode = property('version');
  assert.ok(
    ts.isNumericLiteral(versionNode) || ts.isStringLiteral(versionNode),
    `${sourceName} REPO_MAP_OUTPUT.version must remain a static number or string`
  );
  const contractNode = property('contract');
  assert.ok(
    ts.isArrayLiteralExpression(contractNode),
    `${sourceName} REPO_MAP_OUTPUT.contract must remain a static array`
  );
  const contract = contractNode.elements.map((element) => {
    assert.ok(
      ts.isStringLiteral(element),
      `${sourceName} REPO_MAP_OUTPUT.contract entries must remain static strings`
    );
    return element.text;
  });

  return {
    version: ts.isNumericLiteral(versionNode)
      ? Number(versionNode.text)
      : versionNode.text,
    contract,
  };
}

function assertVersionMovesWithContract(candidate, baseline) {
  const candidateContract = [...candidate.contract].sort();
  const baselineContract = [...baseline.contract].sort();
  if (JSON.stringify(candidateContract) !== JSON.stringify(baselineContract)) {
    assert.ok(
      Number.isInteger(candidate.version) &&
        Number.isInteger(baseline.version) &&
        candidate.version > baseline.version,
      'REPO_MAP_OUTPUT.contract changed from origin/master without a strictly ' +
        'higher integer REPO_MAP_OUTPUT.version; existing or retired artifacts ' +
        'could remain reusable.'
    );
  }
}

function originMasterRepoMapOutputRegistry() {
  let sourceText;
  try {
    sourceText = execFileSync(
      'git',
      ['show', `origin/master:${PARSER_OUTPUT_REGISTRY_PATH}`],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch {
    assert.fail(
      'origin/master is required for the repo-map contract/version fence; ' +
        'fetch origin/master and rerun the test.'
    );
  }
  return parseRepoMapOutputRegistry(sourceText, `origin/master:${PARSER_OUTPUT_REGISTRY_PATH}`);
}

function assertRegisteredRepoMapContract(liveContract) {
  assert.deepEqual(
    [...REPO_MAP_OUTPUT.contract].sort(),
    liveContract,
    `repo-map output shape drifted from the contract registered at ` +
      `REPO_MAP_OUTPUT.version=${REPO_MAP_OUTPUT.version}. If you changed ` +
      'PersistedRepoMap / RepoMapCacheKey in src/lib/repo-map/cache.ts or ' +
      'RepoMap / RepoFile / RepoSymbol in src/lib/repo-map/types.ts, update ' +
      'REPO_MAP_OUTPUT.contract in scripts/lib/parser-output-versions.mjs AND ' +
      'bump REPO_MAP_OUTPUT.version — otherwise stale artifacts are reused.'
  );
}

function addInterfaceProbe(sourceText, interfaceName, propertyName) {
  const declaration = `export interface ${interfaceName} {`;
  assert.ok(
    sourceText.includes(declaration),
    `test fixture could not find ${interfaceName}`
  );
  return sourceText.replace(
    declaration,
    `${declaration}\n  ${propertyName}?: string;`
  );
}

function addExactRuleProbe(sourceText, declarationName, shapeName, propertyName) {
  const anchor =
    `const ${declarationName}: ExactFieldRules<${shapeName}> = {\n`;
  assert.equal(
    sourceText.split(anchor).length,
    2,
    `test fixture could not find ${declarationName} allowlist`
  );
  return sourceText.replace(
    anchor,
    `${anchor}  ${propertyName}: {\n` +
      `    optional: true,\n` +
      `    normalize: (value) => typeof value === 'string' ? normalized(value) : INVALID_RESULT,\n` +
      `  },\n`
  );
}

function addRepoSymbolKindUnionProbe(sourceText, member) {
  const anchor = "  | 'variable';";
  assert.equal(
    sourceText.split(anchor).length,
    2,
    'test fixture could not find RepoSymbolKind union tail'
  );
  return sourceText.replace(anchor, `  | 'variable'\n  | '${member}';`);
}

function addRepoSymbolKindSwitchProbe(sourceText, member) {
  const anchor = '    default:\n      return INVALID_RESULT;';
  assert.equal(
    sourceText.split(anchor).length,
    2,
    'test fixture could not find normalizeRepoSymbolKind default'
  );
  return sourceText.replace(
    anchor,
    `    case '${member}':\n      return normalized(value);\n${anchor}`
  );
}

function addedFields(candidate, baseline) {
  const baselineSet = new Set(baseline);
  return candidate.filter((field) => !baselineSet.has(field));
}

test('repo-map output contract === live envelope + cache key + RepoMap + RepoFile + RepoSymbol fields', () => {
  const typesSource = readFileSync(REPO_MAP_TYPES_PATH, 'utf8');
  const cacheSource = readFileSync(REPO_MAP_CACHE_PATH, 'utf8');
  assertRegisteredRepoMapContract(
    recomputeRepoMapOutputContract(typesSource, cacheSource)
  );
});

test('repo-map parser output validates and projects every direct FileStructure and RepoSymbol field through exact rules', () => {
  const typesSource = readFileSync(REPO_MAP_TYPES_PATH, 'utf8');
  const parserOutputSource = readFileSync(REPO_MAP_PARSER_OUTPUT_PATH, 'utf8');
  assertParserOutputNormalizerParity(typesSource, parserOutputSource);
});

test('repo-map parser-output parity fence detects type-only drift and accepts paired rule updates', () => {
  const typesSource = readFileSync(REPO_MAP_TYPES_PATH, 'utf8');
  const parserOutputSource = readFileSync(REPO_MAP_PARSER_OUTPUT_PATH, 'utf8');
  const typesWithProbe = addInterfaceProbe(
    typesSource,
    'RepoSymbol',
    'documentationProbe'
  );

  assert.throws(
    () => assertParserOutputNormalizerParity(typesWithProbe, parserOutputSource),
    /RepoSymbol fields\/optionality.*rule allowlist diverged/s
  );
  const rulesWithProbe = addExactRuleProbe(
    parserOutputSource,
    'REPO_SYMBOL_FIELD_RULES',
    'RepoSymbol',
    'documentationProbe'
  );
  assert.doesNotThrow(() =>
    assertParserOutputNormalizerParity(typesWithProbe, rulesWithProbe)
  );
  assert.throws(
    () =>
      assertParserOutputNormalizerParity(
        typesWithProbe,
        rulesWithProbe.replace(
          '  documentationProbe: {\n    optional: true,',
          '  documentationProbe: {\n    optional: false,'
        )
    ),
    /RepoSymbol fields\/optionality.*rule allowlist diverged/s
  );

  const structureTypesWithProbe = addInterfaceProbe(
    typesSource,
    'FileStructure',
    'metadataProbe'
  );
  assert.throws(
    () =>
      assertParserOutputNormalizerParity(
        structureTypesWithProbe,
        parserOutputSource
      ),
    /FileStructure fields\/optionality.*rule allowlist diverged/s
  );
  const structureRulesWithProbe = addExactRuleProbe(
    parserOutputSource,
    'FILE_STRUCTURE_FIELD_RULES',
    'FileStructure',
    'metadataProbe'
  );
  assert.doesNotThrow(() =>
    assertParserOutputNormalizerParity(
      structureTypesWithProbe,
      structureRulesWithProbe
    )
  );

  const kindTypesWithProbe = addRepoSymbolKindUnionProbe(
    typesSource,
    'namespace'
  );
  assert.throws(
    () =>
      assertParserOutputNormalizerParity(
        kindTypesWithProbe,
        parserOutputSource
      ),
    /RepoSymbolKind union literals.*switch cases diverged/s
  );
  const kindSwitchWithProbe = addRepoSymbolKindSwitchProbe(
    parserOutputSource,
    'namespace'
  );
  assert.doesNotThrow(() =>
    assertParserOutputNormalizerParity(kindTypesWithProbe, kindSwitchWithProbe)
  );
});

test('repo-map contract changes from origin/master require a version rollover', () => {
  assertVersionMovesWithContract(
    REPO_MAP_OUTPUT,
    originMasterRepoMapOutputRegistry()
  );
});

test('repo-map version retires artifacts built before exact parser-output projection (#3750)', () => {
  assert.equal(
    REPO_MAP_OUTPUT.version,
    11,
    'v10 artifacts may retain parser-only symbol keys; exact parser-output projection must keep the canonical and per-file cache keys on v11'
  );
});

test('repo-map fence rejects cache-key, map, file, or symbol shape drift at the registered version', () => {
  const typesSource = readFileSync(REPO_MAP_TYPES_PATH, 'utf8');
  const cacheSource = readFileSync(REPO_MAP_CACHE_PATH, 'utf8');
  const baseline = recomputeRepoMapOutputContract(typesSource, cacheSource);
  const cacheKeyDrift = recomputeRepoMapOutputContract(
    typesSource,
    addInterfaceProbe(cacheSource, 'RepoMapCacheKey', 'probeField')
  );
  const mapDrift = recomputeRepoMapOutputContract(
    addInterfaceProbe(typesSource, 'RepoMap', 'repositoryIdentityProbe'),
    cacheSource
  );
  const fileDrift = recomputeRepoMapOutputContract(
    addInterfaceProbe(typesSource, 'RepoFile', 'probeField'),
    cacheSource
  );
  const symbolDrift = recomputeRepoMapOutputContract(
    addInterfaceProbe(typesSource, 'RepoSymbol', 'documentationProbe'),
    cacheSource
  );
  const symbolReferenceDrift = `${typesSource.replace(
    '  symbols: RepoSymbol[];',
    '  symbols: AlternateRepoSymbol[];'
  )}\n\nexport type AlternateRepoSymbol = RepoSymbol & { documentationProbe?: string };\n`;
  const fileReferenceDrift = `${typesSource.replace(
    '  files: RepoFile[];',
    '  files: AlternateRepoFile[];'
  )}\n\nexport type AlternateRepoFile = RepoFile & { documentationProbe?: string };\n`;

  assert.deepEqual(addedFields(cacheKeyDrift, baseline), [
    'envelope.cacheKey.probeField',
  ]);
  assert.deepEqual(addedFields(mapDrift, baseline), [
    'map.repositoryIdentityProbe',
  ]);
  assert.deepEqual(addedFields(fileDrift, baseline), [
    'map.files[].probeField',
  ]);
  assert.deepEqual(addedFields(symbolDrift, baseline), [
    'map.files[].symbols[].documentationProbe',
  ]);
  assert.throws(
    () => recomputeRepoMapOutputContract(symbolReferenceDrift, cacheSource),
    /RepoFile\.symbols must remain a direct RepoSymbol\[\] reference/
  );
  assert.throws(
    () => recomputeRepoMapOutputContract(fileReferenceDrift, cacheSource),
    /RepoMap\.files must remain a direct RepoFile\[\] reference/
  );
  assert.throws(
    () => assertRegisteredRepoMapContract(cacheKeyDrift),
    /REPO_MAP_OUTPUT\.version=.*bump REPO_MAP_OUTPUT\.version/s
  );
  assert.throws(
    () => assertRegisteredRepoMapContract(mapDrift),
    /REPO_MAP_OUTPUT\.version=.*bump REPO_MAP_OUTPUT\.version/s
  );
  assert.throws(
    () => assertRegisteredRepoMapContract(fileDrift),
    /REPO_MAP_OUTPUT\.version=.*bump REPO_MAP_OUTPUT\.version/s
  );
  assert.throws(
    () => assertRegisteredRepoMapContract(symbolDrift),
    /REPO_MAP_OUTPUT\.version=.*bump REPO_MAP_OUTPUT\.version/s
  );

  // Prove the less-obvious bypass too: even if an author updates the contract
  // for the new key, retaining the old cache version must still fail.
  assert.throws(
    () =>
      assertVersionMovesWithContract(
        { version: REPO_MAP_OUTPUT.version, contract: symbolDrift },
        { version: REPO_MAP_OUTPUT.version, contract: baseline }
      ),
    /contract changed.*without a strictly higher integer.*version/s
  );
  assert.throws(
    () =>
      assertVersionMovesWithContract(
        { version: REPO_MAP_OUTPUT.version - 1, contract: mapDrift },
        { version: REPO_MAP_OUTPUT.version, contract: baseline }
      ),
    /contract changed.*without a strictly higher integer.*version/s
  );
  assert.doesNotThrow(() =>
    assertVersionMovesWithContract(
      { version: REPO_MAP_OUTPUT.version + 1, contract: symbolDrift },
      { version: REPO_MAP_OUTPUT.version, contract: baseline }
    )
  );
});

test('repo-map version is the value the persisted envelope actually stamps', () => {
  const persisted = persistedRepoMapSample();
  assert.equal(
    persisted.cacheKey.repository,
    null,
    'the live persisted sample must satisfy every required RepoMapCacheKey field'
  );
  assert.equal(
    persisted.version,
    REPO_MAP_OUTPUT.version,
    'the persisted envelope version must equal REPO_MAP_OUTPUT.version (the ' +
      'seam owns PERSISTED_REPO_MAP_VERSION).'
  );
  assert.equal(typeof REPO_MAP_OUTPUT.version, 'number');
});

// ---------------------------------------------------------------------------
// Guard the "do not conflate" boundary: the transcript/dataset knobs are
// documented as related-but-separate and must NOT be the same as either
// parser-output entry's version (a sign someone collapsed distinct caches).
// ---------------------------------------------------------------------------
test('seam keeps the genuinely-distinct knobs separate, not folded into a parser-output version', () => {
  assert.ok(
    'PARSER_SIG_VERSION' in RELATED_INVALIDATION_KNOBS,
    'PARSER_SIG_VERSION must stay documented as a separate transcript-cache knob'
  );
  assert.ok(
    'DATASET_ASSEMBLY_SCHEMA_VERSION' in RELATED_INVALIDATION_KNOBS,
    'DATASET_ASSEMBLY_SCHEMA_VERSION must stay documented as a separate dataset-contract knob'
  );
  // The two parser-output entries gate different artifacts and have different
  // encodings (string vs number) — they are not interchangeable keys.
  assert.notEqual(
    typeof SESSION_BLOB_OUTPUT.version,
    typeof REPO_MAP_OUTPUT.version,
    'the two parser-output knobs intentionally keep their original encodings'
  );
});
