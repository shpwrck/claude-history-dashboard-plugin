/**
 * Prompt-regime segmentation for the session corpus (#3405).
 *
 * Anthropic removed over 80% of the Claude Code system prompt for the Claude 5
 * generation (announced 2026-07-24). Sessions recorded before and after that cut
 * ran under materially different harness instructions, so any trendline,
 * before/after figure, or shadow/replay pair whose window spans the cut is
 * confounded: part of the delta is the prompt regime, not the change being
 * attributed. This module turns the transcript's already-parsed top-level
 * `version` field into that missing control variable.
 *
 * ## Why the boundary is a RANGE, not a single version
 *
 * The obvious discriminator — look for the prompt text itself — does not exist
 * in this data. Claude Code transcripts record user turns, assistant turns, tool
 * results, hooks, and per-line metadata; they do NOT record the system prompt or
 * any session-start system injection. That was verified against the local corpus
 * (1585 transcripts, ~555 MB) rather than assumed: each of the three canonical
 * session-start injection strings — `"skills are available for use with the
 * Skill tool"`, `"Here is useful information about the environment you are
 * running in"`, and `"deferred tools are now available via ToolSearch"` —
 * appears in exactly ONE file, and that file is a session that happened to quote
 * them while working on this very issue. A content marker is therefore not
 * merely noisy here, it is unavailable.
 *
 * The quantitative fallback also fails to resolve a boundary. The first
 * assistant turn's cached prefix (`input_tokens + cache_creation + cache_read`)
 * bundles the system prompt with tool definitions, CLAUDE.md/AGENTS.md, memory,
 * MCP tool schemas, and the first user turn. Grouped by version — as a median,
 * as a low percentile, and as a within-`cwd` floor, which is the tightest
 * estimator of fixed harness overhead since every other component only ADDS —
 * the local corpus shows drift of the same order as the expected signal and no
 * step at any version. A >80% cut is simply not separable from concurrent
 * CLAUDE.md and MCP growth in this corpus.
 *
 * What the corpus DOES resolve cleanly is a temporal bracket. Counting method
 * (stated so the numbers are reproducible): one transcript FILE is one session;
 * files are enumerated RECURSIVELY under `~/.claude/projects` so nested
 * subagent transcripts are included; a session is attributed to the FIRST
 * top-level `version` value its lines carry, and dated by its first
 * `timestamp`. On that basis 1539 of 1585 transcripts carry a version, and
 * against the 2026-07-24 announcement:
 *
 * - `2.1.217` — 23 sessions, 2026-07-22T02:38:59Z .. 2026-07-23T16:03:35Z:
 *   entirely before.
 * - `2.1.218` — 15 sessions, 2026-07-23T13:46:55Z .. 2026-07-27T14:50:04Z:
 *   STRADDLES the announcement (12 before, 3 after).
 * - `2.1.220` — 213 sessions, first at 2026-07-27T14:50:27Z: entirely after.
 *
 * So the true boundary lies in `(2.1.217, 2.1.220]` and cannot be narrowed
 * further from local data. Rather than pick a point and silently misclassify one
 * side of it, a boundary carries BOTH edges and versions strictly between them
 * derive {@link INDETERMINATE_PROMPT_REGIME}. That keeps the uncertainty in the
 * data instead of hiding it in a constant, and an indeterminate session is
 * treated as unpoolable by {@link summarizePromptRegimes} — which is the point:
 * silent aggregation across the boundary is the failure mode being eliminated.
 *
 * ## Why keyed on version and not on date
 *
 * A stale CLI keeps its old prompt. The local corpus shows exactly that: version
 * `2.1.177` has a session running on 2026-08-03, ten days after the
 * announcement, from a machine that had not upgraded. Bucketing by wall-clock
 * date would file that session under the new regime even though it ran under the
 * old prompt. The CLI version is the artifact that actually carries the prompt,
 * so it is the key.
 *
 * ## Adding the next regime change
 *
 * Append one entry to {@link PROMPT_REGIME_BOUNDARIES}, ordered ascending by
 * version. Nothing else changes — derivation, spanning detection, and every
 * consumer generalize over the table. That is the issue's explicit requirement:
 * build the mechanism, not a one-off constant.
 *
 * Boundary + method are also recorded in `REFERENCES.md`.
 */

