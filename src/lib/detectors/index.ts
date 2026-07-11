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
import { detector as disproportionateThinking } from './cost/disproportionate-thinking';
import { detector as modelEvalRoutingGap } from './cost/model-eval-routing-gap';
import { detector as outputVerbosity } from './cost/output-verbosity';
import { detector as batchableWorkload } from './cost/batchable-workload';

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
import { detector as lastNRunsAudit } from './context/last-n-runs-audit';
import { detector as crossSessionReread } from './context/cross-session-reread';
import { detector as toolCallRightSizing } from './context/tool-call-right-sizing';
import { detector as mcpSchemaTax } from './context/mcp-schema-tax';
import { detector as reclaimPotential } from './context/reclaim-potential';

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
import { detector as humanInputLeverage } from './workflow/human-input-leverage';
import { detector as midTurnInterruptSteering } from './workflow/mid-turn-interrupt-steering';
import { detector as conversationalAvailability } from './workflow/conversational-availability';
import { detector as reclaimWaitWindows } from './workflow/reclaim-wait-windows';
import { detector as proceduralMemory } from './workflow/procedural-memory';
import { detector as valueOfAgentHandoff } from './workflow/value-of-agent-handoff';

// ── SAFETY ──────────────────────────────────────────────────────────────
import { detector as dangerousBypass } from './safety/dangerous-bypass';
import { detector as riskyActions } from './safety/risky-actions';
import { detector as promptFriction } from './safety/prompt-friction';
import { detector as denyRuleNeverTriggered } from './safety/deny-rule-never-triggered';
import { detector as allowRuleOverlapsDeny } from './safety/allow-rule-overlaps-deny';
import { detector as configHygieneRollup } from './safety/config-hygiene-rollup';
import { detector as continuationBlocked } from './safety/continuation-blocked';
import { detector as policyChange } from './safety/policy-change';
import { detector as unattendedSessions } from './safety/unattended-sessions';

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
import { detector as passiveWaitStall } from './reliability/passive-wait-stall';
import { detector as cwdDriftExecution } from './reliability/cwd-drift-execution';
import { detector as staleStateAssertion } from './reliability/stale-state-assertion';
import { detector as discoveryFreshness } from './reliability/discovery-freshness';

// ── SPEED ───────────────────────────────────────────────────────────────
// The clock (ADR 0006) — wall-clock/latency levers.
import { detector as hookOverhead } from './speed/hook-overhead';
import { detector as timeMotion } from './speed/time-motion';
import { detector as modelLatency } from './speed/model-latency';
import { detector as serialToolGap } from './speed/serial-tool-gap';

// ── ACTIVITY ────────────────────────────────────────────────────────────
import { detector as staleProjects } from './activity/stale-projects';
import { detector as activityTrend } from './activity/activity-trend';

