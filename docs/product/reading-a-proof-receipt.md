# Reading a proof receipt

A proof receipt is the product's central artifact: the difference between
*"we think context waste is expensive"* and *"this change reduced the relevant
token distribution by E, CI [a, b], on N matched pairs, with quality gates
passing; here is the dollar projection and the model version it is valid for."*

This page explains how to read one. It describes the **method** the engine uses;
the first externally-reviewed receipt is the v0.4 release gate (#995). Until that
gate passes, the product describes how proof is produced — it does not claim a
specific result.

## Why a receipt, not a number

Models are non-deterministic. That is the normal condition of proof, not a
blocker: medicine, agriculture, and web A/B all prove causal effects on systems
noisier than an LLM. None proves *"this run will be better"*; all prove
*"treatment shifts the outcome distribution by E, CI [a, b], N=k."* A receipt
makes that shape explicit and auditable. A bare percentage hides it.

The noise is also the moat. If models were deterministic, "proof" would be
`diff run-a run-b` — commoditized in a sprint. Proving anything over this much
variance needs the apparatus the product already has: jailed reproducible
worktrees, matched pairs, objective gates, pre-registration, a ledger.

## The confidence ladder

Not every claim earns the same confidence. A recommendation's dollar impact
carries an attribution `tier`, and a down-model verdict climbs the same ladder
as evidence accrues:

| Tier (shipped field) | Down-model framing (#2138) | What backs it |
|---|---|---|
| `tier-0-estimate` | **T1 — estimate** | Counterfactual repricing from your real history. Deterministic arithmetic (rate-card deltas, bytes removed from a cached prefix). No experiment. |
| `tier-1-before-after` | **T2 — before / after** | A measured before/after on a real task class (e.g. the `modelPinSavings` hook), comparing observed runs. |
| `tier-2-ablation` | **T3 — replay (causal)** | Re-run the *actual past task* at its base commit two ways — original model vs. cheaper — and blind-judge the outcomes. This is the causal rung. |

A receipt always names its tier. A `tier-0-estimate` figure is honest about
being an estimate; only the replay rung is a causal claim.

### Two claim classes

- **Class A — accounting effects.** Deterministic arithmetic, provable by
  construction with the ruler alone (rate-card deltas, cached bytes removed, a
  posted batch discount).
- **Class B — behavioral effects.** Whether a change shifts the agent's
  trajectory distribution (tokens-to-green, cost, latency, quality). Fully
  exposed to model stochasticity — this is what the experiment apparatus exists
  for.

The engine prefers treatments that are **mostly Class A with a Class B rider**:
the token reduction is near-mechanical and the experiment only has to show
quality holds.

## Anatomy of a receipt

A full proof receipt records:

- **experiment ref + pre-registration ref** — the commit that *predates* the
  batch and fixes the hypothesis, fixture set, N, decision rule, and the
  **minimum detectable effect** the batch is powered for.
- **observed** — the waste pattern, the detector that found it, and **$X/mo from
  your real history**.
- **experiment** — the fixture-set ref, the design (matched pairs, injected vs.
  withheld), N, and the objective gates (build / test / diff, cost, latency).
- **result** — effect size with uncertainty, per-dimension deltas, and a
  **verdict**: proven / null / refuted.
- **projection** — $Y/mo reclaim with stated assumptions; the fixtures-to-history
  bridge is labelled an extrapolation.
- **rollout** — the prescription, written team-legibly.
- **external-review ref**.
- **model-version scope + freshness state** — every effect is conditional on the
  model version the batch ran against (see *Proof decay* below).

## How to read the verdict

- **Effect size beside uncertainty.** A point estimate without a CI is not a
  result. Variance here is heavy-tailed (one runaway loop blows a mean), so
  verdicts use medians and paired non-parametric tests or bootstrap CIs — never
  raw means. A tail claim ("fewer blow-up runs") can be both more provable and
  more valuable than a mean claim.
- **Dollars beside quality, co-equal.** Cost delta and quality delta are
  reported together. A cheaper result that fails the quality gate is not a win.
- **Pairing carries the proof.** Between-task variance dwarfs between-run
  variance, so the matched-pair design (same fixture, control vs. treatment)
  cancels the dominant noise source. Each arm runs k ≥ 2–3 times per fixture.
- **A null is a result.** A pre-registered batch that yields no decisive effect
  ships as a **null receipt**, published with the same rigor. An effect below
  the pre-registered MDE ships as "indistinguishable from null" — a scientific
  null, not a shrug. A batch that *cannot run* is reported as "not yet
  provable," never silently.

## Provenance and auditability

A receipt is only as trustworthy as its trail. Every backing recommendation
carries structured `provenance`:

- **observations** — the directly-observed facts, each traceable to its
  artifact/field;
- **inference** — the step from observations to the claim, kept separate so a
  false inference over true data is visible as such;
- **asOf / stale** — the as-of date of the underlying data; when it is older
  than the freshness threshold, present-tense wording is demoted to "as of
  \<date\>" or suppressed.

Any fix attached to a receipt declares its `fixKind`: a `validated` snippet is
genuinely copy-paste-safe; an `illustrative` one is an example to adapt. Agents
consuming the engine's output must treat a non-`validated` snippet as an example,
never a mandatory command.

### Cost is measured honestly

Claude Code sessions share a large cached system prefix, and prompt-cache warmth
can masquerade as a treatment effect. A receipt that reports cost from headless
experiments must state how cache lineage was forked per arm, whether warm-ups
matched the measured command byte-for-byte, how batches were interleaved,
whether caching was disabled, and whether the final dollars are raw-billed,
transcript-priced, or an analytical decomposition. The full method is
[`docs/experiment-methodology.md`](../experiment-methodology.md).

## What a receipt cannot claim

Stated so no receipt, landing page, or one-pager ever claims past it:

1. **Generalization beyond the fixture corpus.** The fixtures-to-history bridge
   is always an extrapolation.
2. **Model-version stability.** A proof on one model is a *hypothesis* about the
   next.
3. **Long-horizon compounding** ("recursively better over weeks"). Too many
   confounds; designed out, not attempted.
4. **Per-run guarantees.** Distributions only — never "this session will be
   cheaper."

## Proof decay is a feature

Limit 2 above is the recurring-value engine, not a weakness. Receipts carry a
model-version scope; when the model version changes, the engine re-runs the
fixture corpus and **re-stamps or revokes** the receipt. A one-off study goes
stale silently; these receipts age honestly and renew mechanically.

---

The receipt format extends the existing adoption receipt with the efficacy half;
see [`docs/v0.4-proof-engine.md`](../v0.4-proof-engine.md) for the full design
and decision record, and [`docs/recs-adoption-receipts.md`](../recs-adoption-receipts.md)
for the adoption half.
