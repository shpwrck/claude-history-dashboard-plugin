/**
 * Detector catalog — the static barrel.
 *
 * Every recommendation lives one-per-file under `src/lib/detectors/<category>/`
 * and is listed here. As of #507 this is the FULL catalog: the 20 legacy in-file
 * rules that used to live in `recommendations.ts` were ported into per-file
 * detectors and retired, so `buildRecommendations` now loops ONLY this array —
 * there are no more in-file rules.
 *
 * This barrel is deliberately HAND-WRITTEN with compile-time `import`s — no
 * `import.meta.glob`, no dynamic `import()`, no filesystem scan. That keeps the
 * engine as static, auditable, and offline as the original flat rule array
 * (ADR 0002): the set of detectors is fixed at build time and visible in one
 * place.
 *
 * To add a detector (full recipe in `docs/adding-a-recommendation.md`):
 *   1. Create `src/lib/detectors/<category>/<id>.ts` exporting
 *      `export const detector: Detector = { id, category, dataDeps?, rule }`.
 *   2. Import it below and add it to DETECTORS (in its category group).
 *   3. Add a red→green test in `src/lib/recommendations.test.ts`.
 *
 * Example file (`src/lib/detectors/cost/web-search-spend.ts`):
 *
 *   import type { Detector } from '../types';
 *   import { claudeMdMarksApplied, fmtUsd } from '../shared';
 *   export const detector: Detector = {
 *     id: 'cost.web-search-spend',
 *     category: 'cost',
 *     dataDeps: ['tokenData', 'liveConfig'],
 *     rule(input) { ...; return null; },
 *   };
 *
 * Example registration here:
 *   import { detector as webSearchSpend } from './cost/web-search-spend';
 *   export const DETECTORS: Detector[] = [webSearchSpend];
 */
import type { AppliedMarkers, Detector } from './types';

// ── COST ────────────────────────────────────────────────────────────────
import { detector as cache1hWaste } from './cost/cache-1h-waste';
import { detector as cacheEconomics } from './cost/cache-economics';
import { detector as expensiveSessions } from './cost/expensive-sessions';
import { detector as automationShare } from './cost/automation-share';
import { detector as unknownModel } from './cost/unknown-model';
import { detector as legacyModelOverpay } from './cost/legacy-model-overpay';
import { detector as modelRoutingRollup } from './cost/model-routing-rollup';
import { detector as webSearchSpend } from './cost/web-search-spend';
import { detector as priorityTierSpend } from './cost/priority-tier-spend';
import { detector as idleMcpTools } from './cost/idle-mcp-tools';
import { detector as expensiveAgentType } from './cost/expensive-agent-type';
import { detector as modelEvalRoutingGap } from './cost/model-eval-routing-gap';

// ── CONTEXT ─────────────────────────────────────────────────────────────
import { detector as overWindow } from './context/over-window';
import { detector as lowHealth } from './context/low-health';
import { detector as lowCacheHit } from './context/low-cache-hit';
import { detector as bloatedClaudeMd } from './context/bloated-claude-md';
import { detector as compactionHotSessions } from './context/compaction-hot-sessions';
import { detector as repeatedCompactions } from './context/repeated-compactions';
import { detector as compactionLargeToolOutputs } from './context/compaction-large-tool-outputs';
import { detector as overScopedConfigSection } from './context/over-scoped-config-section';
import { detector as repoMapContextWaste } from './context/repo-map-context-waste';
import { detector as toolCallRightSizing } from './context/tool-call-right-sizing';
import { detector as mcpSchemaTax } from './context/mcp-schema-tax';

