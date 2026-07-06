/**
 * judge-gold-set.ts — export accumulated user rejections as an LLM-judge
 * ground-truth gold set (#2207, epic #1298).
 *
 * The rec feedback loop's third slice. `reject-signals.ts` is CAPTURE ONLY: it
 * writes an append-only JSONL log of *why* a user rejected a recommendation
 * (`dismiss` / `wrong` / `not-relevant`). This module CONSUMES that log and
 * derives the missing piece the issue calls out: the LLM judge that validates
 * recommendations (`audit/judge.ts` → {@link JudgeVerdict}, an `isFinding`
 * boolean over each candidate) has no human ground truth to validate ITSELF
 * against. Accumulated rejections are exactly that ground truth.
 *
 * ## The defined format (not TBD)
 *
 * One JSON object per line — JSONL — of `{ findingId, verdict, reason }`:
 * - `findingId` — the `Recommendation.id` (e.g. `cost.cache-1h-waste`).
 * - `reason`    — the raw {@link RejectReason} the user picked, preserved
 *                 verbatim so a consumer can re-derive or filter.
 * - `verdict`   — the normalized ground-truth label ({@link GoldVerdict}):
 *     - `reject` — the human disputed the claim (`wrong`) or said it does not
 *       apply (`not-relevant`). This is a VALIDITY judgment: the judge that
 *       surfaced this finding was wrong, so the ground truth is
 *       `isFinding: false`. Use {@link goldVerdictToExpectedIsFinding}.
 *     - `defer` — the human `dismiss`ed it ("not now"). This is a scheduling
 *       signal, NOT a validity judgment — the claim may be perfectly valid — so
 *       the judge-validation path SKIPS these rows when scoring the judge
 *       (`goldVerdictToExpectedIsFinding` returns `null`).
 *
 * ## How the judge-validation path consumes it
 *
 * A validation harness runs the judge over each `findingId`, then compares the
 * judge's `JudgeVerdict.isFinding` to `goldVerdictToExpectedIsFinding(verdict)`:
 * a `reject` row where the judge still returns `isFinding: true` is a judge miss;
 * `defer` rows are excluded from that scoring. This module only EXPORTS the gold
 * set; it does not run the judge (no live API call, no side effects beyond the
 * one read of the reject log).
 *
 * Pure and deterministic: the transforms take already-read {@link RejectSignal}s
 * and never touch the filesystem; only the async `export*` convenience wrappers
 * read the log (via `readRejectSignals`, whose only dependency is a node
 * builtin — so this stays importable by the zero-node_modules server runtime).
 */
import type { RejectReason } from './reject-reason';
import { type RejectSignal, readRejectSignals } from './reject-signals';

/** The normalized ground-truth labels the gold set emits. */
export const GOLD_VERDICTS = ['reject', 'defer'] as const;
export type GoldVerdict = (typeof GOLD_VERDICTS)[number];

/** One labeled ground-truth row: the exported JSONL line shape. */
export interface JudgeGoldEntry {
  /** The recommendation id the user rejected (`Recommendation.id`). */
  findingId: string;
  /** Normalized ground-truth label — see {@link GoldVerdict}. */
  verdict: GoldVerdict;
  /** The raw reason the user picked, preserved verbatim. */
  reason: RejectReason;
}

/**
 * Map a raw reject reason to its ground-truth judge verdict. `wrong` and
 * `not-relevant` are validity rejections (the finding should not have been
 * surfaced); `dismiss` is a deferral, not a validity judgment.
 */
export function rejectReasonToGoldVerdict(reason: RejectReason): GoldVerdict {
  return reason === 'dismiss' ? 'defer' : 'reject';
}

/**
 * The expected `JudgeVerdict.isFinding` for a gold verdict, or `null` when the
 * row carries no validity signal (a `defer`) and must be skipped when scoring
 * the judge. `reject` ⇒ the judge should have said `isFinding: false`.
 */
export function goldVerdictToExpectedIsFinding(verdict: GoldVerdict): boolean | null {
  return verdict === 'reject' ? false : null;
}

/** Project one reject signal into its gold-set entry. */
export function toJudgeGoldEntry(signal: RejectSignal): JudgeGoldEntry {
  return {
    findingId: signal.findingId,
    verdict: rejectReasonToGoldVerdict(signal.reason),
    reason: signal.reason,
  };
}

/**
 * Build the deduped gold set from accumulated reject signals: ONE ground-truth
 * label per `findingId`.
 *
 * The dedup is **purpose-aware, not naive latest-wins**. A validity rejection
 * (`wrong`/`not-relevant` → `reject`) is hard ground truth that the judge was
 * wrong to surface the finding; a `dismiss` ("not now" → `defer`) is an
 * orthogonal scheduling signal that judge-scoring skips. So a later `dismiss`
 * must NOT erase an earlier validity rejection for the same finding — that would
 * silently drop the human false-positive evidence the gold set exists to hold.
 * Rule: keep the LATEST validity rejection if the finding has any; only when
 * EVERY signal for a finding is a deferral do we fall back to the latest
 * `dismiss`. Within each class the latest `ts` wins (ISO timestamps sort
 * chronologically; an equal-timestamp tie goes to the last signal in input
 * order). Output is sorted by `findingId` for deterministic, diffable exports.
 * Empty in ⇒ empty out.
 */
export function buildJudgeGoldSet(signals: RejectSignal[]): JudgeGoldEntry[] {
  const latestReject = new Map<string, RejectSignal>();
  const latestDefer = new Map<string, RejectSignal>();
  for (const s of signals) {
    const bucket = rejectReasonToGoldVerdict(s.reason) === 'reject' ? latestReject : latestDefer;
    const prev = bucket.get(s.findingId);
    if (!prev || s.ts >= prev.ts) bucket.set(s.findingId, s);
  }
  const findingIds = new Set([...latestReject.keys(), ...latestDefer.keys()]);
  return [...findingIds]
    // A validity rejection dominates a deferral for the same finding.
    .map((id) => toJudgeGoldEntry(latestReject.get(id) ?? latestDefer.get(id)!))
    .sort((a, b) => (a.findingId < b.findingId ? -1 : a.findingId > b.findingId ? 1 : 0));
}

/**
 * Serialize a gold set to newline-delimited JSON. Each entry is one line with a
 * trailing newline (append-friendly, matching the reject-log writer); an EMPTY
 * set serializes to `''` — not `'\n'` — so an empty store yields an empty file.
 */
export function serializeJudgeGoldSet(entries: JudgeGoldEntry[]): string {
  return entries.length ? entries.map((e) => JSON.stringify(e)).join('\n') + '\n' : '';
}

/**
 * Read the append-only reject-signal log and build the gold set. A missing /
 * unreadable / empty log yields `[]` (never throws) — first-ever runs before any
 * rejection has accumulated are the common case for this Low-priority slice.
 */
export async function exportJudgeGoldSet(rejectSignalsFile: string): Promise<JudgeGoldEntry[]> {
  return buildJudgeGoldSet(await readRejectSignals(rejectSignalsFile));
}

/** Read the reject-signal log and serialize its gold set as JSONL text. */
export async function exportJudgeGoldSetJsonl(rejectSignalsFile: string): Promise<string> {
  return serializeJudgeGoldSet(await exportJudgeGoldSet(rejectSignalsFile));
}
