import type { AppliedMarkers, Detector, RecommendationInput } from '../types';
import type { PlanSignature } from '../../parse-plans';

/**
 * Plans that are large or sprawling (many file-change refs or high word count)
 * tend to ship WITHOUT a Verification section — exactly the plans where a
 * missing Verification is most costly (#565, P5 Riley).
 *
 * When a plan crosses ~6 file refs OR ~1000 words and has no Verification
 * section, the user should be nudged to add one before running the plan.
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
  dataDeps: [],   // plans is injected as a non-standard extension field
  rule(input: RecommendationInput) {
    // Read the optional `plans` field without touching the shared RecommendationInput
    // type — the field is wired by the caller when plan data is available.
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
        ` ## Verification or ## Test section — the plans most likely to ship under-specified.`,
      action:
        `Add a ## Verification section to each large plan before running it.` +
        ` Describe the minimal observable signal that proves the plan succeeded.`,
      affected: flagged.length,
      evidence: names,
      fix: {
        target: 'CLAUDE.md',
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
    };
  },
};