// ── WORKFLOW ────────────────────────────────────────────────────────────
import { detector as nativeBypass } from './workflow/native-bypass';
import { detector as redundantReads } from './workflow/redundant-reads';
import { detector as repeatedCommands } from './workflow/repeated-commands';
import { detector as fileChurn } from './workflow/file-churn';
import { detector as assistantRefusalRate } from './workflow/assistant-refusal-rate';
import { detector as unusedInstalledSkills } from './workflow/unused-installed-skills';
import { detector as unusedInstalledSubagents } from './workflow/unused-installed-subagents';
import { detector as unusedInstalledCommands } from './workflow/unused-installed-commands';
import { detector as unusedInstalledPlugins } from './workflow/unused-installed-plugins';
import { detector as toolUndoRate } from './workflow/tool-undo-rate';
import { detector as lowToolEffectiveness } from './workflow/low-tool-effectiveness';
import { detector as shadowAxisWins } from './workflow/shadow-axis-wins';
import { detector as uncoveredShadowAxis } from './workflow/uncovered-shadow-axis';
import { detector as abandonedTasks } from './workflow/abandoned-tasks';
import { detector as blockedTaskPileup } from './workflow/blocked-task-pileup';
import { detector as ownerConcentration } from './workflow/owner-concentration';
import { detector as reviewBottleneck } from './workflow/review-bottleneck';
import { detector as failedWorkflowRuns } from './workflow/failed-workflow-runs';
import { detector as runawayWorkflowCost } from './workflow/runaway-workflow-cost';
import { detector as reworkSignature } from './workflow/rework-signature';
import { detector as churnGeometry } from './workflow/churn-geometry';
import { detector as sharedCheckoutRework } from './workflow/shared-checkout-rework';
import { detector as planMissingVerification } from './workflow/plan-missing-verification';
import { detector as harmfulHabit } from './workflow/harmful-habit';
import { detector as correctionMining } from './workflow/correction-mining';
import { detector as promptClarity } from './workflow/prompt-clarity';
import { detector as autonomyOverSteered } from './workflow/autonomy-over-steered';

// ── SAFETY ──────────────────────────────────────────────────────────────
import { detector as dangerousBypass } from './safety/dangerous-bypass';
import { detector as riskyActions } from './safety/risky-actions';
import { detector as promptFriction } from './safety/prompt-friction';
import { detector as denyRuleNeverTriggered } from './safety/deny-rule-never-triggered';
import { detector as allowRuleOverlapsDeny } from './safety/allow-rule-overlaps-deny';
import { detector as configHygieneRollup } from './safety/config-hygiene-rollup';

// ── SECURITY ────────────────────────────────────────────────────────────
import { detector as modelDeceit } from './security/model-deceit';

// ── RELIABILITY ─────────────────────────────────────────────────────────
import { detector as toolErrors } from './reliability/tool-errors';
import { detector as apiErrors } from './reliability/api-errors';
import { detector as retryStorms } from './reliability/retry-storms';
import { detector as settingsJsonInvalid } from './reliability/settings-json-invalid';
import { detector as hookErrors } from './reliability/hook-errors';
import { detector as hookPreventedContinuation } from './reliability/hook-prevented-continuation';
import { detector as droppedAssignments } from './reliability/dropped-assignments';
import { detector as selfUpdateHealth } from './reliability/self-update-health';
import { detector as mcpNeedsAuth } from './reliability/mcp-needs-auth';
import { detector as configDrift } from './reliability/config-drift';
import { detector as agentReportCard } from './reliability/agent-report-card';
import { detector as retryPrefixRewaste } from './reliability/retry-prefix-rewaste';
import { detector as overloadReretry } from './reliability/overload-reretry';

// ── SPEED ───────────────────────────────────────────────────────────────
// The clock (ADR 0006) — wall-clock/latency levers.
import { detector as hookOverhead } from './speed/hook-overhead';
import { detector as timeMotion } from './speed/time-motion';
import { detector as modelLatency } from './speed/model-latency';

// ── ACTIVITY ────────────────────────────────────────────────────────────
import { detector as staleProjects } from './activity/stale-projects';
import { detector as activityTrend } from './activity/activity-trend';

