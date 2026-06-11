/**
 * Detector types — the leaf of the recommendations dependency graph.
 *
 * Every recommendation rule (legacy in-file rules and per-file detectors under
 * `src/lib/detectors/`) returns one of these shapes, and every detector reads a
 * {@link RecommendationInput}. Definitions live here, NOT in `recommendations.ts`,
 * so that detector files can import them without creating an import cycle:
 *
 *   types.ts (leaf) ← shared.ts ← detectors/<cat>/<id>.ts ← detectors/index.ts ← recommendations.ts
 *
 * `recommendations.ts` re-exports every type below for back-compat, so existing
 * importers (`from './recommendations'`) keep working unchanged.
 */
import type {
  Session,
  ProjectStats,
  SessionTokenData,
  View,
  LiveConfig,
  AssistantFeatures,
  DeceitSignals,
} from '../../types';
import type { ToolUsageData } from '../parse-tools';
import type { ApiErrorEvent } from '../parse-errors';
import type { SessionTimeline } from '../parse-timeline';
import type { AgentSettingEvent, SessionAttribution } from '../parse-agents';
import type { RuntimeEvents } from '../parse-runtime-events';
import type { TaskSteering } from '../parse-steering';
import type { ChurnGeometrySession } from '../parse-churn-geometry';
import type { ToolInventory } from '../parse-tool-inventory';
import type { ShadowCallAggregate } from '../parse-shadow-calls';
// ── #539 ingest artifacts (per-artifact child issues #559–#569, #572) ──────
import type { TaskRecord } from '../parse-tasks';
import type { TeamSummary } from '../parse-teams';
import type { FileHistorySession } from '../parse-file-history';
import type { StatsCache } from '../parse-stats-cache';
import type { PlanSignature } from '../parse-plans';
import type { UpdateResult } from '../parse-last-update';
import type { McpAuthState } from '../parse-mcp-auth';
import type { DriftEvent } from '../parse-backups';
import type { SessionRegistryEntry } from '../parse-session-registry';
import type { TelemetryEvent } from '../parse-telemetry';
import type { DebugSessionMetrics } from '../parse-debug';
import type { WorkflowRun } from '../parse-workflows';
import type { ReclaimClaim } from '../reclaim';
import type { RepoMapDataset } from '../parse-repo-map-join';
import type { OrganizationIdentityDataset } from '../organization-identity';
import type { OrganizationReviewEventsDataset } from '../organization-review-events';

export type RecCategory =
  | 'cost'
  | 'context'
  | 'workflow'
  | 'safety'
  | 'security'
  | 'reliability'
  | 'speed'
  | 'activity';

export type RecSeverity = 'critical' | 'warning' | 'info';

/**
 * Where a "Fix now" snippet is applied. Drives the label and the one-line
 * how-to-apply note in the UI. A `hook` snippet is still a `settings.json`
 * fragment; we keep it distinct only so the note can say "merge into hooks".
 */
export type FixTarget = 'settings.json' | 'CLAUDE.md' | 'hook' | 'command';

/**
 * How safe a {@link RecFix} snippet is to apply as-is (#1101, epic #866).
 *  - `'validated'`    — self-contained config (a settings.json / CLAUDE.md
 *                       fragment), safe to paste verbatim.
 *  - `'illustrative'` — a TEMPLATE whose command must be swapped for the user's
 *                       own check (e.g. a PostToolUse hook running
 *                       `npm run -s typecheck`); not guaranteed runnable as
 *                       written, since validity is relative to the user's repo.
 *  - `'manual'`       — depends on an external tool or per-environment state
 *                       (e.g. a `claude-team` CLI invocation); apply by hand
 *                       where that tool exists.
 *
 * Absent ⇒ `'validated'` (existing config fragments stay copy-paste-safe). The
 * fix-validity gate (`fix-validity.ts`) enforces that a `validated` snippet
 * carries no non-portable reference, and the UI only offers one-click copy for
 * validated fixes — non-validated ones are labelled examples.
 */
export type FixKind = 'validated' | 'illustrative' | 'manual';

/**
 * Structural signal that a CLAUDE.md-targeted fix has already been written.
 * Suppression fires only when **every declared category matches** — so a rule
 * that names both a heading AND a body phrase needs both present. Rules with
 * no markers can never be suppressed by CLAUDE.md, only by settings-key checks
 * elsewhere. Markers are intentionally strict-AND to bias toward "nag" over
 * "silently hide a real finding". See issue #173.
 */
