# Human-as-free-tool

> **Status: v0.6.0, captured thought — not yet groomed (epic #1934).** This page
> describes the insight and the intended shape. Decomposition happens during
> grooming.

## The insight

The cheapest "tool" available to an agent is **the human** — zero tokens. A lot
of value hides in having the human do or answer things that would otherwise cost
the agent many expensive calls: exploration, disambiguation, decisions,
verification. In the v0.6.0 thesis — *route to the cheapest path that holds
accuracy* — the human is the one **zero-token substitution target**.

## Two halves

### 1. Profile it — where would a cheap human input have saved a lot?

Measure, from real history, where a small upfront human input would have
prevented a large agent excursion. Candidate signals, mostly already in the data:

- the **inverse of steering-divergence** — where the human *corrected* the agent
  late, when a one-line answer upfront would have avoided the whole excursion;
- long exploration / repeated-read / runaway-workflow chains that ended in a
  human correction or revert;
- disambiguation loops — the agent guesses, gets corrected, redoes;
- decision points where the agent burned tokens deliberating something a human
  answers in one sentence.

Output: a **value-of-human-input estimate per task class** — expected agent
tokens saved by asking.

### 2. Design the offload

- A recommendation class: "this task type is cheaper if you ask the human X
  upfront."
- An agent-facing pattern: front-load a clarification at high-leverage moments
  (an `AskUserQuestion`-style checkpoint) instead of expensive autonomous
  exploration — fired **only where the exchange rate is favorable**.
- Possibly a hook that detects an imminent high-cost excursion and prompts a
  cheap human checkpoint.

## The tension to respect

Human time is **free in tokens, not free in reality**: it has an
opportunity/interruption cost, and over-asking destroys the autonomy value prop —
the point of an agent is to *not* bug the human. So this is a bounded lever with
an **optimal interruption rate**: ask only where expected token savings far
exceed interruption cost **and** accuracy materially improves. It is the dual of
the over-steering detector — too little human input wastes tokens, too much
wastes the human.

Like every v0.6.0 lever, a win here must still pass the accuracy gate. Sibling
lever: [Down-modelling confidence](./down-modelling-confidence.md) (#2138) — same
family, a different cheap resource.
