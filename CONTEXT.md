# Claude Coach — Context

Domain language for the Claude Coach dashboard (claude-history-dashboard): a
local-first tool that parses `~/.claude` artifacts and turns agent-behaviour
signals into ranked, actionable findings. This file names the concepts that
recur across the recommendation engine, the parse layer, and the views, so the
same word means the same thing in code, issues, and review.

## Language — Recommendation engine

**Recommendation**:
A single ranked, actionable finding the engine emits — `{ id, category,
severity, title, action, fix? }`. The unit the Recommendations view renders.
_Avoid_: suggestion, tip, insight, advice.

**Detector**:
A self-contained module (one file under `src/lib/detectors/<category>/<id>.ts`)
that reads a **Signal** off `RecommendationInput` and returns zero or one
**Recommendation**. The unit of work when fielding a new recommendation.
_Avoid_: rule, check, analyzer, plugin.

**Rule** _(legacy, being retired)_:
The older in-file form of a **Detector** — a function in the `RULES` array in
`recommendations.ts`. Same signature as a detector's `rule`; the migration moves
each one into its own detector file. Treat as a deprecated alias of **Detector**.
_Avoid_: using "rule" for new work — say **Detector**.

**Detector Registry** (a.k.a. **the Catalog**):
The single static, hand-written barrel (`src/lib/detectors/index.ts`) listing
every **Detector**. The one **seam** for adding a recommendation. Static by
decision (ADR 0002) — no runtime rule store, no fs scan.
_Avoid_: rule store, rule engine, plugin system.

**Signal**:
A computed input fact (cache-hit rate, dangerous-command count, native-tool
bypass) parsed at ingest and carried as a field on `RecommendationInput`. A
**Detector** turns one or more signals into a **Recommendation**.
_Avoid_: metric, feature (see flagged ambiguity).

**Fix**:
A copy-pasteable, ready-to-apply snippet attached to a **Recommendation**
(`settings.json` / `CLAUDE.md` / hook / command). Self-suppresses when its
`appliedMarkers` show it is already in effect.
_Avoid_: patch, remediation.

**Config-Hygiene Finding**:
The separate "installed but not used" analysis (`computeConfigHygiene`, the
present/installed/unused cube) rendered in its **own** card — deliberately *not*
a **Recommendation** and *not* in the **Catalog** (yet). Kept distinct so the
recs list stays "what should I change?" and hygiene stays "what's dead weight?".
_Avoid_: calling a hygiene finding a recommendation.

## Language — Digest & action-domains

**Action-domain**:
The outcome-first grouping the digest and nav organise around (`safety`,
`cost`, `success-rate`, `speed`, `context-health`, `workflow-hygiene`) — each
rendered as an outcome-verb ("Stay safe", "Cut cost", "Fail less", "Go faster",
"Tame context", "Clean workflow"). Distinct from a **Detector** `category`: a
category is an engine-side bucket, an action-domain is the user-facing outcome a
**Recommendation** advances. `DOMAIN_FOR_CATEGORY` maps each category to one
domain.
_Avoid_: calling an action-domain a "category" or a "tab".

**Speed** (a.k.a. "Go faster"):
The **wall-clock / elapsed-time** action-domain — the clock, and only the clock.
A **Speed** finding is about how *long* something takes (per-turn latency, hook
overhead in seconds, slow tools/MCP/model latency, elapsed session time), never
about how *much* it costs (**cost**), whether it *succeeds* (**success-rate**),
or how much *effort* was wasted (**workflow-hygiene**). They correlate — rework
costs time — but a **Speed** rec's **Fix** changes the clock ("make this hook
async"), not the motion ("stop re-reading the file").
_Avoid_: using **Speed** for turn-count, rework, or "session too long by
effort" — that is **workflow-hygiene**.

## Language — Repo map

