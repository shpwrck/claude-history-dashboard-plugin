import type { Detector } from '../types';
import type { ClaimDerivation } from '../../claim-provenance';
import { claudeMdMarksApplied, fmtUsd, newestTokenDataDate, short, STALE_WEEKS } from '../shared';
import { isAsOfStale } from '../provenance';
import { SERVER_TOOL_PRICING } from '../../pricing';
import { estimateCost } from '../../parse-sessions';
import { scopeKeyOf, type ReclaimClaim } from '../../reclaim';

// Web-search requests bill at a flat $0.01 each and aren't cached — research
// loops that re-search the same query each turn add up. (#414)
const MIN_SEARCH_COST_USD = 0.5;
const MIN_SHARE = 0.1; // search cost must be >10% of total spend to flag

/**
 * The conservative share of observed web-search spend booked as avoidable
 * (#3508). The detector measures how much was SPENT on search, not how much of
 * it was avoidable — most searches are work the user wanted. Booking the full
 * observed spend as savings asserted that web-search discipline eliminates
 * 100% of it (the same full-observed-cost shape removed from
 * `batchable-workload`/`cache-1h-waste`/`cache-economics`/`expensive-sessions`
 * in #3191–#3193/#3196). What discipline plausibly removes is the re-search
 * overlap the copy describes ("research loops often re-fetch the same
 * queries"), so a deliberately conservative fraction is booked instead and the
 * constant is surfaced in the card copy and cited in provenance.
 */
export const AVOIDABLE_SEARCH_FRACTION = 0.25;

/** Search evidence older than this demotes to "as of <date>" (#3201). */
const STALE_AFTER_DAYS = STALE_WEEKS * 7;

