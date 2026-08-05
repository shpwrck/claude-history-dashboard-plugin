/**
 * Detector: activity.activity-trend
 *
 * Fires when the user's tool-call rate is running materially hotter than last
 * week (>= +50% WoW), surfacing an early warning before they blow the rolling
 * 5h / weekly cap. Primary signal for persona P1 Sam (solo dev, Pro plan).
 *
 * Data source: `~/.claude/stats-cache.json` (CLI-precomputed; zero re-aggregation).
 * Optional field `statsCache` on RecommendationInput — if absent, emits nothing.
 *
 * Issue: #563 (P1 Sam building block)
 */

import type { Detector, RecommendationInput } from '../types';
import { analyzeActivityTrend } from '../../parse-stats-cache';
import { promptRegimeLabel, summarizePromptRegimes } from '../../prompt-regime';
import type { PromptRegimeSpan } from '../../prompt-regime';
import type { Session, SessionTokenData } from '../../../types';

/** WoW toolCallCount threshold above which the user is warned (+50%). */
export const HOT_THRESHOLD_PCT = 50;

/**
 * Prompt-regime awareness (#3405).
 *
 * This detector's whole claim is a week-over-week DELTA, so it is exactly the
 * shape of comparison the >80% Claude Code system-prompt cut confounds: a
 * shorter harness prompt changes how many tool calls a session makes, so a WoW
 * jump whose two weeks ran under different prompt regimes is partly attributable
 * to the harness rather than to the user working hotter. Silent aggregation
 * across that boundary is the failure mode being eliminated, so when the
 * comparison window crosses a regime cut the finding is annotated and its
 * confidence demoted rather than asserted at face value.
 *
 * `analyzeActivityTrend` compares `dailyActivity.slice(-14, -7)` against
 * `.slice(-7)`, so the comparison window is the last 14 RECORDED days of the
 * stats cache — rows exist only for days with activity, so those 14 rows can
 * span a much longer stretch of calendar time. Membership is therefore tested
 * against the recorded day set, not a first..last date range: a session on a
 * gap day inside that range contributed nothing to either week's totals and
 * must not confound a comparison it is not part of.
 *
 * The version comes from `tokenData`, NOT from `Session.version`. `Session`
 * objects reach detectors via `groupBySessions` (`parse-history.ts`), which
 * builds them from `HistoryEntry` — a shape that carries no `version` at all,
 * so `Session.version` is always undefined in production and keying off it
 * would make this whole path dead code. `SessionTokenData` is the shape that
 * actually carries the parsed transcript `version`, so the two are joined by
 * `sessionId`: `sessions` supplies the timing, `tokenData` the regime key.
 */
function regimeSpanForWindow(
  sessions: Session[],
  tokenData: SessionTokenData[],
  windowDates: string[]
): PromptRegimeSpan {
  if (sessions.length === 0 || windowDates.length === 0) return summarizePromptRegimes([]);

  // perf-index-contract: prompt-regime-window-days always-consumed: built only after the empty-window guard above, and every build is immediately queried once per session by the filter on the next line
  const recordedDays = new Set(windowDates);
  const inWindow = sessions.filter(
    (s) =>
      Number.isFinite(s.startTime) &&
      recordedDays.has(new Date(s.startTime).toISOString().slice(0, 10))
  );
  if (inWindow.length === 0) return summarizePromptRegimes([]);

  // perf-index-contract: prompt-regime-session-version always-consumed: built only after the empty-in-window guard above, so the map below is queried at least once on every path that constructs it
  const versionBySessionId = new Map(tokenData.map((t) => [t.sessionId, t.version]));
  return summarizePromptRegimes(inWindow.map((s) => versionBySessionId.get(s.sessionId)));
}

