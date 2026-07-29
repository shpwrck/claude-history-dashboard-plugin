/**
 * Shared detector helpers — gating thresholds, severity scaling, live-settings
 * checks, permission-rule parsing, and CLAUDE.md suppression matching.
 *
 * Imported by both the legacy in-file rules (`recommendations.ts`) and the
 * per-file detectors under `src/lib/detectors/`. Lives below `types.ts` and
 * above the detector files in the dependency graph, so nothing here imports
 * `recommendations.ts` (which would create a cycle). `recommendations.ts`
 * re-exports the public helpers (`bumpSeverity`, `claudeMdMarksApplied`,
 * `DANGEROUS_DENY_RULES`, `BASH_SAFE_ALLOW_RULES`) for back-compat.
 */
import type { LiveConfig, LiveSettings, SessionTokenData } from '../../types';
import type {
  AppliedMarkers,
  RecSeverity,
  TaskClassClassificationReason,
} from './types';
import { estimateCost, isUnattendedEntrypoint } from '../parse-sessions';
import {
  classifyTaskClassDetailed,
  TASK_CLASSES,
  type TaskClass,
  type TaskClassResult,
} from '../task-class';
import { resolveModelPricing, entryCostAtModel, CHEAPEST_MODEL } from '../pricing';
import { scopeKeyOf } from '../reclaim';
import { parseIsoInstantMs } from '../iso-instant';
export {
  allowShadowedByDeny,
  parsePermRule,
  permRuleMatchesCall,
} from '../permission-rules';

/** Higher = surfaced first. Drives the primary sort in `buildRecommendations`. */
export const SEVERITY_RANK: Record<RecSeverity, number> = {
  critical: 3,
  warning: 2,
  info: 1,
};

/**
 * Raise a severity exactly one level on the three-level scale
 * (`info → warning → critical`), capped at `critical`. Used by safety rules
 * that scale severity by context (e.g. a destructive command that ran under an
 * unattended `sdk-*` entrypoint reads one level hotter than the same command
 * typed interactively — #197). No new severity level is introduced.
 */
export function bumpSeverity(sev: RecSeverity): RecSeverity {
  if (sev === 'info') return 'warning';
  if (sev === 'warning') return 'critical';
  return 'critical';
}

// ── Rule gating thresholds ──────────────────────────────────────────────
// Minimum effect sizes below which a rule stays silent, so the panel only
// shows things worth acting on.
export const MIN_SAVINGS_USD = 0.05;
export const MIN_BYPASS_CALLS = 10;
export const MIN_TOOL_ERROR_RATE = 0.2; // 20%
export const MIN_TOOL_ERROR_CALLS = 5;
export const MIN_RETRY_GROUP_COUNT = 4; // back-to-back same-tool calls
export const HIGH_CHURN = 15; // mutating ops on one file
export const STALE_WEEKS = 4; // no activity for N weeks → "stale"
export const MIN_STALE_SESSIONS = 3; // only nudge on projects with real history
export const MIN_ASSISTANT_TURNS = 50; // enough assistant turns to trust a behaviour rate (#206)
export const HIGH_REFUSAL_RATE = 0.15; // ≥15% of turns concede/refuse → prompt-clarity friction
export const RATE_LIMIT_STATUSES = new Set(['429', '529']);

/** First 8 chars of an id — the canonical short session id used in evidence rows. */
export const short = (id: string) => id.slice(0, 8);

// ─────────────────────────────────────────────────────────────────────────
// LIVE-SETTINGS HELPERS
// ─────────────────────────────────────────────────────────────────────────
// Each rule that emits a `settings.json` or `hook` fix calls one of these to
// answer "is my fix already present in the user's live settings?". Returning
// true makes the rule skip itself entirely so the recommendation doesn't keep
// nagging after the user has copied the snippet in. See issue #166.

export function permissionsContain(
  settings: LiveSettings | null | undefined,
  bucket: 'allow' | 'ask' | 'deny',
  rules: string[]
): boolean {
  const have = settings?.permissions?.[bucket];
  if (!Array.isArray(have) || have.length === 0) return false;
  const set = new Set(have);
  return rules.every((r) => set.has(r));
}

