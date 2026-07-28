import type { Detector, RecObservation, RecommendationInput } from '../types';
import { parsePermRule, permRuleMatchesCall } from '../shared';
import { isAsOfStale } from '../provenance';
import { rfc3339TimestampMs } from '../../parse-tools';

/**
 * Retained history whose newest tool call is older than this makes the "never
 * matched" claim a statement about a stale window rather than about current
 * behaviour, so the wording is demoted to "as of <date>" (#1102).
 */
const STALE_DAYS = 14;

/**
 * Minimum retained tool calls before "this rule never matched" carries any
 * information (#3221).
 *
 * With little or no retained history — a fresh install, a failed or partial
 * ingest, a pruned transcript directory — every rule trivially "never matched"
 * because there was nothing for it to match against. Reporting that presents
 * ABSENCE OF EVIDENCE as EVIDENCE OF ABSENCE.
 *
 * Counted over ALL retained tool calls rather than Bash calls specifically,
 * because this detector judges every evaluable deny rule — bare-tool rules for
 * any tool, not only `Bash(...)` rules. Counted over all calls rather than the
 * DATED ones for the same reason `permRuleMatchesCall` needs no timestamp:
 * matching is the floor's subject, and an undated call still exercises a rule.
 * The per-tool split is reported in the detail and provenance instead of gating
 * the finding, so a reader can weigh how much evidence stands behind any
 * individual rule.
 */
const MIN_RETAINED_CALLS = 20;

