# ADR 0002 — Dynamic rule engine for recommendations: discovery pipeline, not runtime evaluation

- **Status:** Accepted (2026-07-22 — shipped and enforced: #189 closed, the detector Catalog implements this design; originally Proposed as an RFC)
- **Date:** 2026-05-30
- **Issue:** #189
- **Scope:** This ADR records a *design decision only*. Implementation is deferred
  to follow-up issues; this PR ships the decision and names the first slice.

## Context

The recommendation surface is two static engines: `buildRecommendations()` in
`src/lib/recommendations.ts` (17 hand-written rules) and `computeConfigHygiene()`
in `src/lib/config-hygiene.ts`. Both are pure, zero-network, fully reproducible,
and every rule that emits a `fix` runs a strict "is this already applied?"
verification layer (`permissionsContain`, `claudeMdMarksApplied`) so it
self-suppresses when the fix is already in the user's `settings.json` / CLAUDE.md.

That staticness is a feature — trust, reproducibility, and request-time
determinism — but the rule set drifts as Claude Code, the Anthropic platform,
and community practice evolve. New pricing, SDK features, CLI skills, and failure
modes only become recommendations when a human hand-writes a rule. We want a
mechanism that keeps the rule set current **without** sacrificing the properties
above.

### Non-goals (load-bearing — do not regress)

- **No live LLM-generated recs at request time.** The engine stays zero-network;
  `/api/dataset.json` and `/api/recommendations.json` must not call out.
- **Augment, don't replace.** The static rules remain authoritative. Anything
  "dynamic" only *proposes additions/tweaks* to that static set.

## Decision

Build a **discovery-and-authoring pipeline** that runs *out of band* and emits
**pull requests** against the existing TypeScript engines. "Dynamic" describes
how rules are *discovered and proposed*, never how they are *evaluated*. The
engine a request hits stays exactly as static, auditable, and offline as today.

### 1. Output form — TypeScript rule PRs (incl. threshold tweaks), no runtime rule store

Agents emit **PRs to `recommendations.ts` / `config-hygiene.ts`**, not runtime
rule definitions from a JSON/YAML store.

- A runtime rule store would introduce a request-time interpretation surface and
  a place for untrusted rule definitions to execute — directly at odds with the
  zero-network, fully-auditable engine. Rejected.
- A **threshold tweak** is just the lowest-risk shape of a rule PR: a diff that
  changes a numeric constant (e.g. `MIN_SAVINGS_USD`, `STALE_WEEKS`) with the
  evidence that motivated it in the PR body. Same review path, smaller blast
  radius.
- Every newly-authored rule that emits a `fix` **must** call the existing
  verification layer (`permissionsContain` / `claudeMdMarksApplied`) so it
  self-suppresses when already applied. This is a checklist item in the rule-PR
  template and is enforceable in review (and later by a lint/test).

### 2. Sources & topology — one agent per source, fan-out then synthesize

Sources, in priority order: the **claude-code CHANGELOG / GitHub releases**, the
**Anthropic blog/docs/cookbook**, **anthropics/claude-code issues**, and
**vetted third-party community repos**. Topology is **one agent per source**
(single-level fan-out) feeding a synthesis/dedup step — matching this repo's
subagent convention (fan out from the top, no nested orchestrators). Each source
agent treats fetched pages as **data**, extracts candidate signals, and proposes
at most a few rule/threshold diffs; the synthesis step dedups against existing
rule `id`s and against each other before opening PRs.

### 3. Trust — scraped content is data; humans gate all logic changes

- Fetched/untrusted content is **never executed** and never templated into code
  without review. The pipeline's only output is a **diff in a PR**, so a
  prompt-injection in a scraped page can at worst produce a *bad proposal*, which
  a human rejects.
- **Human review is mandatory for any change to rule logic** (new rule, changed
  predicate, changed `fix` snippet). Nothing that adds or alters executable rule
  behaviour auto-merges.
- **Auto-merge is reserved for pure-data refreshes only** — e.g. a pricing-table
  update in a data file — and only when the diff is schema-validated and
  test-covered. Even then, the tracer slice keeps it human-gated; auto-merge is a
  later optimisation, not part of slice 1.
- Dynamically-authored rules inherit the **same strict verification layer** as
  hand-written ones (see §1); a rule PR that emits a `fix` without an
  `isApplied`-style guard fails review.

### 4. Lifecycle — provenance, retire-candidates, no contradiction

- Each rule carries lightweight **provenance**: its stable `id` (already the
  consumer contract — never rename), a `source` URL, and a `lastReviewed` date,
  in a comment or a sibling metadata map.
- A periodic **audit agent** flags (a) rules whose source page materially
  changed since `lastReviewed`, and (b) rules whose trigger hasn't fired in N
  weeks across observed sessions — surfaced as retire-candidates, mirroring the
  Catalog-Utilization pattern Marcus (P8) already gets for skills.
- **Contradiction control:** a new rule PR must declare which existing `id`s it
  supersedes (if any); the synthesis step refuses to open a PR whose trigger
  overlaps an existing rule without an explicit supersede note.
- **A/B usefulness:** instrument per-rule fire-rate and (later) fix-applied
  detection via the same `liveConfig` `isApplied` checks — a rule whose fix is
  never applied anywhere is a retire-candidate.

### 5. Cadence & budget

- **Weekly**, matching changelog/release cadence (Anthropic ships roughly at that
  rhythm). On-demand for the tracer slice.
- **Bounded tokens per run:** slice 1 is one source agent over a small diff of
  "what changed since last run", well under a single modest context; the
  multi-source fan-out is budgeted as N small agents + one synthesis, not an
  open-ended crawl. Each run logs what it covered and what it skipped.

## Tracer-bullet slice (smallest thing worth building first)

**One scheduled agent that reads the claude-code CHANGELOG / releases since the
last run and opens a single human-gated PR** proposing *either* a threshold
adjustment to an existing rule *or* one new rule stub in `recommendations.ts`,
with: the source URL + excerpt in the PR body, the required `isApplied` guard
wired in, and a red→green unit test for the new/changed rule.

This proves the full discovery → proposal → review → merge loop end-to-end with
the lowest blast radius: one source, one PR, no runtime store, no multi-source
orchestration, no auto-merge. Everything in §2–§5 layers on only after slice 1
demonstrates the loop is trustworthy.

## Consequences

- The request-time engine stays **byte-for-byte as static and offline as today**;
  this ADR adds an *authoring* pipeline, not an evaluation path. The
  `/api/recommendations.json` route (#126) and the SPA keep consuming the same
  pure `buildRecommendations()` output.
- Reviewers gain a steady trickle of small, evidence-backed rule PRs instead of
  ad-hoc hand-writing; the cost is a standing review obligation (bounded by
  cadence + budget).
- Provenance/`lastReviewed` metadata is new surface to maintain, justified by the
  retire-candidate audit it enables.
- **Deferred to follow-ups** (not built here): the slice-1 changelog agent + rule-PR
  template + `isApplied`-guard lint; per-rule provenance metadata; the audit/
  retire-candidate agent; multi-source fan-out; any auto-merge path.
