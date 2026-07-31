// Localization-quality probe for the repo-map gate — rebuilt for #3471.
//
// Extracted from scripts/repo-map-gate.mjs so its invariants are directly
// unit-testable (review r13-rev-perf, finding 3): the gate's subprocess suite
// anchors to a self-measured canonical baseline, which would silently inflate
// if a probe defect returned — the exact "test asserts the implementation, not
// the requirement" shape. The invariant tests import THIS module and pin the
// absolute semantics (reversed ranking scores 0, seed self-exclusion,
// permutation-invariant denominator) against hand-computed graphs.
//
// NOTE: this file is part of the gate's RANKING_SURFACE hash — changing it
// changes the metric's definition, so the budget's recorded baseline must be
// re-measured in the same commit.
//
// The previous probe had defects that made it unable to report the negative
// result its label promised (the same cannot-fail class as #3076 and #3452):
//
//   1. Its seeds were the HEAD OF THE RANKING UNDER TEST (`files.slice(0, 40)`),
//      so the ground truth moved with the thing being measured. A genuine
//      ranking regression could reshuffle the seed set and RAISE the score.
//   2. Each seed counted ITSELF as a touched file, and seeds were by
//      construction top-ranked, so a large share of "hits" were tautological.
//      Measured on this repo: a fully REVERSED ranking still scored 34.8%.
//   3. An empty probe returned 100 — a perfect score for having measured
//      nothing, which clears any floor by construction.
//
// The rebuild removes all three:
//
//   - EVERY ranked file is a seed. The seed set is the file list itself, so it
//     is invariant under any permutation of the ranking — no sampling knob to
//     widen (#3510) and no seed churn when one file lands (the old
//     denominator-growth alarms in the budget's relaxation ladder).
//   - Ground truth is the RESOLVED IMPORT EDGES: for each seed, the intra-repo
//     files it imports, seed EXCLUDED from its own touched set. Recall is the
//     share of those edges whose target ranks inside the top-K head. A
//     reversed ranking now measures 0.0%.
//   - K is a FRACTION of the ranked file count (`localizationTopKPct`), not an
//     absolute count, so repo growth widens the slice proportionally instead
//     of mechanically depressing recall (the #3471 ratchet: floor lowered 3x,
//     absolute top-K widened 10x, never once constraining ranking).
//   - No evidence means NOT EVALUABLE — never a score. The gate treats a
//     non-evaluable probe as an error in gating mode.
//
// What this measures, stated honestly: of the repo's resolved import edges, how
// often the imported file sits in the ranked head — a structural
// self-consistency tripwire for the ranking/extraction pipeline (broken import
// extraction, misordered hubs, and resolution regressions all crater it), not
// real-session recall. The #889 join can later substitute real sampled-history
// touched sets.

/**
 * @param {{ files: Array<{ path: string, imports: string[] }> }} map
 *   ranked file list (most-referenced first) — the ranking under test
 * @param {number} topKPct  head slice width as a percentage of the ranked count
 * @returns {{ evaluable: boolean, recallPct: number|null, topK: number,
 *             denominator: number, hits: number }}
 */
export function localizationProbe(map, topKPct) {
  const files = map.files;
  const rankIndex = new Map(files.map((f, i) => [f.path, i]));
  const stemOf = (p) => p.replace(/\.[^./]+$/, '');
  const byStem = new Map(files.map((f) => [stemOf(f.path), f.path]));

  const resolveImport = (fromPath, spec) => {
    if (!spec.startsWith('.')) return null;
    const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
    const parts = (dir ? dir.split('/') : []).concat(stemOf(spec).split('/'));
    const stack = [];
    for (const p of parts) {
      if (p === '' || p === '.') continue;
      if (p === '..') stack.pop();
      else stack.push(p);
    }
    const joined = stack.join('/');
    return byStem.get(joined) ?? byStem.get(`${joined}/index`) ?? null;
  };

  // Ceil of the exact rational pct*n/100 — the 1e-9 backs out float noise so
  // e.g. 7% of 100 files is K=7, not ceil(7.000000000000001)=8.
  const topK = Math.max(1, Math.ceil((topKPct / 100) * files.length - 1e-9));
  let denominator = 0;
  let hits = 0;
  for (const seed of files) {
    const touched = new Set();
    for (const spec of seed.imports) {
      const target = resolveImport(seed.path, spec);
      // The seed never counts as its own hit — that was defect (2) above.
      if (target && target !== seed.path) touched.add(target);
    }
    for (const path of touched) {
      denominator++;
      const rank = rankIndex.get(path);
      if (rank != null && rank < topK) hits++;
    }
  }
  if (denominator === 0) {
    return { evaluable: false, recallPct: null, topK, denominator: 0, hits: 0 };
  }
  return { evaluable: true, recallPct: (hits / denominator) * 100, topK, denominator, hits };
}
