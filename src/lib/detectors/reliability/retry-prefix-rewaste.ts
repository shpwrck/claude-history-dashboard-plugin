import type { Detector } from '../types';
import { newestIsoDate, short } from '../shared';
import { detectRetryGroups } from '../../parse-errors';
import { type ReclaimClaim } from '../../reclaim';
import {
  PREFIX_REWASTE_FRAC,
  makeWindow,
  resolveReliabilityScopes,
} from './reclaim-prefix';

/**
 * `reliability.retry-prefix-rewaste` — a failed tool forced its turn (and the
 * turn's cache-read prefix) to be replayed; that prefix re-read is re-paid waste
 * (epic #944, PR4, doc §3/§4 cause-side levers).
 *
 * **Gate: `RetryGroup.hasErrors`, NOT retry count.** A long back-to-back run with
 * no error is legitimate co-located work (e.g. paging through results) and must
 * book $0 — only a run that actually *errored* re-paid a prefix it shouldn't have.
 * Gating on count would over-book that legitimate work (doc §3: "gate on
 * `RetryGroup.hasErrors`, not count").
 *
 * **Conservative by construction (the no-`toolUseId` hard constraint).** Because
 * `TokenEntry` has no edge to the `ToolCall` stream, the token→tool join is
 * timestamp-approximate: we book a `scaleTokens` on `cacheRead` ONLY, at the small
 * fixed {@link PREFIX_REWASTE_FRAC}, over the `(session, model)` rows whose entries
 * fall inside the errored group's `[start, end]` window. The turn's `output`/`input`
 * — the legitimate work — are never touched, and `frac ≪ 1` forbids whole-turn
 * deletion. `cause: 'failed-tool-retry'` puts it in the behavioural band so it books
 * AHEAD of the structural prefix lever that shares the same cache-read (cause-first).
 */
const LEVER_ID = 'reliability.retry-prefix-rewaste';

export const detector: Detector = {
  id: LEVER_ID,
  category: 'reliability',
  dataDeps: ['toolData', 'tokenData'],
  rule(input) {
    // Gate strictly on hasErrors — a high-count, error-free run books nothing.
    const errored = detectRetryGroups(input.toolData).filter((g) => g.hasErrors);
    if (errored.length === 0) return null;

    // One time-window per errored group, indexed by session, for the
    // timestamp-approximate token join.
    const windowsBySession = new Map<string, Array<{ start: number; end: number }>>();
    for (const g of errored) {
      const w = makeWindow(g.startTimestamp, g.endTimestamp);
      if (!w) continue;
      const list = windowsBySession.get(g.sessionId) ?? [];
      list.push(w);
      windowsBySession.set(g.sessionId, list);
    }
    if (windowsBySession.size === 0) return null;

    const { scopeKeys, cacheReadTokens, estSavingsUsd } = resolveReliabilityScopes(
      input.tokenData,
      windowsBySession
    );
    // No priced cache-read in any errored window ⇒ nothing to dollarize. The
    // detector still has a real reliability finding, but with no token scope we
    // emit no reclaim (and no card) — the existing retry-storms detector covers
    // the qualitative signal.
    if (scopeKeys.length === 0 || cacheReadTokens <= 0) return null;

    const reclaim: ReclaimClaim = {
      leverId: LEVER_ID,
      category: 'reliability',
      cause: 'failed-tool-retry',
      // Behavioural band [10,40); causeRank('failed-tool-retry')=10 makes this
      // book ahead of the structural prefix lever sharing the cache-read.
      orderKey: 12,
      ownedPools: ['cacheRead'],
      scopeKeys,
      // Conservative cache-read-only nick — never the whole turn (no toolUseId edge).
      counterfactual: { kind: 'scaleTokens', poolDeltaFrac: { cacheRead: PREFIX_REWASTE_FRAC } },
      evidenceTokens: cacheReadTokens,
    };

    const sessions = new Set(scopeKeys.map((k) => k.split('|')[0]));
    const attributedPct = Math.round(PREFIX_REWASTE_FRAC * 100);
    const asOf = newestIsoDate(
      errored.flatMap((g) => [g.startTimestamp, g.endTimestamp])
    );
    return {
      id: LEVER_ID,
      category: 'reliability',
      severity: 'info',
      title: 'Errored same-tool runs overlap cached-prefix reads',
      detail: `${errored.length} errored consecutive same-tool run(s) were observed; their session windows contained priced cache-read in ${sessions.size} session(s). The conservative attribution model books ${attributedPct}% of that in-window cache-read (~${(cacheReadTokens / 1_000_000).toFixed(
        2
      )}M tokens) as possible re-paid prefix, leaving the legitimate co-located work untouched.`,
      action:
        'Investigate the root tool error before repeating the call; use the Errors view to find the recurring failure.',
      estSavingsUsd,
      reclaim,
      affected: sessions.size,
      evidence: errored
        .slice(0, 5)
        .map((g) => `${short(g.sessionId)}, ${g.toolName} ×${g.count}`),
      view: 'errors',
      provenance: {
        observations: [
          {
            claim: `${errored.length} consecutive same-tool run(s) included at least one error`,
            source: 'parse-errors (detectRetryGroups over parse-tools)',
            field: 'detectRetryGroups().hasErrors',
            value: errored.length,
          },
          {
            claim: `${sessions.size} session(s) had priced cache-read inside those timestamp windows`,
            source: 'detectors/reliability/reclaim-prefix',
            field: 'resolveReliabilityScopes().scopeKeys',
            value: sessions.size,
          },
          {
            claim: `${cacheReadTokens} cache-read token(s) fell inside the resolved windows`,
            source: 'detectors/reliability/reclaim-prefix',
            field: 'resolveReliabilityScopes().cacheReadTokens',
            value: cacheReadTokens,
          },
          {
            claim: `the conservative attribution fraction is ${attributedPct}%`,
            source: 'detectors/reliability/reclaim-prefix',
            field: 'PREFIX_REWASTE_FRAC',
            value: attributedPct,
          },
          {
            claim: `the resulting estimated saving is $${estSavingsUsd.toFixed(4)}`,
            source: 'detectors/reliability/reclaim-prefix',
            field: 'resolveReliabilityScopes().estSavingsUsd',
            value: estSavingsUsd,
          },
          {
            claim: 'displayed evidence rows identify the session, tool, and same-tool run length',
            source: 'parse-errors (detectRetryGroups over parse-tools)',
            field: 'detectRetryGroups().{sessionId,toolName,count}',
          },
        ],
        inference:
          'The errored tool runs and token rows are joined only by session and timestamp. ' +
          'There is no toolUseId edge, so the fixed fraction is a conservative accounting ' +
          'attribution rather than proof that every overlapping cache-read token was caused by a retry.',
        ...(asOf ? { asOf } : {}),
      },
    };
  },
};
