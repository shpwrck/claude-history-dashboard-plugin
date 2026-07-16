# hexo-ai/SIA — benchmark self-improvement vs. the no-ground-truth proof engine

## Source

- URL: https://github.com/hexo-ai/sia
- Paper: arXiv 2605.27276 (Hexo Labs)
- License: MIT
- Date captured: 2026-06-12
- Category: Adjacent product / Inspiration (self-improvement loop research
  framework; not a competitor for the dashboard's user)
- Related issues: #1315 (this analysis), #1266 / #1289 / #1296 (success-proxy
  epics), #995 (proof-receipt release gate), #1312 (category-threat tracking)
- Related docs: [../v0.4-proof-engine.md](../v0.4-proof-engine.md),
  [../v0.4-time-axis.md](../v0.4-time-axis.md),
  [../adr/0005-recs-adoption-measurable-impact.md](../adr/0005-recs-adoption-measurable-impact.md),
  [../recs-adoption-receipts.md](../recs-adoption-receipts.md),
  [defending-against-the-first-party.md](./defending-against-the-first-party.md)

## What It Is

SIA ("Self-Improving AI") is an open-source loop that autonomously raises an AI
system's score on a benchmark task. Three agents drive it:

- **Meta-Agent** — writes the initial target agent from a task spec and any
  reference code.
- **Target Agent** — attempts the task and logs every run.
- **Feedback-Agent** — reads the run logs and rewrites the target.

Two improvement levers: **Harness rewrite** (edit the target's scaffold/code)
and **Weights fine-tune** (via Tinker). The loop iterates in *generations*,
each scored against a held-out `evaluate.py`. It ships with built-in benchmark
tasks (gpqa, lawbench, longcot-chess, spaceship-titanic) and a profile/provider
JSON abstraction for bring-your-own-model configuration.

The architecture rhymes with this repo's proof engine: the Feedback-Agent plays
the role our recommendation engine plays, and SIA's generations correspond to
our shadow-calls / replay / race apparatus
([../shadow-calls.md](../shadow-calls.md), ADR 0004). The rhyme is what makes
the comparison worth writing down — and the differences below are what make it
a positioning asset rather than a collision.

## User Job

SIA's user is an ML researcher (or agent builder) chasing a leaderboard: "make
my task-specific agent score higher on this benchmark." The unit of
optimization is **the agent being built**, and the fitness signal is **a
held-out evaluator over ground-truth data**.

This dashboard's user is a developer doing real work with a general coding
agent they already have. The unit of optimization is **how the developer works
with the agent**, and there is — structurally — **no `evaluate.py` for a real
Tuesday**.

## What It Does Well

- **A ground-truth fitness signal.** `evaluate.py` over held-out data gives
  every generation an unambiguous score. Improvement claims are provable
  benchmark deltas — the strongest possible claim shape, available to SIA
  because its task is benchmark-shaped.
- **Both levers in one loop.** Harness rewrite and weights fine-tune inside the
  same generational loop is a clean factoring of "what can change."
- **Profile/provider JSON abstraction.** A tidy BYO-model configuration seam
  (see *Patterns worth stealing*).
- **Runs visualizer ergonomics.** Generation-over-generation run inspection
  designed around the loop's iteration structure (see *Patterns worth
  stealing*).
- **Paper + leaderboard moat.** Its credibility asset is published benchmark
  results — portable, citable, and easy to communicate.

## Where Claude History Dashboard Is Stronger

- **It optimizes the work that actually exists.** SIA cannot ask "did this
  developer's real Tuesday go better?" — its loop only turns where a held-out
  evaluator exists. The dashboard's whole corpus *is* the real Tuesday: local
  `~/.claude` history of real tasks, real costs, real steering.
- **The user keeps their agent.** SIA improves an agent you are building;
  Probaitio (the v0.4 proof-engine codename — see
  [../plans/naming-brainstorm.md](../plans/naming-brainstorm.md)) improves how
  you use the general agent you already have. No benchmark task to define, no
  target agent to maintain.
- **Proof methodology built for noise without ground truth.** Pre-registration,
  matched pairs, objective gates, null receipts, and proof decay/revalidation
  ([../v0.4-proof-engine.md](../v0.4-proof-engine.md)) are designed for exactly
  the regime SIA never enters: claims over live workflow where no evaluator
  exists.
