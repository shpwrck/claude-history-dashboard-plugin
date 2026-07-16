# ADR 0006 — Speed action-domain: the clock, behind a hard-lever bar

- **Status:** Accepted
- **Date:** 2026-06-05
- **Issue:** #708 (speed-recommendations epic; sub-issues #709–#712)
- **Scope:** Records the design decision for the `speed` action-domain. Names the
  category seam and the actionability bar; implementation is deferred to the
  epic's sub-issues.

## Context

The digest's outcome-first nav (#490) renders six action-domains, one of which is
`speed` ("Go faster"). Its card has always been empty: no `RecCategory` maps to
`speed` in `DOMAIN_FOR_CATEGORY`, so no **Recommendation** can ever reach it. The
empty-state copy pointed at #493 as the future fix, but #493 ("accept thin")
closed having explicitly punted the detectors as out of scope — leaving a
permanently-empty card citing a closed issue.

Two boundary problems had to be settled before the card could be filled honestly:

1. **What does `speed` own?** "Shorter sessions / fewer turns / less wasted
   wall-clock" straddles three domains. `workflow-hygiene` ("Clean workflow")
   already owns wasted *effort* (rework, redundant reads, churn, tool
   ineffectiveness); `success-rate` ("Fail less") already owns *failed* retries.
2. **What clears the bar for a speed *Recommendation*?** The #490 nav epic was a
   war on vanity orientation stats — dead-end cards that show a number with
   nowhere to act. A bare "p95 turn latency is 12s" card is exactly that
   disease.

## Decision

**`speed` owns the clock — wall-clock / elapsed time / latency — and nothing
else.** A Speed finding is about how *long* something takes (per-turn latency,
hook overhead in seconds, slow tool/MCP/model latency, elapsed session time),
never how *much* it costs (`cost`), whether it *succeeds* (`success-rate`), or
how much *effort* was wasted (`workflow-hygiene`). The domains correlate — rework
costs time — but a Speed rec's **Fix** changes the clock ("make this hook
async"), not the motion ("stop re-reading the file"). See `CONTEXT.md`.

**The category seam.** Add a seventh `RecCategory`, `speed`, mapped `speed →
speed` in `DOMAIN_FOR_CATEGORY`, with detectors under `src/lib/detectors/speed/`,
registered through the Catalog (the one seam, ADR 0002). The category is named
`speed`, matching the domain and the `CONTEXT.md` term — one word everywhere.

**Hard-lever bar.** A speed **Detector** must clear the same actionability bar as
every other category: a real lever — an `action` the user can take, ideally a
self-suppressing `fix`. Consequence, and the surprising part:

- **Turn-latency on its own is NOT a Speed Recommendation.** It is a symptom. When
  you attribute a slow turn to its cause, the fixable lever almost always lives in
  *another* domain (bloated context → `context-health`; retry storms →
  `success-rate`). Slowness stays a *speed* rec only when the lever is itself a
  clock lever.
- Bare p95/p50 stays a raw **stat** on the Evaluator view, reachable but not
  surfaced as a Recommendation.

## Considered options

- **Speed = session-length / turn-count.** Rejected: carves territory out of
  `workflow-hygiene` and creates a permanent "speed or hygiene?" ambiguity for
  every future detector.
- **Soft bar — allow diagnostic deep-link recs** (surface a slow dimension, link
  to the Evaluator, no copy-paste fix). Rejected: fills the card faster but
  reopens the exact vanity-stat dead-end #490 climbed out of.

## Consequences

- The card is honestly **sparse at launch** — the only strong clock lever is
  **hook overhead** (`stop_hook_summary` → make the stop-hook async / drop it).
  That is the keystone detector and likely the whole card initially. #493 was
  right to "expect thin."
- A model-latency detector is admissible only if it isolates model latency from
  retry/queue-inflated `elapsed_ms` *and* out-fires `cost/legacy-model-overpay`;
  otherwise it is cut, not force-shipped.
- "Wire the dead Evaluator p50/p95 drill" (the #493 leftover) is **nav/hygiene
  cleanup, not a speed detector** — it makes the stat reachable, nothing more.
