# 0018 — Tiered local-model invocation: batch / live-analysis / in-session, keyed on latency + trust

- **Status:** Accepted (2026-07-09)
- **Date:** 2026-07-09
- **Deciders:** repo owner
- **Related:** epic [#2177](https://github.com/shpwrck/claude-history-dashboard/issues/2177)
  (the design + plan this ADR records) and its prover dependency
  [#2138](https://github.com/shpwrck/claude-history-dashboard/issues/2138) (down-modelling
  confidence). Builds on ADR [0014](./0014-tiered-delivery-model.md) (one engine, N envelopes —
  applied here to *invocation*), ADR [0005](./0005-recs-adoption-measurable-impact.md) (the
  free/local lane Tier S lives in), ADR [0008](./0008-server-llm-usage-governance.md) (server LLM
  governance — the invariant Tier S is decided **not** to trip), ADR
  [0010](./0010-k8s-substrate-reuse-over-build.md) (reuse over build — the routing/budget plumbing
  is off-the-shelf), and ADR [0017](./0017-proof-tier-ladder-and-premise-gate.md) (the proof-tier
  ladder that governs which task classes may down-route).

## Context

The dashboard's model-invocation capability is **one engine in three envelopes**, differentiated
by *latency budget* and *trust boundary* — **not** by compute — mirroring ADR 0014's "one engine, N
envelopes" applied to invocation.

Hardware only sets the *quality ceiling of the local option*; it does not decide whether local
invocation is worth it. A CPU-only box still gets full value from the deterministic engine (no
model) and from any API call (network, not local compute). Local-*model* invocation pays off where
the latency budget is generous and/or the trust boundary forbids egress. VRAM rough guide: ~24 GB
makes the classification/extraction half worthwhile; ~48 GB is the floor for judge-class tasks;
offline batch tolerates large slow models on modest cards (throughput-, not latency-bound).

This ADR records the decisions **already locked** in epic #2177. It does not invent new
architecture; it captures what the epic decided so the plumbing, the guardrails, and the build
order are auditable and citable.

## Decision

### The three tiers (keyed on latency budget + trust boundary, not compute)

| Tier | Trigger | Latency budget | Trust boundary |
|------|---------|----------------|----------------|
| **B — Batch** | scheduled / idle-window | minutes–hours | local (no external egress) |
| **A — Live analysis** | user clicks "analyze" in UI; NOT session-critical-path | seconds | local; ADR 0008 only if an external fallback is added |
| **S — In-session (open-router style)** | agent routes a call mid-session | sub-second–seconds | **local models only** (decided) |

### The four locked decisions

1. **Three tiers B / A / S, keyed on latency budget + trust boundary — not compute.** The
   differentiator is *when the answer is needed* and *what egress the boundary permits*, mirroring
   ADR 0014. Compute (local VRAM) sets only the quality ceiling of the local option, never whether a
   tier exists.

2. **Tier S is local-models-only.** It lives **entirely in the ADR 0005 free/local lane**; ADR 0008
   (Console key, egress scrub, opt-in, cost cap) **does NOT apply to Tier S**. The
   OAuth-never-sends-`~/.claude`-content rule is satisfied **by construction** — an in-session call
   never leaves the machine, so there is no egress to scrub and no external key to configure. The
   local-GPU quality ceiling becomes the in-session routing ceiling — self-limiting and honest.

3. **Tier S is phased.**
   - **Phase 1** — agent-called sub-task tool/MCP: additive, local-only, restricted to **proven task
     classes only**.
   - **Phase 2** — transparent inference routing (a proxy in front of the harness endpoint), **gated
     on accumulated #2138 confidence + calibration**.

4. **Reuse over build (ADR 0010).** Routing / fallback / budget plumbing is **LiteLLM (or
   agentgateway) fronting an OpenAI-compatible local endpoint** — *no custom broker*. The **only**
   custom parts are (a) the routing *policy* (the #2138-derived task-class → model-tier map) and (b)
   the *proof loop*. Everything else is off-the-shelf.

A task class may down-route to a local model **only after it PASSES calibration**
(`shadow-calls/lib/judge.mjs`) against Claude-judged holdout records. Unproven classes stay on the
default model — this is the ADR 0017 proof-tier ladder applied to routing decisions.

### Shared spine (build once)

- **Local serving endpoint** — OpenAI-compatible (vLLM / ollama) so LiteLLM/agentgateway can front
  it.
- **Router + call-site registry** — the task-class → model-tier policy.
- **Budget governor** — reuse `shadow-calls/lib/budget.mjs` so batch + live don't double-spend.
- **Calibration gate** — reuse `shadow-calls/lib/judge.mjs`.
- **Telemetry** — cost / quality / latency per call flows back into the dashboard, feeding #2138.

### Build order = dependency chain (Tier B licenses Tier S)

Tier B is the evidence factory: it generates the per-task-class proof (local vs Claude-judged
holdout) that a cheaper local model holds the bar; Tier S may route only the classes that proof has
cleared. Bottom-up is the only order that yields a trustworthy router.

1. **Tier B** — point replay/shadow at a local endpoint (mostly exists; backend swap) + emit a
   per-class calibration report. *P1.*
2. **Tier A** — user-initiated live local-model analysis surface over the same call sites. *P2.*
3. **Tier S Phase 1** — agent-called local sub-task tool/MCP, proven classes only. *P2.*
4. **Tier S Phase 2** — transparent in-session inference routing via LiteLLM, local-only; **blocked
   by #2138**. *P3.*

### Hard guardrails

- **Zero external Anthropic API calls in the default path in v0.6.0.** Do **not** wire the ADR-0008
  external-fallback branch (the "ADR 0008 only if an external fallback is added" cell in the Tier A
  row). With no fallback wired, the default deployment path makes **zero calls to the external
  Anthropic endpoint** — the flag-off, byte-identical guarantee the local-first rule requires.
- **Tier A is never labeled or presented as "insights."** It must not mimic the CLI `/insights`
  report format, and it is explicitly **NOT** the removed "Re-generate insights with Claude" button
  (an earlier iteration the user removed). Tier A is a local-model analysis surface, nothing more; it
  never impersonates the `/insights` skill.

### Binding principles (stated in-ADR)

- **Publish-only-if-proven.** A routing decision (or any Tier surface) publishes a claim only when
  the proof exists — a receipt or an honest null, never mechanism-alone.
- **Cold-start + evergreen per feature.** Every Tier feature needs *both* a day-one / zero-data
  mechanism (so it is useful before evidence accumulates) *and* an earns-its-receipt-then-decays
  mechanism (so stale proof does not masquerade as current state).
- **Publish-gate, not epic-slip.** The gate is on *publishing an unproven claim*, not on landing the
  mechanism. Tiers may ship; only the proven-class routing and the published claims are gated. An
  epic does not slip merely because proof is still accumulating — the mechanism lands, the claim
  waits for its receipt.

### Relationship to #2138

Tier S is the productization of #2138 (down-modelling confidence): #2138 proves *when* a cheaper
model holds the bar; Tier S acts on that proof by routing. The defensible difference from a blind
OpenRouter is **evidence-backed routing** (trials on real history). Tier B doubles as #2138's prover
backend, so they reinforce rather than block — only Phase 2 is hard-gated on #2138 confidence.

## Consequences

- **Tier S carries no ADR-0008 obligations.** Because it is local-only by construction, there is no
  registered external call site, no Console key, no egress scrub, and no spend cap to attach — the
  ADR 0008 governance surface simply does not apply to it. This keeps the free/local lane (ADR 0005)
  intact and the OAuth credential clean without any new enforcement.
- **The router is trustworthy only bottom-up.** Because Tier B licenses Tier S, a class that has not
  cleared calibration cannot be routed away from the default model. This is a hard build-order
  constraint, not a preference.
- **Almost nothing here is custom.** Per ADR 0010, the serving endpoint, the front proxy, and the
  budget/calibration primitives are all reused (vLLM/ollama, LiteLLM/agentgateway, `budget.mjs`,
  `judge.mjs`). The custom surface is deliberately tiny: the task-class → model-tier *policy* and the
  *proof loop*. Any pressure to hand-roll a broker should be resisted with that burden-of-proof.
- **v0.6.0 ships no external-Anthropic default path.** The Tier A external-fallback branch is left
  unwired for this release; enabling it later would be a governed, opt-in, off-by-default change
  under ADR 0008 — not a silent default.
- **Phase 2 stays gated.** Transparent in-session inference routing does not land until #2138
  confidence + calibration justify it; Phase 1 (proven-classes-only sub-task tool) is the additive
  step that ships first.

---

Back-link: this ADR records epic
[#2177](https://github.com/shpwrck/claude-history-dashboard/issues/2177).