/** ISO `YYYY-MM-DD` of an epoch-ms instant. */
function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Retained-history coverage — the SINGLE derivation every dated claim in this
 * detector rests on (#3221 follow-up).
 *
 * The bug this shape exists to make unrepresentable: an earlier version counted
 * every retained call into `calls` but skipped undated ones when computing the
 * date bounds, so a MIXED history could report "N retained calls spanning X to
 * Y" when only a subset was dated — and could mark the evidence fresh on the
 * strength of a single dated call. Two numbers derived from two different sets
 * of calls will eventually disagree; the fix is not to add a third number
 * tracking the discrepancy but to make the discrepancy impossible.
 *
 * So {@link RetainedCoverage.window} is non-null ONLY when every retained call
 * is dated. One undated call and the window, the `asOf`, and the `stale` flag
 * all fall away together, because they are all read off this one field — there
 * is no path on which a window is asserted over calls it does not cover. This
 * fails closed exactly like `resolveEvidenceRef`'s ambiguous-timestamp fallback
 * (#3125): where the data cannot support the claim, decline it rather than
 * narrow it.
 *
 * Undatedness is not the norm — a `ToolCall.timestamp` is `entry.timestamp ??
 * ''` (`parse-tools`), so it is empty only for a malformed or partial
 * transcript entry — which is why declining the whole window costs little in
 * practice. Datedness is judged by `rfc3339TimestampMs`, not `Date.parse`:
 * a permissive parse would read `'2026'` as an instant, quietly re-admitting
 * the very guess this guard declines.
 */
interface RetainedCoverage {
  /** Every retained call — the basis for the floor AND for match evaluation. */
  calls: number;
  /** Bash share of {@link calls} (same basis, so the two can be stated together). */
  bashCalls: number;
  sessions: number;
  /** How many of {@link calls} carry no readable RFC3339 timestamp. */
  undated: number;
  /** Inclusive day bounds — non-null ONLY when `undated === 0`. */
  window: { firstDay: string; lastDay: string } | null;
}

function retainedCoverage(toolData: RecommendationInput['toolData']): RetainedCoverage {
  let calls = 0;
  let bashCalls = 0;
  let undated = 0;
  let oldestMs = Number.POSITIVE_INFINITY;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const sess of toolData) {
    for (const call of sess.calls) {
      calls += 1;
      if (call.toolName === 'Bash') bashCalls += 1;
      const ms = rfc3339TimestampMs(call.timestamp);
      if (ms === null) {
        undated += 1;
        continue;
      }
      if (ms < oldestMs) oldestMs = ms;
      if (ms > newestMs) newestMs = ms;
    }
  }
  return {
    calls,
    bashCalls,
    sessions: toolData.length,
    undated,
    // Fail closed: partial dating is not a datable window.
    window:
      undated === 0 && calls > 0
        ? { firstDay: isoDay(oldestMs), lastDay: isoDay(newestMs) }
        : null,
  };
}

/**
 * Permission `deny` rules that never matched a tool call in retained history
 * (#175) — reported as an OBSERVATION, never as advice to remove them (#3221,
 * decided on #3383).
 *
 * **What this detector deliberately does not do.** It does not claim a listed
 * rule is unused, unnecessary, dead config, or safe to delete, and it emits no
 * `fix` — no removal checklist, no settings.json fragment, nothing to copy. A
 * deny rule is a GUARD, and "never triggered" is what success looks like for a
 * guard: the dangerous thing was never attempted, or the rule deterred it.
 * "Did this rule ever fire?" is answerable from usage data; "is this rule
 * necessary?" is not.
 *
 * That is also why there is no command-safety classification here. Five review
 * rounds on #3376 established that deciding "is deleting this guard safe?" for
 * an arbitrary command string does not converge: a denylist of dangerous stems
 * missed `terraform destroy`; prefix matching missed `ls && rm -rf /`; a
 * character allowlist missed `env rm -rf /`, because wrappers (`env`, `nice`,
 * `timeout`, `nohup`, `xargs`, `sudo -u`, `watch`, `time`) execute their
 * arguments. Deleting the deletion advice deletes the question, and with it the
 * whole bypass surface — so every evaluable deny rule is reported, destructive
 * ones included, precisely because nothing here proposes touching any of them.
 *
 * **No `fix`, deliberately.** `RecFix.fixKind` defaults to `'validated'` when
 * absent (`detectors/fix-validity.ts`), which is exactly how #3221 shipped an
 * additive `{"permissions":{"deny":[…]}}` snippet under prune wording. Emitting
 * no `fix` at all is the only shape with no implicit default to get wrong; an
 * inert "informational" fix block would still render as a copy-paste surface
 * for advice this detector does not give.
 *
 * **Scope of the claim.** RETAINED history only: "no call we can see matched
 * this rule". The provenance cites the settings array and the tool-call coverage
 * the comparison ran over, and — when {@link RetainedCoverage.window} exists at
 * all — the `asOf` date of the newest retained call, demoting to "as of <date>"
 * once that window goes stale. Partially-dated history yields no window and
 * therefore no dated claim of any kind; see {@link RetainedCoverage}.
 */
export const detector: Detector = {
  id: 'safety.deny-rule-never-triggered',
  category: 'safety',
  dataDeps: ['toolData', 'liveConfig'],
  rule(input, now) {
    const deny = input.liveConfig?.settings?.permissions?.deny;
    if (!Array.isArray(deny) || deny.length === 0) return null;

    // ── retained-history coverage: what the "never matched" claim is made over ──
    // Computed FIRST: with too little retained history every rule trivially
    // "never matched", so there is no honest observation to report at all.
    const coverage = retainedCoverage(input.toolData);
    if (coverage.calls < MIN_RETAINED_CALLS) return null;

    const unused: string[] = [];
    let judged = 0;
    let notEvaluable = 0;
    for (const rule of deny) {
      if (typeof rule !== 'string') continue;
      const { tool, specifier } = parsePermRule(rule);
      // EVIDENCE limit, not a safety judgement: `permRuleMatchesCall` returns
      // `null` for a non-Bash rule carrying a specifier (a path glob such as
      // `Read(./secrets/**)`) — it models this repo's Bash-prefix subset, not
      // Claude Code's full matcher — so "never matched" cannot be established
      // for those. They are counted and disclosed rather than guessed at.
      if (tool !== 'Bash' && specifier !== null) {
        notEvaluable += 1;
        continue;
      }
      judged += 1;
      let matched = false;
      for (const sess of input.toolData) {
        for (const call of sess.calls) {
          if (permRuleMatchesCall(rule, call) === true) {
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
      if (!matched) unused.push(rule);
    }
    if (unused.length === 0) return null;

    // Every dated claim below reads off `coverage.window` — absent it, there is
    // no asOf, no stale flag, and no span in the prose. They cannot disagree
    // because there is nothing to disagree with.
    const asOf = coverage.window?.lastDay;
    const stale = asOf !== undefined ? isAsOfStale(asOf, now, STALE_DAYS) : undefined;

    const base = `${coverage.calls} retained tool call(s) (${coverage.bashCalls} Bash) across ${coverage.sessions} session(s)`;
    const undatedText =
      coverage.undated === coverage.calls
        ? 'none of them carry a readable timestamp'
        : `${coverage.undated} of them carry no readable timestamp`;
    const coverageText = coverage.window
      ? `${base}, spanning ${coverage.window.firstDay} to ${coverage.window.lastDay}`
      : `${base}; ${undatedText}, so this window cannot be dated`;
    const scope = stale
      ? `as of ${asOf}, in retained history`
      : 'in your retained history';
    const excluded =
      notEvaluable > 0
        ? ` ${notEvaluable} further rule(s) carry a non-Bash specifier this check cannot evaluate and are excluded from the comparison.`
        : '';

    const observations: RecObservation[] = [
      {
        claim: `${deny.length} permission deny rule(s) are configured`,
        source: 'liveConfig',
        field: 'settings.permissions.deny',
        value: deny.length,
      },
      {
        claim: `${unused.length} of the ${judged} evaluable rule(s) matched no retained tool call; ${notEvaluable} rule(s) were not evaluable and are excluded`,
        source: 'parse-tools',
        field: 'toolData[].calls[]',
        value: unused.length,
      },
      {
        // Same single derivation as the detail string — the count and the span
        // are read off one `coverage`, so the observation cannot cite a window
        // wider than the calls it was computed from.
        claim: `the comparison ran over ${coverageText}`,
        source: 'parse-tools',
        field: 'toolData[].calls[].timestamp',
        value: coverage.calls,
      },
    ];

    return {
      id: 'safety.deny-rule-never-triggered',
      category: 'safety',
      severity: 'info',
      title: 'Deny rules with no match in retained history',
      detail: `${unused.length} of ${judged} evaluable permission deny rule(s) never matched a tool call ${scope}. A guard that never fires may simply be working — the action was never attempted, or the rule deterred it — so this is not evidence that any of them is unnecessary. Judged over ${coverageText}.${excluded}`,
      action:
        'Informational only: review whether each rule below is still needed. This check reports what never matched; it does not judge whether a rule is safe to remove and recommends no configuration change. Never matching is the expected outcome for a deny rule that is doing its job.',
      evidence: unused,
      affected: unused.length,
      view: 'permissions',
      claimClass: 'accounting',
      proofTier: 'accounting',
      provenance: {
        observations,
        inference:
          'No retained tool call matched these rules within the observed window. That establishes only that they did not fire there — not that they are unused, unnecessary, or safe to remove. No removal is proposed and no configuration change is emitted.',
        ...(asOf !== undefined ? { asOf } : {}),
        ...(stale !== undefined ? { stale } : {}),
      },
    };
  },
};