// ── Registered detectors ────────────────────────────────────────────────
// Emit order is LOAD-BEARING: `buildRecommendations` evaluates these in array
// order and then stable-sorts by (severity → estSavingsUsd → affected), so for
// equal-priority ties the surfaced order is the emit order here. To keep the
// output byte-identical across the #507 port, this array preserves the exact
// pre-#507 emit order: first the 20 ported legacy rules in their original
// `RULES` order, then the 15 epic-#411 detectors in their original
// `NEW_DETECTORS` order. New detectors append to the relevant section; do not
// reshuffle existing entries.
export const DETECTORS: Detector[] = [
  // ── Ported legacy rules (#507), original RULES order ──────────────────
  // cost
  cache1hWaste,
  cacheEconomics,
  expensiveSessions,
  automationShare,
  unknownModel,
  // context
  overWindow,
  lowHealth,
  lowCacheHit,
  // workflow
  nativeBypass,
  redundantReads,
  repeatedCommands,
  fileChurn,
  assistantRefusalRate,
  // safety
  dangerousBypass,
  riskyActions,
  configHygieneRollup, // #1164 — unused mcpServer/plugin hygiene rollup
  promptFriction,
  denyRuleNeverTriggered,
  allowRuleOverlapsDeny,
  // reliability
  toolErrors,
  apiErrors,
  retryStorms,
  // activity
  staleProjects,

  // ── Epic #411 detectors, original NEW_DETECTORS order ─────────────────
  // Tier A — already-parsed inputs, zero plumbing
  bloatedClaudeMd,
  legacyModelOverpay,
  modelRoutingRollup, // #1165 — per-turn routing savings as one summary cost rec
  webSearchSpend,
  priorityTierSpend,
  // Tier B — high-confidence, plumbed via the additional RecommendationInput fields
  compactionHotSessions,
  idleMcpTools,
  settingsJsonInvalid,
  expensiveAgentType,
  hookErrors,
  hookPreventedContinuation,
  // Tier C — medium-confidence composites
  repeatedCompactions,
  compactionLargeToolOutputs,
  unusedInstalledSkills,
  unusedInstalledSubagents,
  unusedInstalledCommands,
  unusedInstalledPlugins,
  toolUndoRate,
  lowToolEffectiveness,

  // ── Epic #513 — shadow-calls experiment detectors (#518/#523, #530) ───
  shadowAxisWins,
  uncoveredShadowAxis,

  // ── Epic #539 — uncaptured ~/.claude artifact detectors (#559–#569, #572) ─
  // Each reads a top-level artifact field on RecommendationInput (assembled in
  // scripts/ingest.mjs, server-only); all emit nothing on a transcript-only
  // (SPA) dataset where those fields are empty.
  abandonedTasks, // #559
  blockedTaskPileup, // #559
  ownerConcentration, // #942
  reviewBottleneck, // #1123
  failedWorkflowRuns, // #635
  runawayWorkflowCost, // #635
  droppedAssignments, // #560
  activityTrend, // #563
  reworkSignature, // #564
  churnGeometry, // #597 — line-level structuredPatch churn geometry
  sharedCheckoutRework, // #956 — shared-checkout / foreign-HEAD-swap rework → worktree-first
  planMissingVerification, // #565
  selfUpdateHealth, // #566
  mcpNeedsAuth, // #567
  configDrift, // #568
  agentReportCard, // #572 — consolidates #561 + #562 + #569

  // ── Epic #944, PR4 (#950) — reliability dollars (cause-side reclaim) ───────
  // Both emit ReclaimClaims (cause: 'failed-tool-retry') so the census moves off
  // reliability 0/11; conservative cache-read-only scaleTokens (no toolUseId edge).
  retryPrefixRewaste,
  overloadReretry,

  // ── #549 — habit-impact view's `hurts` verdict as a recommendation ────────
  harmfulHabit,

  // ── #1040 (epic #866) — mine failed→fixed tool pairs into pinnable facts ──
  correctionMining,

  // ── #1275 — prompt trait buckets → correlational coaching pattern ────────
  promptClarity,

  // ── Epic #1266 — quality-gated autonomy level, over-steered cohort ───────
  autonomyOverSteered,

  // ── Epic #683 — model-deceit detection (#686, slice B) ────────────────────
  // Reads the Slice-A ingest feature (deceitSignals, #685); dark on the
  // transcript-free SPA dataset where that field is empty.
  modelDeceit,

  // ── Epic #708 — speed domain, the clock (ADR 0006) ────────────────────────
  // The first clock-lever detector (#710): slow synchronous Stop hooks adding
  // wall-clock to every turn. Fills the "Go faster" card.
  hookOverhead,
  timeMotion,
  modelLatency,

  // ── Epic #975 — model-evals act-now routing gap (#1086) ───────────────────
  // Reads the server-only `modelEvalSummary` rollup (#1085/#1242): fires only on
  // a non-vetoed, strongly-evidenced scoped routing recommendation. Rule 6:
  // promotion requires explicit user approval — never an automatic change.
  // Dark on the SPA dataset (summary is always null there).
  modelEvalRoutingGap,

  // ── Epic #871 (+ #944) — repo-map-aware structural context waste (#890) ────
  // #1267 — root AGENTS.md/CLAUDE.md sections whose repo-map-governed files all
  // sit under one component subtree should move to path-scoped .claude/rules.
  overScopedConfigSection,
  // Reads the server-only `repoMap` join (#889): replaces generic pin guidance
  // with structural candidates (stable API/config + high-centrality read-only
  // files re-read across sessions), naming specific files/symbols and emitting a
  // structural-prefix scaleTokens ReclaimClaim. Dark on the SPA dataset (no map).
  repoMapContextWaste,

  // ── #1924 (epic #1910) — tool-call right-sizing ───────────────────────────
  // Flags first-call over-fetch (fat whole-file Read) + chronically verbose used
  // MCP/Bash payloads, dollarizing the cache-compounded tail as a structural-prefix
  // cacheRead scaleTokens claim. Excludes native-bypass Bash calls so the same
  // bytes aren't double-claimed; compaction-large-tool-outputs books no claim.
  toolCallRightSizing,

  // ── #1920 (epic #1910) — MCP tool-schema prefix tax ───────────────────────
  // Sizes the MCP tool-schema share of the fixed per-turn prefix and flags
  // duplicate/redundant MCP servers (overlapping tool sets, e.g. github +
  // githubmcp) as a safe removal lever. Sibling to bloated-claude-md (prose docs
  // only); schema size is a documented token proxy → tier-0 estSavingsUsd.
  mcpSchemaTax,
];