/** Regime id for a session whose `version` is missing or unparseable. */
export const UNKNOWN_PROMPT_REGIME = 'unknown';

/**
 * Regime id for a session whose `version` falls strictly inside a boundary's
 * unresolved bracket — known to be near the cut, not known which side of it.
 */
export const INDETERMINATE_PROMPT_REGIME = 'indeterminate';

/** The regime in force below the first boundary: the original long prompt. */
export const BASE_PROMPT_REGIME = 'pre-claude-5';

export type PromptRegimeId = string;

/** One prompt-regime change, expressed as the version bracket that contains it. */
export interface PromptRegimeBoundary {
  /** Regime that BEGINS at this boundary (in force at and above `firstKnownAfter`). */
  id: PromptRegimeId;
  /** Human-readable name for the regime this boundary introduces. */
  label: string;
  /** Regime this boundary ends — the previous entry's `id`, or {@link BASE_PROMPT_REGIME}. */
  supersedes: PromptRegimeId;
  /** Highest version OBSERVED to still carry `supersedes` (inclusive). */
  lastKnownBefore: string;
  /** Lowest version OBSERVED to carry `id` (inclusive). */
  firstKnownAfter: string;
  /** ISO date the change was announced, for corroboration only — never the key. */
  announcedAt: string;
  /** How the bracket was established, so a reader can audit or tighten it. */
  determination: string;
  /** Primary reference for the change. */
  reference: string;
}

/**
 * Ordered ascending by version. Append-only: adding the next regime change is a
 * single entry here.
 */
export const PROMPT_REGIME_BOUNDARIES: readonly PromptRegimeBoundary[] = [
  {
    id: 'claude-5-short',
    label: 'Claude 5 short system prompt (>80% of the prompt removed)',
    supersedes: BASE_PROMPT_REGIME,
    lastKnownBefore: '2.1.217',
    firstKnownAfter: '2.1.220',
    announcedAt: '2026-07-24',
    determination:
      'Temporal bracket over the local corpus (1585 transcripts enumerated recursively, ' +
      '1539 carrying a version; one file = one session, attributed to its first top-level ' +
      '`version` and dated by its first `timestamp`). The system prompt is not recorded in ' +
      'transcripts — all three canonical session-start injection strings appear in exactly ' +
      '1 file each (a session quoting them) — and first-turn cached-prefix token counts show ' +
      'no step at any version once CLAUDE.md/MCP growth is accounted for, so neither a ' +
      'content marker nor a token discriminator can resolve the cut. Bracketed instead by ' +
      'announcement date: 2.1.217 (23 sessions) ends 2026-07-23 entirely before, 2.1.218 ' +
      '(15) straddles 2026-07-23..2026-07-27, 2.1.220 (213) begins 2026-07-27 entirely ' +
      'after. Versions inside (2.1.217, 2.1.220) derive "indeterminate".',
    reference:
      'https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models',
  },
];

/**
 * Parse a CLI version into comparable numeric segments.
 *
 * Accepts a leading dotted-numeric core and ignores any pre-release/build
 * suffix (`2.1.220-beta.1` compares as `2.1.220`), so an unreleased build sorts
 * with its release rather than falling out of the model entirely. Returns
 * `null` when there is no leading numeric segment at all.
 */
export function parseCliVersion(version: string | undefined | null): number[] | null {
  if (typeof version !== 'string') return null;
  const core = /^\s*v?(\d+(?:\.\d+)*)/.exec(version);
  if (!core) return null;
  return core[1].split('.').map((s) => Number.parseInt(s, 10));
}

/**
 * Compare two CLI versions segment-wise. Missing segments count as 0, so
 * `2.1` === `2.1.0`. Returns <0, 0, or >0; unparseable operands sort last.
 */
