import type { Detector } from '../types';
import { short } from '../shared';
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
    return {
      id: LEVER_ID,
      category: 'reliability',
      severity: 'info',
      title: 'Failed-tool retries re-pay the cached prefix',
      detail: `${errored.length} errored retry run(s) replayed their turn across ${sessions.size} session(s); each replay re-reads the cached prefix. A conservative ${Math.round(
        PREFIX_REWASTE_FRAC * 100
      )}% of the in-window cache-read (~${(cacheReadTokens / 1_000_000).toFixed(
        2
      )}M tokens) is re-paid waste — only the re-paid residual, not the legitimate co-located work.`,
      action:
        'Fix the root tool error once instead of re-running it — a single failed Bash/Edit/MCP call replays the whole turn and re-feeds its cache-read prefix. Check the Errors view for the recurring failure.',
      estSavingsUsd,
      reclaim,
      affected: sessions.size,
      evidence: errored
        .slice(0, 5)
        .map((g) => `${short(g.sessionId)}, ${g.toolName} ×${g.count}`),
      view: 'errors',
    };
  },
};