/**
 * Back-compat alias for the pre-#507 name. The barrel used to be `NEW_DETECTORS`
 * (the "new" per-file detectors that ran alongside the legacy in-file rules).
 * Now that the legacy rules are ported in, the array is simply the catalog —
 * `DETECTORS` is the canonical name; this alias keeps older importers working.
 */
export const NEW_DETECTORS = DETECTORS;

/**
 * Finding-id → CLAUDE.md marker signature, resolved statically from the catalog
 * (#1785). Built from each detector's declared {@link Detector.appliedMarkers},
 * so a finding's markers are resolvable even when its detector is currently
 * SUPPRESSED (markers already present in CLAUDE.md) and therefore absent from the
 * live recommendations — the exact adoption case the scorecard's surfaced→ADOPTED
 * transition needs. Detectors with no marker-gated CLAUDE.md fix are omitted.
 *
 * Server/test-side only: this iterates `DETECTORS`, so importing it drags the
 * whole recs engine into the importing chunk. Client/route code (e.g. the
 * Adoption Scorecard) must instead import the client-safe `FINDING_MARKER_CATALOG`
 * from `./applied-markers`; the `applied-markers.contract.test.ts` guard keeps
 * that leaf byte-for-byte equal to what this function returns (#1909).
 */
export function findingMarkerCatalog(): ReadonlyMap<string, AppliedMarkers> {
  const map = new Map<string, AppliedMarkers>();
  for (const d of DETECTORS) {
    if (d.appliedMarkers) map.set(d.id, d.appliedMarkers);
  }
  return map;
}
