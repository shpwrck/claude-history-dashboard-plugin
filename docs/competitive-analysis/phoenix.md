# Arize Phoenix — eval-tier incumbent executing a coding-agent land grab

## Source

- URL: https://github.com/Arize-ai/phoenix
- Companion repos: [Arize-ai/openinference](https://github.com/Arize-ai/openinference)
  (Apache-2.0 instrumentation standard),
  [Arize-ai/coding-harness-tracing](https://github.com/Arize-ai/coding-harness-tracing)
  (Apache-2.0; the repo names `arize-harness-tracing` and `arize-agent-kit` both
  redirect here), [Arize-ai/arize-claude-code-plugin](https://github.com/Arize-ai/arize-claude-code-plugin)
  (MIT, superseded by coding-harness-tracing)
- License: **Elastic License 2.0** (source-available, NOT OSI-approved; forbids
  offering Phoenix as a hosted/managed service) — despite pervasive "fully
  open-source" marketing. OpenInference and coding-harness-tracing are Apache-2.0.
- Date captured: 2026-07-21 (workflow-researched; 22 load-bearing claims
  independently fact-checked against primary sources, all confirmed or corrected)
- Category: Adjacent product (LLM observability / eval platform) with an **active
  coding-agent encroachment vector**
- Related docs: [langfuse.md](./langfuse.md) (the sibling note; shared verdicts
  live in both), `docs/plans/mission-and-positioning.md` (positioning doc, not
  yet committed), [team-observability.md](./team-observability.md),
  [hexo-sia.md](./hexo-sia.md),
  [defending-against-the-first-party.md](./defending-against-the-first-party.md)
- Release/watch cadence: quarterly sweep + immediately on PXI or
  coding-harness-tracing feature news (see Release / Watch Signals)
- Last checked: 2026-07-21

## What It Is

Arize AI's source-available "AI observability platform designed for
experimentation, evaluation, and troubleshooting": OpenTelemetry/OpenInference
tracing, an LLM-evals library (Python + TS), versioned datasets, dataset-based
experiments, prompt playground with **span replay**, sessions/projects,
annotations, custom dashboards, a remote MCP server, and (June 2026) **PXI** — an
embedded, BYO-key AI engineering agent. Python server (FastAPI/Starlette +
Strawberry GraphQL + SQLAlchemy), SQLite by default, Postgres for scale;
notebook-first heritage (`px.launch_app()`), `phoenix serve` CLI, Docker/Helm,
free Phoenix Cloud instances. Self-hosting is explicitly "no license fees, no
usage limits, no feature gates."

Business structure: Phoenix is the deliberately ungated top-of-funnel for
**Arize AX** (commercial SaaS: Free $0/25k spans → Pro $50/mo → Enterprise
custom), which exclusively holds Monitoring, **Online/continuous evals**, the
Alyx copilot, "Signal" (auto failure-mode discovery + PR generation), ML/CV, and
compliance. Momentum: ~10.7k stars, ~2.16M PyPI downloads/month (roughly flat
since the Feb 2025 "2M+" claim), **$70M Series C Feb 2025** (largest-ever in AI
observability; Datadog and Microsoft M12 on the cap table), 1-2 releases/day at
v19.x in July 2026, customers incl. Uber, Booking.com, Duolingo, PepsiCo.

**The 2026 coding-agent land grab (the load-bearing development):**

1. Jan 2026 — Phoenix CLI (`px traces --format json`) + remote MCP server so
   Claude Code/Cursor can query Phoenix data from the terminal.
2. Apr 2026 — official **arize-claude-code-plugin** (marketplace install, 9
   hooks, OpenInference spans with cost calculation to AX or Phoenix). Built
   as hooks because Claude Code's native OTel exports only metrics/logs, never
   traces (anthropics/claude-code#2090, closed not-planned).
3. May 2026 — **coding-harness-tracing** generalizes to 8 harnesses (Claude Code
   CLI + Agent SDK, Cursor IDE/CLI, Codex, Copilot, Gemini CLI, Kiro, Opencode,
   Oh My Pi): 16 hook events for Claude Code (incl. PermissionRequest, compaction
   chain spans), per-category privacy opt-outs (`ARIZE_LOG_PROMPTS` etc.),
   dry-run mode. The launch blog explicitly pitches "run side-by-side experiments
   to compare workflow changes", "Claude Code vs. Cursor on the same task set",
   "with and without a test-running MCP server" — **direct rhetorical
   encroachment on our differentiation sentence.**
4. Jun 2026 — **PXI**: in-product agent that debugs traces against a
   failure-mode checklist, authors evaluators, optimizes prompts as
   **approvable staged diffs**, runs experiments. BYO key or local models.

Adoption of the coding-agent layer is embryonic (~24 stars on the kit) but it is
officially maintained, marketplace-distributed, and marketed.

## User Job

Teams **building** LLM apps/agents: instrument the app, trace it, evaluate
outputs, curate datasets from failures, iterate prompts/models, monitor in
production (AX). The coding-agent kit extends this to "observe your coding
agents" — same telemetry job, new subject. Our user — a developer **operating**
a coding agent who wants proven config/behavior changes — is adjacent, and
Phoenix is now one product decision away from courting them directly.

## What It Does Well

- **OpenInference as an owned standard**: Apache-2.0 semantic conventions
  (10 span kinds incl. AGENT/TOOL/EVALUATOR; `llm.cost.*` USD attributes;
  cache-token details; `graph.node.*` for agent graphs) + 33 Python
  instrumentation packages incl. Claude Agent SDK and MCP. They own the
  vocabulary their funnel runs on.
- **Experiments loop**: trace → dataset (versioned; ground truth optional) →
  task fn → evaluators → per-example side-by-side run comparison. The
  industry-standard mental model for "did the change help."
- **Span replay**: any traced LLM call re-runs in the playground with a
  different prompt/model — a genuine single-call config counterfactual on real
  history.
- **Cost tracking** (June 2025): maintained pricing table (~63 model configs,
  per-token-type incl. cache), effective-dated custom overrides, span→trace→
  project rollups.
- **Evals engineering**: LLM judges forced through function-calling (structured
  judgments, no freeform parsing); UI-attachable server-side evaluators;
  trajectory/tool-calling judge templates; deterministic convergence
  (optimal-vs-actual path length) metrics.
- **PXI's consent posture**: BYO key, staged diffs, elicitation-before-action —
  our ADR-0008-style governance expressed as product UX.
- **Packaging ladder**: pip-local → SQLite → Postgres → nonroot images → Helm →
  one-clicks. A solo dev genuinely can run it locally in minutes.

## Where Claude History Dashboard / Probaitio Is Stronger

- **Retroactive, zero-instrumentation ingest.** Every Arize path is
  forward-only live capture from hook-install time. We read the user's entire
  existing `~/.claude` corpus day one — no server, no OTLP endpoint, no lost
  history. (Verified: nothing in their stack reads harness transcript stores.)
- **Whole-session, environment-faithful counterfactuals.** Their replay unit is
  one extracted LLM call; their experiment "task" is always user-written code.
  Nothing re-runs a full agent session at its base commit under two agent-config
  arms. No causal claim, no reclaim estimate, no config-as-treatment.
- **Config-as-data.** settings.json, CLAUDE.md, hooks, skills, memory,
  permission decisions, plan mode — none of it is an analyzable object for them;
  they see spans.
- **Recommendations as auditable claims.** PXI/Alyx/Signal are prompt-directed
  and correlational; nothing emits cost/model-routing or agent-behavior recs,
  and nothing carries a counterfactual receipt.
- **Zero-egress by default.** Phoenix's web-analytics telemetry is ON by default
  (`PHOENIX_TELEMETRY_ENABLED=false` to disable) and every analysis loop
  (evals, playground, PXI) egresses to a model provider. Our free path makes
  zero external calls, structurally.

## Moat stress-test (claim-by-claim, evidence-based)

| Our claim | Verdict vs Phoenix | The precise surviving form |
|---|---|---|
| Causal not correlational | **Weakened at single-call level** (span replay IS a config counterfactual on real input); survives at session level | "Whole-session, environment-faithful counterfactual trials on agent **configurations**" |
| Real history not benchmarks | **Weakened as worded** — trace→dataset is their canonical loop | "**Retroactive** full-history + re-execution in the task's real environment, no dataset curation or evaluator authoring" |
| Vendor-neutral spend-less recs | Holds on content; **directionally threatened** (PXI + cost data = one step from "cheaper model held") | The counterfactual **receipt** behind the rec, which needs the session-replay runner they lack |
| Local-first zero-egress | **Not a moat on footprint** (pip-local, SQLite); holds on defaults + egress | "Zero-**instrumentation**, zero-setup, zero-egress **by default**" |
| Coding-agent coverage | **Exclusivity falsified** (8 harnesses instrumented) | Depth: retroactive history, config-as-data, behavior-level analysis |

One structural opening they cannot easily close: **the meter is conflicted.**
Arize bills on ingested spans/volume — economically biased toward more spend
flowing through the agent, not less. Our reclaim thesis cuts against their
meter, the same structural argument we already make about model vendors.

## Product Implications (patterns worth stealing)

Prioritized; statuses follow the capture rule.

| # | Borrow | Why / where it lands | Effort |
|---|---|---|---|
| 1 | Cache-aware cost math: maintained per-token-type pricing table + effective-dated custom overrides + tiered rates | Reclaim receipts are only as credible as the cost math; check `src/lib/pricing.ts` coverage of cache read/write + >200K tiers | S |
| 2 | Experiments-comparison UI shape: per-session side-by-side across named runs, evaluator columns, improvement/regression verdict | The de-facto vocabulary for "did it help"; render race/replay receipts in this shape (same gap as hexo-sia's "runs visualizer", `ModelEvalsPf.tsx` substrate #975) | M |
| 3 | Versioned trial corpora: freeze N real sessions as a named corpus version; receipts cite the exact version | Makes receipts reproducible months later; corpus.mjs has the raw material, no version semantics | M |
| 4 | PXI's staged-diff apply flow for recs (propose settings.json/CLAUDE.md edit as reviewable diff, commit on approval) | Closes the adoption loop with lower friction; gives adoption-markers a concrete applied artifact | M |
| 5 | Function-calling structured judge outputs | judge.mjs robustness — force the verdict through a tool call, never parse freeform | S |
| 6 | Trajectory/tool-calling judge templates + convergence (optimal/actual path) metric as judge rubric inputs | Cheap deterministic arm-comparison signals — literally "eval measurement as input" | S |
| 7 | Extend our MCP surface with query tools over trials/receipts (Phoenix's remote-MCP move) + a `--format json` CLI | Agents are our consumers; today's plugin MCP is status/recs-oriented | M |
| 8 | Privacy-toggle pattern: per-category redaction knobs + dry-run on any export/egress surface | Their `ARIZE_LOG_*` design is a clean, legible privacy UX for exactly our data | S |
| 9 | Optional OpenInference/OTLP **export** of parsed sessions (opt-in env flag per non-local-data rule) | Makes "we use the observability tier, we don't compete on it" literal; interop instead of collision | M |
| 10 | Packaging ladder: nonroot image variant, Helm chart, SQLite-default→Postgres story for tiers 2–4 of ADR 0014 | Their ladder is the template for stranger-deployable | M |
| 11 | Hook-based live capture as optional complement (their 16 events see PermissionRequest/Notification/compaction timing transcripts lack) | Enriches friction/wait-class detectors; retroactive corpus read stays the differentiator | M |
| 12 | ELv2 licensing lesson, both directions | Proves free-unlimited-self-host + no-third-party-hosting is marketable; also: never call ELv2 "open source" — the claim-vs-artifact gap is exactly what our auditable-claims culture must not have. Feeds any future license/ADR-0014 decision | S |

**Interop constraint:** ELv2 means we can never embed or resell Phoenix itself
as a managed component. OTel/OpenInference-level interop is fine and is the
intended seam.

## Encroachment Watch

Fire a follow-up (and consider accelerating the corresponding epic) on any of:

- **PXI grows config-variation or cost/model-routing output** ("use Haiku for
  this span class") — the delivery mechanism (prescriptive agent, staged diffs)
  and the cost substrate both already exist; only the pointing is missing.
- **coding-harness-tracing adds session replay / experiment hooks** — the May
  2026 blog already owns the "side-by-side workflow experiments" rhetoric;
  shipping a runner would collapse our claim-1/claim-2 lead to an
  implementation lead (jail, base-commit worktree, judge).
- **Any Arize move to read harness transcript stores directly** (retroactive
  ingest) rather than hooks — the true collision.
- **Session-level evals moving from AX into OSS Phoenix** — always-on
  measurement of coding-agent sessions in the free tier.

## Existing Coverage

| Observation | Status | Evidence / issue |
|---|---|---|
| Whole-session counterfactual runner (race/replay/shadow, jailed, base-commit) | Implemented | ADR 0004, `~/.claude/shadow-calls/`, [../shadow-calls.md](../shadow-calls.md) |
| Retroactive zero-instrumentation `~/.claude` ingest | Implemented | The product core; [../../REFERENCES.md](../../REFERENCES.md) |
| Auditable recommendation contract (provenance, fixKind, stale demotion) | Implemented | [../adding-a-recommendation.md](../adding-a-recommendation.md), epic #866 |
| Cross-vendor model/pricing registry | Backlog | #1259 (also flagged in [hexo-sia.md](./hexo-sia.md)) |
| OTel ingestion as an alternative capture channel | Backlog | #467 context (see [team-observability.md](./team-observability.md)); pluggable-ingest #2060 |
| Runs-visualizer / side-by-side arm comparison UI | Backlog | #2904 (borrow #2; supersedes the hexo-sia Gap row) |
| Versioned trial corpora | Backlog | #2902 (borrow #3) |
| Staged-diff rec apply flow | Backlog | #2905 (borrow #4; adoption-loop epics #2233 family) |
| Structured judge outputs via tool-calls | Backlog | #2910 (borrow #5; `meta` — mirror shpwrck/claude#186) |
| Public comparison/positioning page vs Phoenix | Backlog | #2909 — [../product/vs.md](../product/vs.md) predates the 2026 coding-agent moves |
| Competing on observability breadth / instrumentation coverage | No action | Crowded tier; we consume it as input (mission doc) |
| Embedding/reselling Phoenix as a component | No action | ELv2 forbids it; interop via OTel only |

## Release / Watch Signals

- Meaningful signals: PXI feature news; coding-harness-tracing releases;
  Phoenix release notes mentioning "replay", "experiments" over agent sessions,
  or cost recommendations; OSS/AX boundary moves (online evals into OSS).
- Notable release signals: any retroactive transcript ingest; any reclaim-style
  dollar claim in marketing.
- Follow-up issue: file on first signal per the README watchlist convention.
- No-action notes: their stale-since-June-2025 claims about Langfuse's paywall
  show comparison pages rot — ours must be dated and evidence-cited.

## Follow-up

- This analysis: PR adding this note + [langfuse.md](./langfuse.md) + README
  rows (2026-07-21).
- Positioning: #2909 carries the wording updates the moat stress-test table
  implies for `docs/plans/mission-and-positioning.md` (uncommitted) and
  [../product/vs.md](../product/vs.md). Maintainer call — not edited here.
- Backlog issues filed 2026-07-21 for the actionable borrow rows: #2902
  (versioned corpora), #2904 (arm comparison view), #2905 (staged-diff apply),
  #2908 (cost-math parity), #2910/claude#186 (judge structured output, meta).
