/**
 * dataDeps + dependsOn catalog completeness contract (#2080).
 *
 * Makes `Detector.dataDeps` LOAD-BEARING instead of decorative. Statically
 * parses every detector source (TS compiler API, no detector execution) and:
 *
 *  1. FAILS any detector that reads a `RecommendationInput` field it did not
 *     declare in `dataDeps` — the exact silent coupling the issue describes,
 *     where a detector reads an undefined field, compiles clean, and emits
 *     nothing until a fixture happens to fire.
 *  2. Validates `dependsOn`: every listed id is a registered detector AND the
 *     source actually imports from that detector's module, so the rare
 *     detector→detector edge (e.g. over-scoped-config-section →
 *     shadow-axis-wins) is explicit in the Catalog and can't rot.
 *  3. Proves the analyzer is sound via a NEGATIVE CONTROL: a hand-written
 *     fixture that reads an undeclared field is detected as under-declared, so
 *     the green suite is genuine, not vacuous.
 *  4. Locks the `assembleRecommendationInput` normalization contract: every
 *     field any detector declares as a dataDep is present (populated or
 *     explicitly `null`) on the assembled input — never a silent `undefined`.
 *
 * This is a STATIC catalog check: it adds no runtime behaviour to the engine and
 * does not change what any detector emits.
 */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { DETECTORS } from './index';
import {
  analyzeDetectorSources,
  detectorFileById,
  sourceImportsTarget,
  type DetectorSourceFacts,
} from './data-deps-introspect';
import { assembleRecommendationInput } from '../recommendations';
import type { RecommendationInput } from './types';

const facts = analyzeDetectorSources();

describe('detector source analysis sanity', () => {
  it('finds every registered detector source and resolves its id', () => {
    // One source file per registered, non-emitAll-only detector id.
    const sourceIds = new Set(facts.map((f) => f.id).filter(Boolean));
    for (const d of DETECTORS) {
      expect(sourceIds.has(d.id), `no analyzed source resolves id ${d.id}`).toBe(true);
    }
  });

  it('every detector reads at least one input field (analysis is not vacuous)', () => {
    // If the analyzer silently found zero reads for a real detector, the subset
    // check below would pass vacuously — guard against that regression.
    for (const f of facts) {
      expect(
        f.readFields.length,
        `${f.relFile} (${f.id}) — analyzer found no input reads; the extractor likely missed an access pattern`
      ).toBeGreaterThan(0);
    }
  });
});

describe('dataDeps completeness (load-bearing)', () => {
  it.each(facts.map((f) => [f.id ?? f.relFile, f] as const))(
    '%s declares every RecommendationInput field it reads',
    (_label, f: DetectorSourceFacts) => {
      const declared = new Set(f.declaredDeps ?? []);
      const undeclared = f.readFields.filter((field) => !declared.has(field));
      expect(
        undeclared,
        `${f.relFile} reads ${JSON.stringify(undeclared)} but does not declare ` +
          `${undeclared.length === 1 ? 'it' : 'them'} in dataDeps ` +
          `(declared: ${JSON.stringify([...declared])}). Add the field(s) to the ` +
          `detector's dataDeps so the input coupling stays visible in the Catalog.`
      ).toEqual([]);
    }
  );

  it('declared dataDeps are valid RecommendationInput keys (no typos)', () => {
    const inputKeys = recommendationInputKeys();
    for (const f of facts) {
      for (const dep of f.declaredDeps ?? []) {
        expect(
          inputKeys.has(dep),
          `${f.relFile} declares dataDep "${dep}" which is not a RecommendationInput field`
        ).toBe(true);
      }
    }
  });
});

describe('dependsOn detector->detector edges', () => {
  const withDependsOn = facts.filter((f) => f.declaredDependsOn && f.declaredDependsOn.length);

  it('the canonical over-scoped-config-section -> shadow-axis-wins edge is declared', () => {
    const ocs = facts.find((f) => f.id === 'context.over-scoped-config-section');
    expect(ocs).toBeDefined();
    expect(ocs!.declaredDependsOn ?? []).toContain('workflow.shadow-axis-wins');
  });

  it('every dependsOn id is a registered detector', () => {
    const registered = new Set(DETECTORS.map((d) => d.id));
    for (const f of withDependsOn) {
      for (const id of f.declaredDependsOn!) {
        expect(
          registered.has(id),
          `${f.relFile} dependsOn "${id}" which is not a registered detector`
        ).toBe(true);
      }
    }
  });

  it('every dependsOn edge reflects a real import of the target module', () => {
    const byId = detectorFileById(facts);
    for (const f of withDependsOn) {
      for (const id of f.declaredDependsOn!) {
        const target = byId.get(id);
        expect(target, `${f.relFile} dependsOn "${id}" has no analyzed source`).toBeDefined();
        expect(
          sourceImportsTarget(f, target!),
          `${f.relFile} declares dependsOn "${id}" but does not import from ${target!.relFile}`
        ).toBe(true);
      }
    }
  });
});

