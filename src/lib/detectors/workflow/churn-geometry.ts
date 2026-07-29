import type { Detector } from '../types';
import type { ChurnGeometryFile } from '../../parse-churn-geometry';
import { basename, newestIsoDate, short } from '../shared';

const MIN_GROSS_LINES = 20;
const MIN_REWORK_DISTANCE = 8;
const MIN_POST_STOP_GROSS_LINES = 8;

function rowScore(file: ChurnGeometryFile): number {
  return (
    file.postStopReeditRanges * 100 +
    file.reeditRanges * 20 +
    file.reworkDistance +
    file.grossLines / 100
  );
}

function isFinding(file: ChurnGeometryFile): boolean {
  if (
    file.postStopReeditRanges > 0 &&
    file.grossLines >= MIN_POST_STOP_GROSS_LINES
  ) {
    return true;
  }
  return file.grossLines >= MIN_GROSS_LINES && file.reworkDistance >= MIN_REWORK_DISTANCE;
}

function formatEvidence(file: ChurnGeometryFile): string {
  return (
    `${short(file.sessionId)} ${basename(file.filePath)}: ` +
    `${file.grossLines} gross lines / ${file.netLines} net, ` +
    `${file.reeditRanges} re-edit range(s), ` +
    `${file.postStopReeditRanges} after stop boundary`
  );
}

export const detector: Detector = {
  id: 'workflow.churn-geometry',
  category: 'workflow',
  dataDeps: ['churnGeometry'],
  rule(input) {
    const sessions = input.churnGeometry ?? [];
    const files = sessions.flatMap((session) => session.files).filter(isFinding);
    if (files.length === 0) return null;

    const ranked = [...files].sort((a, b) => rowScore(b) - rowScore(a));
    const top = ranked[0];
    // Anchored to the newest edit that PRODUCED the reported geometry — never
    // to `now`, and never to edits of files that did not qualify. A recent edit
    // to a calm file contributes to no reported row, so letting it set the date
    // would make old churn look freshly observed. The per-file timestamp is
    // derived while summarizing the COMPLETE edit set; `session.edits` is a
    // display-only slice capped at 200 rows and cannot support this claim.
    const asOf = newestIsoDate(files.map((file) => file.latestTimestamp));
    const severity =
      top.postStopReeditRanges > 0 || top.reworkDistance >= 20 ? 'warning' : 'info';

    return {
      id: 'workflow.churn-geometry',
      category: 'workflow',
      severity,
      title: 'Line-level edit churn points to refactor seams',
      detail:
        `${ranked.length} file(s) show high gross-low-net churn or repeated edits to the same line range after a stop boundary. ` +
        `${basename(top.filePath)} touched ${top.grossLines} gross line(s) for ${top.netLines} net line(s), ` +
        `with ${top.reeditRanges} re-edited range(s) and ${top.postStopReeditRanges} crossing a task boundary.`,
      action:
        'Use these files as refactor-seam candidates: stop earlier after the first working patch, run a focused verification, then extract or simplify the hot range before continuing.',
      affected: ranked.length,
      evidence: ranked.slice(0, 5).map(formatEvidence),
      view: 'files',
      provenance: {
        observations: [
          {
            claim: `${ranked.length} file(s) cleared at least one churn-geometry gate across ${sessions.length} session(s)`,
            source: 'parse-churn-geometry (churnGeometry[].files)',
            field: 'grossLines / reworkDistance / postStopReeditRanges',
            value: ranked.length,
          },
          {
            // NOT "the worst file": `ranked` is ordered by the composite
            // `rowScore` below, which no single source field holds, so calling
            // its head the maximum of any one field would be a false
            // superlative (the #3459 defect class). The claim states the
            // ranking basis instead.
            claim:
              `the highest-ranked file by the composite score is ${basename(top.filePath)} ` +
              `in session ${short(top.sessionId)}, with ${top.grossLines} gross line(s) ` +
              `for ${top.netLines} net`,
            source: 'parse-churn-geometry (churnGeometry[].files)',
            field: 'grossLines / netLines',
            value: top.grossLines,
          },
          {
            claim: `that file has ${top.reeditRanges} re-edited range(s), ${top.postStopReeditRanges} of them after a stop boundary, and a rework distance of ${top.reworkDistance}`,
            source: 'parse-churn-geometry (churnGeometry[].files)',
            field: 'reeditRanges / postStopReeditRanges / reworkDistance',
            value: top.postStopReeditRanges,
          },
          {
            claim:
              `a file qualifies at MIN_GROSS_LINES = ${MIN_GROSS_LINES} gross lines with ` +
              `MIN_REWORK_DISTANCE = ${MIN_REWORK_DISTANCE}, or at any post-stop re-edit ` +
              `with MIN_POST_STOP_GROSS_LINES = ${MIN_POST_STOP_GROSS_LINES} gross lines`,
            source: 'detectors/workflow/churn-geometry',
            field: 'MIN_GROSS_LINES / MIN_REWORK_DISTANCE / MIN_POST_STOP_GROSS_LINES',
            value: MIN_GROSS_LINES,
          },
          {
            claim:
              `ranking is by a composite score: postStopReeditRanges x 100 + reeditRanges x 20 ` +
              `+ reworkDistance + grossLines / 100`,
            source: 'detectors/workflow/churn-geometry',
            field: 'rowScore',
            value: Math.round(rowScore(top) * 100) / 100,
          },
        ],
        // What is measured is the GEOMETRY of the structured patches — how many
        // lines were written versus survived, and whether the same line range
        // was returned to. Whether that rework was wasted, and whether a
        // refactor would prevent it, are not measured; "refactor seam" in the
        // action is the inference. Sessions with no structured-patch data
        // contribute nothing rather than counting as clean.
        inference:
          'Gross-versus-net lines and repeat visits to one line range are counted from ' +
          'structured patches. High gross-low-net churn is read as a refactor-seam ' +
          'candidate — an interpretation of the geometry, not a measurement of wasted ' +
          'work or of what a refactor would save.',
        // Anchored to the newest OBSERVED edit, never to `now`.
        ...(asOf ? { asOf } : {}),
      },
    };
  },
};
