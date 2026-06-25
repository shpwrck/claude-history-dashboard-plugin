/**
 * Static detector→input dependency introspection (#2080).
 *
 * `RecommendationInput` carries 40+ optional fields. Each detector declares the
 * subset it reads in `Detector.dataDeps`, but that declaration used to be pure
 * documentation: a detector could read an undeclared (and therefore possibly
 * `undefined`) field, compile clean, and silently emit nothing — the coupling
 * stayed hidden until a fixture happened to fire. This module makes `dataDeps`
 * load-bearing by parsing each detector's TypeScript source and extracting the
 * `RecommendationInput` fields it actually reads, so the catalog test can FAIL a
 * detector that reads a field it did not declare.
 *
 * It is a **static** check (TypeScript compiler API over source, no detector
 * execution), so it adds zero runtime behaviour to the engine — exactly the
 * auditability posture the repo requires of any recommendation-layer change.
 *
 * Test-only: this imports `typescript` (a devDependency) and walks the source
 * tree, so it must never be pulled into the shipped engine or any runtime chunk.
 * Only `data-deps.contract.test.ts` consumes it.
 */
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const DETECTORS_DIR = path.resolve(HERE, '.');
const INPUT_TYPE_NAME = 'RecommendationInput';

export interface DetectorSourceFacts {
  /** Absolute path to the detector source file. */
  file: string;
  /** Repo-relative path, for readable assertion messages. */
  relFile: string;
  /** The detector's declared `id` (string literal), if statically resolvable. */
  id: string | null;
  /** Declared `dataDeps` string literals, or null when the key is absent. */
  declaredDeps: string[] | null;
  /** Declared `dependsOn` string literals, or null when the key is absent. */
  declaredDependsOn: string[] | null;
  /**
   * The `RecommendationInput` fields this detector statically reads — every
   * `<input>.<field>`, `<input>['field']`, and `const { field } = <input>`
   * across the whole file, where `<input>` is any parameter the checker types as
   * `RecommendationInput` (and through `as`/parenthesized/non-null casts of it).
   */
  readFields: string[];
  /** Bare module specifiers this file imports from (for dependsOn edge checks). */
  importSpecifiers: string[];
}

function isDetectorSourceFile(file: string): boolean {
  if (!file.endsWith('.ts') || file.endsWith('.test.ts')) return false;
  if (file.endsWith(`${path.sep}index.ts`)) return false;
  const text = fs.readFileSync(file, 'utf8');
  // Match only a real top-level `export const detector: Detector = …`
  // declaration at line start — not the same literal appearing inside a comment
  // or regex (as it does in this introspection module itself).
  return /^export const detector\s*:/m.test(text);
}

function walkDetectorFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkDetectorFiles(p));
    else if (isDetectorSourceFile(p)) out.push(p);
  }
  return out;
}

/** Strip `as`, parenthesized, and non-null wrappers to reach the inner expression. */
function unwrap(node: ts.Expression): ts.Expression {
  let cur: ts.Expression = node;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    (ts.isSatisfiesExpression?.(cur) ?? false)
  ) {
    cur = (cur as ts.AsExpression | ts.ParenthesizedExpression | ts.NonNullExpression).expression;
  }
  return cur;
}

function isRecommendationInputType(type: ts.Type | undefined): boolean {
  if (!type) return false;
  const sym = type.getSymbol() ?? type.aliasSymbol;
  return sym?.getName() === INPUT_TYPE_NAME;
}

function stringLiteralsFromArray(
  node: ts.Expression,
  resolve: (e: ts.Expression) => string | null
): string[] {
  const inner = unwrap(node);
  if (!ts.isArrayLiteralExpression(inner)) return [];
  const out: string[] = [];
  for (const el of inner.elements) {
    // entries may be `'x'`, `'x' as keyof RecommendationInput`, or a const ref.
    const v = resolve(el);
    if (v !== null) out.push(v);
  }
  return out;
}

