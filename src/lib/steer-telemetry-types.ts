/**
 * Shared types for the PreToolUse-steer telemetry surface (#2203, epic #1868).
 *
 * Node-free so BOTH the browser (AdoptionScorecard) and the node-only parser
 * (`parse-steer-telemetry.ts`, which reads the JSONL log) can import them without
 * pulling `node:fs` into the client bundle.
 *
 * The steer hook (`~/.claude/skills/recs/scripts/pretooluse-steer.mjs`) already
 * logs every delivery + accepted/declined outcome to `.pretooluse-steer.jsonl`.
 * This module is the consumer-side vocabulary; the `misfireTag` *write* is a meta
 * companion in that hook (a separate child of #1868, mirrored to shpwrck/claude).
 */

/** The three steer log event kinds. `delivered` = the steer fired (a surface);
 *  `accepted` = the agent followed it; `declined` = the agent ignored it. */
export const STEER_EVENTS = ['delivered', 'accepted', 'declined'] as const;
export type SteerEvent = (typeof STEER_EVENTS)[number];

/**
 * The misfire taxonomy: WHY a steer was a bad fire, so the precision loop can
 * tune the rule. Defined here ONCE; the meta steer writer duplicates the literal
 * string list (it cannot import a repo type) and keys a comment back to this file.
 *  - `false-positive-on-legit-behaviour` — fired on behaviour that was fine.
 *  - `wrong-scale` — right concern, wrong threshold (too eager / too quiet).
 *  - `wrong-prescription` — real problem, but the suggested fix was wrong.
 *  - `gap` — the steer should have fired on something adjacent but did not.
 */
export const MISFIRE_TAGS = [
  'false-positive-on-legit-behaviour',
  'wrong-scale',
  'wrong-prescription',
  'gap',
] as const;
export type MisfireTag = (typeof MISFIRE_TAGS)[number];

/** One sanitized steer log line (delivery or outcome). */
export interface SteerRecord {
  ts: string;
  event: SteerEvent;
  ruleId: string;
  /** `steer` or `deny` — the steer mechanism. Free-form; not enum-gated. */
  kind: string;
  /** Optional misfire classification (#1868); present only once the meta writer ships it. */
  misfireTag?: MisfireTag;
}

/** One misfire tag and how many times it was recorded against a rule (#2490). */
export interface MisfireTagCount {
  tag: MisfireTag;
  count: number;
}

/** Per-rule rollup the dashboard renders: fire-count + followed/ignored + tags. */
export interface SteerRuleTelemetry {
  ruleId: string;
  /** Distinct `kind`(s) this rule fired under (usually one). */
  kinds: string[];
  /** Number of `delivered` events — how many times the steer fired. */
  fireCount: number;
  /** Number of `accepted` outcomes — the agent followed the steer. */
  acceptedCount: number;
  /** Number of `declined` outcomes — the agent ignored the steer. */
  declinedCount: number;
  /** Distinct misfire tags recorded against this rule (empty until the meta writer ships).
   *  Kept for compatibility; derived from `misfireTagCounts` (its keys, sorted). */
  misfireTags: MisfireTag[];
  /** Per-tag misfire counts, ordered by count desc then tag asc (#2490). Empty
   *  until the meta writer ships tagging, so an empty array means "no tags yet",
   *  never "measured zero misfires". */
  misfireTagCounts: MisfireTagCount[];
  /** Total misfire-tagged events for this rule (sum of `misfireTagCounts`). */
  misfireCount: number;
  /** Misfire rate = `misfireCount / fireCount`, a fact about the log (#2490).
   *  `null` when `fireCount` is 0 — never a rate off a zero denominator, so the
   *  panel shows "—" rather than `NaN`/`0-of-0`. May exceed 1 if a rule was
   *  tagged more often than it fired (a data anomaly surfaced honestly). */
  misfireRate: number | null;
  /** Most recent event timestamp for this rule (ISO), for "as of" rendering. */
  lastTs: string;
}
