import type { Detector } from '../types';
import { basename, HIGH_CHURN, newestIsoDate } from '../shared';
import { topChurnFiles } from '../../parse-files';

/**
 * How many ranked files `topChurnFiles` is asked for.
 *
 * Named rather than left implicit (it is also the parser's default) so the
 * provenance can cite the cap it reports under: the rows returned are the N
 * highest-churn paths, so the qualifying COUNT below is "qualifying within the
 * top N", not "qualifying across the whole corpus". Stating that in the
 * observation is the honest move; silently widening the cap would change the
 * number this card displays, and the `detail` wording is a separate finding
 * (#3232 is scoped to provenance).
 */
const RANKED_LIMIT = 20;

/** Files mutated over and over — possible design smell. */
export const detector: Detector = {
  id: 'workflow.file-churn',
  category: 'workflow',
  dataDeps: ['toolData'],
  rule(input) {
    // One row MORE than the window is requested so real truncation is
    // detectable. `topChurnFiles` slices, so a result of exactly RANKED_LIMIT
    // rows is ambiguous — a corpus with exactly 20 files was not truncated at
    // all, and calling its count a floor would be false. Asking for 21 and
    // seeing 21 is proof that something was dropped; the extra row is then
    // discarded so the reported count is unchanged.
    const probed = topChurnFiles(input.toolData, RANKED_LIMIT + 1);
    const ranked = probed.slice(0, RANKED_LIMIT);
    // Truncation only MATTERS when the row that fell off would itself have
    // qualified. Ranking is descending by churn, so if the 21st path is below
    // HIGH_CHURN then nothing qualifying was omitted and the reported count is
    // exact — calling it a floor there would be its own false claim.
    const truncated = probed.length > RANKED_LIMIT && probed[RANKED_LIMIT].churn >= HIGH_CHURN;
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
        .slice(0, 5)
        .map((c) => `${basename(c.filePath)}, ${c.churn} edits / ${c.sessions} sessions`),
      view: 'files',
      provenance: {
        observations: [
          {
            claim:
              `${churn.length} of the ${ranked.length} ranked file path(s) reached ` +
              `HIGH_CHURN = ${HIGH_CHURN} mutating operations` +
              (truncated
                ? ` (the ranking window is capped at ${RANKED_LIMIT} and more paths than that qualified, so this is a floor)`
                : ''),
            // The probe limit, not the display limit: the floor assertion is
            // established by asking for one row PAST the window and inspecting
            // it, so citing `limit 20` would leave the claim unreproducible.
            source:
              `parse-files (topChurnFiles over toolData[].calls, probed at limit ` +
              `${RANKED_LIMIT + 1}, reported over the top ${RANKED_LIMIT})`,
            field: 'churn',
            value: churn.length,
          },
          {
            claim: `the highest churn observed is ${worst.churn} mutating op(s) on ${basename(worst.filePath)}, across ${worst.sessions} session(s)`,
            source: `parse-files (topChurnFiles over toolData[].calls, limit ${RANKED_LIMIT})`,
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
        // bounded by the ranked window above, so it is a floor when more than
        // RANKED_LIMIT files qualify.
        inference:
          `Edit/Write calls per file path are counted; lines changed, rework, and ` +
          `intent are not measured here. Repeated mutation of one path is treated as ` +
          `a refactor-candidate signal rather than proof of a design problem. Ranking ` +
          `considers at most the ${RANKED_LIMIT} highest-churn paths` +
          (truncated
            ? `, and more than that qualified here, so the count is a floor rather ` +
              `than a corpus-wide total.`
            : `, which did not bind here.`),
        // Anchored to the newest OBSERVED tool call, never to `now`: the churn
        // totals are only true as of the last call the corpus recorded.
        ...(asOf ? { asOf } : {}),
      },
    };
  },
};