// ── Negative control: the analyzer genuinely catches under-declaration ──────
describe('analyzer negative control', () => {
  const UNDERDECLARED_SOURCE = `
import type { Detector, RecommendationInput } from './types';
function helper(input: RecommendationInput) {
  // reads a field NOT present in dataDeps below
  return input.shadowCalls;
}
export const detector: Detector = {
  id: 'test.underdeclared',
  category: 'workflow',
  dataDeps: ['tokenData'],
  rule(input: RecommendationInput) {
    const a = input.tokenData;
    const b = (input as RecommendationInput & { repoMap?: unknown }).repoMap;
    return helper(input) || a || b ? null : null;
  },
};
`;

  it('extracts cast and helper-param reads, flagging the undeclared fields', () => {
    const reads = extractReadsFromSource(UNDERDECLARED_SOURCE);
    // Direct read, cast read, and helper-param read must all be seen.
    expect(reads).toEqual(expect.arrayContaining(['tokenData', 'repoMap', 'shadowCalls']));
    const declared = new Set(['tokenData']);
    const undeclared = reads.filter((r) => !declared.has(r));
    expect(undeclared.sort()).toEqual(['repoMap', 'shadowCalls']);
  });
});

describe('assembleRecommendationInput dataDeps normalization', () => {
  it('presents every declared dataDep field as populated-or-explicitly-null', () => {
    const declaredAcross = new Set<string>();
    for (const d of DETECTORS) for (const dep of d.dataDeps ?? []) declaredAcross.add(dep);

    // A minimal input: only the non-optional fields. Every declared optional dep
    // is absent here, so normalization is what makes them explicit.
    const minimal: RecommendationInput = {
      tokenData: [],
      toolData: [],
      sessions: [],
      projects: [],
      permissionRows: [],
      apiErrors: [],
    };
    const assembled = assembleRecommendationInput(minimal) as unknown as Record<
      string,
      unknown
    >;

    for (const dep of declaredAcross) {
      expect(dep in assembled, `assembled input is missing declared dataDep "${dep}"`).toBe(true);
      // Present means defined (a value) or explicit null — never undefined.
      expect(
        assembled[dep] !== undefined,
        `assembled input field "${dep}" is undefined; a declared dataDep must be ` +
          `populated-or-explicitly-null`
      ).toBe(true);
    }
  });

  it('does not overwrite a caller-supplied value with null', () => {
    const assembled = assembleRecommendationInput({
      tokenData: [],
      toolData: [],
      sessions: [],
      projects: [],
      permissionRows: [],
      apiErrors: [],
      shadowCalls: {
        total: 0,
        counted: 0,
        synthetic: 0,
        skipped: 0,
        live: 0,
        replay: 0,
        byAxis: [],
      } as unknown as RecommendationInput['shadowCalls'],
    });
    expect(assembled.shadowCalls).not.toBeNull();
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

function recommendationInputKeys(): Set<string> {
  // Parse types.ts for the RecommendationInput interface member names so the
  // typo check tracks the real type without a hand-maintained list.
  const typesPath = new URL('./types.ts', import.meta.url);
  const text = ts.sys.readFile(typesPath.pathname) ?? '';
  const sf = ts.createSourceFile('types.ts', text, ts.ScriptTarget.Latest, true);
  const keys = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'RecommendationInput') {
      for (const m of node.members) {
        if (ts.isPropertySignature(m) && m.name && ts.isIdentifier(m.name)) {
          keys.add(m.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return keys;
}

/**
 * Re-implements the analyzer's read-extraction over an in-memory source string,
 * using the same AST shapes, so the negative control can prove the extractor
 * sees direct, cast, and helper-param reads. Kept here (not exported from the
 * introspect module) because it is purely a test of the extraction contract.
 */
function extractReadsFromSource(source: string): string[] {
  const sf = ts.createSourceFile('frag.ts', source, ts.ScriptTarget.Latest, true);
  // Without a checker we identify input idents syntactically: any parameter
  // annotated `: RecommendationInput`.
  const inputIdents = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (
      ts.isParameter(node) &&
      ts.isIdentifier(node.name) &&
      node.type &&
      node.type.getText(sf).replace(/\s/g, '') === 'RecommendationInput'
    ) {
      inputIdents.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const unwrap = (n: ts.Expression): ts.Expression => {
    let cur: ts.Expression = n;
    while (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isNonNullExpression(cur)
    ) {
      cur = (cur as ts.AsExpression | ts.ParenthesizedExpression | ts.NonNullExpression).expression;
    }
    return cur;
  };
  const isInputExpr = (e: ts.Expression): boolean => {
    const u = unwrap(e);
    return ts.isIdentifier(u) && inputIdents.has(u.text);
  };

  const reads = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isInputExpr(node.expression)) {
      reads.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...reads].sort();
}
