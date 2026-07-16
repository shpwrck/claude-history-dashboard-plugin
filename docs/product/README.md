# Probaitio — product docs

These are the public-facing product docs for Probaitio (the engine behind the
local `claude-history-dashboard`). They explain what the product is, how to read
its central artifact (a **proof receipt**), what ships in v0.6.0, and the privacy
model.

> **Claim discipline.** Every page here is held to the same bar as a
> recommendation: an [auditable claim](../adding-a-recommendation.md), not vibes.
> Method claims (how the engine works) are allowed before proof; **result
> claims** (a specific change saved $X) wait for an actual, externally-reviewed
> receipt — the v0.4 release gate (#995). Where a v0.6.0 feature is still an open
> epic, its page describes **intent and method**, never shipped results.

## The three-pillar spine

Probaitio is one engine in three movements:

| Pillar | What it does | Crowding |
|---|---|---|
| **Observe** | Read your local Claude Code / Codex history and make the whole bill legible — cost, context, tool use, session forensics. | Commoditized (first-party APIs, six-plus free trackers). Table stakes. |
| **Experiment** | Run controlled trials on your own work — shadow calls, replay, `/race` — with jailed, reproducible worktrees. | Sparse. |
| **Prove** | Turn a trial into a **causal verdict with quantified uncertainty** and a dollar figure: a proof receipt. | ~Empty. This is the product. |

Everyone *measures* agent cost. Probaitio *proves* what reduces it — causal A/B
trials on your own work, on your machine, with only the verdict ever leaving.

## Read in this order

1. [How it works](./how-it-works.md) — the front door: the three pillars, the
   data flow, and the privacy invariant up front.
2. [Reading a proof receipt](./reading-a-proof-receipt.md) — the differentiator
   doc: the confidence ladder, the anatomy of a receipt, and what a receipt can
   and cannot claim.
3. [Privacy & data use](./privacy-and-data.md) — what Probaitio reads and what
   never leaves your machine.
4. [vs. — how Probaitio differs](./vs.md) — against cost trackers, observability
   platforms, and hidden routers.

### v0.6.0 feature pages

The v0.6.0 release answers one question: *can routing work to the cheapest path
that holds the accuracy bar — and can we **prove** when it does?*

- [Down-modelling confidence](./features/down-modelling-confidence.md) — #2138
- [Tiered model-invocation](./features/tiered-model-invocation.md) — #2177
- [Human-as-free-tool](./features/human-as-free-tool.md) — #1934
- [Shadow Calls view redesign](./features/shadow-calls.md) — #2147