export function compareCliVersions(
  a: string | undefined | null,
  b: string | undefined | null
): number {
  const pa = parseCliVersion(a);
  const pb = parseCliVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Derive the prompt regime in force for a Claude Code version.
 *
 * Returns {@link UNKNOWN_PROMPT_REGIME} when the version is absent or
 * unparseable, and {@link INDETERMINATE_PROMPT_REGIME} when it falls strictly
 * inside a boundary's unresolved bracket.
 */
export function promptRegimeForVersion(version: string | undefined | null): PromptRegimeId {
  const parsed = parseCliVersion(version);
  if (!parsed) return UNKNOWN_PROMPT_REGIME;

  let regime: PromptRegimeId = BASE_PROMPT_REGIME;
  for (const boundary of PROMPT_REGIME_BOUNDARIES) {
    if (compareCliVersions(version, boundary.firstKnownAfter) >= 0) {
      regime = boundary.id;
      continue;
    }
    // Below this boundary's upper edge: either safely under it, or inside the
    // unresolved bracket. Later boundaries are higher still, so we are done.
    if (compareCliVersions(version, boundary.lastKnownBefore) <= 0) return regime;
    return INDETERMINATE_PROMPT_REGIME;
  }
  return regime;
}

/**
 * Derive the prompt regime for anything carrying a Claude Code `version` — a
 * `Session`, a `SessionTokenData`, or any other `SessionDimensions` shape.
 *
 * Kept as a derivation rather than a persisted column: it is a pure function of
 * `version`, which is already parsed and stored, so materializing it would add a
 * redundant field to the serialized blob and the SQLite schema while making the
 * boundary table impossible to correct retroactively. Re-derivation is free and
 * always reflects the current table.
 */
export function promptRegimeForSession(
  session: { version?: string | undefined } | undefined | null
): PromptRegimeId {
  return promptRegimeForVersion(session?.version);
}

/** What a set of sessions looks like with respect to prompt-regime boundaries. */
export interface PromptRegimeSpan {
  /** Distinct RESOLVED regimes present, in table order. Excludes unknown/indeterminate. */
  regimes: PromptRegimeId[];
  /** Two or more distinct resolved regimes are present — the window crosses a cut. */
  spansBoundary: boolean;
  /** At least one session sits inside an unresolved bracket. */
  hasIndeterminate: boolean;
  /**
   * Sessions carrying a parseable version — the ones this module could place at
   * all. Includes sessions that resolved to `indeterminate`, so it is NOT the
   * count of sessions attributed to a regime in {@link PromptRegimeSpan.regimes}.
   */
  knownCount: number;
  /** Sessions whose version was missing or unparseable. */
  unknownCount: number;
  /**
   * The window cannot be pooled as a single regime: it either crosses a cut or
   * contains a session too close to one to place. This is the flag detectors
   * gate on.
   */
  confounded: boolean;
}

/**
 * Summarize the prompt regimes present across a set of session versions.
 *
 * Sessions with no version are counted but do NOT by themselves mark the window
 * confounded. History-derived `Session` objects predate transcript parsing and
 * may carry no `version` at all; treating absence as a conflict would make every
 * window confounded and the signal useless. Absence is reported via
 * `unknownCount` so a caller can weigh it.
 */
export function summarizePromptRegimes(
  versions: Iterable<string | undefined | null>
): PromptRegimeSpan {
  // perf-index-contract: prompt-regime-resolved always-consumed: the closing `order.filter` reads this set unconditionally on every successful call, so there is no path that builds it without querying it
  const resolved = new Set<PromptRegimeId>();
  let hasIndeterminate = false;
  let knownCount = 0;
  let unknownCount = 0;

  for (const version of versions) {
    const regime = promptRegimeForVersion(version);
    if (regime === UNKNOWN_PROMPT_REGIME) {
      unknownCount++;
      continue;
    }
    knownCount++;
    if (regime === INDETERMINATE_PROMPT_REGIME) {
      hasIndeterminate = true;
      continue;
    }
    resolved.add(regime);
  }

  const order = [BASE_PROMPT_REGIME, ...PROMPT_REGIME_BOUNDARIES.map((b) => b.id)];
  const regimes = order.filter((id) => resolved.has(id));
  const spansBoundary = regimes.length > 1;

  return {
    regimes,
    spansBoundary,
    hasIndeterminate,
    knownCount,
    unknownCount,
    confounded: spansBoundary || hasIndeterminate,
  };
}

/** Display label for a regime id, for evidence lines and UI copy. */
export function promptRegimeLabel(id: PromptRegimeId): string {
  if (id === BASE_PROMPT_REGIME) return 'pre-Claude-5 long system prompt';
  if (id === INDETERMINATE_PROMPT_REGIME) return 'near a prompt-regime boundary (unresolved)';
  if (id === UNKNOWN_PROMPT_REGIME) return 'unknown Claude Code version';
  return PROMPT_REGIME_BOUNDARIES.find((b) => b.id === id)?.label ?? id;
}
