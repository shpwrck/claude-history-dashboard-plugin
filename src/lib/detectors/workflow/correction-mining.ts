/**
 * workflow.correction-mining (#1040, epic #866) — the deterministic counterpart
 * to headroom's `learn`.
 *
 * Our other detectors flag the SYMPTOM of a wrong guess (tool errors, retry
 * storms, redundant reads) but never extract the corrective FACT. This one mines
 * failed→fixed tool sequences within a session — an errored call followed by the
 * same-tool call that succeeded at the same intent — and diffs the argument to a
 * ready-to-pin fact: a file Read that failed at one path then succeeded at
 * another (the file is at B, not A), or a command that failed then worked as a
 * variant (`uv run python …`, not `python3 …`).
 *
 * Pinning these in CLAUDE.md stops the agent re-guessing across sessions. The
 * `fix` is marker-bearing so the adoption scorecard (#577) tracks whether the
 * user actually wrote the fact down — this is where we go beyond headroom, which
 * writes corrections but never measures adoption.
 *
 * Deterministic, transcript-free (reads only distilled `toolData`) — free/local
 * path per ADR 0005.
 */
import type { Detector, AppliedMarkers } from '../types';
import { claudeMdMarksApplied, newestIsoDate, STALE_WEEKS, truncate } from '../shared';
import { isAsOfStale } from '../provenance';
import { mineCorrections, aggregateCorrections } from '../../parse-tools';

