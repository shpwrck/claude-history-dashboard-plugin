# Langfuse — OSS category leader, now ClickHouse-owned, already reading `~/.claude`

## Source

- URL: https://github.com/langfuse/langfuse
- Companion repo: [langfuse/Claude-Observability-Plugin](https://github.com/langfuse/Claude-Observability-Plugin)
  (official Claude Code marketplace plugin)
- License: **MIT** for everything except `ee/`, `web/src/ee/`, `worker/src/ee/`
  (commercial Enterprise Edition license). Since June 4, 2025 ALL product
  features (LLM-as-judge, annotation queues, prompt experiments, playground) are
  MIT; the commercial line is enterprise-ops only (SCIM, audit logs, retention
  policies, project-level RBAC, masking).
- Date captured: 2026-07-21 (workflow-researched; 22 load-bearing claims
  independently fact-checked — note two corrected figures below)
- Category: Adjacent product (LLM observability / eval platform) with a
  **first-party `~/.claude` transcript ingest path since June 2026**
- Related docs: [phoenix.md](./phoenix.md) (sibling note; shared verdicts in
  both), `docs/plans/mission-and-positioning.md` (positioning doc, not yet
  committed), [team-observability.md](./team-observability.md),
  [competitor-remote-factory memory] (re:factory's Langfuse telemetry ingest of
  Claude transcripts is now redundant with first-party support)
- Release/watch cadence: quarterly sweep of changelog + `/agents` surface;
  immediately on any "insights/recommendations" feature news
- Last checked: 2026-07-21

## What It Is

The most widely deployed open-source "LLM engineering platform": collaborative
tracing/observability (OTel-native — OTLP endpoint + OTel-based SDKs), prompt
management with deployment labels, LLM-as-judge evals (managed evaluator catalog
built with partners incl. Ragas), datasets/experiments, playground, annotation
queues, custom dashboards, Metrics/Observations APIs, agent-graph view (beta).
v3 architecture is a real server stack: Web + async Worker over **Postgres +
ClickHouse + Redis/Valkey + S3** (six services; 4 cores/16GiB guidance) —
self-hostable ≠ local-first.

Trajectory: YC W23, ~$4M seed, ran ~16-19 people — then **acquired by
ClickHouse on January 16, 2026**, announced with ClickHouse's $400M Series D
(led by Dragoneer; the widely reported ~$15B valuation comes from press
coverage, not ClickHouse's own posts). Public commitments: MIT stays,
self-hosting first-class, roadmap unchanged; Langfuse becomes part of
ClickHouse's "**Agentic Data Stack**". Traction at acquisition: 20k+ stars (now
~31.6k, +11k in six months post-acquisition), 23-26M SDK installs/month (the two
ClickHouse posts cite 23.1M and 26M respectively), 6M+ Docker pulls, 19 of the
Fortune 50, customers Intuit, Twilio, 7-Eleven, Merck. (A "2,000+ paying
customers" figure circulating in coverage could NOT be verified to any primary
source — do not repeat it.) Near-daily releases (v3.223.0 on 2026-07-21).

**The coding-agent moves (load-bearing for us):**

1. **Claude Code integration (June 2026)** — because Claude Code emits OTel
   logs/metrics, not traces, Langfuse ships a marketplace plugin whose **Stop
   hook incrementally reads the local `~/.claude` JSONL transcripts** (file-
   offset state in `~/.claude/state/langfuse_state.json`), converts turns into
   traces (nested tool spans, cache-aware token usage, session grouping,
   backdated timestamps), opt-in per project via `TRACE_TO_LANGFUSE=true`,
   fail-open, 20k-char truncation with SHA256 of the original recorded. The
   same source artifact we parse — egressed to a Langfuse server.
2. **Codex CLI plugin** — same Stop-hook transcript pattern; captures shell
   commands, file patches, MCP tools, **subagent threads**, reasoning tokens.
   Plus an OpenClaw bridge.
3. **"Will you be my CLI?" (Feb 2026)** — agents as first-class users: Agent
   Skills (open standard), a CLI auto-generated from the OpenAPI spec, markdown
   doc endpoints (3-5x token savings), public RAG docs endpoint, llms.txt, docs
   MCP + an authenticated MCP server at `/api/public/mcp` (~60 read AND write
   tools since May 2026). A dedicated `langfuse.com/agents` surface targets
   Claude Code / Codex / Cursor / Windsurf.
4. **Langfuse Assistant** (beta, cloud) — in-product copilot answering
   questions over traces/sessions/metrics with per-action approval. An
   exploration aid today; the obvious seed of a coaching layer.

## User Job

Teams **building** LLM apps: instrument (SDK/OTel), trace, evaluate, manage
prompts, run dataset experiments, watch dashboards. The coding-agent
integrations serve "see what your coding agents did (and cost)" — passive
observability of our exact substrate. The agent-facing surface serves a second
job: letting the user's agents query/operate Langfuse itself.

## What It Does Well

- **Open-core discipline as strategy**: MIT-everything-except-`/ee` (an
  auditable boundary — a folder), June 2025 product open-sourcing, full
  self-host feature parity. It converted licensing trust into category-leading
  community growth (10k→31.6k stars in ~15 months) and dwarfs Phoenix's
  adoption metrics.
- **Transcript-ingest engineering** (the part aimed at our substrate):
  offset-tracked incremental JSONL reads, backdated OTel timestamps, fail-open,
  keychain secret storage, opt-in per project, truncation with recorded hash —
  independently converged on our parser's source and made careful choices.
- **Cost model**: mutually exclusive usage-type buckets (input excludes cached;
  providers' inclusive counts auto-converted), cache read/creation priced
  separately, regex-matched custom model definitions, tiered >200K pricing.
- **Agent-facing product surface**: llms.txt + markdown content negotiation +
  docs RAG endpoint + generated CLI + read/write MCP — a proven playbook for
  making a product cheap for agents to consume.
- **Evaluation library**: managed judge templates ("no prompt writing
  required"), observation-level online evaluators with filter predicates +
  sampling % + variable mapping previewed on historical data, session-level
  scores as first-class objects, a published four-dimension agent-eval
  taxonomy (trajectory / tool use / task completion / multi-turn).
- **Experiments**: dataset items promotable from production traces ("+ Add to
  dataset"), **versioned datasets with time-travel re-runs** (Feb 2026),
  side-by-side run comparison; UI experiments natively execute prompt/model
  variants. Ground truth optional throughout.
- **Momentum + resources**: ClickHouse's balance sheet, 100+ OSS projects
  shipping Langfuse integrations, near-daily releases.

## Where Claude History Dashboard / Probaitio Is Stronger

- **Local-first vs server-first.** Their minimum real deployment is six
  services; their Claude Code path uploads transcripts to that server. We
  analyze in place — no infra, no egress, retroactively over the full existing
  corpus (their hook captures forward-only from install).
- **Causal machinery.** Nothing in Langfuse compares a configuration against
  its counterfactual: experiments are offline dataset runs (arms = user-written
  code), prod A/B is customer-implemented `random.choice` label-splitting with
  explicitly no statistical analysis, judges score outputs. Their own agent-eval
  guide is measurement-only by its own framing.
- **Prescriptive output.** No recommendation engine of any kind — no
  cost-reduction, no model-routing, no agent-config guidance, no reclaim
  estimates. Dashboards a human interprets.
- **Config-as-data.** settings.json / CLAUDE.md / hooks / skills / memory /
  permission decisions are not analyzable objects in their model.
- **The meter is conflicted.** Billable unit = traces + observations +
  **scores, including scores Langfuse itself generates** — evaluating more
  costs more, and revenue scales with ingested volume. A "spend less" verdict
  engine cuts against their business model the same way it cuts against model
  vendors'. Structural, not roadmap-dependent.

## Moat stress-test (claim-by-claim, evidence-based)

| Our claim | Verdict vs Langfuse | The precise surviving form |
|---|---|---|
| Causal not correlational | Holds cleanly on mechanism; weakened only at single-prompt level (UI experiments execute prompt/model variants natively) | "Whole-session, environment-faithful counterfactual trials on agent **configurations**" |
| Real history not benchmarks | **Weakened as worded** — "+ Add to dataset" from production is their documented canonical workflow | "**Retroactive** full history + re-execution in the real environment (base commit, real tools), not extracted call-level datasets" |
| "Eval engines need ground truth" litmus | **Half-false as shorthand** — expected output is optional; LLM-as-judge is reference-free. The *sentence* survives (a judge rubric IS a standard); the "needs a correct answer" phrasing does not | Keep "scores an output against a standard vs compares a config against its counterfactual"; drop "needs ground truth" |
| Vendor-neutral spend-less recs | **Holds** — descriptive cost dashboards only. (Community demand visible: third-party "langfuse-cost-tuning" skill builds advice ON TOP of Langfuse data) | Ship receipts before someone fills their gap |
| Local-first zero-egress | **Holds structurally** (6-service stack; transcript egress; telemetry default-on) | "Zero-instrumentation, zero-infra, zero-egress by default" |
| Coding-agent coverage | **Exclusivity falsified** — first-party Claude Code + Codex transcript ingest since June 2026 | Depth: retroactive corpus, config-as-data, behavior-level detectors, subagent/compaction semantics |

## Product Implications (patterns worth stealing)

| # | Borrow | Why / where it lands | Effort |
|---|---|---|---|
| 1 | "+ Add to trial corpus" gesture on any session in the sessions view, with "promote the sessions that went badly" as the documented workflow | The proven UX for turning real history into experiment fuel; feeds race/replay corpus selection directly | S |
| 2 | Versioned, snapshot-addressable trial corpora (their Feb 2026 versioned dataset experiments) | Receipts citing the exact corpus version stay reproducible — strengthens the v0.6.0 publish-only-if-proven gate | M |
| 3 | Agent-facing surface kit: llms.txt, markdown endpoints, docs-RAG endpoint, generated CLI, self-install Agent Skill | Our primary consumer IS an agent (`/recs`); this is the playbook for being cheap to consume from any harness | M |
| 4 | MCP write-back tools (their ~60-tool server): let agents mark a rec adopted/rejected, enqueue a session into the replay corpus | Closes the adoption loop programmatically; our plugin MCP is read-oriented today | M |
| 5 | Exclusive usage-type cost buckets + tiered >200K pricing + regex custom model definitions | Avoids cache double-counting and aligns our dollar math with what users see elsewhere; check `src/lib/pricing.ts` | S |
| 6 | Stop-hook incremental-ingest hardening: offset state file, fail-open, backdated timestamps, truncation + SHA256 of original | Directly reusable for our live-ingest/sidecar paths; their pin-to-undocumented-SDK-internals problem is the cautionary half | S |
| 7 | Observation-level online evaluator config: filter predicates + sampling % + variable mapping with preview on historical data | Proven ergonomics for cost-controlled selective judging — exactly the selective-firing-policy problem (#2749) | M |
| 8 | Four-dimension agent-eval taxonomy (trajectory/tool use/task completion/multi-turn) + session-level scores as first-class objects | Rubric structure for race/replay judges; session-scoped scores would make the reclaim trendline cleaner than ledger-only records | S |
| 9 | Aggregated + expanded agent-graph view (repeated steps collapse to counted nodes; loops as cycles) | Makes loop/retry/tool-thrash frictions visible at a glance in session views | M |
| 10 | Open-core template: MIT everything, commercial = governance/platform in a clearly-marked folder | The battle-tested licensing shape if Probaitio ever commercializes (ADR 0014 tiers); the boundary-as-folder makes the claim auditable | S |
| 11 | First-party dated comparison/FAQ pages framing the category on our axis (eval vs proof) | Cheap demand capture; both vendors do this to each other. Arize's page carries a claim stale since June 2025 — ours must be dated + evidence-cited | S |
| 12 | OTLP ingestion endpoint as a harness-neutral capture channel (their `/api/public/otel`) | Complement to transcript parsing for harnesses we don't parse yet; aligns with pluggable-ingest (#2060) and #467 | L |

**Partnership wedge rather than collision:** their OTLP endpoint, Metrics/
Observations APIs, and score model make Langfuse a viable *upstream/downstream
integration* — ingest their scores as trial evidence, or export our receipts as
Langfuse session-level scores — making them substrate for the proof engine
instead of a competitor.

## Encroachment Watch

Fire a follow-up on any of:

- **A recommendations/insights layer over coding-agent sessions** — the
  Assistant is the seed; ClickHouse's "own the AI feedback loop" framing is the
  stated ambition. It would be correlational, but it would occupy the mindshare
  our category story needs. This is the sharpest single threat across both
  competitors.
- **Agent-config experiments**: changelog entries around coding-agent
  evaluators, harness-config capture, or session replay reusing their
  dataset-run machinery.
- **Retroactive `~/.claude` backfill** in the Claude Code plugin (today it
  backfills only the current session).
- **ClickHouse bundling** making Langfuse the default landing place for
  coding-agent telemetry in data-stack deals.
- Note also: their agent-first surface means **our users' agents may already
  speak Langfuse** — a `/recs`-consuming agent could be double-instrumented.

## Existing Coverage

| Observation | Status | Evidence / issue |
|---|---|---|
| Retroactive zero-instrumentation `~/.claude` ingest | Implemented | Product core; [../../REFERENCES.md](../../REFERENCES.md) |
| Whole-session counterfactual runner + judge | Implemented | ADR 0004, [../shadow-calls.md](../shadow-calls.md), race/replay skills |
| Cache-aware cost parsing | Implemented (parity audit: Backlog) | `src/lib/pricing.ts`, token parsers; #2908 audits vs their bucket semantics (borrow #5) |
| MCP surface for agents | Implemented (read-oriented) | Dashboard plugin MCP; write-back = Backlog #2907 (borrow #4) |
| Promote-session-to-corpus gesture | Backlog | #2903 (borrow #1) |
| Versioned trial corpora | Backlog | #2902 (borrow #2; same gap flagged in [phoenix.md](./phoenix.md)) |
| llms.txt / markdown / CLI agent surface | Backlog | #2906 (borrow #3) |
| Selective judge firing with preview | Backlog | #2749 (firing-policy lever); borrow #7 is the config-surface shape |
| Selling/hosting a Langfuse-style trace server | No action | Crowded tier, volume-metered business model is the opposite of our thesis |
| Competing on integration breadth (100+ frameworks) | No action | We consume the observability tier as input (mission doc) |

## Follow-up

- This analysis: PR adding this note + [phoenix.md](./phoenix.md) + README rows
  (2026-07-21).
- Positioning updates implied by the stress-test table (shared with the Phoenix
  note) are carried by #2909: re-anchor public wording on retroactive +
  zero-instrumentation + environment-faithful whole-session +
  config-as-treatment; retire the "needs ground truth" shorthand. Maintainer
  call — not edited here.
- Backlog issues filed 2026-07-21: #2902 (versioned corpora), #2903
  (add-to-corpus gesture), #2906 (agent surface kit), #2907 (MCP write-back),
  #2908 (cost-math parity).
- Update the re:factory memory note: its Langfuse-ingest observation is now
  first-party redundant.
