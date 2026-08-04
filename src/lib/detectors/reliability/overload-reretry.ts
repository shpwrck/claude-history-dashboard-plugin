import type { Detector, RecProvenance } from '../types';
import { short, RATE_LIMIT_STATUSES, newestIsoDate } from '../shared';
import { type ReclaimClaim } from '../../reclaim';
import {
  PREFIX_REWASTE_FRAC,
  resolveReliabilityScopes,
} from './reclaim-prefix';

/**
 * `reliability.overload-reretry` — a 529/429 (overloaded / rate-limited) error
 * whose `retryAttempt > 1` means the SDK already retried at least once, re-paying
 * the turn's cached prefix on every re-attempt (epic #944, PR4, doc §3 cause-side
 * levers, $40–80/mo).
 *
 * **Gate: status ∈ {429, 529} AND `retryAttempt > 1`.** The first attempt is the
 * normal request — not waste. Only the *re*-attempts (`retryAttempt > 1`) re-paid a
 * prefix they shouldn't have, so the gate excludes attempt 1 (and any text-matched
 * event with no `retryAttempt`, which carries no attempt depth).
 *
 * **Conservative by construction (the no-`toolUseId` hard constraint, doc §6).**
 * Like `retry-prefix-rewaste`, the token→error join is timestamp-approximate, so we
 * book a `scaleTokens` on `cacheRead` ONLY, at the small fixed
 * {@link PREFIX_REWASTE_FRAC}, over the `(session, model)` rows whose entries fall
 * inside a short window around the error timestamp. Never the whole turn; never
 * `output`/`input`. `cause: 'failed-tool-retry'` keeps it in the behavioural band
 * so it books ahead of the structural cache-read levers (cause-first).
 */
const LEVER_ID = 'reliability.overload-reretry';

/**
 * Half-width (ms) of the timestamp window around a 529/429 re-retry event used to
 * find the token rows it re-paid. `ApiErrorEvent` carries a single point
 * timestamp (not a span), so we widen it symmetrically by a small amount to catch
 * the re-attempted turn's billing without sweeping in unrelated turns. Kept tight
 * (90s) on purpose — a wider window would over-claim under the fuzzy join.
 */
const EVENT_WINDOW_MS = 90_000;

export const detector: Detector = {
  id: LEVER_ID,
  category: 'reliability',
  dataDeps: ['apiErrors', 'tokenData'],
  rule(input) {
    // Gate: rate-limit/overload status AND a re-attempt (retryAttempt > 1).
    const reretries = input.apiErrors.filter(
      (e) =>
        e.status != null &&
        RATE_LIMIT_STATUSES.has(String(e.status)) &&
        typeof e.retryAttempt === 'number' &&
        e.retryAttempt > 1
    );
    if (reretries.length === 0) return null;

    // A short symmetric window per re-retry event, indexed by session.
    const windowsBySession = new Map<string, Array<{ start: number; end: number }>>();
    for (const e of reretries) {
      const t = Date.parse(e.timestamp);
      if (Number.isNaN(t)) continue;
      const list = windowsBySession.get(e.sessionId) ?? [];
      list.push({ start: t - EVENT_WINDOW_MS, end: t + EVENT_WINDOW_MS });
      windowsBySession.set(e.sessionId, list);
    }
    if (windowsBySession.size === 0) return null;

    const { scopeKeys, cacheReadTokens, estSavingsUsd } = resolveReliabilityScopes(
      input.tokenData,
      windowsBySession
    );
    if (scopeKeys.length === 0 || cacheReadTokens <= 0) return null;

    const reclaim: ReclaimClaim = {
      leverId: LEVER_ID,
      category: 'reliability',
      cause: 'failed-tool-retry',
      // Behavioural band; sits just after retry-prefix-rewaste within the band.
      orderKey: 14,
      ownedPools: ['cacheRead'],
      scopeKeys,
      counterfactual: { kind: 'scaleTokens', poolDeltaFrac: { cacheRead: PREFIX_REWASTE_FRAC } },
      evidenceTokens: cacheReadTokens,
    };

    const sessions = new Set(scopeKeys.map((k) => k.split('|')[0]));
    const maxAttempt = reretries.reduce((m, e) => Math.max(m, e.retryAttempt ?? 0), 0);
    const windowSec = EVENT_WINDOW_MS / 1000;
    // Dated by the newest OBSERVED re-attempt timestamp (#3205), never `now`.
    const asOf = newestIsoDate(reretries.map((e) => e.timestamp));
    const provenance: RecProvenance = {
      observations: [
        {
          claim: `${reretries.length} overload/rate-limit error(s) with status 429/529 AND retryAttempt>1 (up to ${maxAttempt}) across ${sessions.size} session(s)`,
          source: 'apiErrors',
          field: 'ApiErrorEvent.status / retryAttempt / timestamp / sessionId',
          value: reretries.length,
        },
        {
          claim: `~${(cacheReadTokens / 1_000_000).toFixed(2)}M cache-read token(s) fell inside a +/-${windowSec}s window around those re-attempt timestamps, over ${scopeKeys.length} (session, model) scope(s)`,
          source: 'tokenData',
          field: 'TokenEntry.timestamp / cacheReadTokens (per session+model scope)',
          value: cacheReadTokens,
        },
        {
          claim: `a conservative ${Math.round(PREFIX_REWASTE_FRAC * 100)}% of that in-window cache-read is booked as estimated associated waste`,
          source: 'tokenData',
          field: 'TokenEntry.cacheReadTokens x PREFIX_REWASTE_FRAC',
          value: Math.round(PREFIX_REWASTE_FRAC * 100),
        },
      ],
      inference: `The token->error association is a +/-${windowSec}s timestamp join, not an exact request match (ApiErrorEvent carries no request/toolUseId), so it is APPROXIMATE — unrelated in-window cache reads can be swept in. The figure is therefore an ESTIMATE of the cache-read waste associated with overload re-attempts, not a proven exact repayment.`,
      ...(asOf ? { asOf } : {}),
    };
    return {
      id: LEVER_ID,
      category: 'reliability',
      severity: 'info',
      title: 'Overload re-retries likely re-read the cached prefix (estimated waste)',
      detail: `${reretries.length} overload/rate-limit (429/529) error(s) re-attempted (retryAttempt up to ${maxAttempt}) across ${sessions.size} session(s); each re-attempt likely re-reads the turn's cached prefix. Associated by an approximate +/-${windowSec}s timestamp join (no exact request id), a conservative ${Math.round(
        PREFIX_REWASTE_FRAC * 100
      )}% of the in-window cache-read (~${(cacheReadTokens / 1_000_000).toFixed(
        2
      )}M tokens) is the estimated associated cache-read waste.`,
      action:
        'Pace heavy automated runs and schedule large unattended batches off-peak so 429/529 backoff re-attempts stop re-feeding the cached prefix.',
      estSavingsUsd,
      reclaim,
      affected: sessions.size,
      evidence: reretries
        .slice(0, 5)
        .map((e) => `${short(e.sessionId)}, ${e.status} attempt ${e.retryAttempt}`),
      view: 'errors',
      provenance,
    };
  },
};
