import type { Detector } from '../types';
import { basename, HIGH_CHURN, newestIsoDate } from '../shared';
import { topChurnFiles } from '../../parse-files';

const EVIDENCE_LIMIT = 5;
const LEGACY_RANKED_LIMIT = 20;

/** Files mutated over and over — possible design smell. */
export const detector: Detector = {
  id: 'workflow.file-churn',
  category: 'workflow',
  dataDeps: ['toolData'],
  rule(input) {
    // Probe one row beyond the established top-20 output. Only pay for an
    // unbounded result when the 21st row proves that the legacy window would
    // omit a qualifying path.
    const probe = topChurnFiles(input.toolData, LEGACY_RANKED_LIMIT + 1);
    const needsFullCount =
      probe.length > LEGACY_RANKED_LIMIT &&
      probe[LEGACY_RANKED_LIMIT].churn >= HIGH_CHURN;
    const ranked = needsFullCount
      ? topChurnFiles(input.toolData, Number.POSITIVE_INFINITY)
      : probe.slice(0, LEGACY_RANKED_LIMIT);
    const churn = ranked.filter((c) => c.churn >= HIGH_CHURN);
    if (churn.length === 0) return null;
    // `topChurnFiles` sorts by `churn` descending, so `churn[0]` already IS the
    // maximum — but the citation folds over the field it cites rather than
    // trusting an upstream sort order, so a later re-ranking cannot silently
    // turn this into a false superlative (the #3459 defect class).
    const worst = churn.reduce((a, b) => (b.churn > a.churn ? b : a));
    // Dated from the newest MUTATING call counted into the QUALIFYING rows, not
    // from every ranked path or the newest call in the corpus: neither a newer
    // low-churn path nor a later Read/Bash contributes to this recommendation,
    // so anchoring to one would assert a freshness the evidence does not have.
    const asOf = newestIsoDate(churn.map((c) => c.latestTimestamp));
    return {
      id: 'workflow.file-churn',
      category: 'workflow',
      severity: 'info',
      title: 'High-churn files',
      detail: `${churn.length} file(s) were edited/written ${HIGH_CHURN}+ times. Heavy churn can signal an unclear interface or repeated trial-and-error.`,
      action: 'Review whether these files need refactoring or clearer up-front specs to reduce rework.',
      affected: churn.length,
      evidence: churn
        .slice(0, EVIDENCE_LIMIT)
        .map((c) => `${basename(c.filePath)}, ${c.churn} edits / ${c.sessions} sessions`),
      view: 'files',
      provenance: {
        observations: [
          {
            claim:
              `${churn.length} of the ${ranked.length} ` +
              `${needsFullCount ? 'observed' : 'ranked'} file path(s) reached ` +
              `HIGH_CHURN = ${HIGH_CHURN} mutating operations`,
            source:
              needsFullCount
                ? 'parse-files (topChurnFiles over all toolData[].calls, unbounded ranking)'
                : `parse-files (topChurnFiles over toolData[].calls, probed at limit ${LEGACY_RANKED_LIMIT + 1}, reported over the top ${LEGACY_RANKED_LIMIT})`,
            field: 'churn',
            value: churn.length,
          },
          {
            claim: `the highest churn observed is ${worst.churn} mutating op(s) on ${basename(worst.filePath)}, across ${worst.sessions} session(s)`,
            source:
              needsFullCount
                ? 'parse-files (topChurnFiles over all toolData[].calls, unbounded ranking)'
                : `parse-files (topChurnFiles over toolData[].calls, limit ${LEGACY_RANKED_LIMIT})`,
            field: 'churn / sessions',
            value: worst.churn,
          },
          {
            claim: `a file qualifies at HIGH_CHURN = ${HIGH_CHURN} mutating operations`,
            source: 'detectors/shared',
            field: 'HIGH_CHURN',
            value: HIGH_CHURN,
          },
        ],
        // What is counted is MUTATING TOOL CALLS (Edit/Write family) per file
        // path, not lines changed and not rework: a file legitimately edited
        // many times counts the same as one thrashed. The design-smell reading
        // in `detail` is the inference, not the measurement. The count is also
        // calculated over the full aggregation when the probe proves the legacy
        // ranking window would omit a qualifying path.
        inference:
          `Edit/Write calls per file path are counted; lines changed, rework, and ` +
          `intent are not measured here. Repeated mutation of one path is treated as ` +
          `a refactor-candidate signal rather than proof of a design problem. ` +
          (needsFullCount
            ? `The displayed count covers the full observed path aggregation; evidence shows ` +
              `only the top ${EVIDENCE_LIMIT} qualifying rows.`
            : `Ranking considers at most the ${LEGACY_RANKED_LIMIT} highest-churn paths, ` +
              `which did not bind here.`),
        // Anchored to the newest OBSERVED tool call, never to `now`: the churn
        // totals are only true as of the last call the corpus recorded.
        ...(asOf ? { asOf } : {}),
      },
    };
  },
};
