import type { AppliedMarkers, Detector, RecommendationInput } from '../types';
import type { PlanSignature } from '../../parse-plans';

/**
 * Surface large or sprawling plans (many file-change refs or high word count)
 * that carry no Verification section (#565, P5 Riley). The structural fields
 * do not measure whether a plan later shipped or whether it was under-specified;
 * they only support a review cue before the plan runs.
 */

const FILE_REFS_THRESHOLD = 6;
const WORDS_THRESHOLD = 1000;

const MARKERS_PLAN_VERIFICATION: AppliedMarkers = {
  headings: [/^##\s+plan verification/i],
  bodyPhrases: [
    'Verification section describing the minimal observable signal',
    'plan is not ready to run',
  ],
};

export const detector: Detector = {
  id: 'workflow.plan-missing-verification',
  appliedMarkers: MARKERS_PLAN_VERIFICATION,
  category: 'workflow',
  dataDeps: ['plans'],
  rule(input: RecommendationInput) {
    // `plans` is a first-class optional field on RecommendationInput.
    const data = (input as RecommendationInput & { plans?: PlanSignature[] }).plans ?? [];
    if (data.length === 0) return null;

    const flagged = data.filter(
      (p) =>
        !p.hasVerification &&
        (p.fileRefs >= FILE_REFS_THRESHOLD || p.words >= WORDS_THRESHOLD)
    );

    if (flagged.length === 0) return null;

    const total = data.length;
    const pct = Math.round((flagged.length / total) * 100);
    const names = flagged.slice(0, 5).map((p) => p.name);

    return {
      id: 'workflow.plan-missing-verification',
      category: 'workflow',
      severity: flagged.length >= 3 ? 'warning' : 'info',
      title: 'Large plans are missing a Verification section',
      detail:
        `${flagged.length} of ${total} plan(s) (${pct}%) exceed the complexity threshold` +
        ` (${FILE_REFS_THRESHOLD}+ file refs or ${WORDS_THRESHOLD}+ words) and carry no` +
        ` ## Verification or ## Test section.`,
      action:
        `Add a ## Verification section to each large plan before running it.` +
        ` Describe the minimal observable signal that proves the plan succeeded.`,
      affected: flagged.length,
      evidence: names,
      fix: {
        target: 'CLAUDE.md',
        fixKind: 'validated',
        label: 'Add plan Verification rule',
        note:
          'Paste this into your CLAUDE.md to enforce a Verification section on large plans.',
        snippet:
          `## Plan Verification discipline\n\n` +
          `Before executing any plan that touches ${FILE_REFS_THRESHOLD}+ files or exceeds` +
          ` ${WORDS_THRESHOLD} words, it MUST include a ## Verification section describing` +
          ` the minimal observable signal that proves the plan succeeded.` +
          ` No Verification section = plan is not ready to run.`,
        appliedMarkers: MARKERS_PLAN_VERIFICATION,
      },
      provenance: {
        observations: [
          {
            claim:
              `${flagged.length} of ${total} plan(s) crossed a complexity threshold ` +
              `without a Verification or Test section (${pct}%)`,
            source: '~/.claude/plans/*.md via parse-plans',
            field: 'flagged.length / plans.length',
            value: `${flagged.length}/${total}/${pct}`,
          },
          {
            claim: `the file-reference threshold is ${FILE_REFS_THRESHOLD}`,
            source: 'workflow.plan-missing-verification detector',
            field: 'FILE_REFS_THRESHOLD',
            value: FILE_REFS_THRESHOLD,
          },
          {
            claim: `the word-count threshold is ${WORDS_THRESHOLD}`,
            source: 'workflow.plan-missing-verification detector',
            field: 'WORDS_THRESHOLD',
            value: WORDS_THRESHOLD,
          },
          {
            claim:
              'the qualifying plan rows record each source id, threshold-driving ' +
              'counts, and missing-verification flag',
            source: '~/.claude/plans/*.md via parse-plans',
            field: 'plans[].{id,fileRefs,words,hasVerification}',
            value: JSON.stringify(
              flagged.map(({ id, fileRefs, words, hasVerification }) => ({
                id,
                fileRefs,
                words,
                hasVerification,
              }))
            ),
          },
        ],
        inference:
          'Crossing a size threshold without a Verification section is a structural ' +
          'review cue. The signature does not measure actual underspecification or ' +
          'shipping outcomes.',
        // PlanSignature intentionally carries no timestamp. An `asOf` date here
        // would be invented rather than observed.
      },
    };
  },
};
