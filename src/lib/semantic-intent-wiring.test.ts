import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Boot-path wiring guard for #2574 (epic #2177), in the same source-level style
 * as `model-eval-ingest-wiring.test.ts` and `references-ingest-parity.test.ts`:
 * vitest cannot BOOT the server module graph (that is the #1013
 * zero-node_modules hazard, verified by container boot), but it CAN pin the
 * wiring so a refactor that drops the registration, the dataset key, or — most
 * importantly — the OPT-IN GATE fails here instead of silently shipping.
 *
 * The flag-off guarantee is the load-bearing assertion in this file. AGENTS.md
 * requires that with `CHD_SEMANTIC_INTENT` unset the default deployment path is
 * byte-identical and makes zero external calls. That is only true if the flag is
 * checked BEFORE every filesystem touch — the `existsSync`, the cache-signature
 * hash, and the source-signature stat. A refactor that reorders any of those to
 * "check the dir, then the flag" would still *work*, and would still ship a null
 * key, while quietly breaking the guarantee. Hence the ordering assertions.
 */

const ROOT = process.cwd();
const src = readFileSync(`${ROOT}/scripts/ingest.mjs`, 'utf8');

function section(fnName: string, span = 20000): string {
  const idx = src.indexOf(`export function ${fnName}`);
  expect(idx, `${fnName}() found in ingest.mjs`).toBeGreaterThan(-1);
  return src.slice(idx, idx + span);
}

describe('semantic-intent boot wiring (#2574)', () => {
  it('declares the conventional receipts dir under ~/.claude', () => {
    expect(src).toContain(
      "const SEMANTIC_INTENT_DIR = join(CLAUDE, 'model-evals', 'semantic-intent');"
    );
  });

  it('gates the whole feature on CHD_SEMANTIC_INTENT=1', () => {
    expect(src).toContain(
      "const SEMANTIC_INTENT_ENABLED = process.env.CHD_SEMANTIC_INTENT === '1';"
    );
  });

  it('imports the pure parser from the npm-free lib module', () => {
    expect(src).toContain("join(LIB, 'semantic-intent.ts')");
    expect(src).toContain('ingestSemanticIntent');
  });

  it('registers the dir behind the flag AND an existsSync guard, via cachedArtifact', () => {
    const s = section('assembleArtifacts');
    expect(s).toContain(
      'if (SEMANTIC_INTENT_ENABLED && existsSync(SEMANTIC_INTENT_DIR))'
    );
    expect(s).toContain("'semantic-intent'");
    expect(s).toContain('return ingestSemanticIntent(raws);');
    // Flag-off / absent-dir default: a null field, never a fabricated empty summary.
    expect(s).toContain('let semanticIntent = null;');
  });

  it('checks the flag BEFORE touching the filesystem (the flag-off guarantee)', () => {
    const s = section('assembleArtifacts');
    const guard = s.indexOf('SEMANTIC_INTENT_ENABLED && existsSync(SEMANTIC_INTENT_DIR)');
    expect(guard, 'flag-first guard present').toBeGreaterThan(-1);
    // `&&` short-circuits, so flag-first is exactly what makes "no stat when off"
    // true. The reversed form would read the dir before consulting the flag.
    expect(s).not.toContain('existsSync(SEMANTIC_INTENT_DIR) && SEMANTIC_INTENT_ENABLED');
  });

  it('contributes to the cache signature only when enabled', () => {
    // A flag-off deploy must hash byte-identically to a pre-#2574 build, so the
    // dir may not enter the content hash on the default path.
    expect(src).toContain(
      'if (SEMANTIC_INTENT_ENABLED && existsSync(SEMANTIC_INTENT_DIR)) {'
    );
    expect(src).toContain("hashTree(SEMANTIC_INTENT_DIR, '', hash);");
  });

  it('contributes to the source signature only when enabled', () => {
    const sig = section('sourceSignature', 8000);
    const flagIdx = sig.indexOf('if (SEMANTIC_INTENT_ENABLED) {');
    const statIdx = sig.indexOf('statSync(SEMANTIC_INTENT_DIR)');
    expect(flagIdx, 'source-signature stat is flag-gated').toBeGreaterThan(-1);
    expect(statIdx).toBeGreaterThan(flagIdx);
  });

  it('threads semanticIntent from assembleArtifacts into the dataset', () => {
    const artifacts = section('assembleArtifacts');
    expect(artifacts).toMatch(/return \{[\s\S]*?semanticIntent,[\s\S]*?\};/);

    const coreIdx = src.indexOf('function assembleDatasetCore');
    expect(coreIdx, 'assembleDatasetCore() found').toBeGreaterThan(-1);
    const core = src.slice(coreIdx, coreIdx + 20000);
    expect(core).toMatch(/\{[\s\S]*?semanticIntent,[\s\S]*?\} = assembleArtifacts\(\);/);
    const coreRet = core.indexOf('\n  return {');
    expect(coreRet).toBeGreaterThan(-1);
    expect(core.slice(coreRet)).toContain('semanticIntent,');

    const dataset = section('assembleDataset');
    expect(dataset).toMatch(/\{[\s\S]*?semanticIntent,[\s\S]*?\} = assembleDatasetCore\(\);/);
    const retIdx = dataset.indexOf('\n  return {');
    expect(retIdx).toBeGreaterThan(-1);
    expect(dataset.slice(retIdx)).toContain('semanticIntent,');
  });

  it('threads semanticIntent into BOTH recommendation-input build sites', () => {
    // Missing either one leaves the #2647 enrichment permanently dark on that
    // route — the exact defect the #1086 review caught for modelEvalSummary.
    const ctxIdx = src.indexOf('function assembleRecommendationContext');
    expect(ctxIdx, 'assembleRecommendationContext() found').toBeGreaterThan(-1);
    expect(src.slice(ctxIdx, ctxIdx + 8000)).toContain(
      'semanticIntent: dataset.semanticIntent,'
    );

    const dataset = section('assembleDataset');
    const recsCall = dataset.indexOf('assembleRecommendationInput({');
    expect(recsCall, 'inline recs input call found').toBeGreaterThan(-1);
    const callEnd = dataset.indexOf('})', recsCall);
    expect(dataset.slice(recsCall, callEnd)).toContain('semanticIntent,');
  });

  it('caps and guards the artifact read like its sibling readers', () => {
    const s = section('assembleArtifacts');
    expect(s).toContain(
      'readArtifactTextCappedSync(join(SEMANTIC_INTENT_DIR, name))'
    );
    expect(s).toContain('if (names.length >= ARTIFACT_DIR_MAX_ENTRIES) break;');
  });

  it('never spawns, fetches, or configures a classifier from the repo', () => {
    // The repo defines the artifact contract + parser only. If this ever fails,
    // the boundary in the module header has been crossed.
    const parser = readFileSync(`${ROOT}/src/lib/semantic-intent.ts`, 'utf8');
    for (const forbidden of ['fetch(', 'require(', 'child_process', 'node:fs', 'node:net', 'http']) {
      expect(parser, `parser must not reference ${forbidden}`).not.toContain(forbidden);
    }
    expect(parser).not.toContain('import ');
  });
});