**Repo Map**:
A bounded, privacy-aware structural index of a project root — files, directories
/ module boundaries, exported/top-level symbols and signatures, import/reference
edges, and markdown-config sections with their references — rendered into a
token-capped text map. The structural bridge between "config *says* X", "these
files/modules are governed by X", and "sessions touching that area did Y" (epic
#871). _Avoid_: code graph, AST dump, symbol table — those name the mechanism,
not the artifact.

**Host-side producer**:
A host process that generates an artifact the read-only container cannot produce
itself (it lacks CLI auth, or the source files aren't mounted), writing the
result under `~/.claude/` for the container to read read-only. The **Repo Map**
is produced this way (ADR 0007), as is the `/insights` regeneration bridge
(#280). _Avoid_: ingest (that is the container's own live walk over `~/.claude`),
worker, job.

## Language — Experiment system

**Coding Harness**:
The agent host that owns session lifecycle, native artifacts, capabilities, and
worker execution, such as Claude Code or Codex.
_Avoid_: model, vendor, experiment engine

**Experiment Runtime**:
The harness-neutral capability that defines and conducts controlled comparisons
and emits versioned experiment records.
_Avoid_: Claude engine, shadow-calls folder, harness

**Experiment Harness Adapter**:
The sole boundary that translates **Experiment Runtime** needs into one
**Coding Harness**'s identity, artifacts, execution, guidance, and capabilities.
_Avoid_: second engine, vendor fork, detector

**Experiment State**:
The private, mutable ledgers, assignments, budgets, kill state, and credentials
used by experiments but not owned by the **Experiment Runtime** package.
_Avoid_: engine code, package, source repository

**Experiment Source**:
The provenance of an experiment, such as passive live shadow, replay, race, or
proof; distinct from its **Coding Harness** and artifact source.
_Avoid_: vendor, harness, artifact source

## Language — Server LLM usage

**Rule A / Rule B** (the API-usage partition):
The two categories any `api.anthropic.com` call-site falls
into. **Rule A**: a call using the user's *subscription OAuth credential*, which
may **never** carry `~/.claude` content (e.g. the plan-limit header ping).
**Rule B**: a **Server-analysis tier** call using a *Console API key*, allowed to
carry **scrubbed** content only when opt-in, registered, and cost-capped.
Browser-direct model calls are prohibited. Recorded in ADR 0008. _Avoid_: "the API ban", "no
api.anthropic.com" as if absolute — the rule is *scoped*, not blanket.

**Server-analysis tier**:
The paid, server-only surface that sends scrubbed `~/.claude` content to
`api.anthropic.com` under a Console API key (the judge/audit family) — the Rule B
carve-out. Distinct from the **free/local paths** (recs engine, parsers, the
Adoption Card) which never call the API. _Avoid_: calling it "the API tier".

**LLM-usage registry**:
The single machine-checked manifest naming every `api.anthropic.com` call-site
with its rule, credential, data class, caps, and exposure. The one **seam** for
adding or reviewing a server LLM call — the outbound analogue of the SPA/server
boundary. _Avoid_: "the API doc", "the allowlist" — it is enforced, not advisory.

**Egress scrub**:
The transmission-grade scrub a **Rule B** payload must pass before it leaves for
`api.anthropic.com` — the bar for sending data to a third party, strictly higher
than the display-grade ingest scrub. A logged pass-through *stub* today; a local
scrub-model later, and a hard prerequisite for any publicly-reachable Rule B
call. _Avoid_: equating it with the ingest-time PII scrub used for local display.

## Language — Hosted dispatch & aggregation

The vocabulary of the hosted Kubernetes deployment model (epic #1247, recorded
in ADR 0009): an operator that dispatches remote Claude Code sessions as pods
and aggregates every source's history into one store.

**RemoteSession**:
The custom resource the operator reconciles — one dispatched remote Claude Code
session. `spec.mode` is `interactive` (a long-lived pod running
`claude remote-control` that registers in claude.ai/code) or `headless` (a Job
running `claude -p`). Carries `credentialRef`, workspace (repo), and pinned
config-snapshot image. _Avoid_: "job", "task", "run" — those blur the two modes
and the CRD identity.

**Artifact-source interface**:
The read boundary that replaces direct `~/.claude` filesystem access — `list`
and `read` artifacts by `(source_id, rel_path, signature)`. The one **seam**
that lets parsers stay file-shaped while truth lives in an aggregated store, and
the seam a future zero-knowledge (#467) layer slots behind. _Avoid_: "the DB
layer", "the store" — it is an interface over raw artifacts, deliberately not a
parsed-model schema.

**claude-tree-classification**:
The single canonical mapping of every `~/.claude` path to one of three buckets —
`config | session-data | secret`. Consumed by **both** the config-snapshot bake
(takes `config`) and the **sidecar shipper** (takes `session-data`), both
refusing `secret`. The canonical home of the `.credentials*` / `paste-cache/`
exclusion. _Avoid_: a second per-consumer denylist — a misroute here leaks a
credential or drops a signal.

**Config-snapshot bake**:
The dynamic job that snapshots live `~/.claude` *config* (the `config` bucket
only) into a content-hash-tagged container image a **RemoteSession** pins.
Reproducible (an old tag reproduces old config) without runtime ConfigMap
fragility. _Avoid_: "the Dockerfile", "the base image" — the image *is* a
versioned config snapshot, not a hand-maintained build.

**Sidecar shipper**:
The native-sidecar process that pushes a pod's `session-data` artifacts to the
ingest endpoint, signature-incremental and PreStop-flushed, surviving pod
crashes. The durability backbone for capture — distinct from a Stop **hook**,
which under-captures out-of-band artifacts. _Avoid_: "the hook", "the exporter".

**Dispatch credential**:
The per-**RemoteSession** `credentialRef` selecting `personal-oauth` (flat-rate
subscription, narrow `maxConcurrent`, crown-jewel refresh token) or
`enterprise-api` (Console key, wide concurrency, ADR-0008-governed, per-token
cost). Orthogonal to `spec.mode`; flows into ingested metadata for per-dispatch
cost attribution. _Avoid_: conflating the credential choice with the mode choice.

## Language — Experiments

**Experiment Definition**:
The versioned declarative specification of an experiment: its treatments,
measurements, capabilities, budgets, safeguards, and applicability contract.
_Avoid_: experiment config, experiment run, axis

**Definition Version**:
An immutable revision of an **Experiment Definition** once any execution refers
to it. A semantic change creates a new Definition Version rather than rewriting
the meaning of existing evidence.
_Avoid_: mutable definition, latest config

**Treatment**:
A named condition declared by an **Experiment Definition**. It is the single
condition executed by an **Experiment Run**; every Definition names exactly one
Treatment as its control. Its behavior is a validated list of Experiment
Interventions.
_Avoid_: arm config, variation blob

**Experiment Intervention**:
A typed change a Treatment asks an adapter to apply through a named Experiment
Capability.
_Avoid_: arbitrary config blob, raw harness flag

**Experiment Workload**:
The Definition's contract or selector for the kind of work on which Treatments
are evaluated.
_Avoid_: copied prompt, embedded repository

**Subject Reference**:
A content-pinned pointer from a Run to the exact workload item it executed.
_Avoid_: workload selector, inline task body

**Study Design**:
The Definition's relationship between subjects and Treatments: paired runs every
Treatment on the same subject; cohort assigns one Treatment to each subject.
_Avoid_: arbitrary experiment DSL

**Treatment Assignment**:
The recorded choice of Treatment for a cohort subject, made explicitly by the
caller or uniformly at random from a recorded seed.
_Avoid_: unrecorded allocation, inferred treatment

**Experiment Run**:
One execution of one **Treatment** under one harness. Sibling Runs may share a
trial correlation, but remain independently retryable and independently failed.
It exists from dispatch onward and ends as succeeded, failed, or cancelled;
selection refusal is not a Run. A terminal Run is immutable; a retry is a new
Run linked to the prior attempt.
_Avoid_: trial, whole experiment, verdict

**Verdict**:
The single current outcome for one trial, derived from its explicit set of
**Experiment Runs** under a named decision policy. A correction replaces the
Verdict and records when and why it changed. Its outcome is a winning Treatment,
a tie, inconclusive evidence, or an invalid comparison. It names every included
Run and every excluded Run with its reason.
_Avoid_: run result, judge response, append-only verdict history

**Portable Experiment**:
An experiment whose Definition may run on any harness satisfying its required
portable capabilities, and whose evidence is relevant across those compatible
harnesses.
_Avoid_: universal experiment, vendor-neutral result

**Harness-Specific Experiment**:
An experiment whose Definition tests proprietary behavior and therefore names
the harnesses on which it is meaningful.
_Avoid_: portable experiment with exceptions

**Experiment Capability**:
A versioned semantic ability a harness adapter can provide and an Experiment
Definition can require. It describes behavior rather than a harness's raw tool
name.
_Avoid_: tool name, feature flag, nested capability expression

**Estimated Usage**:
A Definition's non-binding forecast of the resources one Run will consume, used
for harness selection and planning.
_Avoid_: budget ceiling, safety limit

**Run Limit**:
A hard per-Run resource ceiling enforced independently of **Estimated Usage**.
_Avoid_: estimate, routing hint

**Safeguard Relaxation**:
A Definition's request to loosen a default runtime safeguard for one Run. It is
effective only when separately authorized and recorded; it cannot override the
kill switch, credential protection, or Run Limits.
_Avoid_: definition-owned policy, implicit consent

**Evidence Applicability**:
The derived set of harness contexts to which a Verdict is relevant, with the
capability and provenance reasons supporting that scope.
_Avoid_: author-declared evidence scope, universal proof

**Harness Provenance**:
The separately recorded origin, driver, worker, and judge harness identities for
an Experiment Run. Driver, worker, and judge match the selected harness; origin
may differ after a handoff.
_Avoid_: single ambiguous harness field

**Session Reference**:
A namespaced pointer from an Experiment Run or Verdict to session information
stored by the dashboard, identified by harness, source, and session ID.
_Avoid_: embedded transcript, copied tool output

**Experiment Metric**:
A Definition-declared measurement with an identifier, unit, scope, collection
basis, and versioned semantics that compatible harness adapters can support.
_Avoid_: untyped number, centrally required metric name

**Verdict Policy**:
A versioned runtime-owned decision procedure that turns the selected Runs and
their observations into the trial's current Verdict.
_Avoid_: inline judge code, unversioned rubric

**Experiment Check**:
A declarative pass/fail gate applied consistently to every Treatment. It is
portable unless its contract requires a proprietary Experiment Capability.
_Avoid_: harness-specific test by default, ad hoc gate

## Flagged ambiguities

- **"insight"** — Reserved for the CLI `/insights` skill output, a *different*
  artifact the dashboard reads. Never use "insight" as a synonym for
  **Recommendation**; the app must not impersonate `/insights` (see `CLAUDE.md`).
- **"feature"** — Means `AssistantFeatures` (per-session refusal/hedging/
  code-density counts), one specific **Signal** source. Don't use "feature" for
  a general signal or a product capability in engine code.

## Example dialogue

> **Dev:** I want to add a recommendation when someone's burning money on the
> legacy Opus model. New detector?
>
> **Expert:** Right — a **Detector**, one file under `detectors/cost/`. Is the
> spend already a **Signal** on `RecommendationInput`?
>
> **Dev:** Token data's already there, so no new plumbing. It returns a
> **Recommendation** with a **Fix** that pins the cheaper model in
> `settings.json`.
>
> **Expert:** Good. Register it in the **Catalog** and it ships. Don't reach for
> the old `RULES` array — that's the legacy **Rule** form we're retiring into
> detectors. And keep it out of **Config-Hygiene**; "unused skill" is a hygiene
> finding, not a recommendation.
