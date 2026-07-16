# Portable signal inventory for harness-agnostic experiments

Date: 2026-07-13

Wayfinder ticket: [#2598](https://github.com/shpwrck/claude-history-dashboard/issues/2598)

Wayfinder map: [#2589](https://github.com/shpwrck/claude-history-dashboard/issues/2589)

## Executive answer

Claude Code and Codex already expose enough local structure to run the same experiment in either harness when the experiment measures turn wall time, session wall span, timestamped tool round trips, or common token categories. They do **not** expose every metric with equivalent semantics. The portable runtime must therefore select experiments by declared adapter capabilities and metric semantics, not by the presence of similarly named fields.

The defensible 80/20 portable core is:

- namespaced session identity: `(harness, sourceId, sessionId)`;
- native turn wall time, with Claude `system/turn_duration.durationMs` and Codex `event_msg/task_complete.duration_ms` treated as comparable;
- derived tool round-trip time from timestamped, correlated call/result pairs, explicitly labelled as wall-clock round trip rather than tool execution time;
- provider-native input, cached-input/cache-read, and output token facts, without pretending their billing or reasoning semantics are identical;
- rate-limit windows represented by duration, utilization, reset time, freshness, and acquisition method rather than vendor slot names;
- experiment provenance written by the shared experiment runtime, because neither harness's ordinary session history is a sufficient experiment ledger.

TTFT/model latency is not yet a universally available portable metric. Codex emits native per-turn `time_to_first_token_ms`; Claude can supply request-to-first-chunk observations from optional debug data, while its telemetry API-time sample is session-cumulative and is not equivalent. An experiment requiring TTFT must request a certified latency capability and be ineligible on adapters that cannot provide it. Likewise, missing signals are capability states (`unavailable`, `disabled`, `unsupported`, or `stale`), never numeric zeroes.

## Signal matrix

Confidence means:

- **High**: native fields describe the same concept and unit closely enough for cross-harness analysis.
- **Medium**: a deterministic derivation is useful, but its semantic caveat must travel with the observation.
- **Unsupported**: the available facts are materially different; an adapter must provide or decline the capability.

| Signal | Claude Code source | Codex source | Portable representation | Confidence and limits |
|---|---|---|---|---|
| Harness/source/session identity | Transcript path and top-level/session IDs documented in [`REFERENCES.md`](../../REFERENCES.md); parser registry already models `harness` and `id` in [`src/types.ts`](../../src/types.ts) and [`src/lib/sources.ts`](../../src/lib/sources.ts) | `session_meta.payload.id` / `session_id`, plus source, originator, cwd and Git metadata in `~/.codex/sessions/**/rollout-*.jsonl` | `{ harness, sourceId, sessionId, parentSessionId?, agentId? }` | **High** for the composite identity. Bare session IDs must never be joined across harnesses or sources. Parent/agent relationships are extensions when present. |
| Session timing | Timestamped transcript records; [`parse-timeline.ts`](../../src/lib/parse-timeline.ts) derives bounds from first/last events | Every inspected rollout record was timestamped; `task_started.started_at` and `task_complete.completed_at` add turn bounds | `sessionWallSpanMs`, `startedAt`, `endedAt`, with completeness state | **Medium**. First-to-last event span includes idle/user time and an interrupted session may lack a trustworthy end. It is not active compute time. |
| Turn wall time | Native `system` / `turn_duration.durationMs`, parsed by [`parse-runtime-events.ts`](../../src/lib/parse-runtime-events.ts) | Native `event_msg/task_complete.duration_ms` and matching turn ID | `turnWallTimeMs` with `{scope: "turn", basis: "native"}` | **High**. This is the strongest portable speed signal currently available. Coverage/version still belongs in adapter capability metadata. |
| Tool call identity and ordering | Assistant `tool_use.id` paired with user `tool_result.tool_use_id` in [`parse-tools.ts`](../../src/lib/parse-tools.ts); [`parse-timeline.ts`](../../src/lib/parse-timeline.ts) retains timestamps on both | `response_item` call/output records correlate through `call_id`; top-level records are timestamped | Raw tool event facts with `callId`, timestamp, phase, raw name/namespace | **High** for correlation and ordering. Tool names remain provider-native and require a separate capability taxonomy. |
| Tool duration | Difference between correlated Claude call and result timestamps | Difference between correlated Codex call and output timestamps | `toolRoundTripMs` with `{basis: "derived-call-result"}` | **Medium**. It measures wall-clock round trip, which may include approval, user wait, queueing, nested work, or output transport. Concurrent tools overlap. It must not be labelled execution/CPU time. The existing Claude `ToolCall` parser does not yet calculate it, although the timeline contains the needed facts. |
| First tool/edit latency | Difference between turn/session start and first qualifying correlated tool call | Same derivation from task start and first qualifying call | `timeToFirstActionMs`, action taxonomy/version | **Medium**. Portable only when both adapters map raw tools to the same versioned action capability (for example, file mutation), and when the turn start boundary is known. |
| Model latency / TTFT | Optional debug logs expose request-to-first-chunk measurements through [`parse-debug.ts`](../../src/lib/parse-debug.ts). Claude telemetry's `tengu_exit` API time, parsed by [`parse-telemetry.ts`](../../src/lib/parse-telemetry.ts), is session-cumulative successful-path API time instead | Native per-turn `event_msg/task_complete.time_to_first_token_ms` | Separate metric kinds: `timeToFirstOutputMs` or certified `ttftMs`, each with acquisition semantics | **Unsupported by default**. Claude debug data was absent in the inspected installation and first chunk is not automatically equivalent to first token. Claude cumulative API time must not be compared with Codex turn TTFT. An adapter may advertise a versioned optional latency capability after certifying semantics. |
| Input tokens | Assistant usage fields parsed by [`parse-sessions.ts`](../../src/lib/parse-sessions.ts) | `event_msg/token_count.info.last_token_usage.input_tokens` and cumulative totals | `inputTokens` plus native provenance/scope | **High** as a provider-native count, not as equivalent work or price. Codex adapters should prefer per-turn `last_token_usage`, or safely delta cumulative totals when association is unavailable. |
| Cached input / cache read | `cache_read_input_tokens` | `cached_input_tokens` | `cachedInputTokens` | **High** for a common cache-hit/input category. Billing value and cache policy stay provider-specific. |
| Cache creation | `cache_creation_input_tokens` | No equivalent field in inspected rollout events | Extension `claude.cacheCreationInputTokens` | **Unsupported** as a common metric. Do not fold it into cached input or synthesize zero for Codex. |
| Output tokens | `output_tokens` | `output_tokens` | `outputTokens` | **High** as provider-native output count. It is not a guarantee of equal visible text or reasoning effort. |
| Reasoning/thinking tokens | Claude transcripts may carry thinking content, while existing dashboard estimates reconstruct it rather than receiving an equivalent usage component | Explicit `reasoning_output_tokens` | Provider extensions (`codex.reasoningOutputTokens`, Claude-native facts when present) | **Unsupported** as an exact common metric. Do not compare reconstructed Claude thinking with Codex's explicit usage field as if they were the same counter. |
| Cost | Dashboard pricing can estimate Claude costs from token facts; no single transcript-native USD fact | No transcript-native USD charge for subscription-plan use in inspected rollout events | Optional `costUsd` with pricing-source/version provenance | **Unsupported by default**. Only publish cost when the adapter directly observes it or a versioned pricing calculation owns the estimate. Rate utilization is not cost. |
| Rate/runway windows | The current usage path reads Anthropic response headers via an explicit request in [`scripts/server.mjs`](../../scripts/server.mjs) and normalizes them in [`usage-gauge.ts`](../../src/lib/usage-gauge.ts); this is network-derived rather than a local session artifact | Local `token_count.rate_limits.primary` / `secondary` include `used_percent`, `resets_at`, and `window_minutes`; the shared `~/.agents/skills/session-usage/scripts/check-usage.mjs` already reads these events | Array of `{windowMinutes, utilization, resetAt, observedAt, status, acquisition}` | **High** within a declared window; **medium** for deciding cross-provider runway. Never hard-code `primary = 5h` or `secondary = 7d`: use `window_minutes`. The current shared helper proves acquisition but still maps those slots to 5-hour/7-day labels, so the runtime must correct that before reusing its normalized output. Claude acquisition must remain explicit/opt-in where it makes a network request, and selection must account for stale/unavailable data. |
| Experiment assignment and result provenance | Legacy enrollment and shadow-call ledgers under `~/.claude` contain session, axis/arm, worker/judge, tokens, wall time and gates | Ordinary Codex rollout metadata identifies the harness/runtime but does not identify an experiment definition or treatment | Runtime-authored `ExperimentRun` with definition/version, treatment, origin/worker/judge harnesses, capability snapshot, observations, and source identities | **Unsupported from ordinary histories; high when runtime-authored**. Legacy Claude ledgers are import sources, not the portable authority. Never infer assignment from prompt text, model, or config. |

## Normalization and adapter decisions

### 1. Namespace identity at ingestion

The canonical key is `{harness, sourceId, sessionId}` as anticipated by [#2582](https://github.com/shpwrck/claude-history-dashboard/issues/2582). `sourceId` distinguishes multiple roots or pushed sources from the same harness. Preserve native IDs and optional parent/fork/agent relationships; do not rewrite them into a globally meaningful bare ID.

### 2. Make observations self-describing

Each experiment observation should carry at least:

```ts
type Observation = {
  metric: string
  value: number
  unit: 'ms' | 'tokens' | 'ratio' | 'usd'
  scope: 'turn' | 'session' | 'tool' | 'window' | 'run'
  basis: 'native' | 'derived-call-result' | 'derived-pricing' | 'external-header'
  semanticsVersion: string
  observedAt: string
  source: { harness: 'claude-code' | 'codex'; sourceId: string; artifactKind: string }
  confidence: 'high' | 'medium'
}
```

The schema may use a tagged union rather than this exact shape. The requirements are the portable contract: metric kind, unit, scope, derivation basis, versioned semantics, timestamp, artifact provenance, and confidence cannot be discarded during normalization.

### 3. Capabilities need state, coverage, and semantics

The provider registry proposed by [#2520](https://github.com/shpwrck/claude-history-dashboard/issues/2520) should expose typed capabilities rather than coarse booleans. For example:

```ts
type CapabilityState = {
  state: 'available' | 'unavailable' | 'disabled' | 'unsupported' | 'stale'
  semanticsVersion?: string
  coverage?: number
  acquisition?: 'local' | 'network-opt-in' | 'runtime-authored'
  observedAt?: string
}
```

The inspected Claude installation had transcripts but no local `telemetry` or `debug` directory, despite those shapes being documented in [`REFERENCES.md`](../../REFERENCES.md). This is a normal capability outcome, not malformed data. Experiments declare `requiredCapabilities`; selection excludes an ineligible harness or reports a strict error. Missing metrics are omitted with a reason, not emitted as zero.

### 4. Preserve native extensions

The common token surface should include input, cached input/cache read, and output only. Claude cache creation and Codex reasoning output remain namespaced extensions. Model IDs stay opaque and provider-qualified; there is no defensible automatic mapping from a Claude model tier to a Codex model tier. Raw tool names likewise remain intact while a separately versioned taxonomy maps them to portable capabilities such as shell execution, file read, or file mutation.

### 5. Separate wall time, active time, and latency

`turnWallTimeMs`, `toolRoundTripMs`, `sessionWallSpanMs`, and model latency are different metrics. None should be substituted for another. In particular:

- Claude `tengu_exit` cumulative API time is not Codex TTFT or turn duration.
- Call-to-result elapsed time is not tool execution time.
- First-to-last session timestamp is not productive compute time.
- Token count and spend are outcome/resource metrics, not speed metrics.

### 6. Let the runtime own experiment provenance

The shared runtime designed by [#2591](https://github.com/shpwrck/claude-history-dashboard/issues/2591) should create the `ExperimentRun` record before dispatch and append worker, judge, and measurement facts afterward. It should record the origin harness separately from every worker/judge harness so handoff does not rewrite provenance. Adapters supply local facts and launch/judge capabilities; ordinary harness transcripts are supporting evidence, not the experiment system of record.

## Implications for the remaining wayfinder tickets

- **Harness selection ([#2590](https://github.com/shpwrck/claude-history-dashboard/issues/2590)).** Explicit selection wins. Automatic selection compares normalized rate windows only after checking acquisition method, observation freshness, uncertainty, and required experiment capabilities. If no comparable fresh runway exists, strict mode must stop or require an explicit harness; it must not silently choose from stale or incomparable provider signals.
- **Runtime boundary ([#2591](https://github.com/shpwrck/claude-history-dashboard/issues/2591)).** Core owns schemas, run state, assignment, provenance, eligibility, and result recording. Adapters own artifact discovery/extraction, capability and coverage reports, worker launch, judge invocation, and harness guidance installation.
- **Experiment schema ([#2592](https://github.com/shpwrck/claude-history-dashboard/issues/2592)).** Add `requiredCapabilities`, metric semantics/version, observation provenance, origin/worker/judge harnesses, and explicit missing-capability results. This gives a future CRD-compatible shape without assuming Kubernetes now.
- **Prototype ([#2593](https://github.com/shpwrck/claude-history-dashboard/issues/2593)).** Prove one native metric (`turnWallTimeMs`), one derived metric (`toolRoundTripMs`), one runtime-authored provenance record, and one negative capability case such as Claude TTFT unavailable. A happy path alone will conceal the main portability risk.
- **Speed epic ranking ([#2595](https://github.com/shpwrck/claude-history-dashboard/issues/2595)).** Prefer experiments using turn wall time, tool round trip, and time to first portable action. Defer experiments that require cross-harness TTFT, model API time, or true tool execution time until adapters advertise certified equivalent semantics. Do not rank token/cost experiments as speed experiments.
- **Applicability ([#2596](https://github.com/shpwrck/claude-history-dashboard/issues/2596)).** A result transfers to another harness only when that adapter satisfies the experiment's required capabilities and semantics versions. Matching field names or both tests passing is insufficient.
- **Existing ingest epics ([#1756](https://github.com/shpwrck/claude-history-dashboard/issues/1756), [#2045](https://github.com/shpwrck/claude-history-dashboard/issues/2045), [#2521](https://github.com/shpwrck/claude-history-dashboard/issues/2521)).** Update #1756's Codex documentation/parsing assumptions: current rollouts live under `~/.codex/sessions` and directly expose timing, tokens, TTFT, and rate windows. Narrow #2045's `logs_2.sqlite` work to facts still missing from JSONL rather than making SQLite the default token/runway source. Pushed artifacts must retain stamped origin harness/source and be shape-validated instead of being interpreted through a Claude-only path convention.

## Audit method and sources

This inventory used primary local contracts and structure-only inspection; no transcript prompts, outputs, credentials, or secret values were read into the report.

- Claude artifact contracts and parser ownership: [`REFERENCES.md`](../../REFERENCES.md).
- Cross-harness runway acquisition: `~/.agents/skills/session-usage/scripts/check-usage.mjs`; its Claude path reads first-party headers and its Codex path reads local rollout events, but its current slot labels are not the target normalization contract.
- Current domain and source registry: [`src/types.ts`](../../src/types.ts), [`src/lib/sources.ts`](../../src/lib/sources.ts).
- Claude session, tool, timeline, runtime, telemetry, debug, and rate parsing: [`parse-sessions.ts`](../../src/lib/parse-sessions.ts), [`parse-tools.ts`](../../src/lib/parse-tools.ts), [`parse-timeline.ts`](../../src/lib/parse-timeline.ts), [`parse-runtime-events.ts`](../../src/lib/parse-runtime-events.ts), [`parse-telemetry.ts`](../../src/lib/parse-telemetry.ts), [`parse-debug.ts`](../../src/lib/parse-debug.ts), [`usage-gauge.ts`](../../src/lib/usage-gauge.ts), and [`scripts/server.mjs`](../../scripts/server.mjs).
- Codex local shape: key-only and aggregate inspection of current `~/.codex/sessions/**/rollout-*.jsonl` records. The inspected records consistently used top-level `timestamp`, `type`, and `payload`; the sampled recent rollout had paired call/output IDs and native task duration/TTFT fields. These are observed implementation facts, so adapters must still version their shape assumptions and degrade to a capability error when a future CLI version changes them.
- Existing design/backlog sources: [#1756](https://github.com/shpwrck/claude-history-dashboard/issues/1756), [#2045](https://github.com/shpwrck/claude-history-dashboard/issues/2045), [#2520](https://github.com/shpwrck/claude-history-dashboard/issues/2520), [#2521](https://github.com/shpwrck/claude-history-dashboard/issues/2521), [#2582](https://github.com/shpwrck/claude-history-dashboard/issues/2582), and the [#2590–#2597 wayfinder sequence](https://github.com/shpwrck/claude-history-dashboard/issues/2590).

The result is deliberately strict: where the harnesses expose different phenomena, the schema preserves the difference and eligibility rejects the experiment. Portability comes from explicit contracts and comparable evidence, not from flattening vendor data until it looks uniform.
