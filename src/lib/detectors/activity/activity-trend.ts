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
import type { StatsCache } from '../../parse-stats-cache';
import { analyzeActivityTrend } from '../../parse-stats-cache';

/** WoW toolCallCount threshold above which the user is warned (+50%). */
export const HOT_THRESHOLD_PCT = 50;

export const detector: Detector = {
  id: 'activity.activity-trend',
  category: 'activity',
  dataDeps: ['statsCache' as keyof RecommendationInput],
  rule(input: RecommendationInput, now: number): ReturnType<Detector['rule']> {
    // Opt-in: `statsCache` is not (yet) part of the base RecommendationInput —
    // read it via a typed cast so other callers without it compile unchanged.
    const sc = (input as RecommendationInput & { statsCache?: StatsCache | null }).statsCache;
    if (!sc) return null;

    const analysis = analyzeActivityTrend(sc, now);

    // Not hot enough — nothing to say.
    if (analysis.verdict !== 'hotter' || analysis.toolCallCount.pctChange < HOT_THRESHOLD_PCT) {
      return null;
    }

    const { pctChange, thisWeek, lastWeek } = analysis.toolCallCount;
    const asOf = sc.lastComputedDate.slice(0, 10);
    const stale = analysis.stale;

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

    return {
      id: 'activity.activity-trend',
      category: 'activity',
      severity: pctChange >= 200 ? 'warning' : 'info',
      title,
      detail,
      action,
      affected: thisWeek,
      evidence: [
        `tool calls this week: ${thisWeek.toLocaleString()}`,
        `tool calls last week: ${lastWeek.toLocaleString()}`,
        `sessions this week: ${analysis.sessionCount.thisWeek}`,
        `sessions last week: ${analysis.sessionCount.lastWeek}`,
        `source: stats-cache.json (lastComputedDate: ${sc.lastComputedDate})`,
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
        ],
        inference: `Week-over-week tool-call rate is +${pctChange}% (>= ${HOT_THRESHOLD_PCT}% threshold), so at this pace the rolling 5h / weekly cap may be reached sooner than expected.`,
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
