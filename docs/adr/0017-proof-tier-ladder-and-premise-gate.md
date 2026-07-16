# 0017 — Proof-tier ladder + premise-pricing gate for recommendation claims

- **Status:** Accepted (2026-06-25)
- **Date:** 2026-06-25
- **Deciders:** repo owner
- **Related:** the v0.4 proof engine ([`docs/v0.4-proof-engine.md`](../v0.4-proof-engine.md),
  epic #995) and its two-claim-classes note; the recommendation auditability contract
  ([`docs/adding-a-recommendation.md`](../adding-a-recommendation.md), epic #866, audit #1049);
  ADR [0005](./0005-recs-adoption-measurable-impact.md) (adoption vs efficacy split). Worked
  example that motivated this ADR: the #890 repo-map context-waste proof run
  ([#2083](https://github.com/shpwrck/claude-history-dashboard/issues/2083),
  [`docs/v0.4-proof-external-review-2083.md`](../v0.4-proof-external-review-2083.md)).

## Context

Every recommendation is an **auditable product claim** — agents consume
`/api/recommendations.json` via `/recs` as operating guidance, so a false claim erodes trust in
the whole engine. A natural over-reading of that principle is: *prove every claim with the causal
apparatus* (the jailed, matched-pair, pre-registered fixture batch + external review). The #890
episode showed why that is the wrong default:

- One claim (#890 "reference stable files instead of re-reading them") took the full Tier-3
  apparatus **~$208 of Opus + several days** and returned an **informative NULL**.
- The external review (#1078) found the batch was **~15× underpowered by design** (the effect is a
  tiny fraction of session cost) — i.e. the question was *not answerable* at the powered MDE.
- A 30-second check would have pre-empted most of that cost: **the #890 pattern does not fire on
  real `~/.claude` history at all (observedUsdPerMo ≈ $0).** We spent a full causal proof on a
  pattern with no measured real-world stakes.

Two confusions drove the misallocation. First, conflating **accounting claims** ("you re-paid $X"
— a measurement of what happened, provable by arithmetic) with **causal claims** ("doing X *will*
save you money" — a counterfactual that needs an experiment). Most of the ~46 live detectors are
accounting claims that have no experiment to run. Second, treating the causal apparatus as free:
it is the engine's moat *feature*, but applied indiscriminately it is ruinous and produces
low-information NULLs on patterns that don't matter.

## Decision

**Proof depth is proportionate to the claim, not uniform.** Two policies:

### 1. A proof-tier ladder (depth ∝ claim class × stakes × cost-to-prove)

| Tier | For | What "proof" means | Cost |
|---|---|---|---|
| **0 — auditable** *(ALL claims, mandatory)* | everything | evidence cites artifact+field, reproducible computation, detector tests, stale→"as of \<date\>" (the existing Auditability contract) | ~free |
| **1 — accounting** | Class A | the arithmetic on real data *is* the proof; structured `provenance` | cheap |
| **2 — observational** | cheap causal signal | shadow-calls / replay / on-real-history A-B, autonomy-axis divergence — correlational | moderate |
| **3 — causal-proof** | high-stakes, contested causal claims | jailed matched-pair fixtures, pre-registration, external review (the v0.4 engine) | **expensive — ration it** |

Tier 0 is the universal floor (every claim is auditable). Tier 3 is the heavyweight, spent like
capital. Claims declare their posture via `claimClass` and `proofTier` on the `Recommendation`
type (ADR-additive, optional, adopted incrementally like `provenance`/`fixKind`).

### 2. A premise-pricing gate before any Tier-3 proof

Before promoting a claim to Tier 3, confirm the pattern **fires on real history with a material
price** (`premiseUsdPerMo`). **No material price → no causal proof.** A claim is promoted to Tier 3
only when **value(certainty) > cost(proof)** *and* the premise is priced. This single gate is the
cheap filter that prevents expensive NULLs on patterns that don't matter (the #890 lesson).

## Consequences

- **Most detectors stay Tier 0/1** — evidence + arithmetic, which they already largely do; this ADR
  names the bar rather than raising it for them.
- **Tier 3 is reserved and gated.** New causal proofs must cite a non-zero `premiseUsdPerMo` first.
  The #890 run is grandfathered as the apparatus-validating worked example; its receipt records the
  honest NULL with the underpowered/unpriced caveats.
- **The contract enforces the declaration, not (yet) the experiment.** `docs/adding-a-recommendation.md`
  requires detectors to declare `claimClass`/`proofTier` and forbids a causal cost-win claim above
  the `accounting` tier without the matching backing. Hard validation (a contract test that fails a
  `causal` claim asserting savings at `proofTier:'accounting'`) is a deliberate follow-up, kept out
  of this ADR to stay additive — like the provenance allowlist, adoption is incremental.
- **Retarget over rescale.** When a causal question "can't be measured at this scale," the sanctioned
  response is to retarget the apparatus at a pattern whose effect is naturally large *and* priced
  (e.g. tool-call payload right-sizing), not to inflate fixtures until they clear an arbitrary MDE —
  which would manufacture an artifact. The proof engine measures effects that exist; it does not
  conjure them.
