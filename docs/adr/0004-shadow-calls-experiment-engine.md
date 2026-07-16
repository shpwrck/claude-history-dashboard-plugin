# ADR 0004 — Shadow calls: controlled experiments that feed the recommendation engine

- **Status:** Accepted (implemented across epic #513; packaging amendment tracked by #2582)
- **Date:** 2026-06-03
- **Amended:** 2026-07-13
- **Issue:** #513 (children #514–#523, kill switch #527)
- **Packaging issue:** #2582
- **Builds on:** ADR 0002 (the recommendation engine this feeds)

## Context

The recommendation engine (ADR 0002) is a **post-hoc reader**: it computes signals over
retained `~/.claude` history and emits hand-authored rules. It can tell you *what
happened* but never *what would have happened a different way* — it has no
counterfactual. "Would Haiku have been just as good here?" / "Would `/diagnose` have
solved this faster?" are unanswerable from history alone.

Shadow calls add that counterfactual by running real work **two ways** and recording which
won, so recommendations can be grounded in the user's own controlled experiments instead of
only in observational data.

### Non-goals (load-bearing — do not regress)

- **A passive live shadow never alters Main.** The user's actual result must be
  byte-identical to no-shadow behaviour; that shadow is a pure side-channel. `/race` is a
  separate, explicitly invoked foreground experiment whose selected winner may change the
  delivered result.
- **Automatic analysis stays local.** With experiment execution disabled, dashboard ingest
  and recommendations make zero request-time network calls (ADR 0002); experiment data
  arrives as a parsed file, exactly like history. Explicitly enabled workers and judges may
  call a model through their harness, governed by consent, budget, kill, and jail policy.
- **No uncontrolled spend.** Experiments are gated by a budget authority and stoppable by a
  kill switch (#527).
- **No unjailed worker or ambient credential access.** A worker runs inside the required
  fail-closed jail or is skipped. The jail confines writes, pins allowed egress, and denies
  the real harness homes, credentials, and config roots behind a seeded temporary home.
- **Installation is not consent.** Installing the dashboard/runtime leaves experiment
  execution off and makes zero external calls. A user must explicitly invoke or enable an
  experiment entry point; recurring execution is a separate opt-in.

## Decision

For the passive shadow counterfactual, run substantial work twice — **Main** (exactly
today's behaviour, the delivered answer) and one **Shadow** variation drawn from a rotating
catalogue of supported harness features — judge both, append the verdict to a ledger, and
aggregate it into recommendations. Foreground race and batch proof/model-evaluation flows
share the packaged runtime and record contracts without inheriting the passive-delivery
semantics.

### 1. Core shadow sources, broader experiment record family

- **Live shadow** — fired *after* the Main answer is delivered, as a background worktree
  worker that redoes the same task with one axis varied. Cost-additive, so gated *down*.
- **Replay** — re-runs *past* tasks from a harness's history when the window is idle.
  Converts otherwise-wasted, already-paid-for capacity into experiments, so gated *up* (the
  inverse).

The original implementation appends `mode`-tagged records to
`~/.claude/shadow-calls/ledger.jsonl`. The packaged schema retains those records and names
their provenance **experiment source** (`replay`, `race-live`, `proof`, and so on), distinct
from the coding **harness** that executed the work.

`/race` is an explicit foreground producer that races a current goal and may apply the
winning result. Proof and model evaluation are explicit batch producers. They use the same
runtime controls and evidence contracts, but are not passive live-shadow triggers.

### 2. Package code and contracts; externalize mutable state

The original implementation put executable engine code under
`~/.claude/shadow-calls/` and left this repository with only the consumer. That correctly
kept user state outside the product repository and recognized that session triggering is
harness behaviour. It did not, however, create a stable boundary: the engine, enrollment
registry, skills, proof runner, model-evaluation contracts, and consumers grew across three
independently versioned repositories. Entry points now rely on home-directory layout and
symlink-sensitive relative imports, while core execution still assumes Claude paths,
artifacts, tools, instructions, hooks, environment variables, and CLI behaviour.

The amended boundary is:

- The **experiment runtime** is versioned and released with this repository. It owns the
  authored engine code and contracts: registry and axes, treatment selection, corpus and
  run orchestration, sandbox policy, budget/consent/kill decisions, judging and verdicts,
  record schemas and migrations, and stable CLI/API entry points. Race, replay, enrollment,
  proof, and model evaluation use this one runtime rather than parallel implementations.
- **Experiment state** remains external and user-owned: ledgers, enrollment assignments,
  budget state, kill state, credentials, and other mutable artifacts live under configured
  host data roots. Existing `~/.claude` paths remain readable compatibility locations, not
  source-code ownership boundaries. State and secrets are never committed to this repo.
- A thin **experiment harness adapter** owns every vendor-specific operation. Installed
  skills and lifecycle hooks are UX/integration adapters that invoke stable runtime entry
  points; they do not contain or reach across repositories for engine logic.
- The **dashboard consumer** continues to ingest records locally and turn them into
  evaluation, API, UI, and recommendation evidence. Packaging the producer does not make
  automatic analysis perform network calls.

### 3. One harness adapter seam

The experiment runtime depends on one high-level adapter contract for:

1. namespaced session identity and harness provenance;
2. historical-task discovery plus transcript, usage, tool, and outcome normalization;
3. isolated worker launch and structured judge execution;
4. guidance injection and lifecycle integration; and
5. capability and quota reporting used by axis selection and budget policy.

Core modules must not bypass the adapter to inspect `~/.claude` or `~/.codex`, parse a
vendor transcript, read or mutate vendor instruction files, read a vendor-only environment
variable, or invoke a vendor CLI. An axis such as config scoping may ask the adapter to
transform `CLAUDE.md` or `AGENTS.md` inside a prepared, disposable workspace; it must never
rewrite the user's source or ambient config. Unsupported capabilities are reported and the
affected axis is skipped; the runtime does not silently emulate one harness with another.

Every new record uses `{ harness, sourceId, sessionId }` as its durable session identity.
Backward-compatible readers may accept legacy bare `sessionId` records, but new joins must
not assume session IDs are globally unique. `experimentSource` records how the experiment
was produced and must not be overloaded to mean harness or artifact source.

### 4. Migration and compatibility

Claude is the first compatibility adapter: its packaged path must preserve current axes,
budget and kill precedence, verdicts, and readable evidence before the legacy engine is
removed. Existing shadow and enrollment ledgers remain readable through explicit schema
versions, migrations, or backward-compatible readers. The home-directory engine becomes a
temporary shim and data location with a tested removal criterion, not a permanent second
implementation.

Codex support is a second adapter to the same contract, coordinated with #1260, #1262,
#1756, and #2210. It is not a fork of the experiment engine.

### 5. Axis rotation, not single-variable

One axis per experiment, rotating through the supported harness's feature surface (model,
reasoning effort, prompt formulation, skills, plugins, MCP, subagents, tool selection,
autonomy/mode, context strategy) via a persisted pointer. One axis at a time keeps wins
*attributable*; adapter capability reporting prevents an unsupported axis from being treated
as a loss.

### 6. Judging — objective + LLM-judge, user breaks ties

Deterministic metrics (tokens, wall-time, tool calls, build/test/lint), an objective
deceit/unbacked-green-claim gate, and an independent LLM quality judge. Rubric dimensions
(#536): **correctness** (anchored to what the user *accepted*, not mere plausibility),
**design** (CUPID / KISS / DRY / GRASP; neutral for non-code), **completeness**,
**clarity**, **scopeFit**, and **autonomy** (fewer user prompts/interventions is better).
The judge is a pure tiebreaker. Precedence: **user > gate (build/test failure loses) >
deceit > autonomy > cost > judge > tie**.

Cost is **price-aware** (#536), not raw-token: each run's `costUsd = tokens × blended $/Mtok`
for its model, so a cheaper-tier model that used more tokens can still win on dollars — the
raw-token comparison systematically under-credited cheaper models (caught by the first real
replay, where Haiku used 2.3× the tokens of Opus yet was far cheaper in $).

### 7. Baseline & reproducibility

Replay uses **cold control + variation** (re-run the original approach *and* the variation,
both cold; the recorded run is a third reference), at the task's **base commit** in an
isolated workspace supplied through the adapter (fallback chain base-commit → HEAD →
output-only). Side-effecting tasks (push, PR, deploy, sends, issue mutations) are excluded
by default. Explicit `--admit-side-effecting` replay is allowed only inside the required
jail with cassette/mock-proxy handling that prevents real external mutations.

The execution boundary is fail-closed: every experiment worker is jailed or skipped. The
jail confines writes to prepared paths, pins allowed egress, and read-denies the real
`~/.claude`, `~/.codex`, credential, and config roots while exposing only a seeded temporary
home. A harness adapter may strengthen this policy but cannot bypass it. In particular, a
subscription OAuth credential must never be used to send `~/.claude`-derived content; when
a replay or judge needs that content and no governed eligible credential path exists, the
runtime skips the call.

### 8. Budget authority, consent mode + kill switch

The packaged budget authority remains the single accountant. The Claude compatibility
policy keeps today's thresholds: live skips above 60 % 5h utilisation (cap 3/5h, force the
cheap model axis when tight); replay only runs below 50 % (idle headroom); one combined
weekly cap. Other adapters supply normalized quota/cost facts and an explicit policy; when
the facts required for a safe decision are unavailable, the runtime fails closed. The
**kill switch** (#527) — a runtime command, `SHADOW_CALLS_OFF=1`, or the data-root `OFF`
sentinel (currently `~/.claude/shadow-calls/OFF`) — is consulted first, so one flip stops
all live + replay activity and silences the recs auto-inject.

Layered on top, **consent mode** (`ask` | `notify` | `auto`, default `notify`) governs the
per-run UX for an enabled live-shadow entry point: `notify` announces then proceeds
(killable), `ask` requires approval (and skips when unattended), `auto` is silent. The kill
switch outranks it — when engaged, the firing path never reaches the consent step. Replay
is unattended by nature and governed by explicit enablement, the budget gate, and the kill
switch.

### 9. Replay-aware evidence weighting

The detector weights evidence by trust: **live-confirmed wins → `warning`; replay-only →
`info`** (replay carries cold-start + staleness caveats).

### 10. Discovery — propose new rule classes (#530)

`workflow.shadow-axis-wins` says "adopt axis X". `workflow.uncovered-shadow-axis` asks the
follow-up: is that win pattern already encoded as a rule? It cross-references each strong
shadow win against the catalog (an `AXIS_COVERAGE` intent map) and, for an axis with **no
covering rule**, surfaces a recommendation whose fix is the `gh issue` command to propose a
dedicated detector. That proposal then rides the standing engine-gap feedback loop (#511)
into a backlog issue. This is the deterministic MVP of ADR 0002's discovery pipeline; the
richer LLM-driven, free-form, draft-PR discovery stays out-of-band as documented in #530.

## Consequences

- **Good:** recommendations become grounded in the user's own A/Bs; the cheapest experiment
  (model downshift) is also the most valuable; idle quota is no longer wasted.
- **Good:** the engine, schemas, tests, and consumers ship at compatible versions; a clean
  installation no longer depends on matching source checkouts or symlink layout.
- **Good:** Claude and Codex share experimental semantics while retaining honest,
  capability-gated vendor integration.
- **Cost:** doubles spend on shadowed work — controlled by the budget gate + kill switch.
- **Cost:** the adapter contract and legacy-ledger migration are additional compatibility
  surfaces. Claude parity is a release gate before deleting the old engine.
- **Honest limits:** cold-start fairness (a shadow subagent lacks in-session context — fair
  for atomic tasks, directional for deep flows; axis J probes it) and the counterfactual
  ceiling (we see the shadow's *output*, not where its *approach* would have led N steps
  later). Encoded as evidence weighting, not hidden.
- **State stays external:** packaging code does not relocate private artifacts, credentials,
  mutable ledgers, or kill state into Git.
- **Scheduling is opt-in:** the packaged install never creates or enables a recurring
  schedule. The existing external replay-tick timer is a compatibility artifact that the
  migration must deliberately preserve or retire; enabling recurring spend remains a user
  action (`/schedule` or `/loop`).

## See also

- `docs/shadow-calls.md` — operator overview (how to read a session, enable replay, kill it).
- #2582 — packaging epic and adapter acceptance contract.
- `~/.claude/shadow-calls/SCHEMA.md` — compatibility-era ledger/state schema; the packaged
  schema becomes authoritative when the migration lands.
- REFERENCES.md — external artifact → parser → consumer mappings; #2583 tracks the missing
  enrollment-ledger row found during this amendment.
