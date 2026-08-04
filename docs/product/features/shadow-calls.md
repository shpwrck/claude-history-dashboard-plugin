# Shadow Calls view redesign

> **Status: v0.6.0, in progress (epic #2147).** This page describes the redesign
> goals. Sub-issue A (the counting model) is the keystone; B–G build on it.

## Why redesign

The Shadow Calls view aggregates experiment data baked into the ingest dataset.
It is about to receive **far more** of it: continuous per-window replays from the
scheduled routine, model-eval batches, proof-batch and live `/race` runs, and
new axes and sources beyond today's set.

Today the view is aggregate-only and can silently drop rows — as of 2026-06-26 the
headline once counted 26 "experiments" while the maintainer's local ledger
(`~/.claude/shadow-calls/ledger.jsonl`, a gitignored append-only runtime file) held
43 lines: 15 synthetic demo rows and 2 excluded skips (26 + 15 + 2 = 43). That exact
ledger state is a historical observation with **no immutable in-repo artifact**
preserving it — the runtime ledger is not committed — but the breakdown reconciles
against the parser's `counted + synthetic + skipped === total` invariant
(`src/lib/parse-shadow-calls.ts`), so a reviewer can trace the 26 / 15 / 2 split to
the counting model. That confusion is exactly what this epic closes: the view must
**report correctly at volume**.

## The four redesign directions

1. **Counting transparency.** No silently dropped or merged categories. Real vs.
   synthetic vs. skipped, and live vs. replay, are explicit. What a viewer reads
   is exactly what ran.
2. **Per-experiment drill-down.** A flat, filterable, sortable log of individual
   experiments — not just per-axis rollups.
3. **Trends over time.** Time-series of volume, win-rate, and cost/token delta as
   the steady stream grows.
4. **Readability at scale.** Color-coded deltas, cost-per-quality framing,
   win-rate confidence, and the performance work to stay correct and fast at high
   volume.

## Why it matters beyond the view

The derived `workflow.shadow-axis-wins` recommendation reads this data — and a
recommendation is an [auditable claim](../../adding-a-recommendation.md). So the
redesign closes specific trust risks:

- **Headline semantics** — exclusions are visible, not buried in the parser.
- **Pipeline integrity at volume** — the parser, the ingest step, and the
  signature cache stay correct and performant with no dropped records, no stale
  cache, no silent caps; backed by tests.
- **Per-axis weighting** — live, replay (with its cold-start caveat), and
  synthetic evidence are labelled and weighted correctly, so the derived
  recommendation is not over-trusting cold or seeded evidence.

In short: as the [experiment](../how-it-works.md) tier scales up, this is the
surface that keeps its output honest enough to
[prove from](../reading-a-proof-receipt.md).
