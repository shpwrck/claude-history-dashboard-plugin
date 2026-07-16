# Tiered model-invocation

> **Status: v0.6.0, design + plan (issue #2177).** This page describes the
> design. Tier B is the near-term build; the in-session transparent router
> (Tier S Phase 2) is gated on accumulated down-modelling confidence (#2138).

The dashboard's model-invocation capability is **one engine in three envelopes**,
differentiated by *latency budget* and *trust boundary* — not by compute.
Hardware only sets the quality ceiling of the local option; it does not decide
whether local invocation is worth it.

## The three tiers

| Tier | Trigger | Latency budget | Trust boundary |
|---|---|---|---|
| **B — Batch** | scheduled / idle window | minutes–hours | local (no external egress) |
| **A — Live analysis** | you click "analyze" in the UI; not on the session critical path | seconds | local; external only under ADR 0008 if a fallback is ever added |
| **S — In-session** (open-router style) | the agent routes a call mid-session | sub-second–seconds | **local models only** (decided) |

## Decisions locked

- **Tier S is local-models-only.** It lives entirely in the free/local lane (ADR
  [0005](../../adr/0005-recs-adoption-measurable-impact.md)); the server-LLM
  governance (ADR [0008](../../adr/0008-server-llm-usage-governance.md)) does not
  apply to it, and the OAuth-never-sends-`~/.claude`-content rule is satisfied by
  construction. The local-GPU quality ceiling becomes the in-session routing
  ceiling — self-limiting and honest.
- **Reuse over build** (ADR [0010](../../adr/0010-k8s-substrate-reuse-over-build.md)).
  Routing, fallback, and budget plumbing reuse an existing OpenAI-compatible
  gateway in front of a local endpoint. No custom broker. What stays custom is
  the routing **policy** (the #2138-derived task-class → model-tier map) and the
  **proof loop**.
- **A class may down-route only after it passes calibration** against
  Claude-judged holdout records. Unproven classes stay on the default model.

## Build order: Tier B licenses Tier S

The order is the dependency chain. **Tier B is the evidence factory**: it
generates the per-task-class proof (local model vs. judged holdout) that a
cheaper local model holds the bar. Tier S may route only the classes that proof
has cleared. Bottom-up is the only order that yields a trustworthy router.

1. **Tier B** — point replay/shadow at a local endpoint and emit a per-class
   calibration report.
2. **Tier A** — a user-initiated live local-model analysis surface over the same
   call sites.
3. **Tier S Phase 1** — an agent-called local sub-task tool, proven classes only.
4. **Tier S Phase 2** — transparent in-session routing, local-only; **blocked by
   #2138**.

## Relationship to down-modelling confidence

Tier S is the **productization** of the
[down-modelling confidence loop](./down-modelling-confidence.md): #2138 proves
*when* a cheaper model holds the bar; this routes on that proof. The defensible
difference from a blind OpenRouter is **evidence-backed routing** — trials on
your real history, not a generic price table.
