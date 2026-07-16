# Harness-neutral speed opportunities under the 80/20 rule

Date: 2026-07-13

Wayfinder ticket: [#2595](https://github.com/shpwrck/claude-history-dashboard/issues/2595)

Wayfinder map: [#2589](https://github.com/shpwrck/claude-history-dashboard/issues/2589)

Input inventory: [portable signals across Claude Code and Codex](./2026-07-portable-signal-inventory.md)

## Executive decision

The first portable speed portfolio should contain three levers and one shared clock ledger:

1. **Overlap long waits with independently useful work.** Detect backgroundable work that blocks the foreground, then dispatch it asynchronously and self-resume. This is the largest measured opportunity, but its 3,984 observed minutes are a **human-blocked-time ceiling**, not a promise that task completion becomes 3,984 minutes faster.
2. **Fail once, then diagnose or change strategy.** Detect repeated error-bearing tool attempts and price their correlated round-trip clock. The current data shows broad prevalence—1,092 errored retry runs across 246 sessions, including 607 storms—but does not yet attach defensible wall-clock minutes.
3. **Batch or parallelize only provably independent calls and subtasks.** Detect serial work only after an independence gate. The current time-motion aggregate exposes 53.6 minutes across 8,657 adjacent Read call/result gaps, but those raw adjacencies do not prove independence; none of the 53.6 minutes may be booked as reclaimable until the stronger detector passes.
4. **Use one non-overlapping accounting ledger.** Make end-to-end task completion the primary speed outcome; preserve active-turn, tool-round-trip, and human-blocked clocks as distinct explanatory measures. Realized reclaimed time exists only after a controlled treatment beats its comparison arm at equivalent quality.

This is the 80/20 boundary. Output/context right-sizing is a supporting resource lever, not a first-wave speed claim. Fast modes, model/effort routing, TTFT, hook timing, cache behavior, permission waits, and many named micro-stalls remain capability-gated or deferred until the core ledger shows that they materially move the clock.

## Evidence boundary

The prevalence figures below are a local Claude Code snapshot, generated at `2026-07-14T03:13:50Z` over events from `2026-05-08T19:41:57.809Z` through `2026-07-14T03:04:16.940Z`. The snapshot contained 641 timelines and 254 runtime-event rows. It establishes a priced premise for this installation; it does **not** establish Codex prevalence. Portability is assessed separately from the signal contracts and documented harness capabilities.

The portable inventory found native turn wall time to be the strongest common speed fact and correlated call-to-result elapsed time to be a useful, medium-confidence derivation. It also found cross-harness TTFT, true tool execution time, proprietary cache semantics, and model economics non-equivalent by default. Those limits govern this ranking rather than being flattened away.

Confidence labels have specific meanings:

- **High**: the occurrence and clock are directly observed with stable semantics.
- **Medium**: the occurrence is observed, but attribution or treatment effect requires a causal run.
- **Low**: only a proxy or unpriced premise exists; the candidate cannot support a current savings claim.

Effort is relative to the experiment runtime planned by #2589:

- **S**: normalize or extend an existing detector/axis.
- **M**: add a portable detector, adapter capability, and paired treatment.
- **L**: requires new optional telemetry, semantic certification, or provider-specific infrastructure.

## Ranked opportunity matrix

| Rank | Candidate detector and lever | Observed prevalence | Expected minutes reclaimed | Evidence confidence | Portability | Effort | Disposition |
|---:|---|---|---|---|---|---|---|
| 1 | `foreground-block-clock`: background/detach long commands and independent agent work; self-resume instead of ending on a passive wait | 2,207 backgroundable foreground calls in 138 sessions; 6 passive turn-end stalls in 6 sessions | **3,984 human-blocked minutes observed as a ceiling.** Real task-completion savings are unpriced until useful work overlaps the wait. | High for block clock; medium for causal reclaim | High behind `asynchronousDispatch` and `selfResume` capabilities | S–M | **Ship in core** |
| 2 | `error-retry-clock`: after one failure, diagnose, repair, or change strategy instead of repeating the same operation | 1,092 errored retry runs in 246 sessions; 607 runs had 4+ consecutive same-tool attempts with errors | **Unpriced until correlated error-call/result and intervening turn clock are retained.** Counts and cache re-payment are not minutes. | High for prevalence; medium for avoidability; low until clock-priced | High behind `correlatedActionResult` and `errorClassification` capabilities | M | **Ship in core** |
| 3 | `independent-serial-work`: batch calls or parallelize subtasks only when inputs and result dependencies prove independence | Raw time-motion aggregate: 8,657 adjacent Read use/result gaps totaling 53.6 minutes across 362 affected sessions | **At most the eligible subset of the 53.6-minute Read clock in this snapshot.** The current aggregate cannot identify that subset, and other tool families are not yet priced. | Medium for raw clock; low for current reclaim estimate | High behind a versioned tool/action taxonomy and parallel-dispatch capability | M | **Ship after the independence gate** |
| 4 | `payload-latency`: generate less output and return targeted tool slices | 1,051 reclaimable duplicate/oversized items totaling about 7.94M context tokens; 737 over-fetching tool calls | **Not minute-priced.** Input reduction usually has a much smaller latency effect than output reduction or removing requests. | High for token waste; low for speed effect | High for byte/token accounting; medium for provider latency effect | M | **Supporting measure; not a core speed claim** |
| 5 | `execution-tier`: use a faster model mode or lower reasoning effort when quality permits | 6h 1m of native model-working turn time is an exposure envelope, not an eligible cohort; the existing “downgradable” classifier is cost/quality evidence, not clock evidence | **Unknown.** Vendor speed multipliers cannot be applied to the whole envelope, and modes carry different cost and quality tradeoffs. | Low until paired within each harness | Medium: the concept is common, but modes and economics are provider-specific | M | **Defer to a capability-gated second wave** |
| 6 | `context-thrash-clock`: compact, clear, or hand off before repeated context pressure | 153 sessions in the high-risk band, 111 with repeated compactions, and 105 above 200K tokens | **Unknown.** Token/context pressure is observed, but no portable compaction-duration or end-to-end latency delta is priced. | High for pressure; low for speed effect | Medium: harness context mechanisms differ | M–L | **Keep as a countermetric; defer as a speed axis** |

The ranking deliberately favors a measured clock or a broad, directly observed occurrence over an attractive vendor feature. Rank 1 is first because it already has a large, auditable block-time denominator and a concrete lever. Ranks 2 and 3 follow because their mechanisms remove whole failed or serial round trips, which is generally more promising than trimming input tokens, but both need stricter accounting before advertising minutes.

## Core detector contracts

### 1. Foreground block clock

Emit one observation for a correlated tool call when all of these hold:

- the adapter classifies the action as backgroundable or parallel-dispatchable;
- the action ran synchronously in the foreground;
- elapsed call-to-result time exceeds the versioned block floor;
- no overlapping interval has already claimed the same clock; and
- provenance retains harness, source, session, turn, call ID, raw action, taxonomy version, threshold, and timestamps.

Keep two outputs separate:

- `humanBlockedMs`: the interval during which the foreground conversation could not accept independently useful work;
- `taskCompletionWallMs`: the objective's end-to-end clock, which may be unchanged when the background action remains on the critical path.

Passive “I will wait” turn ends belong to the same lever family but a different event kind. Their recoverable cost is the interval until a real human prompt re-engages the stalled session, with explicit background jobs and scheduled/self-resuming polls excluded. The current detector implementation and evidence contract live in [`workflow/conversational-availability.ts`](../../src/lib/detectors/workflow/conversational-availability.ts) and [`reliability/passive-wait-stall.ts`](../../src/lib/detectors/reliability/passive-wait-stall.ts).

### 2. Error retry clock

Add a clock-valued detector beside the existing retry counts. A retry run begins with an error-bearing result and continues through semantically equivalent attempts until success, abandonment, or a material strategy/input change. Record:

- failed attempt count and error class;
- sum and union of correlated `toolRoundTripMs` intervals;
- intervening native `turnWallTimeMs` attributed to the retry run;
- the first material strategy change, if any;
- cache/token facts as resource countermetrics, never converted to minutes; and
- conservative overlap keys so a failed interval cannot also be claimed by serial-work or foreground-block totals.

The detector must not say the entire failed turn was avoidable. It may report the measured repeat-attempt clock and test whether the treatment reduces it. Existing retry counts provide the premise, while [`docs/adding-a-recommendation.md`](../adding-a-recommendation.md) governs any user-facing claim and its stale-data, suppression, evidence, and fix-validity tests.

### 3. Independent serial work

Do not infer independence merely because two calls are adjacent or share a tool name. A later action is eligible only when the versioned action taxonomy and retained arguments show that it does not consume the earlier result, mutate the same resource, require ordering, or depend on a shared unsafe side effect. When certainty is unavailable, emit `unproven`, not an opportunity.

For an eligible group, calculate:

- serial baseline as the union of its observed correlated call/result intervals;
- parallel lower bound from the group's critical path rather than the sum of branch durations;
- potential `max(0, serialBaselineMs - criticalPathMs)`;
- action, argument, dependency, and concurrency provenance; and
- token/cost and failure-rate countermetrics, since parallel fan-out can increase both.

The existing [`serial-tool-gap.ts`](../../src/lib/detectors/speed/serial-tool-gap.ts) already contains a conservative argument/result dependency gate. The server's slim timeline currently omits enough command/result detail that the gate cannot prove independence there, while [`time-motion.ts`](../../src/lib/detectors/speed/time-motion.ts) reports raw adjacent gaps. The portable implementation should preserve the strict gate and supply the required normalized evidence; it must not relax the gate to make the detector fire.

## Shared clock ledger

Every core experiment writes the same four clock families. They must not be collapsed into a single “time saved” field.

| Measure | Definition | Claim it supports | Claim it does not support |
|---|---|---|---|
| `taskCompletionWallMs` | Objective start to deterministic acceptance gate | Primary end-to-end speed outcome | Active model/tool time in isolation |
| `activeTurnWallMs` | Native turn durations, combined by union/critical path when branches overlap | Where harness-active wall time moved | Human availability or provider TTFT |
| `toolRoundTripMs` | Timestamped correlated call-to-result elapsed time | Round trips removed or shortened | True execution/CPU time |
| `humanBlockedMs` | Foreground or forced-reengagement intervals during which independently useful interaction could not continue | Conversational availability regained | Automatic reduction in task completion time |

The ledger also records `avoidableRoundTrips`, output/input/cached-input tokens, cost when a versioned source exists, retry/failure count, quality score, rework, and harness runway. Those are countermetrics or explanatory facts, not alternate clocks.

Accounting rules:

1. **End-to-end wins.** Rank a causal speed result by `taskCompletionWallMs`; use the other clocks to explain it. An availability-focused experiment may instead declare `humanBlockedMs` primary, but its verdict must be labelled availability rather than task speed.
2. **Union overlapping intervals.** Never sum concurrent branches, nested agents, tool round trips, and their containing turn as though each were separate elapsed time.
3. **One ownership key per avoidable interval.** A repeated failed foreground call can match several detectors; a versioned precedence rule assigns its clock to one family and reports the other labels as facets.
4. **Separate ceiling, lower bound, and realized effect.** Observational clocks are opportunity ceilings or conservative lower bounds. Only a controlled comparison yields realized reclaimed minutes.
5. **Keep missing distinct from zero.** Unsupported, disabled, stale, or incomplete clocks remain explicit capability states, following the portable signal inventory.
6. **Retain denominators.** Every aggregate carries session/task count, eligible-event count, covered-event count, window, harness/source, detector version, and exclusions.

This implements the clock-only speed boundary in [ADR 0006](../adr/0006-speed-domain-the-clock-hard-lever.md), the proof ladder and premise gate in [ADR 0017](../adr/0017-proof-tier-ladder-and-premise-gate.md), and the auditable adoption/impact posture in [ADR 0005](../adr/0005-recs-adoption-measurable-impact.md).

## Causal experiment axes

All three axes use paired or blocked/cohort runs within one selected harness at a time. They hold the workload, repository state, model/configuration, acceptance gate, and safety policy constant; interleave arms; use identical warmups; and either isolate cache lineages or disable caching where supported. These controls follow [`docs/experiment-methodology.md`](../experiment-methodology.md). Cross-harness evidence remains per-harness and is combined only under #2596's applicability rules.

### Axis A: `background-first`

**Question:** When a workload contains a long action plus independently useful follow-on work, does asynchronous dispatch and self-resume reduce human-blocked time or task completion without increasing failures or rework?

- Control: run the long action synchronously before continuing.
- Treatment: dispatch the same action asynchronously, make independent progress, then join once at the first true dependency.
- Required capabilities: correlated actions, asynchronous dispatch, self-resume/join, native turn wall time, and deterministic objective gate.
- Primary outcome: `humanBlockedMs` for an availability trial, or `taskCompletionWallMs` for a task-speed trial; never switch the primary outcome after seeing results.
- Countermetrics: objective pass, rework, failed joins, token/cost/runway, and peak concurrency.

The repository already has a `background-first` evaluator axis, but the inspected experiment snapshot had one treatment observation and no comparison observations, so its verdict was inconclusive. That is premise evidence, not causal proof.

### Axis B: `diagnose-before-reretry`

**Question:** After a deterministic tool failure, does one diagnosis/strategy-change step beat immediate semantically equivalent retries?

- Control: current/default recovery behavior.
- Treatment: after the first matching failure, inspect the root error and require a material input, tool, or strategy change before another attempt.
- Required capabilities: correlated action/result, error classification, native turn wall time, action equivalence, and deterministic objective gate.
- Primary outcome: `taskCompletionWallMs`.
- Secondary outcomes: repeated-error `toolRoundTripMs`, failed attempts, time to first material strategy change, tokens/cost/runway, and final quality.

Use seeded, safe, deterministic failures or naturally recurring error classes with matched cohorts. Do not deliberately cause destructive errors, bypass safety checks, or treat the absence of retries as success when the objective was abandoned.

### Axis C: `batch-independent-work`

**Question:** For a pre-certified independent work set, does batch/parallel dispatch reduce the critical path at equivalent quality and resource use?

- Control: execute the certified actions sequentially.
- Treatment: dispatch the same actions concurrently up to a declared cap, then join.
- Required capabilities: versioned action taxonomy, dependency certification, parallel dispatch, correlated results, native turn wall time, and deterministic objective gate.
- Primary outcome: `taskCompletionWallMs`.
- Secondary outcomes: eligible serial clock, realized critical-path reduction, time to first useful action, failures/retries, output completeness, tokens/cost/runway, and peak concurrency.

Provider guidance supports the mechanism without proving this product's effect: OpenAI recommends reducing requests and parallelizing independent steps in its [latency optimization guide](https://developers.openai.com/api/docs/guides/latency-optimization), while both [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) and [Claude Code subagents](https://code.claude.com/docs/en/sub-agents) support parallel independent work and warn about added cost, startup, or conflict risk. Those warnings are why concurrency and quality remain countermetrics rather than assumed wins.

## Why the fourth and fifth candidates are not core

### Output and context right-sizing

The local token premise is strong: duplicate and oversized payloads are common and expensive to carry. The speed premise is weaker. OpenAI's official guide says cutting output tokens usually moves latency much more directly, while cutting input tokens by 50% often improves latency only about 1–5% unless the context is unusually large. Therefore:

- record payload bytes/tokens on every core experiment;
- narrow obviously wasteful tool output as normal hygiene;
- do not convert reclaimed input/cache tokens into wall-clock minutes; and
- promote a dedicated `payload-latency` axis only after the ledger shows a substantial context-size/turn-time slope or a generated-output cohort.

### Fast modes and model/effort routing

Both products expose speed-oriented modes, but they are opt-in commercial capabilities with different availability, semantics, quality effects, and prices. [Codex fast mode](https://learn.chatgpt.com/docs/agent-configuration/speed) and [Claude Code fast mode](https://code.claude.com/docs/en/fast-mode) cannot be treated as equivalent arms or assigned one shared multiplier. A future `execution-tier` experiment should run within each harness, record exact capability and price provenance, enforce a cost/runway ceiling, and require quality non-inferiority. Until then, model-working time is merely the maximum exposed clock, not expected reclaim.

## Explicit long-tail dispositions

| Candidate | Decision | Reason |
|---|---|---|
| Generic idle/AFK time | **Reject as reclaimable agent speed** | The current 19h 43m idle/AFK bucket is mostly a human-presence boundary. It may inform scheduling, but cannot be booked as avoidable compute or task time. |
| Cross-harness TTFT/model API latency | **Defer** | Codex has native per-turn TTFT; Claude's optional first-chunk/debug and cumulative API-time facts are not equivalent. Require certified adapter capability first. |
| Hook overhead | **Reject from the portable core** | Claude's transcript evidence is sparse and configuration can become stale; Codex has no established equivalent. [`docs/hook-timing-spike.md`](../hook-timing-spike.md) found no durable per-tool hook timing in ordinary transcripts. |
| Cache-cold turns/cache creation | **Defer** | Cache creation/read fields and policies differ by provider. Keep native facts as countermetrics; do not define one portable causal lever yet. |
| Permission/approval wait via optional telemetry | **Defer** | Potentially useful, but not available with common local semantics today. Add only after opt-in telemetry prices a material premise. |
| Slow-command hotspot, timeout waste, workflow straggler, spinner stall, directory scan, and MCP latency | **Fold into the core ledger first** | These are action classes or symptoms, not separate accounting systems. Let foreground, retry, and serial-work detectors rank their measured clocks before adding detectors. |
| Time to first edit/action | **Keep as a diagnostic metric** | Portable only through a versioned action taxonomy; it describes where delay occurs but has no unique lever beyond round-trip removal and payload discipline. |
| Provider-specific proprietary tools | **Scope to the origin harness** | Results may be useful but are not portable unless another adapter certifies the same capability and semantics. |
| Context compaction instructions | **Keep as hygiene/countermetric** | Current pressure counts are credible, but neither compaction cost nor task-time effect is portable and priced. |

This reconciles rather than duplicates the broader candidate list in [#2528](https://github.com/shpwrck/claude-history-dashboard/issues/2528), the serial-tool work in [#1753](https://github.com/shpwrck/claude-history-dashboard/issues/1753), and the critic-gap evidence program in [#1911](https://github.com/shpwrck/claude-history-dashboard/issues/1911). Separate tickets should be created only when the shared ledger prices a long-tail premise or an adapter gains a newly certified capability.

## Decision handed to the next map ticket

[#2594](https://github.com/shpwrck/claude-history-dashboard/issues/2594) should choose a first proof portfolio from these three axes, not reopen the candidate list:

- use `background-first` as the high-minute availability proof;
- use `diagnose-before-reretry` as the high-prevalence failure-recovery proof;
- use `batch-independent-work` as the direct critical-path proof once the independence evidence is available;
- require equivalent objective quality and report token/cost/runway for every verdict;
- keep per-harness results authoritative and treat cross-harness replication under #2596; and
- publish measured ceilings and realized causal effects as different fields.

The recommended implementation order is ledger → foreground/block normalization → retry clock → independence evidence → three paired axes. This order makes every later candidate compete on the same clock instead of creating a detector-specific savings vocabulary.

## Reproduction and sources

The local snapshot claims were reproduced from the dashboard's local-only APIs:

```bash
curl -fsS http://127.0.0.1:5173/api/dataset.json \
  | jq '{generatedAt, windowStart, windowEnd, harness, sourceId,
      timelines: (.timelines | length),
      runtimeEvents: (.runtimeEvents | length)}'

curl -fsS http://127.0.0.1:5173/api/recommendations.json \
  | jq '.[] | select(.id == "workflow.conversational-availability"
      or .id == "reliability.passive-wait-stall"
      or .id == "reliability.retry-prefix-rewaste"
      or .id == "reliability.retry-storms"
      or .id == "speed.time-motion"
      or .id == "context.reclaim-potential"
      or .id == "context.tool-call-right-sizing"
      or .id == "context.compaction-hot-sessions"
      or .id == "context.repeated-compactions"
      or .id == "context.over-window")
    | {id, detail, affected, provenance}'

curl -fsS http://127.0.0.1:5173/api/experiments.json \
  | jq '.axes[] | select(.key == "background-first")'
```

Primary repository sources:

- Portable signal semantics and inspected artifact fields: [`2026-07-portable-signal-inventory.md`](./2026-07-portable-signal-inventory.md).
- Detector source: [`src/lib/detectors/speed`](../../src/lib/detectors/speed), [`src/lib/detectors/workflow`](../../src/lib/detectors/workflow), and [`src/lib/detectors/reliability`](../../src/lib/detectors/reliability).
- Experimental controls: [`docs/experiment-methodology.md`](../experiment-methodology.md).
- Speed ownership and proof policy: [ADR 0006](../adr/0006-speed-domain-the-clock-hard-lever.md), [ADR 0017](../adr/0017-proof-tier-ladder-and-premise-gate.md), and [ADR 0005](../adr/0005-recs-adoption-measurable-impact.md).
- Existing backlog reconciliation: [#2528](https://github.com/shpwrck/claude-history-dashboard/issues/2528), [#1753](https://github.com/shpwrck/claude-history-dashboard/issues/1753), [#1911](https://github.com/shpwrck/claude-history-dashboard/issues/1911), and the [#2590–#2599 wayfinder sequence](https://github.com/shpwrck/claude-history-dashboard/issues/2589).

The audit's central constraint is simple: a portable mechanism may be plausible before it is proven, but a minute is not reclaimed until a controlled run moves a non-overlapping clock at equivalent quality.