// NOTE: `DANGEROUS_DENY_STEMS` / `isDangerousDenyRule` lived here until #3221.
// They existed so `safety.deny-rule-never-triggered` could withhold a
// destructive guard from its prune advice. That detector no longer gives prune
// advice — it is purely informational — so nothing needs to classify whether a
// deny rule's command is dangerous, and a denylist of dangerous stems that
// fails open (`terraform destroy`, `kubectl delete`, `ls && rm -rf /`,
// `env rm -rf /`) is exactly the bypass surface #3383 decided to delete rather
// than keep narrowing. Do not reintroduce without a consumer that survives that
// argument.

export function hasPostEditHook(settings: LiveSettings | null | undefined): boolean {
  const post = settings?.hooks?.PostToolUse;
  if (!Array.isArray(post)) return false;
  // Match any hook whose matcher mentions Edit or Write. We don't validate the
  // inner `command` — the user may swap in their own typecheck/lint, which is
  // explicitly what the rec's "note" tells them to do.
  return post.some((h) => {
    const m = typeof h?.matcher === 'string' ? h.matcher : '';
    return /\bEdit\b|\bWrite\b/.test(m);
  });
}

export function isModelPinned(settings: LiveSettings | null | undefined): boolean {
  return typeof settings?.model === 'string' && settings.model.length > 0;
}

/**
 * True when a `Stop` hook is currently configured in settings. Used by the
 * stale-input contract (#1102): a historical "stop hooks errored" finding must
 * not be phrased in the present tense when no Stop hook is configured anymore.
 * We don't validate the inner command — any configured Stop hook counts.
 */
export function hasStopHook(settings: LiveSettings | null | undefined): boolean {
  const stop = settings?.hooks?.Stop;
  return Array.isArray(stop) && stop.length > 0;
}

/**
 * True when a cwd-anchoring `PreToolUse` guard is currently configured in
 * settings. Used by the historical-demotion contract for
 * `reliability.cwd-drift-execution` (#2013, mirroring the #1102 stale-input
 * demotion in `hasStopHook`): a historical "git/gh ran unanchored" finding must
 * not be phrased as a current failure when the guard already blocks it going
 * forward. We match the guard by its command string containing
 * `cwd-anchor-guard` (the global `cwd-anchor-guard.mjs` PreToolUse hook in
 * `shpwrck/claude`), across every PreToolUse entry's inner hook commands.
 */
export function hasPreToolUseAnchorGuard(
  settings: LiveSettings | null | undefined
): boolean {
  const pre = settings?.hooks?.PreToolUse;
  if (!Array.isArray(pre)) return false;
  return pre.some((entry) =>
    (entry?.hooks ?? []).some(
      (h) => typeof h?.command === 'string' && h.command.includes('cwd-anchor-guard')
    )
  );
}

export function isHaikuPinned(settings: LiveSettings | null | undefined): boolean {
  return typeof settings?.model === 'string' && /\bhaiku\b/i.test(settings.model);
}

/**
 * The merged CLAUDE.md text the suppression matcher runs against. Concatenates
 * the global file (`~/.claude/CLAUDE.md`) with every per-project CLAUDE.md
 * value in the bundle. Phase 1 of #173 only delivers `global` — per-project
 * support arrives when the container gains read access to project roots.
 */
export function mergedClaudeMdText(
  liveConfig: LiveConfig | null | undefined
): string {
  return mergedClaudeMdParts(liveConfig).join('\n\n');
}

/**
 * The individual CLAUDE.md documents {@link mergedClaudeMdText} concatenates,
 * in merge order (global first, then each non-empty per-project file).
 *
 * Exported so a detector reporting a figure ABOUT the merged text can cite how
 * many documents it was merged from without re-implementing the "which files
 * count" predicate. Two copies of that predicate would drift, and a provenance
 * observation whose composition claim disagrees with the number it explains is
 * worse than no observation at all (#3180).
 */
