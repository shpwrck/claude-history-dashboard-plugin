import type { Detector } from '../types';
import { claudeMdMarksApplied, fmtUsd, short } from '../shared';
import { SERVER_TOOL_PRICING } from '../../pricing';
import { estimateCost } from '../../parse-sessions';
import { scopeKeyOf, type ReclaimClaim } from '../../reclaim';

// Web-search requests bill at a flat $0.01 each and aren't cached — research
// loops that re-search the same query each turn add up. (#414)
const MIN_SEARCH_COST_USD = 0.5;
const MIN_SHARE = 0.1; // search cost must be >10% of total spend to flag

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
  category: 'cost',
  dataDeps: ['tokenData', 'liveConfig'],
  rule(input) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS)) return null;
    let searches = 0;
    let totalCost = 0;
    const sessions = new Set<string>();
    const scopeKeys = new Set<string>();
    for (const d of input.tokenData) {
      totalCost += estimateCost(d);
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
      counterfactual: { kind: 'directUsd', usd: searchCost },
      evidenceTokens: 0,
    };
    return {
      id: 'cost.web-search-spend',
      category: 'cost',
      severity: 'info',
      title: 'Web-search requests are a material cost driver',
      detail: `Web searches cost ~${fmtUsd(searchCost)} total ($0.01/request, ${searches} requests across ${sessions.size} session(s)) — about ${pct}% of estimated spend. Research loops often re-fetch the same queries each turn.`,
      action:
        'Prefer web_fetch for known stable URLs (no per-request charge), batch related lookups into one broad query, and cache fetched content in a file rather than re-searching.',
      estSavingsUsd: searchCost,
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
    };
  },
};