function analyzeFile(
  file: string,
  program: ts.Program,
  checker: ts.TypeChecker
): DetectorSourceFacts {
  const sf = program.getSourceFile(file);
  if (!sf) {
    throw new Error(`TypeScript program did not load detector source: ${file}`);
  }

  // 1) Identifiers the checker types as RecommendationInput (params across every
  //    local function — `rule`, `emitAll`, and private helpers).
  const inputIdents = new Set<string>();
  const collectIdents = (node: ts.Node): void => {
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      if (isRecommendationInputType(checker.getTypeAtLocation(node.name))) {
        inputIdents.add(node.name.text);
      }
    }
    ts.forEachChild(node, collectIdents);
  };
  collectIdents(sf);

  const isInputExpr = (expr: ts.Expression): boolean => {
    const u = unwrap(expr);
    return ts.isIdentifier(u) && inputIdents.has(u.text);
  };

  // 2) Read fields + descriptor literals.
  const readFields = new Set<string>();
  const importSpecifiers = new Set<string>();
  let id: string | null = null;
  let declaredDeps: string[] | null = null;
  let declaredDependsOn: string[] | null = null;

  // Map top-level `const NAME = 'literal'` so an `id: DETECTOR_ID` reference can
  // be resolved back to its string value.
  const stringConsts = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.initializer &&
        ts.isStringLiteral(decl.initializer)
      ) {
        stringConsts.set(decl.name.text, decl.initializer.text);
      }
    }
  }
  const resolveStringExpr = (expr: ts.Expression): string | null => {
    const u = unwrap(expr);
    if (ts.isStringLiteral(u)) return u.text;
    if (ts.isIdentifier(u) && stringConsts.has(u.text)) return stringConsts.get(u.text)!;
    return null;
  };

  const visit = (node: ts.Node): void => {
    // input.field
    if (ts.isPropertyAccessExpression(node) && isInputExpr(node.expression)) {
      readFields.add(node.name.text);
    }
    // input['field']
    if (
      ts.isElementAccessExpression(node) &&
      isInputExpr(node.expression) &&
      node.argumentExpression &&
      ts.isStringLiteral(node.argumentExpression)
    ) {
      readFields.add(node.argumentExpression.text);
    }
    // const { a, b: c } = input
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isInputExpr(node.initializer) &&
      ts.isObjectBindingPattern(node.name)
    ) {
      for (const el of node.name.elements) {
        const prop = el.propertyName ?? el.name;
        if (ts.isIdentifier(prop)) readFields.add(prop.text);
      }
    }
    // import ... from '<spec>'
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      importSpecifiers.add(node.moduleSpecifier.text);
    }
    // the `export const detector: Detector = { ... }` descriptor
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'detector' &&
      node.initializer
    ) {
      const init = unwrap(node.initializer);
      if (ts.isObjectLiteralExpression(init)) {
        for (const prop of init.properties) {
          if (!ts.isPropertyAssignment(prop) || !prop.name) continue;
          const key = prop.name.getText(sf);
          if (key === 'id') {
            id = resolveStringExpr(prop.initializer);
          } else if (key === 'dataDeps') {
            declaredDeps = stringLiteralsFromArray(prop.initializer, resolveStringExpr);
          } else if (key === 'dependsOn') {
            declaredDependsOn = stringLiteralsFromArray(prop.initializer, resolveStringExpr);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return {
    file,
    relFile: path.relative(REPO_ROOT, file),
    id,
    declaredDeps,
    declaredDependsOn,
    readFields: [...readFields].sort(),
    importSpecifiers: [...importSpecifiers],
  };
}

let cached: DetectorSourceFacts[] | null = null;

/**
 * Parse every detector source file and return its static dependency facts.
 * Memoized per process — building the TS program is the expensive step.
 */
export function analyzeDetectorSources(): DetectorSourceFacts[] {
  if (cached) return cached;
  const files = walkDetectorFiles(DETECTORS_DIR).sort();
  const configPath = ts.findConfigFile(REPO_ROOT, ts.sys.fileExists, 'tsconfig.app.json');
  if (!configPath) throw new Error('could not find tsconfig.app.json for detector analysis');
  const cfg = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, path.dirname(configPath));
  const program = ts.createProgram(files, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
  cached = files.map((f) => analyzeFile(f, program, checker));
  return cached;
}

/**
 * Resolve a `dependsOn` target id to the repo-relative module path of the
 * detector source that declares it, for the import-edge cross-check.
 */
export function detectorFileById(facts: DetectorSourceFacts[]): Map<string, DetectorSourceFacts> {
  const byId = new Map<string, DetectorSourceFacts>();
  for (const f of facts) {
    if (f.id) byId.set(f.id, f);
  }
  return byId;
}

/**
 * Does `source` import (transitively through this file's own import list) from
 * the module that defines `target`? We resolve each relative import specifier of
 * `source` against its directory and compare to `target`'s file path (with the
 * `.ts` extension restored). This keeps the dependsOn declaration honest: it
 * must reflect a real import edge, not an aspirational one.
 */
export function sourceImportsTarget(
  source: DetectorSourceFacts,
  target: DetectorSourceFacts
): boolean {
  const sourceDir = path.dirname(source.file);
  const targetNoExt = target.file.replace(/\.ts$/, '');
  for (const spec of source.importSpecifiers) {
    if (!spec.startsWith('.')) continue;
    const resolved = path.resolve(sourceDir, spec).replace(/\.ts$/, '');
    if (resolved === targetNoExt) return true;
  }
  return false;
}