export interface AppliedMarkers {
  /**
   * Heading regexes. At least one heading line in the merged CLAUDE.md text
   * must match at least one regex. Use `/^##\s+…/i` patterns so the author's
   * own variations on the section title ("Cache policy", "Caching") still
   * count.
   */
  headings?: RegExp[];
  /**
   * Distinctive body phrases (case-insensitive substring match). All listed
   * phrases must appear somewhere in the merged CLAUDE.md text. Use phrases
   * uncommon in natural writing to keep false-positives down (e.g.
   * `'1-hour cache'`, not `'cache'`).
   */
  bodyPhrases?: string[];
}

/**
 * A ready-to-paste fix for a recommendation. Only emitted when a *genuine*,
 * valid snippet exists for the finding — we never fabricate config keys, so a
 * rule with no real one-shot fix simply leaves `fix` undefined.
 */
export interface RecFix {
  /** Destination for the snippet. */
  target: FixTarget;
  /** Short button / heading label, e.g. "Add deny rules". */
  label: string;
  /** One line on how to merge it in. */
  note: string;
  /** The exact text to copy: JSON for settings/hook, markdown for CLAUDE.md. */
  snippet: string;
  /**
   * How safe the snippet is to apply as-is (#1101). Absent ⇒ `'validated'`.
   * Non-`validated` fixes are rendered as labelled examples, never as a
   * copy-paste-safe one-click fix. See {@link FixKind}.
   */
  fixKind?: FixKind;
  /**
   * CLAUDE.md presence signals — only meaningful when `target` is `'CLAUDE.md'`.
   * Drives the suppression check for fixes whose acceptance is a paragraph of
   * prose rather than a structural settings.json key. Absent ⇒ never suppress
   * on prose grounds.
   */
  appliedMarkers?: AppliedMarkers;
}

/**
 * One directly-observed fact behind a recommendation, traceable to the
 * artifact it was read from. The keystone of the auditability contract
 * (#1049): a reader must be able to reproduce the count without
 * reverse-engineering the detector. This is the "observation" half of the
 * observation / inference / fix split — `claim` states ONLY what was measured,
 * never the conclusion drawn from it (that belongs in {@link RecProvenance.inference}).
 */
export interface RecObservation {
  /**
   * The measured fact, phrased without inference, e.g.
   * "18 of 18 team inbox assignments are unread". No "should", no "because".
   */
  claim: string;
  /**
   * The `~/.claude/` artifact or `parse-*` source this was read from, e.g.
   * `'stats-cache.json'`, `'parse-tools'`, `'~/.claude.json'`. Stable enough
   * that an auditor knows where to look.
   */
  source: string;
  /**
   * The specific parsed field / path within {@link source} when one applies,
   * e.g. `'lastComputedDate'`, `'toolData[].calls[].isError'`. Optional for
   * sources that are a single scalar.
   */
  field?: string;
  /**
   * The reproducible value behind {@link claim} — the raw count/number/string
   * an auditor would recompute. Optional only when the claim is itself the
   * value.
   */
  value?: string | number;
}

/**
 * Structured provenance for a recommendation (#1049, epic #866 keystone).
 *
 * Splits a finding into the three things an auditor must be able to separate:
 * what was *observed* (each citing its artifact), what was *inferred* from
 * those observations, and — via {@link Recommendation.fix} — what is *proposed*.
 * Additive and OPTIONAL, exactly like {@link RecommendationSavingsAttribution}
 * and {@link Recommendation.reclaim}: detectors migrate onto it one at a time
 * (the sibling slices #1101–#1105), and the provenance contract test only
 * enforces shape where it is present plus an explicit opt-in allowlist, so the
 * not-yet-migrated detectors compile and behave unchanged.
 */
export interface RecProvenance {
  /** The directly-observed facts, each traceable to its artifact/field. */
  observations: RecObservation[];
  /**
   * The inferential step from observations to the recommendation — the "so
   * what". Kept distinct from the observations so a false inference over true
   * data is visible as such.
   */
  inference?: string;
  /**
   * As-of date (ISO `YYYY-MM-DD`) of the underlying data when it derives from a
   * timestamped artifact (e.g. `stats-cache.json`'s `lastComputedDate`). Drives
   * the stale-input demotion in #1102: present-tense wording is only honest
   * when this is fresh.
   */
  asOf?: string;
  /**
   * True when {@link asOf} is older than the detector's freshness threshold, so
   * downstream rendering can demote present-tense wording to "as of <date>" or
   * suppress (#1102). Detectors that cannot tell leave it undefined.
   */
  stale?: boolean;
}

