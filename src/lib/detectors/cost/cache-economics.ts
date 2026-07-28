import type { SessionTokenData } from '../../../types';
import type { Detector } from '../types';
import { fmtUsd, MIN_SAVINGS_USD, short } from '../shared';
import { getModelPricing } from '../../pricing';

interface SessionContextSpend {
  sessionId: string;
  inputCost: number;
  cacheWriteCost: number;
  cacheWrite1hCost: number;
  cacheReadCost: number;
  cacheReadTokens: number;
  cacheCreation1hTokens: number;
}

const WARN_CACHE_READ_USD = 5;
const WARN_UNREAD_1H_USD = 1;

function emptySession(sessionId: string): SessionContextSpend {
  return {
    sessionId,
    inputCost: 0,
    cacheWriteCost: 0,
    cacheWrite1hCost: 0,
    cacheReadCost: 0,
    cacheReadTokens: 0,
    cacheCreation1hTokens: 0,
  };
}

function summarizeSession(data: SessionTokenData): SessionContextSpend {
  const out = emptySession(data.sessionId);
  for (const entry of data.entries) {
    const pricing = getModelPricing(entry.model);
    const cache1h = Math.min(
      entry.cacheCreation1hTokens,
      entry.cacheCreationTokens
    );
    const cache5m = entry.cacheCreationTokens - cache1h;

    out.inputCost += (entry.inputTokens / 1_000_000) * pricing.input;
    out.cacheWriteCost +=
      (cache5m / 1_000_000) * pricing.cacheWrite5m +
      (cache1h / 1_000_000) * pricing.cacheWrite1h;
    out.cacheWrite1hCost += (cache1h / 1_000_000) * pricing.cacheWrite1h;
    out.cacheReadCost += (entry.cacheReadTokens / 1_000_000) * pricing.cacheRead;
    out.cacheReadTokens += entry.cacheReadTokens;
    out.cacheCreation1hTokens += cache1h;
  }
  return out;
}

/**
 * Deterministic cache economics audit (#595): split observed context spend into
 * uncached input, cache writes, and cache reads. It deliberately does not claim
 * the deeper "dead / never-referenced token" tranche, which needs content-level
 * attribution beyond the token counters.
 */
export const detector: Detector = {
  id: 'cost.cache-economics',
  category: 'cost',
  dataDeps: ['tokenData'],
  rule(input) {
    const sessions = input.tokenData.map(summarizeSession);
    const inputCost = sessions.reduce((sum, s) => sum + s.inputCost, 0);
    const cacheWriteCost = sessions.reduce((sum, s) => sum + s.cacheWriteCost, 0);
    const cacheReadCost = sessions.reduce((sum, s) => sum + s.cacheReadCost, 0);
    const totalContextCost = inputCost + cacheWriteCost + cacheReadCost;
    if (totalContextCost <= 0) return null;

    const unread1h = sessions.filter(
      (s) => s.cacheCreation1hTokens > 0 && s.cacheReadTokens === 0
    );
    const unread1hCost = unread1h.reduce((sum, s) => sum + s.cacheWrite1hCost, 0);
    if (cacheReadCost < MIN_SAVINGS_USD && unread1hCost < MIN_SAVINGS_USD) {
      return null;
    }

    const novelCost = inputCost + cacheWriteCost;
    const cacheReadShare = Math.round((cacheReadCost / totalContextCost) * 100);
    const severity =
      cacheReadCost >= WARN_CACHE_READ_USD || unread1hCost >= WARN_UNREAD_1H_USD
        ? 'warning'
        : 'info';
    const topCacheRead = sessions
      .filter((s) => s.cacheReadCost > 0)
      .sort((a, b) => b.cacheReadCost - a.cacheReadCost)
      .slice(0, 3)
      .map(
        (s) =>
          `${short(s.sessionId)}: ${fmtUsd(s.cacheReadCost)} cache-read context`
      );
    const topUnread1h = unread1h
      .sort((a, b) => b.cacheWrite1hCost - a.cacheWrite1hCost)
      .slice(0, 3)
      .map(
        (s) =>
          `${short(s.sessionId)}: ${fmtUsd(s.cacheWrite1hCost)} 1h cache writes, no cache reads`
      );

    return {
      id: 'cost.cache-economics',
      category: 'cost',
      severity,
      title: 'Audit context cache economics',
      detail:
        (cacheReadCost > 0
          ? `${fmtUsd(cacheReadCost)} of context spend (${cacheReadShare}%) was re-sent from prompt cache. `
          : 'No cache-read context spend was recorded. ') +
        `${fmtUsd(novelCost)} was novel context (${fmtUsd(inputCost)} uncached input, ${fmtUsd(cacheWriteCost)} cache writes). ` +
        (unread1hCost > 0
          ? `${fmtUsd(unread1hCost)} was 1-hour cache write spend in session(s) with no cache reads of their own — a candidate for a shorter cache TTL, not a measured saving. `
          : '') +
        'The deeper dead-token tranche is not claimed here; this v0 uses only deterministic token counters.',
      action:
        'Use the highest cache-read sessions to target context-slimming work. Treat 1-hour cache writes with no same-session cache reads as a CANDIDATE for a shorter cache TTL, and check those sessions before changing anything — zero reads within the session does not establish the entry went unused.',
      // No estSavingsUsd (#3193). Zero SAME-SESSION cache reads was being
      // exported as the full write cost recovered. It does not establish that:
      // the entry may have been read by a later session, or after the captured
      // interval, and a shorter TTL would not have avoided the write cost
      // anyway — only the rate premium on it. Observed spend stays as
      // accounting; the recoverable fraction is not measured here.
      affected: new Set(
        sessions
          .filter((s) => s.cacheReadCost > 0 || s.cacheWrite1hCost > 0)
          .map((s) => s.sessionId)
      ).size,
      evidence: [...topCacheRead, ...topUnread1h],
      view: 'tokens',
      provenance: {
        observations: [
          {
            claim: `${fmtUsd(cacheReadCost)} spent on cache-read input tokens`,
            source: 'parse-sessions',
            field: 'TokenEntry.cacheReadTokens',
            value: Math.round(cacheReadCost * 100) / 100,
          },
          {
            claim: `${fmtUsd(novelCost)} spent on novel context tokens`,
            source: 'parse-sessions',
            field: 'TokenEntry.inputTokens + TokenEntry.cacheCreationTokens',
            value: Math.round(novelCost * 100) / 100,
          },
          {
            // Scope stated in the claim itself: the zero is same-session only,
            // so the reader is not left to assume it covers the entry's whole
            // lifetime (#3193).
            claim: `${unread1h.length} session(s) wrote 1-hour cache tokens and recorded zero cache-read tokens WITHIN THAT SESSION (reuse by a later session is not observed)`,
            source: 'parse-sessions',
            field: 'TokenEntry.cacheCreation1hTokens + TokenEntry.cacheReadTokens',
            value: unread1h.length,
          },
        ],
        inference:
          'Cache-read spend is observed re-sent context. Sessions that wrote 1-hour cache tokens and recorded zero cache reads are a candidate signal only, bounded by the same-session observation window: it cannot distinguish an entry that went unused from one reused by a later session or after the captured interval, so no recovered amount is claimed from it. Content-level dead-token attribution is intentionally deferred.',
      },
    };
  },
};
