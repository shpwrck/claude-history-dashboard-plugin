# 0014 — Tiered delivery model: one engine, four envelopes, sorted by data locality

- **Status:** Accepted (2026-06-17 delivery-architecture discussion)
- **Date:** 2026-06-17
- **Deciders:** repo owner
- **Related:** ADR [0003](./0003-public-spa-hosting.md) (retired public upload
  surface), ADR [0008](./0008-server-llm-usage-governance.md) (server LLM governance —
  applies to Tier 3), ADR [0009](./0009-hosted-k8s-operator-dispatch-aggregation.md) /
  [0012](./0012-probatio-operator-mvp-realization.md) (the operator — Tier 4). **Supersedes** the
  "NO TEE" stance of epic #467 *for the hosted-MCP tier only* (see Decision, Tier 3). Reframes epic
  #1852 (bundle budget) as browser-delivery optimization. Plan detail in
  `docs/plans/bundle-rearchitecture.md`.

## Context

The investigation started as "the JS bundle keeps hitting its ceiling and that warps how features
get built." Measuring the live public SPA (`coach.skrzypek.dev`) reframed the problem: it is a
single-page app whose `<body>` is an empty `<div id="root">` plus a render-blocking module script,
so a first-time visitor sees **nothing** until ~430KB of JS downloads, React boots, and a
fetch→unzip→parse→render data pipeline completes. Cold first paint was seconds-scale; warm was
~144ms. No amount of byte-budget restructuring changes that the first frame waits on the JS.

The decisive reframe: **"SPA vs. not" is the wrong axis — the right axis is "where does the data
live."** That is fixed by the privacy model: the product's moat is local-first / zero-knowledge,
so the surface that explores a *user's private data* cannot be server-rendered (the server is not
allowed to see it). Most non-SPA architectures assume the server has the data; here it does not.
So client-side rendering is forced **only** where private data lives, and every other surface is
free to be static, server-rendered, or hosted as appropriate.

That insight generalizes the single public SPA (ADR 0003) into a ladder of delivery surfaces, each
defined by data locality, trust asked of the user, and install cost.

## Decision

Adopt a **four-tier delivery model**. All tiers wrap the **same `src/lib` parse / detector /
recommendation engine** ("one engine, four envelopes"); they differ only in *where the engine runs*
and *how it is invoked*.

| # | Tier | Data lives | Compute | Trust asked | Install | Rendering |
|---|------|-----------|---------|-------------|---------|-----------|
| 1 | **Sample SPA** | build-time sample corpus | browser | none | none | **static / SSG → instant** |
| 2 | **Self-hosted MCP** | the user's machine | the user's machine | none (local) | plugin / local server | local web UI (may SSR) + agent MCP |
| 3 | **Hosted MCP** *(deferred)* | our servers | our servers, **inside a confidential-computing enclave** | trust the enclave attestation, not us | account | web + MCP |
| 4 | **Operator full install** | customer's cluster | customer's cluster | their own infra | k8s operator | enterprise web + MCP + org aggregation |

Each rung trades a little more trust/install for more capability/scale. Tier 1 is
zero-install; Tier 2 is the privacy-max solo tier with agent integration; Tier 4 is the
privacy-preserving answer to the "I want it hosted" demand (it runs in the *customer's* boundary).

**Tier 3 specifics:**
- **Deferred.** It is the hardest rung and nothing below it depends on it. Build
  Tiers 1–2 and 4 first.
- **Confidential computing, not consent.** Hosted *compute* on user data fundamentally requires
  something to see plaintext. The honest options are: client-side compute with the server as
  encrypted storage (clean ZK, but then it is not hosted compute), a TEE (trust relocated to silicon
  + attestation), or naked consent (operator sees data). FHE/MPC cannot carry this analytics
  workload. We choose **full confidential computing (TEE + remote attestation)** as the mechanism.
- **This supersedes epic #467's explicit "NO TEE" decision for the hosted tier** — but only by
  *narrowing what runs in the enclave.* #467 rejected TEE with a specific, still-valid argument: if
  the hosted analysis sends plaintext to a third-party LLM (Anthropic) by design, the enclave guards
  the data for milliseconds and then egresses it — theater. That critique stands. Tier 3's
  confidential computing is therefore coherent **only for compute that does not egress plaintext**:
  the **deterministic `src/lib` engine running on raw history inside the enclave**. Any LLM
  augmentation must either stay inside the enclave's trust boundary (confidential inference) or fall
  back to #467's scrubbed-digest pattern (which gains little from the TEE for that specific call). An
  enclave wrapped around a plaintext-to-Anthropic call is explicitly out of scope — it would re-make
  the mistake #467 named.
- **Local model access is a hard dependency, not a perk.** The deferred non-deterministic path needs in-enclave (T3) / in-cluster (T4) inference to run at all without egress — it is the concrete realization of the "confidential inference" option above, not an optional enhancement of it.
- **Positioning guardrail.** Confidential computing is *trust-relocated*, **not** zero-knowledge.
  Tiers 1–2 and 4 may claim "we cannot see your data"; Tier 3 may claim only "we do not see your
  data *if the enclave attestation holds, and the compute does not egress it*." Marketing must never
  blur the two.

## Consequences

- **The public browser tier is sample-only.** Issue #3735 retired the separate
  upload surface, image, and edge deployment. The sample remains the static,
  instant front door and its isolation is enforced by `sample-boundary`.
- **The engine must stay delivery-agnostic.** Four surfaces share `src/lib`; if any rung forks the
  analysis, it is four codebases. Guard this the way the `sample-boundary` CI job guards the browser/server
  split.
- **Epic #1852's separate upload budget is retired.** The sample's instant-ness
  comes from being static; it keeps boundary and cold-load checks without a
  second frozen byte-budget flavor.
- **Tier 3 stays a labeled "you are trusting the enclave" option,** never folded into the
  local-first story; ADR 0008's governance (egress scrub, retention caps, cost caps) applies to it.
- **The hosted tiers return two things the local tiers structurally cannot.** (1) *Recursive feedback* — only Tiers 3/4 can observe the downstream effect of the engine's own recommendations (adoption + efficacy, ADR 0005; the v0.4 proof loop), giving the engine the ground-truth fitness signal it otherwise lacks (cf. the SIA gap, #1315). This must flow back only as **aggregate / differentially-private statistics** that leave the enclave (Tier 3) or customer boundary (Tier 4) — raw per-session outcomes would re-break the data-locality guarantee, the same trap the hosted-tier LLM-egress note names. (2) *Local model access* — in-enclave (Tier 3) or in-cluster (Tier 4) inference is what makes non-deterministic analysis possible **without egress**; for Tier 4 the customer's own models can sidestep ADR 0008's egress scrub entirely. These are the concrete "more capability" each rung trades trust for — named, rather than left as vague "scale."
