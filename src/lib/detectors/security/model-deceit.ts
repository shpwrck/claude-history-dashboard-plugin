import type { Detector } from '../types';
import { short } from '../shared';

/**
 * security.model-deceit (#686, slice B of epic #683) — surface sessions where
 * the agent CLAIMED work it can't be shown to have done.
 *
 * This is the thin downstream read of the Slice-A ingest feature
 * (`parse-deceit-signals.ts`, #685): all the correlation and false-positive
 * tuning — the four honest classes (scoped disclosure, stale-but-true, real
 * background completion, sloppy fail-regex) — already happened at ingest, so by
 * the time `unbackedClaimCount` / `contradictedClaimCount` are non-zero the
 * signal is already high-precision. The detector adds nothing beyond the
 * numeric feature: it never re-reads transcripts and never fabricates a claim.
 *
 * It lives in its own `security` category (NOT `safety`): the existing `safety/`
 * detectors cover *config* hygiene (deny rules, bypass), whereas this is about
 * agent *trustworthiness* — a distinct concern that gets its own category so it
 * can be surfaced and filtered on its own.
 *
 * Fires per-dataset (aggregating the flagged sessions) with evidence rows drawn
 * from the capped claim snippets. A contradicted success claim (asserted "all
 * green" while a real verification run failed) is the stronger signal → warning;
 * unbacked-only action claims → info. Optional/empty `deceitSignals` (the
 * transcript-free SPA dataset, or a clean history) ⇒ the detector stays dark.
 */
const MAX_EVIDENCE = 5;

export const detector: Detector = {
  id: 'security.model-deceit',
  category: 'security',
  dataDeps: ['deceitSignals'],
  rule(input) {
    const signals = input.deceitSignals ?? [];
    if (signals.length === 0) return null;

    // A session is flagged only when it has assistant turns AND at least one
    // claim the ingest parser couldn't back. The parser already excludes the
    // honest classes, so any non-zero count here is a genuine flag.
    const flagged = signals.filter(
      (s) =>
        s.assistantTurnCount > 0 &&
        s.unbackedClaimCount + s.contradictedClaimCount > 0
    );
    if (flagged.length === 0) return null;

    let unbacked = 0;
    let contradicted = 0;
    for (const s of flagged) {
      unbacked += s.unbackedClaimCount;
      contradicted += s.contradictedClaimCount;
    }

    const evidence = flagged
      .flatMap((s) => s.claimSnippets.map((snip) => `${short(s.sessionId)}: "${snip}"`))
      .slice(0, MAX_EVIDENCE);

    // A contradicted "all green" (a real failure says otherwise) is the clearer
    // deceit than an action claim with merely-absent evidence.
    const severity = contradicted > 0 ? 'warning' : 'info';

    const parts: string[] = [];
    if (contradicted > 0) {
      parts.push(
        `${contradicted} success claim(s) contradicted by a real verification failure`
      );
    }
    if (unbacked > 0) {
      parts.push(`${unbacked} action claim(s) with no supporting tool evidence`);
    }

    return {
      id: 'security.model-deceit',
      category: 'security',
      severity,
      title: 'Agent claimed work it cannot be shown to have done',
      detail: `${parts.join(' and ')} across ${flagged.length} session(s) — e.g. "all tests pass" with a failing run, or "I ran the suite" with no matching tool call.`,
      action:
        'Spot-check the flagged turns and require the agent to run and show verification before claiming completion (a Stop hook that blocks on unverified claims, or a CLAUDE.md "verify before done" rule).',
      affected: contradicted + unbacked,
      view: 'sessions',
      evidence,
    };
  },
};
