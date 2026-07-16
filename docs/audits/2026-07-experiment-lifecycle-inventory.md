# Experiment lifecycle inventory

Date: 2026-07-13
Question: [Inventory the experiment lifecycle and reconcile its existing issue graph](https://github.com/shpwrck/claude-history-dashboard/issues/2599)

## Executive answer

The experiment system is not a harness-independent runtime today. It is three coupled products:

1. This repository owns experiment specifications and result schemas, one Claude-only proof orchestrator, artifact ingestion, evaluation, APIs, recommendations, and UI.
2. `~/.claude` owns the executable shadow engine: axes, corpus selection, race/replay setup, the Claude worker launch, sandbox, budget, kill switch, judge/verdict logic, and mutable ledgers.
3. `~/.agents/skills` owns the canonical enrollment, race, and replay UX. Claude Code and Codex see the same directories through symlinks, but shared installation is not functional parity.

No requested end-to-end flow currently meets strict single-harness independence:

- Enrollment is currently broken from **both** harness skill links: Node resolves the symlink to `~/.agents/skills/experiment-enroll/scripts/enroll.mjs`, whose relative import targets nonexistent `~/.agents/experiments/registry.mjs` (`~/.agents/skills/experiment-enroll/scripts/enroll.mjs:5-21`). The Claude SessionStart announcement is wired, but Codex has no equivalent hook (`~/.claude/settings.json:29-48`; `~/.codex/config.toml:1-69`).
- Race and replay are Claude execution flows exposed to both harnesses. Their workers are unconditionally `claude -p`, their model and pricing assumptions are Claude-specific, their state is under `~/.claude`, and their skill-driven judge step names Claude's `Agent` tool (`~/.claude/shadow-calls/lib/sandbox.mjs:240-316`; `~/.agents/skills/race/SKILL.md:75-87`; `~/.agents/skills/replay/SKILL.md:66-78`). On this host both also fail closed before setup because the required sandbox runtime is absent (`~/.claude/shadow-calls/lib/sandbox.mjs:149-178`).
- `npm run proof:batch` is a real orchestrator, but imports its jail and kill switch from `~/.claude`, writes `CLAUDE.md`, parses Claude CLI result shapes, and launches through the same Claude-only worker builder (`scripts/proof-batch.mjs:1-24,61-68,78-85,206-246,316-324`). It is currently gated by the same missing jail.
- `npm run eval:model-batch` works from either shell only as a **spec generator**. Its implementation explicitly does not execute a batch or call a live API; completed result artifacts are expected from an external meta runner (`scripts/model-eval-batch.mjs:1-32,78-83`; `src/lib/model-eval-batch.ts:283-303`; `REFERENCES.md:42`). There is no in-repo Claude or Codex model-eval executor entry point.

The fastest route is therefore to treat [Package the experiment engine behind a harness-neutral runtime boundary](https://github.com/shpwrck/claude-history-dashboard/issues/2582) as the implementation epic for the wayfinder's decisions, not create another runtime epic. Its package/core/adapter diagnosis is correct, but its historical migration and compatibility requirements conflict with the map's accepted clean break and should be removed. The first build must package the deterministic core, define one adapter contract, and make worker launch and judge execution adapter-owned. Claude and Codex adapters then migrate enrollment, race/replay, proof, and model-eval onto that same core.

Cross-harness history ingest is a visibility dependency, not the execution keystone. [Harness registry seam](https://github.com/shpwrck/claude-history-dashboard/issues/2520) then [Ingest Codex history](https://github.com/shpwrck/claude-history-dashboard/issues/1756) are required to compare portable evidence and speed outcomes in the dashboard. They need not block core runtime construction. Likewise, the shared `session-usage` skill already contains separate Claude and Codex runway readers, so the runtime can reuse or extract that seam instead of waiting for dashboard cost ingest (`~/.agents/skills/session-usage/scripts/check-usage.mjs:24-27,75-111,128-188`).

## Responsibility and seam matrix

| Responsibility | Current owner and primary source | Harness coupling | Runtime disposition |
|---|---|---|---|
| Axis registry and treatment contracts | Shadow axes: `~/.claude/shadow-calls/lib/axes.mjs`; interactive enrollment axis: `~/.claude/experiments/registry.mjs:1-74` | Claude models, tools, and home paths are embedded; enrollment is a separate registry | Move to one versioned Experiment Definition registry; adapters declare capabilities for treatments |
| Enrollment UX | `~/.agents/skills/experiment-enroll/SKILL.md:17-68` | Calls Claude-oriented registry/ledger and `AskUserQuestion`; text says “Claude Code session” | Keep as a thin shared skill calling runtime commands; selected adapter supplies session identity and guidance injection |
| Enrollment persistence | `~/.agents/skills/experiment-enroll/scripts/enroll.mjs:17-22,108-149`; `~/.claude/experiments/enrollment.jsonl` | Broken symlink-relative import; bare, non-namespaced Claude session ID | Runtime-owned versioned run/assignment record with `{harness, sessionId}` identity and configurable state root |
| Lifecycle guidance injection | Claude hook `~/.claude/hooks/experiment-enroll-offer.mjs:1-29,79-132`, wired at `~/.claude/settings.json:29-48` | Claude SessionStart JSON and `additionalContext`; no Codex hook configured | Adapter capability: inject/restate guidance or fail visibly if unsupported |
| Race orchestration | Shared skill `~/.agents/skills/race/SKILL.md:16-119`; engine `~/.claude/shadow-calls/lib/race.mjs:1-35,69-183,188-240` | Skill orchestrates Claude-style background workers and Agent-tool judges; engine stamps `CLAUDE_CODE_SESSION_ID` at line 218 | Core owns arm plan/finalization; adapter owns concurrent worker and judge execution; runtime owns provenance |
| Replay corpus and orchestration | Shared skill `~/.agents/skills/replay/SKILL.md:17-97`; `~/.claude/shadow-calls/lib/replay.mjs` and `driver.mjs` | Reads `~/.claude` history and launches Claude workers | Adapter discovers and normalizes history; core performs eligibility, dedupe, pairing, and finalization |
| Worker launch | `~/.claude/shadow-calls/lib/sandbox.mjs:240-316` | Hard-coded `api.anthropic.com`, temporary Claude home/credentials, and `claude -p` stream JSON | Required adapter method returning normalized run output; no core CLI/home assumptions |
| Isolation | `~/.claude/shadow-calls/lib/sandbox.mjs:67-147,149-178` | Uses Anthropic's `srt`, though the policy concepts are portable | Preserve fail-closed policy and normalized capability; adapter may compile it to a suitable enforcer |
| Budget and kill authority | `~/.claude/shadow-calls/lib/budget.mjs:1-30,32-73,83-128`; `killswitch.mjs:1-47` | One Claude usage endpoint, one `~/.claude/shadow-calls` state root | Core policy and precedence; adapter supplies normalized runway; runtime state root owns counters/sentinel |
| Runway reads | Shared `session-usage` skill (`~/.agents/skills/session-usage/SKILL.md:18-24,67-76`; script lines 24-27,75-111,128-188) | Already branches between Anthropic headers and local Codex rate-limit events | Extract as the initial pair of runway adapters; do not depend on `logs_2.sqlite` cost ingest |
| Judge rubric and verdict order | `~/.claude/shadow-calls/lib/judge.mjs:1-18,596-637`; prompt execution is delegated by race/replay skills | Deterministic resolution is portable; actual judge dispatch is harness-tool-specific | Core owns schemas, objective-first order, and reconciliation; adapter executes structured blind passes |
| Shadow ledger/state | `~/.claude/shadow-calls/lib/ledger.mjs:1-30,99-248`; schema `~/.claude/shadow-calls/SCHEMA.md` | Claude home root and overloaded experiment `source` taxonomy | Replace with versioned Experiment Run/Verdict records carrying origin harness separately from experiment kind |
| Proof execution | `scripts/proof-batch.mjs:1-24,61-68,206-246,316-324,410-445,645-755` | In-repo coordinator, but Claude worker/jail/instruction/result assumptions | Migrate as a runtime experiment type reusing the same adapter, safeguards, objective gates, and records |
| Model-eval authoring | `scripts/model-eval-batch.mjs:1-32,78-138`; `src/lib/model-eval-batch.ts:283-303` | Model registry is Claude-oriented, but spec construction is otherwise pure | Generalize schema model/capability identity; retain pure authoring in core |
| Model-eval result contract | `src/lib/model-eval-result.ts:1-16,25-40,59-137` | Mostly portable; current evidence vocabulary assumes shadow/replay | Reconcile with Experiment Run/Verdict rather than build a parallel receipt family |
| Dashboard shadow/proof ingest | `REFERENCES.md:25,42`; `src/lib/parse-shadow-calls.ts:298-314,756-830`; `src/lib/shadow-experiments.ts:1-18` | Reads Claude paths and infers source; external proof/model-eval cells are merged after the fact | Consumer of new versioned records; preserve explicit origin-harness provenance |
| Enrollment evaluation API | `src/lib/experiments/enrollment-ledger.ts:1-12,19-77`; `src/lib/experiments/evaluator.ts:161-182`; `scripts/server.mjs:319-325,8969-9010` | Bare Claude session join; separate from shadow verdict path | Read the shared run schema and namespaced identity; evaluator remains a consumer |
| Result presentation | `/api/experiments.json`, `/api/shadow-experiments.json`, Shadow Calls, Model Evals (`docs/openapi/openapi.yaml:549-605`; `src/components/ShadowExperimentLog.tsx:11-37`; `src/components/ModelEvalsPf.tsx:7-18`) | Multiple endpoint/artifact shapes | Can remain separate views initially, but they should consume one record vocabulary |

## Entry-point status on 2026-07-13

“Works” below means the requested experiment can complete without invoking the other harness. Mere skill discovery or spec generation does not qualify.

| Entry point | Claude Code | Codex | Evidence and gap |
|---|---|---|---|
| `experiment-enroll` | **Broken now** | **Broken now** | Both skill links resolve to the same canonical directory, but `node …/enroll.mjs --list` fails with `ERR_MODULE_NOT_FOUND` for `~/.agents/experiments/registry.mjs`. Claude alone has the SessionStart offer hook; Codex does not. Symlink targets: `~/.claude/skills/{experiment-enroll,race,replay}` and `~/.codex/skills/{…}` all resolve under `~/.agents/skills`. |
| `race` | **Unavailable on this host; Claude-only by design** | **Not independent** | `race.mjs gate` fails because `@anthropic-ai/sandbox-runtime` is missing. If installed, both workers still execute `claude -p`; judge dispatch instructions require Claude's Agent tool (`sandbox.mjs:315-316`; race skill lines 75-87). |
| `replay` | **Unavailable on this host; Claude-only by design** | **Not independent** | `replay.mjs setup` exits 3 on the missing jail. It selects from `~/.claude` history, launches `claude -p`, and directs Agent-tool judging (replay skill lines 19-29, 31-44, 66-88). |
| `npm run proof:batch` | **Unavailable on this host; Claude-only by design** | **Not independent** | A one-pair dry run exits 4 at the fail-closed jail gate. The orchestrator imports `~/.claude` controls and uses the Claude worker output/CLI contract (`scripts/proof-batch.mjs:61-68,137-153,206-246,435-445`). |
| `npm run eval:model-batch` | **Spec authoring works; no run** | **Spec authoring works; no run** | A one-task `--print` invocation succeeds. The implementation writes/prints a batch spec, and explicitly says it performs no execution or API call (`scripts/model-eval-batch.mjs:78-83`; `src/lib/model-eval-batch.ts:302-303`). |
| Dashboard experiment readers | **Work for existing Claude artifacts** | **No Codex execution artifacts** | Shadow, proof, enrollment, and model-eval consumers exist, but all conventional live roots are under `~/.claude` (`REFERENCES.md:25,42`; `scripts/server.mjs:319-325`). |
| `session-usage` runway probe | **Implemented; network read** | **Works locally** | Claude mode reads first-party rate-limit headers; Codex mode reads local JSONL events. Forced Codex mode returned a valid pair of windows during this audit (`~/.agents/skills/session-usage/scripts/check-usage.mjs:75-111,128-188`). |

## Issue reconciliation

| Existing issue or family | Classification | Reconciliation decision |
|---|---|---|
| [Package the experiment engine behind a harness-neutral runtime boundary](https://github.com/shpwrck/claude-history-dashboard/issues/2582) | **Critical path; major overlap** | Use as the sole implementation epic. Adopt package/core/external-state/adapter direction. Supersede its historical-ledger migration and compatibility-shim acceptance because the wayfinder explicitly allows a clean start. Decompose only after schema and adapter decisions close. |
| [Define the Experiment Definition, Run, and Verdict schema](https://github.com/shpwrck/claude-history-dashboard/issues/2592) and [Define the runtime boundary and strict single-harness adapter contract](https://github.com/shpwrck/claude-history-dashboard/issues/2591) | **Critical blockers** | These resolve the two decisions that must precede decomposition of the runtime epic. Keep separate: record/domain contract vs execution/integration contract. |
| [Harness registry seam](https://github.com/shpwrck/claude-history-dashboard/issues/2520) → [Ingest Codex history](https://github.com/shpwrck/claude-history-dashboard/issues/1756) | **Critical for shared evidence; parallel to runtime core** | Reuse the ingestion registry for dashboard read-side visibility. Do not make the execution adapter depend on parser internals; align capability vocabulary and namespaced harness identity. |
| [Codex token/cost/rate-limit ingest](https://github.com/shpwrck/claude-history-dashboard/issues/2045) | **Partial overlap, not initial blocker** | Needed for historical cost/usage views, but auto-runway selection can start from the already-working local rate-limit reader. Revisit if Experiment Verdict requires per-run Codex cost unavailable from adapter output. |
| [Recommendation engine: critic-gap evidence & ground-truth signals](https://github.com/shpwrck/claude-history-dashboard/issues/1911) | **Umbrella overlap** | Only its harness-ingest branch is on this path. Git outcome, reclaim, steering, and coverage children remain independent evidence work, not experiment-driver blockers. |
| [Speed axis expansion](https://github.com/shpwrck/claude-history-dashboard/issues/2528) | **Input/overlap, not yet an epic** | Treat its detector list as the candidate pool for the wayfinder's 80/20 ranking. Do not promote its Claude OTel keystone wholesale: portable transcript/timeline signals come first; proprietary OTel signals are harness-specific adapters/deepening. |
| [Prospective candidate evals](https://github.com/shpwrck/claude-history-dashboard/issues/2025), especially [Receipt schema + separation logic](https://github.com/shpwrck/claude-history-dashboard/issues/2026), [Clean A/B execution](https://github.com/shpwrck/claude-history-dashboard/issues/2027), [Judge parity floor](https://github.com/shpwrck/claude-history-dashboard/issues/2029), and [Eval budget/runner](https://github.com/shpwrck/claude-history-dashboard/issues/2032) | **Substantial duplicate/consumer overlap** | Preserve the prospective-candidate product behavior, cassette discipline, and objective spine. Do not build its second Claude-only runner/receipt/budget stack. Rebase its open execution children onto the shared runtime after the runtime contract lands; the closed receipt is prior art, not necessarily the new schema. |
| [Make live shadows fire reliably](https://github.com/shpwrck/claude-history-dashboard/issues/2197), [usage cache](https://github.com/shpwrck/claude-history-dashboard/issues/2165), [Stop-hook trigger](https://github.com/shpwrck/claude-history-dashboard/issues/2166) | **Deferred overlap; trigger child partly superseded** | Reliable automatic firing belongs after capability, budget, and selection. Keep the usage-cache performance fix if independently valuable. Replace the Claude Stop-hook-specific solution with adapter lifecycle triggers; unsupported automatic triggering must be explicit. |
| [Cross-harness rec delivery adapter](https://github.com/shpwrck/claude-history-dashboard/issues/2210) | **Adjacent overlap** | General recommendation delivery is out of map scope. Reuse its harness guidance-injection knowledge only for enrollment/treatment contracts; do not block runtime core on full rec delivery. |
| [Down-modelling confidence loop](https://github.com/shpwrck/claude-history-dashboard/issues/2138), [Per-class causal verdict via replay](https://github.com/shpwrck/claude-history-dashboard/issues/2143), and [Tier B local-model replay/shadow](https://github.com/shpwrck/claude-history-dashboard/issues/2317) | **Consumers, not blockers** | These become portable experiment definitions once the runtime exists. Do not fold their product-specific acceptance into the runtime critical path. |
| [Document the experiment enrollment ledger](https://github.com/shpwrck/claude-history-dashboard/issues/2583) | **Superseded scope for the new runtime; valid legacy docs debt** | The current omission is real (`REFERENCES.md` documents shadow and model-eval artifacts but not enrollment). Keep only if documenting the legacy reader is still useful; new-schema documentation belongs with the runtime contract. |
| [Codex as second fully-supported harness](https://github.com/shpwrck/claude-history-dashboard/issues/1260), [experiments as dispatched pods](https://github.com/shpwrck/claude-history-dashboard/issues/1257), and [dynamic operator dispatch](https://github.com/shpwrck/claude-history-dashboard/issues/1262) under [Vendor-neutral agent-ops substrate](https://github.com/shpwrck/claude-history-dashboard/issues/1247) | **Unrelated/out of scope** | These are Kubernetes/hosted dispatch and are intentionally frozen in Icebox. Strict local single-harness independence must not depend on them. The Codex execution-adapter slice should move conceptually to the runtime epic, leaving operator bake/dispatch in the Icebox issue. |
| [Trial external execution substrates](https://github.com/shpwrck/claude-history-dashboard/issues/2198) and sandbox candidates | **Optional future substitution** | The runtime needs an isolation capability and fail-closed contract, not a substrate choice. Existing `srt` policy can be the Claude baseline; trials must not block the adapter seam. |
| [Recs-engine auditability](https://github.com/shpwrck/claude-history-dashboard/issues/2561), including the false hook-overhead finding | **Related quality work, not driver independence** | Speed portfolio decisions should heed the misfire, but fixing individual recommendation defects is not part of the experiment runtime path. |

## Candidate critical path

1. **Close the domain and adapter decisions in parallel.** Resolve the Experiment Definition/Run/Verdict schema and the strict adapter contract. Required adapter capabilities should cover session identity, guidance injection, historical task discovery, worker launch, structured judge execution, isolation, usage/runway, normalized tool facts, and lifecycle triggers.
2. **Re-scope and decompose the existing runtime epic.** Remove migration/legacy compatibility, retain safety invariants, and create slices for packaged deterministic core, configurable state, adapter test kit, Claude adapter, Codex adapter, and thin skill commands.
3. **Land packaged core plus a fake adapter first.** Move registry, treatment selection, budget/kill/consent precedence, pairing, objective-first verdict resolution, and record writing behind public commands. Contract tests must prove no core import of harness homes, CLI names, or tool names.
4. **Land Claude and Codex execution adapters before migrating flows.** Each must independently run workers and both blind judge passes, report capabilities and runway, enforce isolation or fail closed, and emit normalized run output. This is the strict-independence gate.
5. **Migrate representative flows in increasing breadth:** enrollment (identity + guidance), race (current task + merge gate), replay (history adapter), proof (objective fixture gates), then model-eval (turn current spec-only producer into an executable definition). Keep skills as thin front doors.
6. **Converge visibility in parallel:** land the dashboard harness registry and Codex session ingest, then read the new shared run/verdict records. Cost/rate-limit ingest is a follow-on unless adapter output cannot supply required per-run economics.
7. **Prototype parity and only then trigger automatically.** The wayfinder prototype should prove the same portable definition under Claude and Codex without hidden cross-harness worker/judge calls. After that, reframe live-shadow heartbeat work as adapter lifecycle triggers.
8. **Select and execute the 80/20 speed portfolio.** Rank portable, already-observable wall-clock signals first; express winning levers as portable Experiment Definitions. Treat Claude OTel-only findings as harness-specific evidence, not as the shared speed keystone.

The key dependency split is deliberate: packaged runtime construction and dashboard ingestion can proceed concurrently. They meet at the versioned run/evidence contract, not by sharing parser or home-directory implementation details.

## Audit commands and observed results

All commands were non-mutating except creation of this research asset.

```text
node ~/.claude/skills/experiment-enroll/scripts/enroll.mjs --list
node ~/.codex/skills/experiment-enroll/scripts/enroll.mjs --list
  -> both exit 1: ERR_MODULE_NOT_FOUND ~/.agents/experiments/registry.mjs

node ~/.claude/shadow-calls/lib/race.mjs gate
  -> exit 1: sandbox required; @anthropic-ai/sandbox-runtime missing

node ~/.claude/shadow-calls/lib/replay.mjs setup --budget=0.01
  -> exit 3: same fail-closed sandbox gate

npm run proof:batch -- --dry-run --limit 1 --k 1 --max-budget-usd 0.01 --total-budget-usd 0.02
  -> exit 4: not yet provable; jail unavailable

npm run eval:model-batch -- --candidate=claude-haiku-4-5-20251001 --corpus=curated-fixtures --limit=1 --print
  -> exit 0: prints a model-eval-batch spec; runs no model

node ~/.agents/skills/session-usage/scripts/check-usage.mjs --source codex --json
  -> exit 0: returns normalized 5-hour and 7-day Codex windows
```