- **The longitudinal corpus moat.** SIA's moat is a paper and a leaderboard;
  ours is the accumulating local-history corpus plus prescription on real
  workflow ([../v0.4-time-axis.md](../v0.4-time-axis.md)) — an asset a
  competitor cannot buy back later.

## Positioning one-pager

> **SIA improves the agent you're building on a benchmark; Probaitio improves
> how you work with the agent you already have, on the work you already do.**

The two systems share a loop shape (attempt → log → analyze → rewrite →
re-score) but optimize different units against different signals:

| | SIA | Probaitio (this product) |
|---|---|---|
| Unit of optimization | A task-specific agent under construction | A developer's workflow with a general coding agent |
| Fitness signal | Ground truth: held-out `evaluate.py` score | No ground truth: a defensible success proxy over real history (epics #1266 / #1289 / #1296) |
| Corpus | Benchmark tasks (gpqa, lawbench, ...) | The user's own `~/.claude` history — real tasks, real spend |
| Loop analog | Feedback-Agent rewrites the target across generations | Recommendation engine + shadow-calls / replay / race (ADR 0004, #594) |
| Claim shape | Provable benchmark delta | Pre-registered receipt: effect size + uncertainty, or an honest null (#995) |
| User | ML researcher chasing a leaderboard | Developer doing real work |
| Moat | Paper + leaderboard | Local-history corpus + prescription on real workflow, no benchmark required |

**The moat split, explicitly.** SIA's credibility compounds through publication:
anyone can re-run the benchmark and reproduce the delta, and anyone can also
*replicate the product* by re-implementing the loop — the benchmark is public,
so the asset is the citation, not the data. Probaitio's credibility compounds
through the user's own accumulated history and the receipt/revalidation
archive: nobody — including SIA — can reproduce a year of one developer's real
agent history, and no benchmark framework can prescribe changes to work it
never observes. The two moats do not contest the same ground **today**; the
encroachment section below is about the day they might.

Vocabulary guard (extends the #996 voice rules): never describe this product as
"self-improving AI" or position receipts as benchmark results. The sentence
above is the line; "experiments on developers using the agent," not "improving
an agent."

## The success proxy: earning a skeptic's trust without ground truth

SIA sets a hard credibility bar: its improvement claims are deltas against a
held-out evaluator. A methods-literate skeptic will ask the obvious question:
*"SIA can prove its loop works. You have no `evaluate.py`. Why should I believe
your engine improves anything?"* This section is the answer, and it feeds the
success-proxy epics (#1266, #1289, #1296) and the #995 proof receipt.

**The structural fact first.** Live developer workflow has no held-out test
set. Real tasks are non-repeatable, success is multi-dimensional, and the
counterfactual ("what would this week have looked like without the change?") is
unobservable. Any product that claims a ground-truth score over live workflow
is either secretly benchmark-shaped (and thus not measuring your work) or
lying. The honest move is not to fake an evaluator but to build a **proxy whose
failure modes are named, bounded, and audited** — the same discipline that
already governs recommendations in this repo ("auditable claims, not vibes,"
[../adding-a-recommendation.md](../adding-a-recommendation.md), epic #866).

**The signal: human-steering divergence.** The proxy's raw material is
something a benchmark loop never sees: the developer's own corrective behavior
in the transcript. When a human interrupts, redirects, re-prompts, reverts, or
abandons, the history records a divergence between what the agent did and what
the human wanted — ground truth's nearest observable shadow. Less steering on
the same kind of work, sustained over time, is the defensible core of "better."
Epics #1266 / #1289 / #1296 carry the canonical definition; this section
records *why the shape earns trust*, so the doc does not duplicate the specs.

Three properties make the proxy skeptic-proof rather than vibes-with-a-metric:

1. **Three-tier claim strength.** Claims are stratified by what each tier can
   actually support, and a claim never borrows the strength of a tier above
   it. This extends the ladder the repo already enforces: deterministic
   adoption evidence at the bottom (ADR 0005 Tier 1 — byte-level
   marker-confirmed config change, no behavioral inference), observational
   proxy movement in the middle (steering divergence trending down on
   comparable work — correlational, labeled as such), and controlled
   experiment at the top (injected-vs-withheld matched pairs with
   pre-registration, [../v0.4-proof-engine.md](../v0.4-proof-engine.md)).
   SIA's benchmark delta is one undifferentiated tier; our answer to its bar
   is not "we have an evaluator too" but "every claim declares which tier it
   stands on, and only the top tier says *caused*."
2. **Cost-blind by construction.** The proxy is computed without reference to
   cost, then priced separately by the v0.3 accounting ruler. The skeptic's
   trap here is circularity: an engine whose success measure rewards
   cheapness will "prove" that spending less is succeeding more, and a
   token-efficiency vendor grading itself on token efficiency convinces
   nobody. Keeping the success signal blind to spend means a cheaper workflow
   that increases steering reads as a regression, not a win — dollars stay
   the wedge, not the verdict ([../v0.4-time-axis.md](../v0.4-time-axis.md)).
3. **Recurrence-hardened.** A quiet detector is not a cured problem. The repo
   already names the false-quiet failure mode — a deleted CLAUDE.md section
   reads identically to a fixed one (ADR 0005,
   [../recs-adoption-receipts.md](../recs-adoption-receipts.md)) — so "no
   recurrence" is reported as a labeled lower bound, never as impact. The
   proxy inherits and extends that hardening: a success claim must survive
   recurrence checks over subsequent comparable sessions, and a silence whose
   cause cannot be attributed (fix applied vs. signal source removed vs. task
   mix shifted) is downgraded, not counted.

**Why this clears the bar SIA sets.** SIA's proof is strong *because its
problem is small*: a fixed task, a frozen evaluator, held-out data. Probaitio's
claims are necessarily weaker per-claim — distributional, tiered, hedged — but
they are about the thing the user actually cares about, and their honesty is
checkable: pre-registered before the data, published with uncertainty, shipped
as a null when null ([../v0.4-proof-preregistration.md](../v0.4-proof-preregistration.md)),
and stamped with model-version scope that decays and revalidates. The skeptic
is not asked to trust a proxy; they are asked to audit a chain — artifact,
detector, tier, receipt — every link of which is reproducible from their own
local history. SIA proves more about less; the receipt proves less about more,
and says so. That sentence is the trust model.

## Encroachment watch

**The category-defining prize is a credible no-ground-truth fitness signal for
live workflow.** Whoever first cracks one owns the category, because every
player today is on the benchmark side of the wall: SIA, the eval frameworks,
and the leaderboard ecosystem all require an evaluator to exist. The wall is
structural for them and load-bearing for us — which is exactly why a crossing
attempt is the one move to treat as a category threat (tracked direction:
#1312).

Signals to watch from SIA (or any SIA-shaped successor):

- **"Your repo as the task."** Any move toward "improve your coding agent's
  harness with your own repository as the benchmark task" — e.g. using a
  repo's test suite as `evaluate.py` and looping harness rewrites against it.
  That is the benchmark wall being crossed at its thinnest point, since a test
  suite is the one ground-truth-ish evaluator real work sometimes has.
- **Fitness signals derived from run logs instead of evaluators.** SIA's
  Feedback-Agent already reads full trajectories. If generations start being
  scored by trajectory-derived signals (steering, retries, human edits) rather
  than `evaluate.py`, that is a success-proxy attempt in our category.
- **A persistent cross-run corpus.** Today each SIA task is self-contained. A
  longitudinal store of runs across tasks/projects would be the start of a
  history moat of their own.
- **Developer-workflow framing in their positioning.** Watch the README/paper
  language drift from "AI system on a benchmark task" toward "your agent on
  your work."

Response posture if a signal fires: file against #1312, and accelerate the
proxy epics (#1266 / #1289 / #1296) — the defense is shipping the credible
proxy first, not contesting benchmarks (where SIA wins on home turf). Record the
signal using the release-watch convention in
[README.md](./README.md#release-watchlist) so the note captures last-checked
cadence, the concrete release signal, and any follow-up issue before automation
is considered.

## Patterns worth stealing

Two SIA mechanics are worth importing, mapped onto concrete seams here:

1. **Profile/provider JSON abstraction (BYO-model config).** SIA cleanly
   separates "which provider/model/credentials" from the loop logic via JSON
   profiles. Candidate spots:
   - `src/lib/model-registry.ts` — today an Anthropic-only registry
     (`ModelFamily = 'opus' | 'sonnet' | 'haiku'`, hardcoded pricing tiers).
     The cross-vendor proof direction (#1259,
     [defending-against-the-first-party.md](./defending-against-the-first-party.md))
     needs exactly a profile-shaped registry: provider + model + pricing +
     capability flags as data, not as a union type.
   - The ADR 0008 server-LLM call-site registry
     ([../llm-usage-registry.md](../llm-usage-registry.md)) — provider
     profiles would give registered call sites one declarative place for
     "which key, which model, which caps" instead of per-site configuration.
   - Meta-side, the shadow-calls engine's axis/model selection
     (`~/.claude/shadow-calls/lib/axes.mjs`, ADR 0004) is the eventual
     consumer for "run the same task under profile X vs profile Y."
2. **Runs-visualizer ergonomics.** SIA's visualizer is built around the loop's
   native unit — a generation — with score-over-generations as the spine and
   drill-down into individual runs. Our equivalents are organized by session,
   not by experiment iteration. Candidate spots:
   - `src/components/ModelEvalsPf.tsx` (Model Evals workbench, #975
     substrate) — adopt the "iterations as the spine, verdict trend as the
     headline, runs as drill-down" layout for eval batches.
   - The shadow-calls ledger surface (`src/lib/parse-shadow-calls.ts` +
     `workflow.shadow-axis-wins` detector) — today the ledger is inspected
     via CLI (`ledger.mjs stats`); a generation-style view (axis on one
     dimension, outcome trend over time) would make replay/race results
     legible the way SIA makes generations legible.
   - `src/lib/forensic-graph.ts` / `src/components/SessionTimeline.tsx` —
     already strong per-run timeline evidence; the missing SIA-style piece is the
     *across-runs* comparison frame, which is what the #995 receipt needs to
     present matched pairs anyway.

Neither pattern imports SIA's optimization target — they are config and
presentation ergonomics, safe to borrow without drifting toward
benchmark-shaped claims.

## Existing Coverage

| Observation | Status | Evidence / issue |
|---|---|---|
| Loop-shaped experimentation (attempt/log/analyze/vary) | Implemented | Shadow-calls engine, ADR 0004, [../shadow-calls.md](../shadow-calls.md) |
| Tiered claim discipline (adoption vs efficacy; Class A vs B) | Implemented | ADR 0005; [../v0.4-proof-engine.md](../v0.4-proof-engine.md) |
| Recurrence caveats on quiet detectors | Implemented | ADR 0005 "no recurrence, not impact"; [../recs-adoption-receipts.md](../recs-adoption-receipts.md) |
| Defensible no-ground-truth success proxy (three-tier, cost-blind, recurrence-hardened) | Backlog | Epics #1266, #1289, #1296; narrative section above |
| Proof receipt + pre-registration gate | Backlog | Epic #995; [../v0.4-proof-preregistration.md](../v0.4-proof-preregistration.md) |
| Provider/model profile abstraction (cross-vendor registry) | Gap | Candidate spots above; direction held by #1259 |
| Generation-style runs visualizer over eval/replay batches | Gap | Candidate spots above (`ModelEvalsPf.tsx`, shadow-calls ledger surface) |
| Category-threat watch on no-ground-truth fitness signals | Backlog | #1312; watch-item list above; [README release watchlist](./README.md#release-watchlist) |
| Competing on benchmark self-improvement | No action | Different unit of optimization; positioning one-pager above |
| Weights fine-tune lever (Tinker-style) | No action | We do not train models; out of product boundary |

## Follow-up

- Source analysis issue: #1315 (this document).
- Category-threat tracking: #1312 (encroachment watch above feeds it).
- Success-proxy epics: #1266, #1289, #1296 (canonical proxy definitions live
  there; this doc carries the positioning narrative only).
- The two "Gap" rows above (provider profiles, runs visualizer) should be filed
  as backlog issues when picked up — per the capture rule, actionable scope
  does not live only in this doc.