export const detector: Detector = {
  id: 'activity.activity-trend',
  category: 'activity',
  // #3405 prompt-regime segmentation joins `sessions` (which day a session ran)
  // to `tokenData` (which Claude Code `version` it ran on) by sessionId; the
  // trend numbers themselves still come only from `statsCache`.
  dataDeps: ['statsCache', 'sessions', 'tokenData'],
  rule(input: RecommendationInput, now: number): ReturnType<Detector['rule']> {
    const sc = input.statsCache;
    if (!sc) return null;

    const analysis = analyzeActivityTrend(sc, now);

    // Not hot enough — nothing to say.
    if (analysis.verdict !== 'hotter' || analysis.toolCallCount.pctChange < HOT_THRESHOLD_PCT) {
      return null;
    }

    const { pctChange, thisWeek, lastWeek } = analysis.toolCallCount;
    const asOf = sc.lastComputedDate.slice(0, 10);
    const stale = analysis.stale;

    // #3405: does the comparison window straddle a prompt-regime change?
    const windowDates = sc.dailyActivity.slice(-14).map((d) => d.date);
    const span = regimeSpanForWindow(input.sessions ?? [], input.tokenData ?? [], windowDates);
    const confounded = span.confounded;
    const regimeNote = span.spansBoundary
      ? `spans a Claude Code prompt-regime change (${span.regimes.map(promptRegimeLabel).join(' -> ')})`
      : 'includes sessions on a Claude Code version too close to a prompt-regime change to place';
    // Name every regime the window touched, including the unplaceable ones — a
    // mixed window resolves one regime AND carries indeterminate sessions, so
    // reporting only the resolved id would contradict the claim beside it.
    const regimeValue =
      [...span.regimes, ...(span.hasIndeterminate ? ['indeterminate'] : [])].join(',') ||
      'indeterminate';

    // Stale-input demotion (#1102): when the stats cache is stale, "this week"
    // / "is running" / "at this pace" are no longer honestly present-tense —
    // the latest *computed* week may be days old. Demote to a dated, past-tense
    // framing instead of asserting current state from stale data.
    const title = stale
      ? `Tool-call rate ran ${pctChange}% hotter than the prior week (as of ${asOf})`
      : `Tool-call rate is running ${pctChange}% hotter than last week`;
    const detail = stale
      ? `As of ${asOf} (latest computed week — stats-cache.json may be stale; run the CLI to refresh): ` +
        `${thisWeek.toLocaleString()} tool calls vs ${lastWeek.toLocaleString()} the prior week (+${pctChange}%). ` +
        `At that pace the rolling 5-hour or weekly cap was being approached sooner than expected.`
      : `This week so far: ${thisWeek.toLocaleString()} tool calls vs ${lastWeek.toLocaleString()} last week (+${pctChange}%). ` +
        `At this pace you may hit the rolling 5-hour or weekly cap sooner than expected.`;
    const action = stale
      ? 'Refresh the CLI stats (run any Claude command) to get a current read, then consider spreading heavy work across more sessions.'
      : 'Consider cooling off — spread heavy work across more sessions, ' +
        'or check your 5h/weekly usage before starting the next large task.';

    // Regime-spanning demotion (#3405): the WoW delta is not attributable to the
    // user alone, so it never escalates to `warning` and the copy says why.
    const regimeTitle = confounded ? `${title} (confounded: ${regimeNote})` : title;
    // The hedge is deliberate: REFERENCES.md records that the size of the
    // prompt cut's effect is NOT measurable from local data, so this may not
    // claim the harness "changes tool-call volume" — only that the two causes
    // cannot be told apart here (auditable-claims rule, AGENTS.md).
    const regimeDetail = confounded
      ? `${detail} Treat the delta as indicative only: the comparison window (last 14 recorded days) ${regimeNote}, ` +
        `so a change in the harness prompt cannot be separated from a change in your own pace.`
      : detail;
    const regimeAction = confounded
      ? `${action} Before reading this as a behavior change, compare weeks that ran on the same Claude Code prompt regime.`
      : action;

    return {
      id: 'activity.activity-trend',
      category: 'activity',
      severity: !confounded && pctChange >= 200 ? 'warning' : 'info',
      title: regimeTitle,
      detail: regimeDetail,
      action: regimeAction,
      affected: thisWeek,
      evidence: [
        `tool calls this week: ${thisWeek.toLocaleString()}`,
        `tool calls last week: ${lastWeek.toLocaleString()}`,
        `sessions this week: ${analysis.sessionCount.thisWeek}`,
        `sessions last week: ${analysis.sessionCount.lastWeek}`,
        `source: stats-cache.json (lastComputedDate: ${sc.lastComputedDate})`,
        ...(confounded
          ? [
              `prompt regime: comparison window ${regimeNote} ` +
                `(${span.knownCount} versioned sessions in window, ${span.unknownCount} without a version)`,
            ]
          : []),
      ],
      // Auditability contract (#1049, epic #866 keystone): the observed facts
      // each cite stats-cache.json + their parsed field, the inference is kept
      // separate from them, and `asOf`/`stale` carry the lastComputedDate so the
      // stale-input demotion (#1102) can reword "this week so far" honestly.
      provenance: {
        observations: [
          {
            claim: `${thisWeek.toLocaleString()} tool calls in the current week window`,
            source: 'stats-cache.json',
            field: 'lastComputedDate / per-day toolCallCount (this week)',
            value: thisWeek,
          },
          {
            claim: `${lastWeek.toLocaleString()} tool calls in the prior week window`,
            source: 'stats-cache.json',
            field: 'per-day toolCallCount (last week)',
            value: lastWeek,
          },
          ...(confounded
            ? [
                {
                  claim: `The comparison window (last 14 recorded days) ${regimeNote}`,
                  source: 'session transcripts',
                  field: 'version (top-level transcript field) -> promptRegimeForVersion',
                  value: regimeValue,
                },
              ]
            : []),
        ],
        inference: confounded
          ? `Week-over-week tool-call rate is +${pctChange}% (>= ${HOT_THRESHOLD_PCT}% threshold), but the two weeks did not run under the same Claude Code system prompt, so a harness contribution cannot be separated from the user's own pace and the finding is reported without escalation.`
          : `Week-over-week tool-call rate is +${pctChange}% (>= ${HOT_THRESHOLD_PCT}% threshold), so at this pace the rolling 5h / weekly cap may be reached sooner than expected.`,
        // `asOf` is normalized to YYYY-MM-DD above: `lastComputedDate` is only
        // contracted as a non-empty string by parse-stats-cache, so a CLI that
        // ever writes a full timestamp must not break the strict ISO-date
        // provenance contract. `stale` drives the wording demotion (#1102).
        asOf,
        stale,
      },
      view: 'activity',
    };
  },
};
