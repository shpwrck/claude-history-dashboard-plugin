// Pure selection logic for the MCP shim's `top_frictions` tool (#2948).
//
// Kept out of scripts/mcp-shim.mjs so it can be unit-tested without booting
// the stdio MCP server (importing mcp-shim.mjs connects a transport at module
// top level). The shim imports this module; the plugin bundle inlines it
// (scripts/build-plugin-mcp.mjs, ssr.noExternal), so nothing changes at
// runtime shape.
//
// There is NO `friction` value in the engine's category vocabulary
// (`RecCategory` in src/lib/detectors/rec-enums.ts) — the original inline
// filter matched `category === 'friction'` and therefore ALWAYS fell through
// to its top-5-overall fallback. "Friction" here means the friction-shaped
// categories: the engine's rework, stall, and context-tax families.
// mcp-shim-frictions.test.mjs pins these values against the real RecCategory
// union so a future category rename breaks loudly.

/** RecCategory values considered friction-shaped (rework/stall/context-tax). */
export const FRICTION_CATEGORIES = Object.freeze([
  'workflow',
  'reliability',
  'context',
]);

/**
 * Extract the recommendations array from the /api/recommendations.json
 * payload (bare array or `{ recommendations: [...] }`).
 */
export function extractRecommendations(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.recommendations)) return data.recommendations;
  return [];
}

/**
 * Select the top friction-shaped recommendations from a payload.
 *
 * Filters to the FRICTION_CATEGORIES (preserving the payload's own ranking
 * order) and caps at `limit`. When no recommendation matches, falls back to
 * the top `limit` recommendations of any category and says so in `note`.
 * Result shape is the `top_frictions` tool contract:
 * `{ total_recommendations, top_frictions, note }`.
 */
export function selectTopFrictions(data, { limit = 5 } = {}) {
  const recs = extractRecommendations(data);
  const frictions = recs
    .filter((r) => FRICTION_CATEGORIES.includes(r?.category))
    .slice(0, limit);

  return {
    total_recommendations: recs.length,
    top_frictions: frictions.length > 0 ? frictions : recs.slice(0, limit),
    note:
      frictions.length === 0
        ? `No workflow/reliability/context recommendations found; showing top ${limit} recommendations instead.`
        : undefined,
  };
}
