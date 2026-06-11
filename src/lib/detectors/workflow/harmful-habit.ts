import type { Detector, RecSeverity } from '../types';
import { short } from '../shared';
import {
  analyzeHabitImpact,
  type HabitFactor,
  type SessionOutcomeTag,
} from '../../parse-timeline-success';

// Turn the habit-impact view's `hurts` verdict into a ranked, actionable
// recommendation (#549). The Patterns view (SessionPatterns.tsx) already splits
// sessions one factor at a time and derives a helps/hurts/mixed verdict, but no
// detector consumed it — so a habit that tracks with WORSE outcomes produced
// zero recommendations and the digest / habit-factor cell had nothing to
// deep-link to.
//
// We recompute the report here from signals already in the input
// (timelines + tokenData + toolData + apiErrors). The user's good/bad session
// labels live in browser localStorage (use-session-tags) and never reach the
// engine, so we pass an empty tag map and lean on `analyzeHabitImpact`'s
// cost+cleanliness proxy fallback — the same anchor the UI uses for untagged
// sessions. That keeps the detector self-contained and identical across the
// SPA and server datasets.

// A real, prescriptive next step per factor — paired with the habit so the
// recommendation is actionable, not just "you do this thing".
const ACTION_HINT: Record<string, string> = {
  compaction:
    'start fresh sessions or trim context sooner so the run does not have to compact',
  'tool-errors':
    'add a PostToolUse validation hook so tool errors surface and get fixed before the next turn',
  'tool-density':
    'plan or batch tool use instead of high-volume exploratory calls',
  rhythm: 'slow the rapid-fire turns — plan the next action before firing it',
  'tool-repetition':
    'reuse earlier results instead of re-running the same call',
};

const pct = (r: number) => `${Math.round(r * 100)}%`;

/** One evidence row per harmful habit: the good-rate gap and its magnitude. */
function factorRow(f: HabitFactor): string {
  return `${f.title}: ${pct(f.high.goodRate)} good ${f.high.label} vs ${pct(
    f.low.goodRate
  )} ${f.low.label} (${f.magnitude})`;
}

/**
 * Flag the habit most strongly associated with worse session outcomes. Reads
 * the same per-factor analysis the Patterns view shows; emits the strongest
 * `hurts` factor as the headline and lists any others as evidence. Silent when
 * no factor has enough sessions on both sides to earn a `hurts` verdict.
 */
export const detector: Detector = {
  id: 'workflow.harmful-habit',
  category: 'workflow',
  dataDeps: ['timelines', 'tokenData', 'toolData', 'apiErrors'],
  rule(input) {
    const report = analyzeHabitImpact(
      input.timelines ?? [],
      input.tokenData,
      input.toolData,
      input.apiErrors,
      new Map<string, SessionOutcomeTag>()
    );
    // factors are sorted strongest-gap-first; hurts means the habit side
    // (`high`) has the lower good-outcome rate.
    const hurting = report.factors.filter((f) => f.verdict === 'hurts');
    if (hurting.length === 0) return null;

    const top = hurting[0];
    const gap = top.low.goodRate - top.high.goodRate; // > 0 for a hurts factor
    // Severity banding is the detector's own concern (distinct from the
    // analyzeHabitImpact verdict cutoff): a wide good-rate gap warrants a
    // warning, a slim one stays informational.
    const severity: RecSeverity = gap >= 0.25 ? 'warning' : 'info';
    const hint = ACTION_HINT[top.key];

    return {
      id: 'workflow.harmful-habit',
      category: 'workflow',
      severity,
      title: `${top.title} tracks with worse session outcomes`,
      detail: `Sessions ${top.high.label} have a ${pct(
        top.high.goodRate
      )} good-outcome rate vs ${pct(top.low.goodRate)} for ${top.low.label} ones (${
        top.magnitude
      }), across ${report.totalSessions} sessions. Outcome is proxied from cost and cleanliness for sessions you have not labelled good/bad.`,
      action: hint
        ? `Compare the two sides in the Patterns view, then ${hint}.`
        : 'Compare the two sides in the Patterns view and decide whether to change the habit.',
      affected: top.high.sessionCount,
      view: 'patterns',
      // A handful of rows, like the other detectors: the top few harmful habits,
      // then the worse side's example session-ids (these resolve to projects in
      // the #330 project-filtered view; the prose rows above simply don't).
      evidence: [
        ...hurting.slice(0, 3).map(factorRow),
        ...top.high.examples.map((e) => short(e.sessionId)),
      ],
    };
  },
};