export function mergedClaudeMdParts(
  liveConfig: LiveConfig | null | undefined
): string[] {
  if (!liveConfig?.claudeMd) return [];
  const parts: string[] = [];
  if (liveConfig.claudeMd.global) parts.push(liveConfig.claudeMd.global);
  for (const text of Object.values(liveConfig.claudeMd.perProject ?? {})) {
    if (typeof text === 'string' && text.length > 0) parts.push(text);
  }
  return parts;
}

/**
 * Strict-AND check: a rec's CLAUDE.md fix is considered applied only when
 * **every declared marker category matches** the merged CLAUDE.md text.
 *
 *  - Rules without `appliedMarkers` always return false (never suppressed).
 *  - Empty arrays inside a marker category degrade to "category not declared"
 *    so an author can opt out of one signal without writing a marker that's
 *    impossible to satisfy.
 *
 * Bias is intentional: we'd rather nag the user about a rec they've already
 * addressed in prose than silently hide a real finding. See #173.
 *
 * Exported because downstream tooling (phase-2 P/I/U recs, ad-hoc
 * verification scripts) reuses the same matcher against the same bundle.
 */
export function claudeMdMarksApplied(
  liveConfig: LiveConfig | null | undefined,
  markers: AppliedMarkers | undefined
): boolean {
  if (!markers) return false;
  const headings =
    Array.isArray(markers.headings) && markers.headings.length > 0
      ? markers.headings
      : null;
  const phrases =
    Array.isArray(markers.bodyPhrases) && markers.bodyPhrases.length > 0
      ? markers.bodyPhrases
      : null;
  if (!headings && !phrases) return false;
  const text = mergedClaudeMdText(liveConfig);
  if (text.length === 0) return false;
  if (headings) {
    const headingLines = text
      .split('\n')
      .filter((line) => /^#{1,6}\s+/.test(line));
    const anyHit = headings.some((re) =>
      headingLines.some((line) => re.test(line))
    );
    if (!anyHit) return false;
  }
  if (phrases) {
    const lower = text.toLowerCase();
    const allHit = phrases.every((phrase) =>
      lower.includes(phrase.toLowerCase())
    );
    if (!allHit) return false;
  }
  return true;
}

// ── Canonical permission-rule lists ─────────────────────────────────────
// Kept module-scope so a rule's "already applied?" check sees the exact same
// strings the pasted snippet emits.

/** deny block the dangerous-bypass fix pastes in. */
export const DANGEROUS_DENY_RULES = [
  'Bash(rm -rf:*)',
  'Bash(rm -fr:*)',
  'Bash(git reset --hard:*)',
  'Bash(git clean -fd:*)',
  'Bash(git push --force:*)',
  'Bash(git push -f:*)',
  'Bash(dd:*)',
  'Bash(mkfs:*)',
  'Bash(shred:*)',
  'Bash(curl:*)',
  'Bash(wget:*)',
];

/** ask block the dangerous-commands fix pastes in (deny minus curl/wget). */
export const DANGEROUS_ASK_RULES = [
  'Bash(rm -rf:*)',
  'Bash(rm -fr:*)',
  'Bash(git reset --hard:*)',
  'Bash(git clean -fd:*)',
  'Bash(git push --force:*)',
  'Bash(git push -f:*)',
  'Bash(dd:*)',
  'Bash(mkfs:*)',
  'Bash(shred:*)',
];

/** Allowlist the prompt-friction rec proposes for Bash. */
export const BASH_SAFE_ALLOW_RULES = [
  'Bash(ls:*)',
  'Bash(pwd)',
  'Bash(echo:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
];

// ── small formatting helpers ────────────────────────────────────────────
export function fmtUsd(n: number): string {
  if (!isFinite(n)) return '$0.00';
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

export function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

export function daysAgo(ts: number, now: number): number {
  return Math.max(0, Math.round((now - ts) / (24 * 60 * 60 * 1000)));
}

/** Largest epoch-ms `new Date(...).toISOString()` can render without throwing. */
const MAX_TIME_MS = 8.64e15;

/**
 * Last instant of year 9999 — the largest one `toISOString()` renders with a
 * FOUR-DIGIT year.
 *
 * {@link MAX_TIME_MS} is not a tight enough bound for our purposes. Between the
 * two, `toISOString()` switches to the expanded-year form and
 * `.slice(0, 10)` returns `'+010000-01'` rather than a date — which fails the
 * `YYYY-MM-DD` contract `validateRecProvenance` enforces, so the recommendation
 * would be rejected at validation time rather than merely mis-dated.
 * `parseWorkflowRun` takes `startTime` straight from a manifest, so such a value
 * is reachable from data, not just from a test.
 */
const MAX_ISO_DATE_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/**
 * An epoch-ms instant as an ISO `YYYY-MM-DD`, or `undefined` when it is not a
 * real, renderable instant.
 *
 * `new Date(ms).toISOString()` THROWS a RangeError past ±8.64e15, and a
 * detector that throws takes the whole recommendation build down — so the range
 * guard is the point, not decoration. `0` is treated as "unknown" rather than
 * 1970-01-01 because every caller here uses 0 as its no-timestamp sentinel.
 */
export function isoDateFromMs(ms: number): string | undefined {
  if (!isRenderableMs(ms)) return undefined;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * True when `ms` is an instant {@link isoDateFromMs} can actually render.
 *
 * Split out so a caller can reject an unrenderable candidate BEFORE it competes
 * to be the maximum. Selecting an out-of-range value and only discovering it is
 * unrenderable at format time discards every valid instant alongside it — one
 * absurd number in a parsed manifest would silently strip `asOf` from otherwise
 * reproducible evidence.
 */
function isRenderableMs(ms: number): boolean {
  return (
    Number.isFinite(ms) && ms > 0 && Math.abs(ms) <= MAX_TIME_MS && ms <= MAX_ISO_DATE_MS
  );
}

/**
 * The newest READABLE entry timestamp across `tokenData`, as an ISO
 * `YYYY-MM-DD` — the `asOf` anchor for any provenance claim derived from
 * session token entries.
 *
 * Derived from the DATA, never from `now`: a claim is only true as of the last
 * thing that was actually observed, and stamping it with today's date asserts a
 * freshness the corpus does not have. Several v0.6 audit findings are exactly
 * that mistake, so the anchor lives here once instead of being re-derived (and
 * re-mis-derived) per detector.
 *
 * Unparseable timestamps are skipped rather than coerced — `TokenEntry.timestamp`
 * is a raw transcript string and older writers/fixtures leave non-dates in it.
 * A corpus with no readable timestamp yields `undefined`, and since
 * `provenance.asOf` is optional that absence is honest where a guess would not
 * be.
 */
export function newestTokenDataDate(
  tokenData: readonly SessionTokenData[] | undefined
): string | undefined {
  return newestIsoDate(
    (tokenData ?? []).flatMap((d) => (d.entries ?? []).map((e) => e.timestamp))
  );
}

/**
 * The newest READABLE instant in a list of ISO timestamp STRINGS, as an ISO
 * `YYYY-MM-DD` — the generic `asOf` anchor for a claim derived from any
 * timestamped artifact (tool calls, structured-patch edits, mined corrections).
 *
 * Same rule and same rationale as {@link newestTokenDataDate}, which is now
 * expressed in terms of it: the anchor comes from the DATA, never from `now`,
 * because a claim is only true as of the last thing actually observed. Keeping
 * one derivation matters — two hand-rolled "newest timestamp" loops are exactly
 * the pair-that-drifts defect the audit keeps finding, and every detector must
 * demote against the same instant.
 *
 * Entries that are not real ISO instants are SKIPPED, not coerced
 * (`parseIsoInstantMs`) — these are raw transcript strings and older
 * writers/fixtures leave non-dates in them. An input with nothing readable
 * yields `undefined` — honest absence, since `provenance.asOf` is optional.
 */
export function newestIsoDate(
  timestamps: Iterable<string | null | undefined>
): string | undefined {
  let newest = 0;
  for (const t of timestamps) {
    if (typeof t !== 'string') continue;
    const ms = parseIsoInstantMs(t);
    if (ms !== undefined && ms > newest) newest = ms;
  }
  return isoDateFromMs(newest);
}

/**
 * The newest instant in a list of epoch-MILLISECOND values, as an ISO
 * `YYYY-MM-DD`. The numeric sibling of {@link newestIsoDate}, for artifacts
 * that carry a number rather than a string (`TaskRecord.mtimeMs`,
 * `WorkflowRun.startTime`).
 *
 * Entries that are not RENDERABLE instants are skipped before the maximum is
 * taken — `null`/`undefined`, non-finite, `<= 0`, and anything beyond the range
 * `Date.prototype.toISOString` can express. Filtering first is the point:
 * `parseWorkflowRun` takes `startTime` straight from a manifest, so one absurd
 * finite number would otherwise WIN the max and then fail to format, stripping
 * `asOf` from evidence that was perfectly well dated by its other runs. A
 * corpus with no usable instant yields `undefined` rather than 1970-01-01.
 */
export function newestEpochDate(
  msValues: Iterable<number | null | undefined>
): string | undefined {
  let newest = 0;
  for (const ms of msValues) {
    if (typeof ms !== 'number' || !isRenderableMs(ms)) continue;
    if (ms > newest) newest = ms;
  }
  return isoDateFromMs(newest);
}

/**
 * Shared automation-cost math: estimated spend on unattended (`sdk-*`) sessions,
 * the total estimated spend across all sessions, and automation's percentage
 * share of that total.
 *
 * Extracted from `ruleAutomationCost` (#299) so the Automation view's
 * cost-summary band and the recommendation rule read from ONE computation — they
 * must show the same number and never recompute it inline. `share` is a
 * percentage in [0, 100]; it is `0` when there's no billable total, so callers
 * don't have to guard a divide-by-zero.
 */
export function automationCostShare(tokenData: SessionTokenData[]): {
  autoCost: number;
  total: number;
  share: number;
} {
  let autoCost = 0;
  let total = 0;
  for (const d of tokenData) {
    const c = estimateCost(d);
    total += c;
    if (isUnattendedEntrypoint(d.entrypoint)) {
      autoCost += c;
    }
  }
  const share = total > 0 ? (autoCost / total) * 100 : 0;
  return { autoCost, total, share };
}

/** One task class's slice of the automation partition (internal helper shape). */
export interface AutomationClassCost {
  taskClass: TaskClass;
  /** Actual estimated spend on this class's unattended sessions. */
  autoCost: number;
  /** Counterfactual same-token Haiku-swap ceiling; non-bookable metadata. */
  swapSavings: number;
  /** Distinct unattended sessions assigned to this class. */
  sessions: number;
  /**
   * Billable (non-synthetic) automation turns counted for this class — the
   * sample size `n` behind its cost/swap estimate (#2141). Synthetic turns are
   * excluded, exactly as they are from the swap math.
   */
  sampleSize: number;
  /**
   * Freshest billable-turn timestamp (epoch ms) seen in this class, or `null`
   * when the class has no dated billable turn (#2141). The detector renders this
   * as the `asOf` date so a reader can gate on data freshness.
   */
  latestTimestampMs: number | null;
  /**
   * Classifier provenance for this class (#2376): one row per distinct matched
   * reason (`classifyTaskClassDetailed`) that assigned sessions here, with a
   * bounded sample of the session ids, so the partition is auditable. The rows'
   * `sessions` counts sum to {@link AutomationClassCost.sessions}. Surfaced by
   * the detector as `TaskClassCostBreakdown.classification`.
   */
  classification: TaskClassClassificationReason[];
}

/**
 * Representative session-id sample cap per matched reason (#2376). Small on
 * purpose: the sample only needs to let an auditor open a session and re-run the
 * classifier — the full membership is recoverable from the raw sessions — so a
 * handful keeps the `cost.automation-share` payload bounded no matter how many
 * sessions share a reason.
 */
export const MAX_CLASS_SESSION_REFS_PER_REASON = 3;

export interface AutomationCostByClass {
  /** Grand automation spend — identical to {@link automationCostShare}().autoCost. */
  autoCost: number;
  /** Grand same-token Haiku-swap ceiling across all classes. */
  swapSavings: number;
  /** Tokens behind positive swap deltas; retained as audit metadata. */
  swapTokens: number;
  /** Distinct unattended session ids across all classes. */
  sessionIds: string[];
  /** `scopeKeyOf(sessionId, model)` for every positive-delta entry. */
  scopeKeys: string[];
  /** Per-class partition, keyed by class. */
  byClass: Record<TaskClass, AutomationClassCost>;
  /** Per-class partition in the stable {@link TASK_CLASSES} order. */
  classes: AutomationClassCost[];
}

/**
 * Task-class segmentation of automation cost (#2139, epic #2138). PARTITIONS
 * the exact figures {@link automationCostShare} and the `cost.automation-share`
 * detector already compute: every unattended (`sdk-*`) session is assigned to
 * exactly one class via {@link classifyTaskClass} (from its `entrypoint` +
 * `opener`), so the returned per-class `autoCost` sums back to
 * `automationCostShare().autoCost` and the per-class `swapSavings` sums back to
 * the raw swap ceiling — by construction, nothing is dropped. The detector
 * exposes these figures as non-bookable metadata until quality proof exists.
 *
 * The swap-savings math here is the SAME per-entry counterfactual the detector
 * used inline (skip synthetic models, sum only positive actual−Haiku deltas via
 * {@link entryCostAtModel}), lifted into one place so the totals and the
 * per-class split cannot drift. The detector now derives its totals from this
 * helper.
 */
export function automationCostByClass(
  tokenData: SessionTokenData[]
): AutomationCostByClass {
  const mkClass = (taskClass: TaskClass): AutomationClassCost => ({
    taskClass,
    autoCost: 0,
    swapSavings: 0,
    sessions: 0,
    sampleSize: 0,
    latestTimestampMs: null,
    classification: [],
  });
  const byClass: Record<TaskClass, AutomationClassCost> = {
    authoring: mkClass('authoring'),
    mechanical: mkClass('mechanical'),
    review: mkClass('review'),
  };
  // Per-class classifier provenance (#2376), keyed by the matched reason. Built
  // alongside the cost partition so the "why" of the split is derived from the
  // exact same per-session classification, never a second re-run that could drift.
  const reasonsByClass: Record<TaskClass, Map<string, TaskClassClassificationReason>> = {
    authoring: new Map(),
    mechanical: new Map(),
    review: new Map(),
  };
  const recordReason = (result: TaskClassResult, sessionId: string): void => {
    const reasons = reasonsByClass[result.taskClass];
    const existing = reasons.get(result.reason);
    if (existing) {
      existing.sessions += 1;
      if (
        existing.sessionRefs.length < MAX_CLASS_SESSION_REFS_PER_REASON &&
        !existing.sessionRefs.includes(sessionId)
      ) {
        existing.sessionRefs.push(sessionId);
      }
      return;
    }
    reasons.set(result.reason, {
      reason: result.reason,
      signal: result.signal,
      sessions: 1,
      sessionRefs: [sessionId],
    });
  };
  const sessionIds = new Set<string>();
  const scopeKeys = new Set<string>();
  let autoCost = 0;
  let swapSavings = 0;
  let swapTokens = 0;

  for (const d of tokenData) {
    if (!isUnattendedEntrypoint(d.entrypoint)) continue;
    // Classify with the DETAILED classifier so the matched reason/signal is
    // retained as auditable per-class provenance (#2376), not discarded. The
    // resolved `taskClass` is identical to the label-only `classifyTaskClass`,
    // so the cost partition is unchanged.
    const classification = classifyTaskClassDetailed({
      entrypoint: d.entrypoint,
      opener: d.opener,
    });
    const bucket = byClass[classification.taskClass];
    // Count every unattended session (matches the detector's `sessions` set,
    // which is populated before the per-entry loop) so nothing is dropped.
    sessionIds.add(d.sessionId);
    bucket.sessions += 1;
    recordReason(classification, d.sessionId);
    const c = estimateCost(d);
    autoCost += c;
    bucket.autoCost += c;
    for (const entry of d.entries) {
      const model = entry.model || 'unknown';
      const resolved = resolveModelPricing(model);
      if (resolved.isSynthetic || resolved.isUnknownModel || resolved.isMissingModel) {
        continue;
      }
      // Every billable, priced turn is an observation behind this
      // class's estimate — its sample size (#2141). Track the freshest dated
      // turn so the detector can render an honest `asOf`.
      bucket.sampleSize += 1;
      const ts = new Date(entry.timestamp).getTime();
      if (Number.isFinite(ts)) {
        bucket.latestTimestampMs =
          bucket.latestTimestampMs === null
            ? ts
            : Math.max(bucket.latestTimestampMs, ts);
      }
      // COUNTERFACTUAL, NOT A GUARANTEE (#2548): this reprices the SAME tokens at
      // the cheaper model's rates — an UPPER-BOUND estimate that assumes the
      // cheaper model does the identical work in the same number of turns. A
      // cheaper model may need more iterations or fail to complete a class, so
      // the swap savings is a ceiling, not a promised reduction. That risk is
      // this detector's inference from the equal-token assumption; Anthropic's
      // guidance is to balance capability/speed/cost and test actual prompts.
      // Per-task-class classification is risk segmentation, not clearance.
      const delta =
        entryCostAtModel(entry, model) - entryCostAtModel(entry, CHEAPEST_MODEL);
      if (delta > 0) {
        swapSavings += delta;
        bucket.swapSavings += delta;
        scopeKeys.add(scopeKeyOf(d.sessionId, model));
        swapTokens +=
          entry.inputTokens +
          entry.outputTokens +
          entry.cacheCreationTokens +
          entry.cacheReadTokens;
      }
    }
  }

  // Freeze each class's provenance in a deterministic order (#2376): the
  // heaviest reason first, then reason text as a stable tiebreak, so the same
  // input always renders the same auditable rows.
  for (const c of TASK_CLASSES) {
    byClass[c].classification = [...reasonsByClass[c].values()].sort(
      (a, b) => b.sessions - a.sessions || a.reason.localeCompare(b.reason)
    );
  }

  return {
    autoCost,
    swapSavings,
    swapTokens,
    sessionIds: [...sessionIds],
    scopeKeys: [...scopeKeys],
    byClass,
    classes: TASK_CLASSES.map((c) => byClass[c]),
  };
}

// ── Quote- and heredoc-aware command splitting (ported from cwd-anchor-guard) ──
// Shared by the reliability detectors that scan Bash command text for a leading
// subcommand (`cwd-drift-execution`, `discovery-freshness`): a delimiter inside a
// quote (a commit message, a PR body) must NOT split, and heredoc bodies are
// dropped so their text isn't parsed as commands.

const HEREDOC_OPENER_RE = /<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/g;
/** Drop heredoc BODIES so their text isn't parsed as commands. */
export function stripHeredocs(command: string): string {
  const lines = command.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const openers = [...lines[i].matchAll(HEREDOC_OPENER_RE)].map((m) => ({
      dash: m[1] === '-',
      delim: m[3],
    }));
    if (!openers.length) continue;
    let j = i + 1;
    for (const op of openers) {
      while (j < lines.length) {
        const term = op.dash ? lines[j].replace(/^\t+/, '') : lines[j];
        j++;
        if (term === op.delim) break;
      }
    }
    i = j - 1;
  }
  return out.join('\n');
}

const SEGMENT_DELIMS = new Set([';', '|', '\n']);
/** Split a command into top-level segments, ignoring delimiters inside quotes. */
export function splitSegments(command: string): string[] {
  const src = stripHeredocs(command);
  const segs: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < src.length) {
        cur += c + src[++i];
        continue;
      }
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      segs.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (SEGMENT_DELIMS.has(c)) {
      segs.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  segs.push(cur);
  return segs.map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Timestamped window sums (#3235, #3238).
//
// Several detectors ask the same question repeatedly: "sum these numeric fields
// over the token entries whose timestamp falls in [lo, hi]". Done naively that
// is a fresh scan of the session's whole token history PER QUERY — O(Q x T) on
// the detector hot path, for a partition that does not depend on which query is
// asking.
//
// This builds the answer once per session: timestamps sorted ascending, plus a
// prefix sum per tracked field. A query is then two binary searches and one
// subtraction, O(log T). Floating-point note: prefix subtraction is not
// bit-identical to summing a slice, so dollar figures can differ in the last
// ulp; every consumer here already rounds or compares with a tolerance.
// ---------------------------------------------------------------------------

/** A sorted, prefix-summed index over timestamped numeric rows. */
export interface WindowSumIndex {
  /** Ascending event timestamps (ms). */
  readonly ms: number[];
  /** `prefix[f][i]` = sum of field `f` over the first `i` rows. Length T+1. */
  readonly prefix: number[][];
  /** Number of tracked fields. */
  readonly fieldCount: number;
}

/**
 * Build a {@link WindowSumIndex} from rows carrying a timestamp and N numeric
 * fields. Rows whose timestamp is not finite are dropped — the same rows the
 * per-query scans skipped.
 */
export function buildWindowSumIndex<T>(
  rows: readonly T[],
  msOf: (row: T) => number,
  fieldsOf: (row: T) => number[],
  fieldCount: number
): WindowSumIndex {
  const kept: { ms: number; fields: number[] }[] = [];
  for (const row of rows) {
    const ms = msOf(row);
    if (!Number.isFinite(ms)) continue;
    kept.push({ ms, fields: fieldsOf(row) });
  }
  kept.sort((a, b) => a.ms - b.ms);

  const ms = new Array<number>(kept.length);
  const prefix: number[][] = [];
  for (let f = 0; f < fieldCount; f++) prefix.push(new Array<number>(kept.length + 1).fill(0));
  for (let i = 0; i < kept.length; i++) {
    ms[i] = kept[i].ms;
    for (let f = 0; f < fieldCount; f++) {
      prefix[f][i + 1] = prefix[f][i] + (kept[i].fields[f] || 0);
    }
  }
  return { ms, prefix, fieldCount };
}

/** First index whose timestamp is >= `target` (T when none). */
function lowerBound(ms: readonly number[], target: number): number {
  let lo = 0;
  let hi = ms.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ms[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose timestamp is > `target` (T when none). */
function upperBound(ms: readonly number[], target: number): number {
  let lo = 0;
  let hi = ms.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ms[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Sum every tracked field over the rows inside a timestamp window, in
 * O(log T). `lowerInclusive` picks the half-open convention: `true` matches
 * `lo <= t <= hi` (#3235's span windows), `false` matches `lo < t <= hi`
 * (#3238's orphaned-turn windows, where the lower bound is the previous
 * boundary and must not be re-counted).
 */
export function sumInWindow(
  index: WindowSumIndex,
  loMs: number,
  hiMs: number,
  lowerInclusive: boolean
): number[] {
  const out = new Array<number>(index.fieldCount).fill(0);
  if (index.ms.length === 0) return out;
  if (!Number.isFinite(loMs) || !Number.isFinite(hiMs)) return out;
  const start = lowerInclusive ? lowerBound(index.ms, loMs) : upperBound(index.ms, loMs);
  const end = upperBound(index.ms, hiMs);
  if (end <= start) return out;
  for (let f = 0; f < index.fieldCount; f++) {
    out[f] = index.prefix[f][end] - index.prefix[f][start];
  }
  return out;
}
