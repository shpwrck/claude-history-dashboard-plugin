import type { Detector } from '../types';
import type { AppliedMarkers } from '../types';
import { claudeMdMarksApplied, newestTokenDataDate, short } from '../shared';
import { LOW_HIT_RATE, computeCacheEfficiency } from '../../context-health';

const MARKERS_LOW_CACHE_HIT: AppliedMarkers = {
  headings: [/^##\s+(Keep the )?prompt cache\b/i],
  bodyPhrases: ['stable context prefix, so avoid churning'],
};

/** Low cache hit rate across sessions — context is being re-sent uncached. */
export const detector: Detector = {
  id: 'context.low-cache-hit',
  appliedMarkers: MARKERS_LOW_CACHE_HIT,
  category: 'context',
  dataDeps: ['tokenData', 'liveConfig'],
  rule(input) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS_LOW_CACHE_HIT)) return null;
    const eff = computeCacheEfficiency(input.tokenData).filter(
      (r) => r.totalReads + r.totalWrites > 0
    );
    if (eff.length === 0) return null;
    const low = eff.filter((r) => r.hitRate < LOW_HIT_RATE);
    if (low.length === 0) return null;
    const avg = eff.reduce((s, r) => s + r.hitRate, 0) / eff.length;
    // `computeCacheEfficiency` sorts ASCENDING by hitRate, so the head of the
    // filtered list is the worst reuse observed.
    const worst = low[0];
    const asOf = newestTokenDataDate(input.tokenData);

    // ── No reclaimable %/$ claim (#3121) ─────────────────────────────────────
    // Aggregate hit-rate CANNOT identify which written prefixes were later read,
    // so it cannot substantiate a reclaimable cache-write fraction or dollar
    // amount, and the parsed token counters carry no per-prefix write->read
    // lineage. This detector therefore stays advisory and exposes ONLY the
    // measured read/write reuse ratio as a labeled heuristic — it emits no
    // `reclaim` claim (see context-health.ts, epic #944/#949 reverted here).

    return {
      id: 'context.low-cache-hit',
      category: 'context',
      severity: 'info',
      title: 'Low cache hit rate on some sessions',
      detail: `${low.length} session(s) read back less than ${(LOW_HIT_RATE * 100).toFixed(0)}% of cached context (overall average ${(avg * 100).toFixed(0)}%). Low reuse means more tokens billed at full input rate.`,
      action:
        'Avoid frequent context churn within a session (large unrelated reads, mode switches) so the prompt cache stays warm.',
      affected: low.length,
      view: 'context',
      fix: {
        target: 'CLAUDE.md',
        label: 'Keep the cache warm',
        note: 'Append to CLAUDE.md so context stays stable within a session and the prompt cache is reused.',
        snippet: `## Keep the prompt cache warm\n\nCache hits require a stable context prefix, so avoid churning it mid-session:\n- Don't interleave large, unrelated file reads into focused work — batch related reads together.\n- Avoid switching permission modes or models in the middle of a task.\n- Don't re-Read files that haven't changed; reuse what's already in context.\n- Group similar work so repeated context (same files, same instructions) is reused rather than re-sent at full input rate.`,
        appliedMarkers: MARKERS_LOW_CACHE_HIT,
      },
      provenance: {
        observations: [
          {
            // Denominator excludes sessions with no cache traffic at all —
            // those have no hit rate to be low, and counting them would dilute
            // the proportion with sessions the rule never evaluated.
            claim: `${low.length} of ${eff.length} session(s) with any cache traffic read back less than the reuse floor`,
            source: 'context-health (computeCacheEfficiency over tokenData)',
            field: 'hitRate',
            value: low.length,
          },
          {
            claim: `the reuse floor is LOW_HIT_RATE = ${(LOW_HIT_RATE * 100).toFixed(0)}%`,
            source: 'context-health',
            field: 'LOW_HIT_RATE',
            value: LOW_HIT_RATE,
          },
          {
            claim: `the mean hit rate across those ${eff.length} session(s) is ${(avg * 100).toFixed(1)}%`,
            source: 'context-health (computeCacheEfficiency over tokenData)',
            field: 'hitRate',
            value: Number(avg.toFixed(4)),
          },
          {
            claim: `the worst reuse observed is ${(worst.hitRate * 100).toFixed(1)}%, on session ${short(worst.sessionId)}`,
            source: 'context-health (computeCacheEfficiency over tokenData)',
            field: 'hitRate',
            value: Number(worst.hitRate.toFixed(4)),
          },
        ],
        // Hit rates are measured; nothing here is a reclaimable amount. The
        // aggregate read/write ratio is a labeled heuristic reuse signal only —
        // it cannot identify WHICH written prefixes went unread, so it does not
        // support a reclaimable fraction or dollar saving (#3121). Low reuse also
        // has innocent causes (a genuinely short session, deliberately unrelated
        // work) that the hit rate alone cannot separate.
        inference:
          'Hit rates are measured re-use ratios (reads / (reads + writes)); they are ' +
          'exposed as a heuristic signal, not a reclaimable amount. Aggregate counters ' +
          'cannot identify which written prefixes were later read, so no reclaimable ' +
          'cache-write fraction or dollar saving is derivable or claimed. Low reuse also ' +
          'has innocent causes (a genuinely short session, deliberately unrelated work) ' +
          'that the hit rate alone cannot separate.',
        // Newest OBSERVED entry, never `now`.
        ...(asOf ? { asOf } : {}),
      },
    };
  },
};
