import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Boot-path wiring guard for #1242 (epic #975): the pure #1085 summarizer
// (`ingestModelEvalResults`) must be registered in `scripts/ingest.mjs`'s
// assembleArtifacts() behind the same existsSync + cachedArtifact discipline
// as every other optional artifact dir, and the resulting summary must be
// threaded into the assembleDataset() payload. vitest cannot BOOT the server
// module graph (that is exactly the #1013 zero-node_modules hazard, verified
// by container boot), but it CAN pin the wiring so a refactor that drops the
// registration or the dataset key fails here instead of silently shipping a
// dataset without the field. Same source-level technique as
// references-ingest-parity.test.ts (#541).

const ROOT = process.cwd();
const src = readFileSync(`${ROOT}/scripts/ingest.mjs`, 'utf8');

function assembleSection(fnName: string): string {
  const idx = src.indexOf(`export function ${fnName}`);
  expect(idx, `${fnName}() found in ingest.mjs`).toBeGreaterThan(-1);
  // Far larger than either function body; precise enough for containment checks.
  return src.slice(idx, idx + 20000);
}

describe('model-eval ingest boot wiring (#1242)', () => {
  it('declares the conventional results dir under ~/.claude', () => {
    expect(src).toContain(
      "const MODEL_EVAL_RESULTS_DIR = join(CLAUDE, 'model-evals', 'results');"
    );
  });

  it('imports the pure summarizer from the npm-free lib module', () => {
    expect(src).toContain("join(LIB, 'model-eval-ingest.ts')");
    expect(src).toContain('ingestModelEvalResults');
  });

  it('registers the dir behind an existsSync guard via cachedArtifact', () => {
    const section = assembleSection('assembleArtifacts');
    expect(section).toContain('if (existsSync(MODEL_EVAL_RESULTS_DIR))');
    expect(section).toContain("cachedArtifact(");
    expect(section).toContain("'model-eval-results'");
    // The parse callback ends in the summarizer, so the cached value is the
    // ModelEvalSummary rollup, not raw artifact bodies.
    expect(section).toContain('return ingestModelEvalResults(raws);');
    // Absent-dir default stays null — the no-op case ships a null field.
    expect(section).toContain('let modelEvalSummary = null;');
  });

  it('threads modelEvalSummary through assembleArtifacts into the dataset', () => {
    const artifacts = assembleSection('assembleArtifacts');
    // Returned from assembleArtifacts()...
    expect(artifacts).toMatch(/return \{[\s\S]*?modelEvalSummary,[\s\S]*?\};/);
    // ...destructured from assembleArtifacts() and re-emitted by the shared
    // assembly core (#2182 extracted the fold/aggregate build into
    // assembleDatasetCore(), consumed by BOTH the full dataset and the lighter
    // recs dataset)...
    const coreIdx = src.indexOf('function assembleDatasetCore');
    expect(coreIdx, 'assembleDatasetCore() found in ingest.mjs').toBeGreaterThan(-1);
    const core = src.slice(coreIdx, coreIdx + 20000);
    expect(core).toMatch(/\{[\s\S]*?modelEvalSummary,[\s\S]*?\} = assembleArtifacts\(\);/);
    const coreRet = core.indexOf('\n  return {');
    expect(coreRet).toBeGreaterThan(-1);
    expect(core.slice(coreRet)).toContain('modelEvalSummary,');
    // ...then destructured from assembleDatasetCore() and re-emitted as a
    // dataset key by the full assembleDataset().
    const dataset = assembleSection('assembleDataset');
    expect(dataset).toMatch(/\{[\s\S]*?modelEvalSummary,[\s\S]*?\} = assembleDatasetCore\(\);/);
    const retIdx = dataset.indexOf('\n  return {');
    expect(retIdx).toBeGreaterThan(-1);
    expect(dataset.slice(retIdx)).toContain('modelEvalSummary,');
  });

  it('threads modelEvalSummary into the recommendation input (#1086)', () => {
    // The act-now routing-gap detector reads `input.modelEvalSummary`, so the
    // recs route's input assembly must pass the dataset key through — same
    // source-level pin as the dataset threading above.
    const idx = src.indexOf('function assembleRecommendationContext');
    expect(idx, 'assembleRecommendationContext() found in ingest.mjs').toBeGreaterThan(-1);
    const section = src.slice(idx, idx + 8000);
    expect(section).toContain('modelEvalSummary: dataset.modelEvalSummary,');
    // BOTH RecommendationInput build sites must thread the key: the enterprise
    // context above AND the inline assembleRecommendationInput(...) call inside
    // assembleDataset() that drives the live /api/recommendations.json route —
    // missing the latter leaves the detector permanently dark there (#1086
    // review finding).
    const dataset = assembleSection('assembleDataset');
    const recsCall = dataset.indexOf('assembleRecommendationInput({');
    expect(recsCall, 'inline recs input call found in assembleDataset()').toBeGreaterThan(-1);
    const callEnd = dataset.indexOf('})', recsCall);
    expect(dataset.slice(recsCall, callEnd)).toContain('modelEvalSummary,');
  });

  it('caps and guards the artifact read like its sibling readers', () => {
    const section = assembleSection('assembleArtifacts');
    // Entry cap (early break in the listing loop, so memory stays O(cap)) +
    // per-file byte cap + per-file JSON.parse guard.
    expect(section).toContain('if (names.length >= ARTIFACT_DIR_MAX_ENTRIES) break;');
    expect(section).toContain(
      'readArtifactTextCappedSync(join(MODEL_EVAL_RESULTS_DIR, name))'
    );
    expect(section).toContain('/* malformed artifact file — skip */');
  });

  it('invalidates the dataset cache and the stat-gate when artifacts change', () => {
    // contentHash: a new/changed artifact must rebuild the compressed dataset,
    // guarded so the absent-dir hash input is byte-identical to before.
    expect(src).toContain('if (existsSync(MODEL_EVAL_RESULTS_DIR)) {');
    expect(src).toContain("hashTree(MODEL_EVAL_RESULTS_DIR, '', hash);");
    // sourceSignature: dropping an artifact (dir mtime moves) must trigger
    // re-ingest without waiting for unrelated transcript churn.
    const sigIdx = src.indexOf('export function sourceSignature');
    expect(src.slice(sigIdx, sigIdx + 6000)).toContain(
      'statSync(MODEL_EVAL_RESULTS_DIR).mtimeMs'
    );
  });
});