// ── MAINTENANCE ───────────────────────────────────────────────────────────
// Upkeep of the agent's own durable state (#1965 category foundation).
import { detector as memoryHygiene } from './maintenance/memory-hygiene';
import { detector as docHygiene } from './maintenance/doc-hygiene';

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
  policyChange,
  promptFriction,
  denyRuleNeverTriggered,
  allowRuleOverlapsDeny,
  continuationBlocked,
  unattendedSessions,
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
  disproportionateThinking,
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

  // ── Epic #1934 — value of a cheap upfront human input (#2200, keystone) ──
  humanInputLeverage,

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
  serialToolGap,

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

  // ── #1923 (epic #1910) — output-verbosity (caveman) cost lever ────────────
  // Measures verbose assistant PROSE output (assistantFeatures.textLength, text
  // blocks only) and dollarizes a conservative compression against the output
  // pool. Sized honestly/prose-only; tier-0 estimate. The causal caveman-vs-normal
  // proof axis is a separate meta follow-on, tracked apart.
  outputVerbosity,

  // ── #1755 (epic #1910) — batchable-workload Batch API -50% cost lever ──────
  // Flags token-heavy unattended (sdk-*) sessions routable through the Batch API
  // for ~50% off standard input/output; composes after automation-share's model
  // reprice (orderKey 82) so the saving is marginal, not double-counted. The
  // batch-route shadow-calls axis is a separate meta follow-on.
  batchableWorkload,

  // ── #1752 (epic #1910) — cross-session cold-read -> distilled-note lever ───
  // The cross-session slice nothing else covers: aggregates the per-session FIRST
  // (cold) Read of each DOC across the corpus (parse-file-reread only sees
  // within-session repeats), books NET savings (eager note-load subtracted),
  // prices at the measured cache-read residual, stability-gates to read-only docs,
  // and stays doc-scoped so it never double-books vs repo-map-context-waste (code).
  crossSessionReread,

  // ── #1758 (epic #1911) — native context-reclaim-potential measurement ──────
  // The decided competitive response to the headroom tool: a DETERMINISTIC,
  // ML-free counter of compressible/removable context. Owns ONLY the buckets the
  // file-Read detectors don't — oversized/duplicate NON-file tool_result payloads
  // (toolData) and re-pasted file content in user turns (sessions[].pastedContents)
  // — so it never double-books vs cross-session-reread (doc cold first-reads) or
  // repo-map-context-waste (structural code repeats). Prices at the cache-read
  // residual; ML estimate is DEFERRED (Future follow-up).
  reclaimPotential,

  // ── #1873 (epic #1910) — passive-wait stalls (reliability) ────────────────
  // Flags assistant turn-ends that end on wait/monitor language with no
  // harness-backed background mechanism (run_in_background / Task / Workflow), so
  // the session can't self-resume and a real human prompt (never a tool_result)
  // is forced — weighted by the silence gap. Reads parse-timeline's per-turn
  // waitLanguage/backgrounded flags; dark on a transcript-free dataset.
  passiveWaitStall,

  // ── #1870 (epic #1910) — cwd-drift command execution (reliability) ─────────
  // Flags `git`/`gh` command segments run with NO anchor (`git -C`, a preceding
  // `cd <dir> &&`, `gh -R`/`--repo`, `GH_REPO=`). git/gh resolve their target
  // repo from the shell cwd, so an unanchored op on a drifted session silently
  // hits the WRONG repo (commit to the wrong tree, stale-read false claims).
  // Build families are excluded (loud failure; cwd not on the wire). Measures
  // the behaviour the global cwd-anchor-guard hook prevents (dogfooding loop,
  // sibling of #1871). Reads toolData; dark on a transcript-free dataset.
  cwdDriftExecution,
  // ── #1871 (epic #1910) — stale-state assertions (reliability) ─────────────
  // Flags LOCAL git reads of an integration/remote ref (origin/…, master, main,
  // @{u}, --contains) issued with no `git fetch`/`git pull` earlier in the same
  // session — the un-fetched-tree source of "X is merged/landed/exists" claims.
  // gh reads (live) and ref-less git reads are excluded. Measures the behaviour
  // the global repo-freshness hook prevents (dogfooding loop). Reads toolData;
  // dark on a dataset with no Bash calls.
  staleStateAssertion,
  // ── #2325 (epic #1868) — discovery freshness (reliability) ────────────────
  // The FILE-READ sibling of #1871: a Read of a repo-map-tracked file, then a
  // working-tree-moving git op (checkout/pull/rebase/…), then an Edit/Write of
  // the same path with NO re-Read — the edit is applied against content the ref
  // moved past. Counts the (Read,Edit) file pair; inspects Bash only to spot the
  // intervening tree-move (disjoint from #1871's Bash git-ref reads). Emitted as
  // an observational hypothesis. Reads toolData + repoMap (tracked-path oracle +
  // generation sha); dark without a repo-map or tool calls.
  discoveryFreshness,

  // ── #1754 (epic #1910) — mid-turn user-interrupt steering ─────────────────
  // Dollarizes the in-flight output tokens discarded when a human cuts the
  // assistant off mid-response (literal `[Request interrupted by user]` sentinel
  // on parse-timeline's per-turn `interrupted` flag, joined to parse-sessions
  // output tokens). Honest workflow/autonomy DIAGNOSTIC — leads with
  // interrupts/session, books no cost-census reclaim; dark on a transcript-free
  // dataset.
  midTurnInterruptSteering,

  // ── #2230 (part of #2227) — conversational-availability (workflow) ─────────
  // The DURING-work complement to reliability.passive-wait-stall (turn-END dead-
  // air): foreground tool calls fired mid-turn that were eligible to be
  // backgrounded (long-running Bash build/test/install/deploy, or an un-detached
  // Agent/Workflow) but ran synchronously, blocking the human's thread past a
  // 10s floor. Reads parse-timeline's per-entry kind/backgrounded/toolName/
  // timestamp; sub-second reads never clear the floor. Dark on a slim/transcript-
  // free dataset (the Bash-kind test reads the stripped `summary`).
  conversationalAvailability,

  // ── #1880 (epic #867) — wait-class reclaim ruleset ─────────────────────────
  // The engine-side policy author following reliability.passive-wait-stall: from
  // the same stall signature it groups forced-human turn-ends by their parsed
  // wait class (CI/deploy/push/remote-queue/watcher) and emits a suggest-only
  // ruleset for reclaiming the idle window with provably non-interfering backlog
  // work. The live enforcer Stop-hook that consumes the ruleset is the `meta`
  // sibling child (mirrored to shpwrck/claude).
  reclaimWaitWindows,

  // ── #2250 (epic #2265) — procedural-memory extraction ──────────────────────
  // Spots UN-captured procedural memory: a contiguous multi-step Bash procedure
  // (e.g. `git pull → npm run build → docker push`) that recurs ad-hoc across
  // >=3 sessions with no backing skill. Suppressed when an installed skill's
  // id/description already covers the procedure; demoted to "as of <date>" when
  // the latest recurrence is stale. Non-validated (illustrative) skill scaffold.
  proceduralMemory,

  // ── #2312 (epic #2281) — value of agent handoff ──────────────────────────
  // Detects durable external state established with no runbook/handoff artifact,
  // plus later early-turn rediscovery of that setup. Emits a conservative
  // human-minute hypothesis backed by accounting observations; the published
  // calibrated rec class is deferred to the sibling profiling receipt.
  valueOfAgentHandoff,

  // ── #1882 (epic #1910) — rolling "last N runs" maintenance audit ───────────
  // Orders sessions chronologically, compares the most recent N runs' mean peak
  // context against the prior-runs baseline, and fires when per-run context is
  // trending up (environmental drift / scaffolding a newer model no longer
  // needs). Reads only tokenData; carries provenance with an as-of/stale anchor.
  lastNRunsAudit,

  // ── #1779 (epic #1910) — first `maintenance` detector: memory-store hygiene ──
  // Reads the per-project memory store + MEMORY.md index (#1965 foundation) and
  // emits the five deterministic signals — oversized index, long index line,
  // dangling index link, unindexed file, dangling wikilink — grouped into one
  // recommend-only card. Dark on a memory-store-free dataset (SPA/upload).
  memoryHygiene,

  // ── #2258 (epic #2256) — doc-artifact hygiene: the docs analogue of the
  // memory-store audit. Reads the repo doc graph (#2257 buildDocGraph) and emits
  // three deterministic signals — broken internal links, orphaned docs, and
  // dangling `src/…` references (cross-checked against the repo-map inventory) —
  // grouped into one recommend-only card. Dark on a doc-graph-free dataset.
  docHygiene,
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
