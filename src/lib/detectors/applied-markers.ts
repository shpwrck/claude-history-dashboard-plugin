// Client-safe finding-id -> CLAUDE.md marker catalog (#1785, bundle fix #1909).
//
// The adoption scorecard renders in a client route (`digest`) and needs each
// finding's `appliedMarkers` to resolve a SURFACED-only finding's live hunk.
// Importing the `detectors/index.ts` barrel to get that would eagerly bundle the
// ENTIRE recs engine (every detector module + its rule/transitive deps) into the
// client chunk and trip the route bundle-budget gate (ADR 0016 /
// docs/bundle-budget-contract.md). This LEAF carries only the static marker data
// — RegExp headings + body phrases, no detector logic — so the client pulls a
// few hundred bytes, not the engine.
//
// The detector modules remain the behavioural source of truth (each declares the
// same markers on `Detector.appliedMarkers`); `applied-markers.contract.test.ts`
// asserts this catalog is byte-for-byte equal to the catalog built from those
// detector fields, so the two representations can never silently drift.
import type { AppliedMarkers } from './types';

export const MARKERS_LOW_CACHE_HIT: AppliedMarkers = {
  headings: [/^##\s+(Keep the )?prompt cache\b/i],
  bodyPhrases: ['stable context prefix, so avoid churning'],
};
export const MARKERS_RATE_LIMITS: AppliedMarkers = {
  headings: [/^##\s+Rate-limit hygiene\b/i],
  bodyPhrases: ['Avoid launching many parallel agent runs'],
};
export const MARKERS_EXPENSIVE_SESSIONS: AppliedMarkers = {
  headings: [/^##\s+Session scope\b/i],
  bodyPhrases: ['start a fresh session when the task changes'],
};
export const MARKERS_REDUNDANT_READS: AppliedMarkers = {
  headings: [/^##\s+Key files\b/i],
  bodyPhrases: ['Load these files once into context'],
};
export const MARKERS_CACHE_1H_WASTE: AppliedMarkers = {
  headings: [/^##\s+Cach(e|ing)\b/i],
  bodyPhrases: ['default 5-minute prompt cache for routine work'],
};
export const MARKERS_LOW_HEALTH: AppliedMarkers = {
  headings: [/^##\s+(Keep the session|Session) heal/i],
  bodyPhrases: ['Avoid switching permission modes mid-session'],
};
export const MARKERS_REPEATED_COMPACTIONS: AppliedMarkers = {
  headings: [/^##\s+Session resets\b/i],
  bodyPhrases: ['split the remaining work into a new session'],
};
export const MARKERS_REPEATED_COMMANDS: AppliedMarkers = {
  headings: [/^##\s+Common commands\b/i],
  bodyPhrases: ['wrap them in a script'],
};
export const MARKERS_NATIVE_BYPASS: AppliedMarkers = {
  headings: [/^##\s+Prefer native tools and path-safe shell usage\b/i],
  bodyPhrases: [
    'choose native tools or path-safe alternatives before Bash',
  ],
};
export const MARKERS_MODEL_EVAL_ROUTING_GAP: AppliedMarkers = {
  headings: [/^##\s+Scoped model routing\b/i],
  bodyPhrases: ['scoped model-routing decision adopted from eval evidence'],
};
export const MARKERS_COMPACTION_HOT_SESSIONS: AppliedMarkers = {
  headings: [/^##\s+Context discipline\b/i],
  bodyPhrases: ['letting context grow until it auto-compacts'],
};
export const MARKERS_CORRECTIONS: AppliedMarkers = {
  headings: [/^##\s+(?:Known paths|File locations|Project map|Corrections|Gotchas)\b/i],
  bodyPhrases: ['not the first place the agent looked'],
};
export const MARKERS_OVER_WINDOW: AppliedMarkers = {
  headings: [/^##\s+Context discipline\b/i],
  bodyPhrases: ['working context well under the model'],
};
export const MARKERS_COMPACTION_LARGE_TOOL_OUTPUTS: AppliedMarkers = {
  headings: [/^##\s+Tool output discipline\b/i],
  bodyPhrases: ['prefer Grep/Glob over unfiltered'],
};
export const MARKERS_WEB_SEARCH_SPEND: AppliedMarkers = {
  headings: [/^##\s+Web-search discipline\b/i],
  bodyPhrases: ['Prefer web_fetch for stable URLs'],
};
export const MARKERS_REPO_MAP_WASTE: AppliedMarkers = {
  headings: [/^##\s+Stable reference files\b/i],
  bodyPhrases: ['Reference these stable files instead of re-reading them'],
};
export const MARKERS_CROSS_SESSION_REREAD: AppliedMarkers = {
  headings: [/^##\s+Distilled reference notes\b/i],
  bodyPhrases: ['Distill these docs once here instead of re-reading them cold'],
};
export const MARKERS_RECLAIM_POTENTIAL: AppliedMarkers = {
  headings: [/^##\s+Context reclaim discipline\b/i],
  bodyPhrases: ['Cache or reference these large tool outputs and pasted blocks'],
};
export const MARKERS_OUTPUT_VERBOSITY: AppliedMarkers = {
  headings: [/^##\s+Output brevity\b/i],
  bodyPhrases: ['keep assistant output terse'],
};
export const MARKERS_PLAN_VERIFICATION: AppliedMarkers = {
  headings: [/^##\s+plan verification/i],
  bodyPhrases: [
    'Verification section describing the minimal observable signal',
    'plan is not ready to run',
  ],
};
export const MARKERS_SHADOW_AXIS_WINS: AppliedMarkers = {
  headings: [/^##\s+default approach/i],
  bodyPhrases: ['Revisit if live shadows stop favouring it'],
};
// Hook fixes (#1783): the fix snippet is JSON pasted into settings.json, not
// CLAUDE.md prose, so there is no snippet to match in the merged CLAUDE.md.
// These key on the adopt-block wrapper the opt-in helper writes. Dangerous-
// bypass no longer uses such a receipt: current structural settings coverage
// is authoritative, and an old prose receipt must not hide a newly observed
// dangerous-command gap (#2642).
const RETIRED_MARKERS_DANGEROUS_BYPASS: AppliedMarkers = {
  headings: [/^##\s+Claude Coach Adopted Recommendations\b/i],
  bodyPhrases: ['Dangerous commands ran under bypassed permissions'],
};
/**
 * Historical marker signatures used only to render an existing SUPPRESSED
 * receipt without resolving a shared heading to the wrong live hunk. These are
 * deliberately excluded from FINDING_MARKER_CATALOG: they must not mark a new
 * SURFACED finding adopted or suppress a detector (#2642).
 */
export const RETIRED_SUPPRESSION_MARKER_CATALOG: ReadonlyMap<
  string,
  AppliedMarkers
> = new Map([
  ['safety.dangerous-bypass', RETIRED_MARKERS_DANGEROUS_BYPASS],
]);
export const MARKERS_TOOL_ERRORS: AppliedMarkers = {
  headings: [/^##\s+Claude Coach Adopted Recommendations\b/i],
  bodyPhrases: ['Tools with high error rates'],
};
export const MARKERS_CWD_DRIFT_EXECUTION: AppliedMarkers = {
  headings: [/^##\s+Anchor (?:repo|git)\b/i],
  bodyPhrases: ['silently targets the wrong repository'],
};
export const MARKERS_STALE_STATE_ASSERTION: AppliedMarkers = {
  headings: [/^##\s+Fetch before asserting repo state\b/i],
  bodyPhrases: ['local tree can sit many commits behind origin'],
};
export const MARKERS_DISCOVERY_FRESHNESS: AppliedMarkers = {
  headings: [/^##\s+Read freshness\b/i],
  bodyPhrases: ['re-read the target after the ref moves before acting'],
};
export const MARKERS_GHOST_SESSION: AppliedMarkers = {
  headings: [/^##\s+Edit-session completion\b/i],
  bodyPhrases: ['do not stop after discovery', 'state the concrete blocker explicitly'],
};

export const MARKERS_HUMAN_INPUT_LEVERAGE: AppliedMarkers = {
  headings: [/^##\s+(?:Ask(?:ing)? upfront|Human input|Value of human input|Upfront questions)\b/i],
  bodyPhrases: ['ask the human upfront'],
};
export const MARKERS_VALUE_OF_AGENT_HANDOFF: AppliedMarkers = {
  headings: [
    /^##\s+(?:Agent handoff|Handoff artifacts|Durable state handoff|Runbooks for durable state)\b/i,
  ],
  bodyPhrases: ['durable external state changes need a handoff artifact'],
};
export const MARKERS_SESSION_RESTART_RETYPE: AppliedMarkers = {
  headings: [/^##\s+Resume prior sessions instead of re-?typing\b/i],
  bodyPhrases: ['resume the prior session instead of re-explaining the task'],
};

/**
 * Canonical finding-id -> markers map, client-safe (no detector logic pulled in).
 * Keys are detector ids; each value mirrors that detector's
 * `Detector.appliedMarkers`. Kept in sync with the detector catalog by
 * `applied-markers.contract.test.ts`.
 */
export const FINDING_MARKER_CATALOG: ReadonlyMap<string, AppliedMarkers> = new Map([
  ['context.low-cache-hit', MARKERS_LOW_CACHE_HIT],
  ['reliability.api-errors', MARKERS_RATE_LIMITS],
  ['cost.expensive-sessions', MARKERS_EXPENSIVE_SESSIONS],
  ['workflow.redundant-reads', MARKERS_REDUNDANT_READS],
  ['cost.cache-1h-waste', MARKERS_CACHE_1H_WASTE],
  ['context.low-health', MARKERS_LOW_HEALTH],
  ['context.repeated-compactions', MARKERS_REPEATED_COMPACTIONS],
  ['workflow.repeated-commands', MARKERS_REPEATED_COMMANDS],
  ['workflow.native-bypass', MARKERS_NATIVE_BYPASS],
  ['cost.model-eval-routing-gap', MARKERS_MODEL_EVAL_ROUTING_GAP],
  ['context.compaction-hot-sessions', MARKERS_COMPACTION_HOT_SESSIONS],
  ['workflow.correction-mining', MARKERS_CORRECTIONS],
  ['workflow.human-input-leverage', MARKERS_HUMAN_INPUT_LEVERAGE],
  ['workflow.value-of-agent-handoff', MARKERS_VALUE_OF_AGENT_HANDOFF],
  ['workflow.session-restart-retype', MARKERS_SESSION_RESTART_RETYPE],
  ['context.over-window', MARKERS_OVER_WINDOW],
  ['context.compaction-large-tool-outputs', MARKERS_COMPACTION_LARGE_TOOL_OUTPUTS],
  ['cost.web-search-spend', MARKERS_WEB_SEARCH_SPEND],
  ['cost.output-verbosity', MARKERS_OUTPUT_VERBOSITY],
  ['context.repo-map-context-waste', MARKERS_REPO_MAP_WASTE],
  ['context.cross-session-reread', MARKERS_CROSS_SESSION_REREAD],
  ['context.reclaim-potential', MARKERS_RECLAIM_POTENTIAL],
  ['workflow.plan-missing-verification', MARKERS_PLAN_VERIFICATION],
  ['workflow.shadow-axis-wins', MARKERS_SHADOW_AXIS_WINS],
  ['reliability.tool-errors', MARKERS_TOOL_ERRORS],
  ['reliability.cwd-drift-execution', MARKERS_CWD_DRIFT_EXECUTION],
  ['reliability.stale-state-assertion', MARKERS_STALE_STATE_ASSERTION],
  ['reliability.discovery-freshness', MARKERS_DISCOVERY_FRESHNESS],
  ['reliability.ghost-session', MARKERS_GHOST_SESSION],
]);
