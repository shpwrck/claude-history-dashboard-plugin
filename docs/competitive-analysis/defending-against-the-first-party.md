# Defending against the first party — multi-LLM / multi-harness neutrality

## Source

- Category: Strategy companion (positioning, not a competitor profile)
- Date captured: 2026-06-11
- Origin: a competitive discussion triggered by the K8s-dispatch direction
  (epic #1247) — "how do we defend against Anthropic just building this?"
- Related: [anthropic-official-analytics.md](./anthropic-official-analytics.md), [claude-code-setup-plugin.md](./claude-code-setup-plugin.md),
  [team-observability.md](./team-observability.md),
  [nirmata-aicontrols.md](./nirmata-aicontrols.md),
  [../v0.4-proof-engine.md](../v0.4-proof-engine.md),
  [../v0.4-productization-course.md](../v0.4-productization-course.md),
  [../v0.4-time-axis.md](../v0.4-time-axis.md); epic #1247; tracked under #926

## The question

Epic #1247 adds a hosted Kubernetes operator that dispatches remote agent sessions
as pods and aggregates history into one store. The fear: Anthropic ships hosted
Claude Code sessions anyway (they already have cloud instances + remote-control),
and eats this for breakfast. Is any of it defensible?

## The concession: the operator is the most eatable piece

Split the system into two planes — the same split that runs through the whole
#1247 design:

- **Compute / dispatch plane** (operator, pods, remote `claude` sessions). **Not
  defensible.** Anthropic already ships cloud Claude Code + claude.ai/code
  remote-control. Hosted dispatch is on their roadmap *because it sells tokens* —
  maximum incentive to own it, plus native/zero-ops/integrated-billing advantages
  we cannot match. The existing `anthropic-official-analytics.md` rule already
  says it: **"do not try to out-aggregate the first party."** A hosted
  aggregation+dispatch product does exactly that.
- **Data / analysis / control plane.** Where every moat lives — and exactly where
  Anthropic is **conflicted** (a vendor billed per token will not ship "cut your
  spend 60%") and **blind** (they only ever see their own ecosystem).

So the defense is not "stop Anthropic building the operator." It is: **don't make
the operator the product. Make it plumbing for what Anthropic structurally won't
build.**

## The decision: multi-LLM + multi-harness is the only *permanent* moat

Anthropic can out-host, out-aggregate, and even ship a token-conflicted efficiency
feature for enterprise *retention* (losing an account beats reduced token spend —
so the conflict is a **tendency and a lag, not a wall**). The one thing a model
vendor can **never credibly do** is be **neutral across models and harnesses**.
Neutrality is structural, not a feature, and it is permanent.

This is authentic to how the project already works: the working agreements are
already split `AGENTS.md` (harness-agnostic) + `CLAUDE.md` / Codex addenda. The
product is catching up to the workflow.

### What neutrality reframes #1247 into

A **vendor-neutral agent-operations + proof substrate**, not "hosted Claude."
Multi-harness is a *dimension* over the existing design, not a redesign:

- **Artifact-source interface (#1248)** → harness-agnostic: a `source` carries a
  `harness` type with a parse adapter per harness. (Reality check: today's parsers
  are deeply `~/.claude`-shaped — REFERENCES.md is all Claude. **Neutral bones,
  Claude-deep flesh.**)
- **RemoteSession CRD (#1249)** → `spec.harness` (claude-code | codex | ...); the
  operator dispatches any agent.
- **Bake (#1250) / policy (#1255) / MCP (#1256)** → per-harness variants. A
  parameter, not a rewrite.
- **OTel (#1258)** → the *neutral common denominator* — OTLP is the one telemetry
  dialect every harness speaks. Commodity, but commodity in the neutral
  aggregator's favor.

### The crown jewel: cross-vendor proof (#1259)

The proof engine (#1257) is where neutrality stops being defense and becomes
offense. Extend the shadow/replay axis to **cross-VENDOR models**: run the same
real task on Claude vs GPT vs Gemini, blind-judge equivalence, and prescribe the
**cheapest model that still passes**. An objective, vendor-neutral "best/cheapest
way to do this task across all models" — the single offering structurally
impossible for any model vendor to make with a straight face. That is the lunch
nobody can eat.

## The threat that is *not* Anthropic

By building a k8s operator with policy (#1255) and cost attribution, the project
leaves the cozy local-solo niche (where Anthropic is conflicted) and steps into
the **vendor-neutral agent-governance** ring, where the competitors are **not**
conflicted and **are** k8s-native:

- **Nirmata AIControls** — Kyverno/K8s-native governance; `README.md` already
  flags the collision on per-identity cost attribution "relevant post K8s-dispatch
  switch."
- **claude-code-otel / team-observability cluster** — OTel ingestion is commodity
  the moment you go cluster/team; #1258 is table stakes here, not a moat.

Differentiation over *these* players is the **proof engine** (causal experiments +
prescription) and **session-forensic coaching depth** they lack — not harness
count, and not hosting.

## Operating rules (the discipline)

1. **Concede the operator as a product.** It is internal substrate: it scales the
   proof engine and hosts the control plane. Never market "hosted Claude
   dispatch." If Anthropic ships cloud sessions, **consume them as another
   aggregation source** (the artifact-source interface already allows it). Ride
   their rails.
2. **Lead with neutrality + prescription.** Cross-vendor, self-hosted/data-
   residency, and "here is the cheaper way" — the axes the first party is
   structurally slow on.
3. **Neutral bones, Claude-deep flesh, Codex as the second source (#1260).**
   Breadth in the interfaces, depth in the coverage. Codex proves the bones are
   neutral; do not chase a six-harness land grab and dilute the depth that is the
   current strength.
4. **Speed is the real defense.** Be the category on these axes before Anthropic
   ships a token-conflicted half-measure.
