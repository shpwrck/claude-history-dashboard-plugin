import type { Detector } from '../types';
import type { AppliedMarkers } from '../types';
import { claudeMdMarksApplied, newestTokenDataDate, short } from '../shared';
import { OVER_WINDOW, computeContextGrowth } from '../../context-health';

const MARKERS_OVER_WINDOW: AppliedMarkers = {
  headings: [/^##\s+Context discipline\b/i],
  bodyPhrases: ['working context well under the model'],
};

function compactTokenCount(tokens: number): string {
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens % 1_000 === 0) return `${tokens / 1_000}K`;
  return tokens.toLocaleString();
}

/** Sessions that blew past the usable context window — compact earlier. */
export const detector: Detector = {
  id: 'context.over-window',
  appliedMarkers: MARKERS_OVER_WINDOW,
  category: 'context',
  dataDeps: ['tokenData', 'liveConfig'],
  rule(input) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS_OVER_WINDOW)) return null;
    const growth = computeContextGrowth(input.tokenData);
    const over = growth.flatMap((g) => {
      const resolution = g.contextWindow.resolution;
      if (
        resolution.kind !== 'exact' ||
        g.peakContext <= resolution.contextWindowTokens
      ) {
        return [];
      }
      return [
        {
          ...g,
          resolvedWindowTokens: resolution.contextWindowTokens,
          windowResolutionSource: resolution.source,
        },
      ];
    });
    if (over.length === 0) return null;
    // perf-index-contract: over-window-resolution-order always-consumed: every emitted finding renders this complete ordered window list in its copy and provenance
    const resolvedWindows = [
      ...new Set(over.map((g) => g.resolvedWindowTokens)),
    ].sort((a, b) => a - b);
    // perf-index-contract: over-window-resolution-source-order always-consumed: every emitted finding cites this complete ordered resolver-source list in provenance
    const windowResolutionSources = [
      ...new Set(over.map((g) => g.windowResolutionSource)),
    ].sort();
    const singleResolvedWindow =
      resolvedWindows.length === 1 ? resolvedWindows[0] : null;
    // Preserve the established 200K user-facing wording and fix bytes for
    // legacy rows whose missing model resolves through the explicit default.
    // Other exact tiers get truthful, derived wording instead of inheriting
    // 200K; provenance changes below so it cites the actual resolution.
    const isStandardWindow = singleResolvedWindow === OVER_WINDOW;
    const resolvedWindowLabel = singleResolvedWindow
      ? compactTokenCount(singleResolvedWindow)
      : resolvedWindows.map(compactTokenCount).join(' and ');
    // `computeContextGrowth` sorts by growthRate, NOT by peak, so `over[0]` is
    // not the highest peak. Fold over the field the observation cites.
    const highestPeak = over.reduce((a, b) => (b.peakContext > a.peakContext ? b : a));
    const asOf = newestTokenDataDate(input.tokenData);
    const title = isStandardWindow
      ? 'Sessions spilled past the 200K context window'
      : singleResolvedWindow
        ? `Sessions spilled past the ${resolvedWindowLabel} context window`
        : `Sessions spilled past resolved ${resolvedWindowLabel} context windows`;
    const detail = isStandardWindow
      ? `${over.length} session(s) peaked above 200K tokens, where context is evicted and re-sent at cost.`
      : singleResolvedWindow
        ? `${over.length} session(s) peaked above the exact resolved ${resolvedWindowLabel} context window, where context is evicted and re-sent at cost.`
        : `${over.length} session(s) peaked above their exact resolved context windows (${resolvedWindowLabel}), where context is evicted and re-sent at cost.`;
    const fixSnippet = isStandardWindow
      ? `## Context discipline\n\nKeep the working context well under the model's context window.\n- When the conversation grows large (roughly 150K+ tokens) or right after finishing a discrete task, run \`/compact\` to summarise and reclaim space.\n- When starting genuinely unrelated work, run \`/clear\` to begin a fresh session instead of carrying stale context.\n- Avoid pulling large files or command output into context the current task doesn't need.`
      : `## Context discipline\n\nKeep the working context well under each model's resolved context window (${resolvedWindowLabel}).\n- When the conversation approaches its resolved window or right after finishing a discrete task, run \`/compact\` to summarise and reclaim space.\n- When starting genuinely unrelated work, run \`/clear\` to begin a fresh session instead of carrying stale context.\n- Avoid pulling large files or command output into context the current task doesn't need.`;
    const windowResolutionObservation = {
      claim: singleResolvedWindow
        ? `the exact resolved context window is ${singleResolvedWindow.toLocaleString()} tokens via ${windowResolutionSources.join(' and ')}`
        : `the exact resolved context windows represented are ${resolvedWindows.map((tokens) => tokens.toLocaleString()).join(' and ')} tokens via ${windowResolutionSources.join(' and ')}`,
      source: 'context-health (computeContextGrowth / resolveContextWindowUsage)',
      field: 'contextWindow.resolution',
      value: singleResolvedWindow ?? resolvedWindows.join(','),
    };
    return {
      id: 'context.over-window',
      category: 'context',
      severity: 'warning',
      title,
      detail,
      action:
        'Compact earlier or start a fresh session once a task is done — keep working context well under the window.',
      affected: over.length,
      evidence: over
        .slice(0, 5)
        .map((g) => `${short(g.sessionId)}, peak ${(g.peakContext / 1000).toFixed(0)}k`),
      view: 'context',
      fix: {
        target: 'CLAUDE.md',
        fixKind: 'illustrative',
        label: 'Compact earlier',
        note: 'Append to your project (or ~/.claude) CLAUDE.md so Claude trims context before the window fills.',
        snippet: fixSnippet,
        appliedMarkers: MARKERS_OVER_WINDOW,
      },
      provenance: {
        observations: [
          {
            // Denominator is every session with at least one readable token
            // entry — `computeContextGrowth` skips only entry-less sessions, so
            // it is NOT "sessions that grew".
            claim: `${over.length} of ${growth.length} session(s) with readable token entries peaked above the window`,
            source: 'context-health (computeContextGrowth over tokenData)',
            field: 'peakContext',
            value: over.length,
          },
          {
            claim: `the highest observed peak was ${highestPeak.peakContext.toLocaleString()} tokens, on session ${short(highestPeak.sessionId)}`,
            source: 'context-health (computeContextGrowth over tokenData.entries)',
            field: 'peakContext',
            value: highestPeak.peakContext,
          },
          windowResolutionObservation,
        ],
        // The peak is measured; the eviction cost that follows from it is the
        // documented behaviour of the window, NOT something observed per
        // session here. Keeping those apart is the point of the split (#3185).
        inference:
          `A peak above ${isStandardWindow ? OVER_WINDOW.toLocaleString() : `its exact resolved ${resolvedWindowLabel} context window`} is a measured high-water mark. ` +
          'Eviction-and-re-send is what the window does past that point — this ' +
          'counts the sessions that reached it, not the tokens they re-paid.',
        // Newest OBSERVED entry, never `now`.
        ...(asOf ? { asOf } : {}),
      },
    };
  },
};