export type SavingsAttributionTier =
  | 'tier-0-estimate'
  | 'tier-1-before-after'
  | 'tier-2-ablation';

export type SavingsAttributionConfidence = 'low' | 'medium' | 'high';

export interface SavingsAttributionPeriod {
  /** Inclusive ISO timestamp/date boundary for the compared period. */
  start: string;
  /** Exclusive ISO timestamp/date boundary for the compared period. */
  end: string;
}

export interface SavingsAttributionWindow {
  /** The counterfactual or pre-intervention period. */
  baseline?: SavingsAttributionPeriod;
  /** The observed post-intervention or treatment period. */
  comparison?: SavingsAttributionPeriod;
}

/**
 * Optional calibration metadata for a recommendation's dollar impact.
 *
 * `estSavingsUsd` stays the ranking field. This contract says how that estimate
 * was grounded: a Tier 0 heuristic, a Tier 1 before/after measurement, or a
 * Tier 2 controlled ablation. It is pure data so server, SPA, and tests can
 * pass it through without introducing new runtime behaviour.
 */
export interface RecommendationSavingsAttribution {
  /** Stable id for the recommendation/rule/intervention being measured. */
  interventionKey: string;
  /** Stable id for the machine-observable behaviour signature. */
  signatureId: string;
  tier: SavingsAttributionTier;
  /** The detector's predicted recoverable savings for the same scope. */
  predictedSavingsUsd?: number;
  /** Observed savings from a before/after or ablation comparison. */
  realizedSavingsUsd?: number;
  confidence?: SavingsAttributionConfidence;
  window?: SavingsAttributionWindow;
}

export interface ModelPinSavingsConfig {
  baseline: SavingsAttributionPeriod;
  comparison: SavingsAttributionPeriod;
  targetModel?: string;
}

/**
 * Per-session prompt-trait rollup consumed by prompt-coaching detectors. This
 * mirrors the parser slice's public shape closely enough that fixture-backed
 * detectors can compile before the ingest/parser PR lands on master.
 */
export interface PromptAnalysis {
  sessionId: string;
  promptTurnCount: number;
  lowSpecificityTurnCount: number;
  specificityMarkerCount?: number;
  questionTurnCount?: number;
  imperativeTurnCount?: number;
}

export interface Recommendation {
  /** Stable rule id, e.g. "cost.cache-1h-waste". Used as a React key. */
  id: string;
  category: RecCategory;
  severity: RecSeverity;
  /** Imperative, specific headline. */
  title: string;
  /** One or two sentences with the concrete numbers behind the finding. */
  detail: string;
  /** What to actually do about it. */
  action: string;
  /** Estimated USD impact, when the rule can quantify one. Drives ranking. */
  estSavingsUsd?: number;
  /**
   * Optional calibration metadata for the dollar impact. This does not affect
   * ranking; `estSavingsUsd` remains the stable ordering field until a later
   * slice intentionally changes ranking semantics.
   */
  savingsAttribution?: RecommendationSavingsAttribution;
  /**
   * Structured reclaim claim for the guarded-marginal cascade (epic #944, PR1).
   * When present, the engine books this claim against the actual token residual
   * matrix instead of summing `estSavingsUsd` blindly — see `src/lib/reclaim.ts`.
   * `estSavingsUsd` is then a DERIVED back-fill of the booked marginal; legacy
   * callers that only read `estSavingsUsd` keep working unchanged.
   */
  reclaim?: ReclaimClaim;
  /** Count of affected sessions / files / calls. Secondary ranking key. */
  affected?: number;
  /** View to deep-link to for the underlying detail. */
  view?: View;
  /** Up to a handful of supporting rows (session ids, files, commands). */
  evidence?: string[];
  /** A copy-pasteable, ready-to-apply fix, when one genuinely exists. */
  fix?: RecFix;
  /**
   * Structured, auditable provenance (#1049, epic #866 keystone): the observed
   * facts (each citing its artifact/field), the inference drawn from them, and
   * an as-of date for stale-input handling. Additive and optional — detectors
   * adopt it incrementally; the provenance contract test enforces shape where
   * present and requires it for the opt-in allowlist. When present, `evidence`
   * remains the short human-readable row list; `provenance.observations` is the
   * machine-auditable companion.
   */
  provenance?: RecProvenance;
  /**
   * Optional provenance for findings that do not come from the deterministic
   * detector catalog. Omitted means the normal deterministic engine.
   */
  source?: 'judge-audit';
  /**
   * True when the finding's severity was scaled up because a contributing
   * signal ran under an unattended (`sdk-*`) entrypoint — e.g. a destructive
   * command executed by automation, where nobody is watching to abort it
   * (#197). Drives the "Unattended" marker in the UI.
   */
  unattended?: boolean;
  /**
   * Projects this finding is attributable to, derived from the session-ids that
   * lead its `evidence` rows (#330). Populated ONLY on the project-filtered
   * response from `filterRecommendationsByProject`; the global (unfiltered)
   * output never carries it, so that output stays byte-identical to pre-#330
   * and the v1 `/recs` consumer is unaffected.
   */
  projects?: string[];
}

