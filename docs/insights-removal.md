# Insights removal — degradation map, alternatives, and plan (#1056)

The dashboard "Insights" feature surfaced the output of the CLI `/insights`
skill (an LLM analysis of `~/.claude/usage-data/` reports). #1056 removes that
feature. This doc captures **what is removed**, **what each preserved feature
loses**, the **alternative source** evaluated for each lost signal, and the
**staged plan**.

Decision (2026-06): full removal — but capture the degradation and substitute a
real alternative source wherever one exists; accept (and document) the
degradation where none does.

## What is removed

- **View + components:** `Insights.tsx`, `InsightsReport.tsx`,
  `InsightsMetrics.tsx`, `recommendations/InsightsPanel.tsx`, the
  `InsightsRecommendations` panel in `Recommendations.tsx`, the `insights` nav
  entry / route / `view-registry` entry, the e2e `'insights'` reachable view.
- **Data layer:** `parse-insights.ts`, `sample-insights.ts`,
  `insights-regeneration.ts`, the `/api/insights` status+regenerate routes in
  `server.mjs`, the `parseInsights*` imports + `insightsMeta/insightsFacets/
  insightsReport` keys in `ingest.mjs` and `upload-artifacts.ts`.
- **Types:** `InsightsSessionMeta`, `InsightsSessionFacets`, `InsightsReport`
  and its sub-types (`InsightsChart`, `InsightsProjectArea`,
  `InsightsClaudeMdSuggestion`, …).

**Preserved:** all transcript-derived usage/session reporting (Tokens, Cost,
Sessions, Timeline, Tools, Recommendations engine, scorecard, patterns). The
`~/.claude/usage-data/` *directory read* goes away with insights; no other view
depends on it.

## Degradation map and alternatives

| Consumer | Insights signal used | Lost capability | Alternative source | Decision |
|---|---|---|---|---|
| `session-scorecard.ts` (architecture axis) | `facets.outcome`, `facets.primarySuccess`, `facets.frictionCounts` | LLM-semantic outcome bump (±10/±30) + "Insights outcome" evidence | The axis **already** falls back without facets (`facets ? 85 : 75`, uses `toolData`/`assistantFeatures`/`apiErrors`); `parse-timeline-success` offers only a behavioural *cleanliness proxy* (self-documented as not a real outcome) | **Accept degradation** — keep the existing no-facets path; do NOT substitute the weaker proxy into a confidence-rated score |
| `SessionPatterns.tsx` | `facets.sessionType` grouping + `facets?` | LLM session-type grouping | `session-type-classifier.ts` (`classifySessionType` heuristic) | **Substitute** — wire the heuristic classifier so grouping survives |
| `Recommendations.tsx` | `insightsReport` → `InsightsRecommendations` panel | The insights-derived CLAUDE.md suggestion panel | None (it rendered the `/insights` report's own suggestions) | **Remove** the panel; the recommendations engine's own findings remain |
| `AskClaude.tsx` / `claude-context.ts` | `insightsReport` narrative as chat context | Insights narrative in the Ask-Claude context blob | The context already includes tokens/projects/sessions; narrative is additive | **Remove** the insights section from the context builder |
| `DigestSpine.tsx` | `insightsReport?` | Optional digest display | None | **Remove** the optional block |

Net product effect: the Ask-Claude context and the scorecard architecture axis
get slightly less rich; SessionPatterns keeps grouping via the heuristic
classifier; the insights view and its CLAUDE.md-suggestion panel are gone. No
feature breaks — every consumer already treated insights data as optional.

## Staged plan

1. **PR A — decouple + substitute (this PR adds the doc + the alternative wiring,
   removes nothing yet).** Wire `session-type-classifier` into `SessionPatterns`
   as the grouping source; drop the `insightsFacets/Report` inputs from the
   scorecard fallback path, `Recommendations`, `AskClaude`, `claude-context`,
   `DigestSpine`. After PR A, no feature consumes insights data, but the view +
   data layer still exist (unused). Green CI proves nothing broke.
2. **PR B — remove the feature.** Delete the view/components/parsers/types,
   `ingest`/`upload-artifacts` keys, the `/api/insights` routes, the nav/route/
   registry/e2e entries, and `parse-insights`/`sample-insights`/
   `insights-regeneration`. REFERENCES.md insights rows removed.

Splitting keeps each PR coherent and individually green (PR A can't break a
consumer; PR B can't strand a live reference).