const MARKERS = {
  headings: [/^##\s+Web-search discipline\b/i],
  bodyPhrases: ['Prefer web_fetch for stable URLs'],
};

/**
 * Flag web-search request spend that is both material and a meaningful share of
 * total cost. Self-suppresses once CLAUDE.md documents web-search discipline.
 * (#414)
 */
export const detector: Detector = {
  id: 'cost.web-search-spend',
  appliedMarkers: MARKERS,
  category: 'cost',
  dataDeps: ['tokenData', 'liveConfig'],
  rule(input, now) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS)) return null;
    let searches = 0;
    let totalCost = 0;
    // #3516 review: estimateCost zero-prices unknown-model sessions, so the
    // share denominator covers PRICED spend only; count the excluded sessions
    // so the share cannot read as covering everything (#3514).
    let unpricedSessions = 0;
    const sessions = new Set<string>();
    const scopeKeys = new Set<string>();
    for (const d of input.tokenData) {
      totalCost += estimateCost(d);
      if (d.hasUnknownModel) unpricedSessions += 1;
      for (const e of d.entries) {
        if (e.webSearchRequests > 0) {
          searches += e.webSearchRequests;
          sessions.add(d.sessionId);
          scopeKeys.add(scopeKeyOf(d.sessionId, e.model || 'unknown'));
        }
      }
    }
    const searchCost = searches * SERVER_TOOL_PRICING.webSearchRequest;
    if (searchCost < MIN_SEARCH_COST_USD) return null;
    if (totalCost <= 0 || searchCost / totalCost <= MIN_SHARE) return null;
    const pct = Math.round((searchCost / totalCost) * 100);
    // The AVOIDABLE share, not the observed spend (#3508): only the assumed
    // re-search overlap is booked as recoverable.
    const avoidableUsd = searchCost * AVOIDABLE_SEARCH_FRACTION;
    // Reclaim claim: the web-search spend is a flat server-tool fee, not a token
    // pool — `directUsd` books it against the scopes' synthetic server-fee
    // residual so it stays inside the same residual-guarded identity (and can
    // never exceed the real flat-fee bill).
    const reclaim: ReclaimClaim = {
      leverId: 'cost.web-search-spend',
      category: 'cost',
      orderKey: 60,
      ownedPools: [],
      scopeKeys: [...scopeKeys],
      counterfactual: { kind: 'directUsd', usd: avoidableUsd },
      evidenceTokens: 0,
    };
    // Dated from the newest OBSERVED entry across the corpus the share is
    // computed over (never `now`); no readable timestamps → no asOf (#3201).
    const asOf = newestTokenDataDate(input.tokenData);
    const stale = isAsOfStale(asOf, now, STALE_AFTER_DAYS);
    const datePrefix = stale ? `As of ${asOf} (dated evidence): ` : '';
    // Typed explicitly: the operand keys differ per derivation, and the
    // heterogeneous array literal otherwise union-widens against
    // Record<string, ClaimScalar> under exactOptionalPropertyTypes.
    const derivations: ClaimDerivation[] = [
      {
        id: 'search-cost-usd',
        formula: 'searches * webSearchRequestUsd',
        operands: {
          searches,
          webSearchRequestUsd: SERVER_TOOL_PRICING.webSearchRequest,
        },
        value: searchCost,
      },
      {
        id: 'search-share-of-spend',
        formula: 'searchCostUsd / pricedTotalCostUsd',
        operands: { searchCostUsd: searchCost, pricedTotalCostUsd: totalCost },
        value: searchCost / totalCost,
      },
      {
        id: 'avoidable-search-usd',
        formula: 'searchCostUsd * AVOIDABLE_SEARCH_FRACTION',
        operands: {
          searchCostUsd: searchCost,
          avoidableSearchFraction: AVOIDABLE_SEARCH_FRACTION,
        },
        value: avoidableUsd,
      },
    ];
    return {
      id: 'cost.web-search-spend',
      category: 'cost',
      severity: 'info',
      title: 'Web-search requests are a material cost driver',
      detail: `${datePrefix}Web searches cost ~${fmtUsd(searchCost)} total ($0.01/request, ${searches} requests across ${sessions.size} session(s)) — about ${pct}% of estimated spend. Research loops often re-fetch the same queries each turn, so a conservative ${Math.round(AVOIDABLE_SEARCH_FRACTION * 100)}% of that spend (~${fmtUsd(avoidableUsd)}) is treated as avoidable re-searching; the rest is presumed wanted.`,
      action:
        'Prefer web_fetch for known stable URLs (no per-request charge), batch related lookups into one broad query, and cache fetched content in a file rather than re-searching.',
      estSavingsUsd: avoidableUsd,
      reclaim,
      affected: sessions.size,
      evidence: [...sessions].slice(0, 5).map((s) => short(s)),
      view: 'cost',
      fix: {
        target: 'CLAUDE.md',
        label: 'Add web-search discipline',
        note: 'Append to CLAUDE.md so research loops stop re-charging for repeated searches.',
        snippet: `## Web-search discipline

- Prefer web_fetch for stable URLs (no per-request charge); web_search bills $0.01/request.
- Batch related lookups into one broad query instead of many narrow ones.
- Cache fetched content in a file — do not re-fetch the same URL across turns.`,
        appliedMarkers: MARKERS,
      },
      // Auditability contract (#1049/#3201): observed request counts and the
      // flat fee are the facts; the dollar figures are named derivations a
      // reader can recompute; the avoidable fraction is declared an assumption.
      provenance: {
        observations: [
          {
            claim: `${searches} web-search requests recorded in total`,
            source: 'parse-sessions',
            field: 'tokenData[].entries[].webSearchRequests',
            value: searches,
          },
          {
            claim: `${sessions.size} session(s) recorded at least one web-search request`,
            source: 'parse-sessions',
            field: 'tokenData[].sessionId (where entries[].webSearchRequests > 0)',
            value: sessions.size,
          },
          {
            claim: 'web_search bills a flat $0.01 per request',
            source: 'pricing.ts',
            field: 'SERVER_TOOL_PRICING.webSearchRequest',
            value: SERVER_TOOL_PRICING.webSearchRequest,
          },
          {
            claim: `estimated priced spend across all parsed sessions is ~${fmtUsd(totalCost)} (token pools priced at registry rates plus flat server-tool fees)`,
            source: 'parse-sessions',
            field: 'tokenData[].entries[] (token counts x pricing-registry rates, estimateCost)',
            value: totalCost,
          },
          {
            claim: `${unpricedSessions} session(s) carry unrecognized-model spend that estimateCost zero-prices, so their real spend is excluded from the total and the share above`,
            source: 'parse-sessions',
            field: 'count(tokenData[] where hasUnknownModel)',
            value: unpricedSessions,
          },
        ],
        derivations,
        inference:
          `The observed spend and its share of total cost are accounting facts; how much ` +
          `of it was AVOIDABLE is not observable from transcripts. ` +
          `${Math.round(AVOIDABLE_SEARCH_FRACTION * 100)}% is a deliberately conservative ` +
          `assumption standing in for the re-search overlap the discipline removes — ` +
          `only that fraction is booked as savings; most searches are presumed wanted (#3508).`,
        ...(asOf !== undefined ? { asOf, stale } : {}),
      },
    };
  },
};