export interface RecommendationInput {
  tokenData: SessionTokenData[];
  toolData: ToolUsageData[];
  sessions: Session[];
  projects: ProjectStats[];
  permissionRows: { mode: string; sessionId: string }[];
  apiErrors: ApiErrorEvent[];
  /**
   * Bundle of live Claude Code config — settings.json, global CLAUDE.md,
   * installed skills/plugins/MCP servers/hooks, etc. Used by rules that emit
   * a fix to skip themselves when the fix is already in effect anywhere in
   * the bundle (settings.json from #166, CLAUDE.md headings/body phrases for
   * #173). `null` means "couldn't read or parse the bundle" and is treated as
   * "filter nothing" so a malformed config doesn't hide real findings.
   */
  liveConfig?: LiveConfig | null;
  /**
   * Per-session assistant-behaviour features derived at ingest (#206) — refusal
   * / hedging / code-density / ends-with-question counts and thinking size, all
   * numeric so they ride the main dataset without inline transcripts. Optional:
   * `undefined`/`null` (or a transcript-free dataset) simply means the
   * behaviour rules emit nothing.
   */
  assistantFeatures?: AssistantFeatures[] | null;
  /**
   * Per-session prompt-trait features derived at ingest (#1274) — numeric
   * prompt wording buckets only, with no prompt prose retained. Optional:
   * `undefined`/`null` (or datasets predating the parser slice) means prompt
   * coaching detectors emit nothing.
   */
  promptAnalysis?: PromptAnalysis[] | null;
  /**
   * Per-session model-deceit signal derived at ingest (#685, epic #683 slice A)
   * — claim↔evidence mismatch counts (`unbackedClaimCount`,
   * `contradictedClaimCount`) and a few short claim snippets, all numeric so
   * they ride the main dataset without inline transcripts. Optional: the
   * downstream detector (slice B) is the only consumer; `undefined`/`null` (or a
   * dataset with no flagged sessions) simply means it emits nothing.
   */
  deceitSignals?: DeceitSignals[] | null;
  // ── Additional parsed signals (epic #411, #468) ─────────────────────────
  // Each of the fields below is an existing `parse-*.ts` output that the
  // dataset already computes (see scripts/ingest.mjs `assembleDataset`). They
  // are plumbed in via {@link RecommendationInput} so detectors can consume
  // them WITHOUT new server-side computation. ALL are optional: an
  // `undefined`/empty value means the detectors that read them emit nothing,
  // which keeps existing test fixtures and call sites compiling unchanged.
  /** Per-session timeline rows (parse-timeline). Feeds tool/compaction signals. */
  timelines?: SessionTimeline[];
  /** Agent-setting events (parse-agents). Feeds agent-effectiveness detectors. */
  agentSettings?: AgentSettingEvent[];
  /** Per-session cost/agent attribution (parse-agents). */
  attribution?: SessionAttribution[];
  /** Runtime/hook lifecycle events (parse-runtime-events). Feeds hook-health detectors. */
  runtimeEvents?: RuntimeEvents[];
  /**
   * Per-stop-hook task-span human steering counts (#1288). Optional: later
   * autonomy detectors consume this; existing fixtures can omit it.
   */
  taskSteering?: TaskSteering[] | null;
  /** Line-level edit geometry from toolUseResult.structuredPatch (#597). */
  churnGeometry?: ChurnGeometrySession[];
  /** Per-session tool inventory (parse-tool-inventory). Feeds idle-tool/skill detectors. */
  toolInventories?: ToolInventory[];
  /**
   * Per-axis aggregate of the shadow-calls experiment ledger
   * (`~/.claude/shadow-calls/ledger.jsonl`, parse-shadow-calls). Feeds the
   * `workflow.shadow-axis-wins` detector (epic #513, #518/#523). Optional:
   * `undefined`/`null`/empty (no experiments run yet) ⇒ the detector emits nothing.
   */
  shadowCalls?: ShadowCallAggregate | null;
  // ── #539 ingest artifacts ────────────────────────────────────────────────
  // Each is a top-level `~/.claude/` artifact (NOT a per-session transcript
  // signal), assembled separately in `scripts/ingest.mjs` like `shadowCalls`/
  // `liveConfig` and passed straight into the recommendation input. ALL optional:
  // an `undefined`/empty/`null` value means the detectors that read them emit
  // nothing, so existing fixtures and the transcript-only SPA dataset compile
  // and behave unchanged.
  /** Canonical Task/TodoWrite state from `tasks/` (#559). */
  tasks?: TaskRecord[];
  /** Inter-agent inbox health from `teams/` (#560). */
  teams?: TeamSummary[];
  /**
   * Explicit organization contributor/team identity map (#1122). Detectors may
   * use this to connect parser-level aliases, such as task owners, to durable
   * contributor ids. Absence, unknown aliases, or ambiguous aliases must mean
   * "do not guess".
   */
  organizationIdentity?: OrganizationIdentityDataset | null;
  /**
   * Structured PR/review request events (#1123). Enterprise connectors may supply
   * this aggregate so detectors can cite concrete review queue observations
   * without reading transcript text. Absence means review-latency detectors stay
   * silent.
   */
  reviewEvents?: OrganizationReviewEventsDataset | null;
  /** Live process registry from `sessions/` (#561). Feeds the #572 report card. */
  sessionRegistry?: SessionRegistryEntry[];
  /** Failed-event telemetry from `telemetry/` (#562). Feeds the #572 report card. */
  telemetry?: TelemetryEvent[];
  /** Per-session debug-log latency metrics from `debug/` (#569). Feeds #572. */
  debugLogs?: DebugSessionMetrics[];
  /** CLI daily-activity rollup from `stats-cache.json` (#563). */
  statsCache?: StatsCache | null;
  /** Rework signature from the `file-history/` snapshot store (#564). */
  fileHistory?: FileHistorySession[];
  /** Plan-mode document signatures from `plans/` (#565). */
  plans?: PlanSignature[];
  /** CLI self-update outcomes from `.last-update-result.json` (#566). */
  updateResults?: UpdateResult[];
  /** MCP re-auth state from `mcp-needs-auth-cache.json` (#567). */
  mcpAuth?: McpAuthState | null;
  /** Pre-computed config-drift events from `backups/` (#568). */
  configBackups?: DriftEvent[];
  /**
   * Server-only repo-map join substrate (#889): structural file/symbol map
   * linked to rereads, churn, config sections, attribution, and existing
   * recommendations. Omitted in SPA/upload datasets.
   */
  repoMap?: RepoMapDataset | null;
  /**
   * Workflow-tool run manifests (parse-workflows). Feeds the workflow-health
   * detectors (failed/aborted runs, runaway fan-out cost). Optional:
   * `undefined`/empty ⇒ those detectors emit nothing. The live server-dataset
   * wiring (walking `<session>/workflows/wf_*.json`) is a follow-up; until it
   * lands these detectors are unit-tested against fixtures. (#635)
   */
  workflows?: WorkflowRun[];
  /**
   * Optional measurement window for the automation model-pin recommendation.
   * When absent or insufficient, the detector keeps emitting its legacy
   * estimate-only finding.
   */
  modelPinSavings?: ModelPinSavingsConfig | null;
}

/**
 * A self-contained recommendation detector. New recommendations live one-per-
 * file under `src/lib/detectors/<category>/<id>.ts`, each exporting a `detector`
 * of this shape, and are collected by the static barrel in
 * `src/lib/detectors/index.ts`. `buildRecommendations` runs `rule` for every
 * registered detector alongside the legacy in-file rules.
 *
 * The registry is **static** (hand-written compile-time imports, no dynamic
 * `import()` / no fs scan) so it stays as auditable and offline as the original
 * flat rule array — see ADR 0002.
 */
export interface Detector {
  /** Stable rule id, MUST equal the `id` the rule emits, e.g. 'cost.web-search-spend'. */
  id: string;
  category: RecCategory;
  /**
   * Which {@link RecommendationInput} fields this detector reads. Documentation
   * + introspection only (the discovery workflow and the "what feeds the
   * engine" map use it); it does NOT drive evaluation or loading.
   */
  dataDeps?: (keyof RecommendationInput)[];
  /** The pure detector function. Returns `null` when there's nothing to say. */
  rule: (input: RecommendationInput, now: number) => Recommendation | null;
}
