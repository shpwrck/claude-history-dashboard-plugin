# Down-modelling confidence loop

> **Status: v0.6.0, in progress (epic #2138).** This page describes intent and
> method. The confidence figures and a class proven at the causal rung are the
> epic's acceptance criteria, not yet shipped results.

## The problem

The largest single reclaim lever on a heavy automation bill is **swapping an
expensive model for a cheaper one on the work that does not need the expensive
one**. On this install's own spend, automation dominates the bill, and the
swap-to-cheaper lever is the biggest repriced line item — but today that figure
is only an **estimate** (`tier-0-estimate`: counterfactual repricing).

Estimates do not give anyone the confidence to actually down-model, because the
real risk is not cost — it is **quality**. A blanket `{"model": "claude-haiku-4-5"}`
pin is wrong for an environment whose automation is autonomous coding. The
missing piece is a mechanism that makes a down-model decision *defensible*.

## What it delivers

A **per-task-class, tiered, decaying** proof that a cheaper model — or a
cheap-worker + verifier composite — holds the quality bar, surfaced as auditable
recommendations and dogfooded by this install's own automation loops.

Four load-bearing choices:

1. **Per-task-class, never global.** Verdicts segment automation by class
   (picker dry-runs, classify passes, status writes, log-only replay,
   structured-output workflow stages vs. PR-authoring vs. review). Down-model the
   proven-safe classes; leave code-authoring on the strong model.
2. **A confidence ladder, replay = the quality-clearing rung.** T1 estimate
   (counterfactual repricing) → T2 before/after (directional cost evidence on one
   class; it does not prove completion or quality) → **T3 replay** (re-run the
   actual past task at its base commit on the cheaper model, blind-judge against
   the original). See
   [Reading a proof receipt](../reading-a-proof-receipt.md) for the ladder.
3. **Measure the composite, not just the swap.** The strongest reclaim is
   *cheap-worker + verifier ≈ frontier*. The engine measures the composite's
   total cost and quality on real history, so the recommendation becomes "swap to
   cheap + verify, proven to hold the bar at N% of the monolith's cost" — the
   v0.6 adversarial-agent thesis made concrete.
4. **Confidence is first-class and decays.** Each down-model recommendation
   carries its proof tier, sample size, blind-judge agreement, and an `asOf`
   freshness reading. Model versions move, so a proof auto-demotes to "as of
   \<date\>" until re-validated — never asserted as current state.

## First-party guidance informs evaluation; it is not local proof

The **per-task-class floor** — down-model only quality-cleared classes and keep
code-authoring on the strong model — is consistent with Anthropic's first-party
guidance to balance capability, speed, and cost when choosing a model, tune
effort to the task, and test model/effort choices on the application's actual
prompts and data
([choosing a model](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model),
[effort](https://platform.claude.com/docs/en/build-with-claude/effort)).

That is **why** the T1 swap figure is only an upper bound: it reprices the same
tokens at the cheaper model's rate and therefore assumes equal completion in the
same number of turns. The risk that a cheaper route needs extra iterations or
does not complete the work is this detector's inference from that untested
assumption, not a claim attributed to Anthropic. The `cost.automation-share`
recommendation states that caveat in its copy and structured `provenance`, and
its blanket-pin snippet is `illustrative` (adapt to a quality-cleared scope),
never a copy-paste-safe validated fix (#2548).

The per-class breakdown keeps every raw swap ceiling visible for auditability.
Every class's figure is **ceiling-only** and excluded from `estSavingsUsd` and
the structured `reclaim` claim: keyword classification is risk segmentation,
not completion or quality proof. Mechanical and review work are lower-risk
evaluation candidates, but their equal-turn repricing arithmetic is no more
bookable than authoring until a quality-gated T3 replay (or equivalent evidence)
clears the class.

**This guidance is general, not a local proof.** It explains the *shape* of the
risk and justifies the floor; it does **not** certify that any particular class
on this install is safe to down-route. A class-scoped T2 before/after can show
cost direction, but only a quality-gated T3 replay (or equivalent evidence) on
your own history clears a class — the guidance sets the default posture (stay
on the strong model until proven), and that quality receipt is what overturns
it.

## Why this is the moat, not a clone

A hidden router makes the down-model call and hides the reasoning. Probaitio does
**not** build a runtime router; it produces the **confidence to set a routing
policy** — auditable, on your own sessions, vendor-neutral — that any consumer
can gate on. The competitor hides the why; Probaitio is the receipt. The proof
runs on your real history, so it is not a benchmark claim about someone else's
workload.

## The deliverable is the loop closing on real spend

Success is measured on the real reclaim trendline, not a synthetic benchmark.
This install's autonomous loops must **consume** the verdicts: the burn-epic and
workflow tooling reads the proven-safe task-class verdicts and down-models those
stages at runtime, leaving unproven classes on the strong model.

**Related:** sibling lever [Human-as-free-tool](./human-as-free-tool.md) (#1934)
— same family, a different cheap resource. Productized by
[Tiered model-invocation](./tiered-model-invocation.md) (#2177), which routes the
classes this loop has cleared.