const MARKERS_CORRECTIONS: AppliedMarkers = {
  headings: [/^##\s+(?:Known paths|File locations|Project map|Corrections|Gotchas)\b/i],
  bodyPhrases: ['not the first place the agent looked'],
};

/** Cap evidence/fact rows so the card and CLAUDE.md block stay scannable. */
const MAX_ROWS = 5;

/**
 * A short, CLAUDE.md-ready sentence for one corrective fact.
 *
 * This text is what lands in the USER'S CLAUDE.md, so the present tense has to
 * be earned. There are three states, not two:
 *
 *  - `current` — dated AND inside the freshness window: "is the real path".
 *  - dated but stale — past tense carrying the date it was last seen to work.
 *  - undated — past tense saying so, rather than inventing an "as of".
 *
 * An unqualified "is the real path" derived from old or undatable evidence
 * would pin the agent to a location the file may have left.
 */
function factLine(
  c: { failed: string; succeeded: string },
  proof: { current: boolean; asOf?: string }
): string {
  const succeeded = truncate(c.succeeded, 80);
  const failed = truncate(c.failed, 80);
  if (proof.current) {
    return `\`${succeeded}\` is the real path (the agent first tried \`${failed}\`).`;
  }
  const when = proof.asOf ? `as of ${proof.asOf}` : 'when last observed, date unknown';
  return `\`${succeeded}\` was the working path ${when} (the agent first tried \`${failed}\`) — re-check before relying on it.`;
}

export const detector: Detector = {
  id: 'workflow.correction-mining',
  appliedMarkers: MARKERS_CORRECTIONS,
  category: 'workflow',
  dataDeps: ['toolData', 'liveConfig'],
  rule(input, now) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS_CORRECTIONS)) return null;

    const mined = mineCorrections(input.toolData);
    const facts = aggregateCorrections(mined);
    if (facts.length === 0) return null;

    const top = facts.slice(0, MAX_ROWS);
    // Folded over `occurrences` — the field the claim cites — rather than read
    // off `facts[0]`. `aggregateCorrections` does sort by occurrences today, so
    // the two agree; taking the max explicitly means a later re-ranking cannot
    // silently turn "re-guessed most often" into a false superlative (#3459).
    const mostRepeated = facts.reduce((a, b) => (b.occurrences > a.occurrences ? b : a));
    // Anchored to the newest OBSERVED fix call, never to `now`: a correction is
    // only known to hold as of the last time it was seen to succeed.
    const asOf = newestIsoDate(mined.map((c) => c.succeededTimestamp));
    /**
     * A mined path is only known to have worked ON THE DAY it was observed to
     * work — files move. Past the standard freshness window this stops being a
     * statement about where the file IS and becomes a statement about where it
     * WAS, so the wording is demoted to a dated lead (the `native-bypass` /
     * `dangerous-bypass` precedent, same `STALE_WEEKS` window) and the fix
     * stops being offered as a one-click CLAUDE.md write. Pinning a path that
     * has since moved is worse than not pinning one.
     */
    const stale = isAsOfStale(asOf, now, STALE_WEEKS * 7);
    /**
     * Freshness is decided PER CORRECTION, not once for the corpus.
     *
     * A single corpus-wide flag lets one recently re-confirmed correction
     * certify every other row: the old path would be written into CLAUDE.md as
     * "the real path" on the strength of a different fact's timestamp. Each
     * aggregate carries its own newest `succeededTimestamp`, so each row is
     * judged against its own evidence.
     *
     * Undated evidence is treated exactly like stale evidence, NOT like fresh.
     * `isAsOfStale(undefined, …)` is `false` by design — you cannot demote
     * against a date you cannot read — but reading that `false` as "fresh" is
     * absence of evidence standing in for evidence of absence. `parse-tools`
     * normalizes a missing transcript timestamp to an empty string, so an
     * arbitrarily old correction reaches here undated.
     */
    const proofFor = (c: { succeededTimestamp: string }) => {
      const rowAsOf = newestIsoDate([c.succeededTimestamp]);
      const rowStale = isAsOfStale(rowAsOf, now, STALE_WEEKS * 7);
      return { current: rowAsOf !== undefined && !rowStale, asOf: rowAsOf };
    };
    /**
     * The SNIPPET is all-or-nothing: it is one block the user pastes whole, so
     * it may only be offered as a one-click `validated` fix when every row in
     * it is individually current. One demoted row makes the block a template to
     * adapt.
     */
    const proofs = top.map(proofFor);
    const canAssertCurrent = proofs.every((p) => p.current);
    /**
     * Why the warning needs THREE cases, not two.
     *
     * A row can fail `current` for two different reasons — it is dated but old,
     * or it has no readable date at all — and a corpus can contain both at
     * once. A two-way split gets every mixed case wrong in one direction or the
     * other: "no readable timestamp" is false when a demoted row has a perfectly
     * usable date, and "seen over N weeks ago" is false when the only
     * non-current row is undated rather than old. So the two reasons are
     * tracked independently and the warning names whichever actually applies.
     *
     * These are per-ROW, deliberately: the corpus-wide `stale` flag is computed
     * against the newest timestamp anywhere in the corpus, so one fresh
     * correction hides an old one behind it.
     */
    const anyUndated = proofs.some((p) => p.asOf === undefined);
    const anyStale = proofs.some((p) => p.asOf !== undefined && !p.current);
    /**
     * One sentence naming the reason(s) this evidence cannot be asserted as
     * current — both when both apply.
     */
    const staleWarning =
      anyStale && anyUndated
        ? `at least one path was last seen to work over ${STALE_WEEKS} weeks ago, and another carries no readable timestamp at all.`
        : anyStale
          ? `at least one was last seen to work over ${STALE_WEEKS} weeks ago and may have moved since.`
          : 'this history carries no readable timestamp, so how long ago these paths worked is unknown.';
    const lead = asOf
      ? stale
        ? `As of ${asOf}, the available tool history contained`
        : `Through ${asOf}, the available tool history recorded`
      : 'The available (undated) tool history contained';

    return {
      id: 'workflow.correction-mining',
      category: 'workflow',
      severity: 'info',
      title: 'Pin recurring wrong-path corrections in CLAUDE.md',
      detail:
        `${lead} ${facts.length} wrong-path guess(es) from failed→fixed tool sequences — a file read/edit that errored, ` +
        `then succeeded at a different path with the same filename. ` +
        (canAssertCurrent
          ? 'Recording the real path stops future sessions re-guessing.'
          : `Re-check each path before pinning it: ${staleWarning}`),
      action:
        'Add the corrected paths to your project CLAUDE.md so the agent uses the working location first.',
      affected: facts.length,
      evidence: top.map(
        (c) =>
          `${c.toolName}: ${truncate(c.failed, 48)} → ${truncate(c.succeeded, 48)}` +
          (c.occurrences > 1 ? ` (×${c.occurrences})` : '')
      ),
      view: 'tools',
      fix: {
        target: 'CLAUDE.md',
        label: 'Pin the corrections',
        // DECLARED, never inherited — an absent fixKind silently defaults to
        // 'validated', which is how a stale path would have kept its one-click
        // "Fix now" affordance. Fresh evidence is a self-contained CLAUDE.md
        // block and genuinely paste-safe; stale evidence is a template the user
        // must re-check against the current tree before pinning, which is the
        // definition of 'illustrative'.
        fixKind: canAssertCurrent ? 'validated' : 'illustrative',
        note: canAssertCurrent
          ? 'Append to your project CLAUDE.md. These are facts the agent had to discover by failing first — pinning them avoids the failed attempt next time.'
          : `Re-verify each path against the current tree before pinning: ${staleWarning} A file that has moved since would pin the agent to the wrong location; each line below carries what is known about when it was last seen working.`,
        snippet:
          `## Known paths & gotchas\n\n` +
          `These were learned the hard way — the agent guessed wrong, then found the right value. ` +
          `They are not the first place the agent looked, so pin them:\n\n` +
          top.map((c, i) => `- ${factLine(c, proofs[i])}`).join('\n'),
        appliedMarkers: MARKERS_CORRECTIONS,
      },
      provenance: {
        observations: [
          {
            claim: `${facts.length} distinct failed→fixed correction(s) were mined from ${mined.length} matched sequence(s)`,
            source: 'parse-tools (mineCorrections → aggregateCorrections over toolData[].calls)',
            field: 'failed / succeeded',
            value: facts.length,
          },
          {
            claim:
              `the most repeated correction is \`${truncate(mostRepeated.failed, 60)}\` → ` +
              `\`${truncate(mostRepeated.succeeded, 60)}\`, seen ${mostRepeated.occurrences} time(s)`,
            source: 'parse-tools (aggregateCorrections over toolData[].calls)',
            field: 'occurrences',
            value: mostRepeated.occurrences,
          },
          {
            claim: `at most MAX_ROWS = ${MAX_ROWS} correction(s) are shown and written into the fix snippet`,
            source: 'detectors/workflow/correction-mining',
            field: 'MAX_ROWS',
            value: MAX_ROWS,
          },
        ],
        // What is measured is a PAIR of tool calls — one that errored, one that
        // then succeeded at the same intent within a short window — matched on
        // the filename stem. That match is a heuristic: two genuinely different
        // files sharing a stem can pair into a correction that was never a
        // correction (generic stems are already excluded for this reason). The
        // claim that pinning the path prevents a future wrong guess is the
        // recommendation, not a measured outcome.
        inference:
          'Adjacent failed→succeeded tool calls sharing a filename stem are paired and ' +
          'counted. Whether the pair really was one intent — and whether writing the ' +
          'path down prevents the next wrong guess — is not measured here.',
        ...(asOf ? { asOf, stale } : {}),
      },
    };
  },
};
