# Competitive Analysis And External References

This directory is the durable home for competitive analysis, inspiration notes,
and external product references that inform Claude History Dashboard.

Use it for:

- Products that compete with or overlap the dashboard.
- Adjacent tools that solve a related workflow problem.
- External references that sharpen a feature, interaction model, parser target,
  recommendation rule, or positioning choice.

Do not use these docs as the backlog. Product opportunities captured here must
be converted into GitHub issues when they become actionable implementation work.
The current docs-tracking issue is #926.

## Direct Competitors

Tools that solve the same core job — local analytics/coaching over Claude Code
history — for the same user. Tiered by how directly they overlap the dashboard.

| Source | Tier | Notes | Headline gap / overlap |
|---|---|---|---|
| Sniffly (chiphuyen) | Local analytics dashboard | [sniffly.md](./sniffly.md) | **Shareable dashboards**; error analysis |
| agentsview (kenn-io) | Local analytics dashboard | [agentsview.md](./agentsview.md) | **Multi-agent (20+)**; live SSE updates |
| Claude Code dashboard cluster | Local analytics dashboards | [claude-code-dashboards.md](./claude-code-dashboards.md) | **Semantic search**; prompt-level cost; plan-limit bar; IDE distribution |
| vibe-log | Recommendations / coaching | [vibe-log.md](./vibe-log.md) | **Statusline rec delivery**; `/insights`→artifacts |
| Usage monitors (ccusage et al.) | CLI spend & limits | [usage-monitors.md](./usage-monitors.md) | **Predictive burn-rate**; community calibration |
| Team observability (claude-code-otel et al.) | Team / OTel | [team-observability.md](./team-observability.md) | **Multi-seat**; OTel ingestion (vs #467) |
| Anthropic official analytics | First-party baseline | [anthropic-official-analytics.md](./anthropic-official-analytics.md) | Authoritative cost; org aggregation |

## Adjacent Sources

| Source | Category | Notes | Status / follow-up |
|---|---|---|---|
| Storybloq | Adjacent product: project memory and agent workflow | [storybloq.md](./storybloq.md) | None yet |
| Anthropic first-party `claude-code-setup` | Adjacent product: static setup recommender | [claude-code-setup-plugin.md](./claude-code-setup-plugin.md) | #1312, #2178 |
| Claude How To | External reference / inspiration: Claude Code learning corpus | [claude-howto.md](./claude-howto.md) | #1063 |
| simonw/claude-code-transcripts | Adjacent product: transcript publishing | [claude-code-transcripts.md](./claude-code-transcripts.md) | #807 |
| Her / हेर | Adjacent product: session forensics | [her.md](./her.md) | #807 |
| headroom | Inspiration: context compression and memory layer | [headroom.md](./headroom.md) | #727 |
| Helmdeck | Adjacent product: typed-tool runtime for agents | [helmdeck.md](./helmdeck.md) | Shared cost/efficiency narrative |
| obra/Superpowers | Adjacent product / Inspiration: prescriptive agent methodology + skills framework | [superpowers.md](./superpowers.md) | #1874 — recs foil; mine Iron Laws for rules (#189/#656), proof loop measures what it prescribes |
| Agent Substrate | Adjacent product: K8s agent-session multiplexing runtime | [agent-substrate.md](./agent-substrate.md) | Buy-vs-build for #1247 dispatch half (ADR 0009) |
| AX (google/ax) | Adjacent product: distributed agent runtime / harness (runs on Agent Substrate) | [ax.md](./ax.md) | Harness half of the same dispatch reference; prior art for #1247 (ADR 0009) |
| agent-sandbox (kubernetes-sigs) | Adjacent product: K8s `Sandbox` CRD for isolated agent runtimes | [agent-sandbox.md](./agent-sandbox.md) | Candidate execution substrate under the #1247 operator (replaces the hand-rolled `Job`), gated on a gVisor/Kata RuntimeClass |
| Nirmata AIControls | Adjacent product: AI-agent governance / enforcement proxy | [nirmata-aicontrols.md](./nirmata-aicontrols.md) | Kyverno/K8s-native; collides only on per-identity cost attribution (relevant post K8s-dispatch switch) |
| hexo-ai/SIA | Adjacent product / inspiration: benchmark self-improvement loop | [hexo-sia.md](./hexo-sia.md) | Ground-truth `evaluate.py` vs our no-ground-truth proxy (#1266/#1289/#1296); encroachment watch feeds #1312 |
| rh-agent | Adjacent product: vertical skill-pack distribution of an agent runtime | [rh-agent.md](./rh-agent.md) | #1877 — instrumentation target, not a rival |
| AI Agent Maintenance (Nate's Notebook) | Inspiration: agent-maintenance framework / recs taxonomy | [agent-maintenance.md](./agent-maintenance.md) | Seven maintenance surfaces; "last 10 runs" audit; drift thesis |
| Unified Agentic Memory Across Harnesses (TDS, Bratanic) | Inspiration: hooks as the harness-agnostic seam; external memory layer | [unified-agentic-memory-hooks.md](./unified-agentic-memory-hooks.md) | Verified cross-harness hook-event mapping (Claude Code / Codex / Cursor); feeds #1247/#1260/#2571; memory shape converges with #2233 |
| Arize Phoenix (+ OpenInference, coding-harness-tracing, PXI) | Adjacent product: LLM observability/eval platform, ELv2; active coding-agent land grab | [phoenix.md](./phoenix.md) | **Instruments 8 coding harnesses via hooks (May 2026)**; PXI staged-diff prescriptive agent; moat wording must sharpen to retroactive + whole-session + config-as-treatment |
| Langfuse | Adjacent product: LLM observability/eval platform, MIT open-core; ClickHouse-owned since Jan 2026 | [langfuse.md](./langfuse.md) | **First-party `~/.claude` transcript ingest (June 2026)**; agent-facing surface kit (CLI/MCP/llms.txt); no recs layer yet — the sharpest mindshare threat if one ships |

## External Guidance Tracker

Use this section for source families that will recur across many notes rather
than one competitor-style comparison.

| Source family | Category | Existing backlog / implementation |
|---|---|---|
| Anthropic / Claude Code docs, changelogs, blog, cookbook, pricing | External reference | [anthropic-guidance.md](./anthropic-guidance.md); #656 tracks external guidance ingestion; #189 records the dynamic rule-engine design; `src/lib/pricing.ts` and cost/recommendation issues carry current pricing work |
| Claude Code runtime artifacts under `~/.claude` | External reference | [../REFERENCES.md](../REFERENCES.md) is authoritative; #704 tracks parser-table parity |
| Public transcript/session tools | Adjacent product / external reference | #807 tracks Her and `claude-code-transcripts` parity; static export and Gist publishing are intentionally separate future issues |
| v0.4 time-axis strategy | Strategy companion | [../v0.4-time-axis.md](../v0.4-time-axis.md) captures the six-to-twelve-month moat logic from the competitive-analysis work |
| First-party defense (K8s dispatch) | Strategy companion | [defending-against-the-first-party.md](./defending-against-the-first-party.md) — why the operator is conceded and multi-LLM/multi-harness neutrality + cross-vendor proof is the only permanent moat; reframes epic #1247 |

## Release Watchlist

This is a manual capture convention, not monitoring infrastructure. Use it to
keep the v0.4 proof-engine position current while avoiding premature RSS/feed
ingestion, cron jobs, `/schedule` routines, dashboard notifications, or API
endpoints. If a repeated signal proves worth automating, file a separate
follow-up issue with evidence from these notes first.

| Source / category | Meaningful release signal | Record in | Cadence / trigger |
|---|---|---|---|
| Anthropic / Claude Code | Claude Code changelog, artifact/schema changes, pricing/model behavior changes, plan-limit semantics, `/insights`, hooks, statusline, official first-party analytics/admin API changes, or `claude-code-setup` changes that affect parser assumptions, recommendations, or proof receipts (especially when it starts using history/usage/transcripts) | [anthropic-guidance.md](./anthropic-guidance.md), [anthropic-official-analytics.md](./anthropic-official-analytics.md), [claude-code-setup-plugin.md](./claude-code-setup-plugin.md), then a GitHub issue when implementation is actionable | Weekly while v0.4 proof work is active; immediately on a notable Claude Code release |
| Cursor | Agent-mode, background-agent, usage/cost visibility, project-memory, eval, or enterprise analytics changes that narrow the gap with local proof/coaching over coding-agent history | New `cursor.md` note when the signal changes positioning; link a GitHub issue only for actionable app work | On notable release; monthly sweep during release planning |
| GitHub Copilot | Coding-agent, code-review agent, CLI/IDE telemetry, org analytics, prompt/eval, or enterprise governance releases that compete with dashboard recommendations, proof, or team framing | New `github-copilot.md` note when the signal changes positioning; link a GitHub issue only for actionable app work | On notable release; monthly sweep during release planning |
| Sourcegraph / Cody | Codebase-context, agentic coding, enterprise analytics, search, or eval releases that change the context/recommendation moat | New `sourcegraph-cody.md` note when the signal changes positioning; link a GitHub issue only for actionable app work | On notable release; monthly sweep during release planning |
| OpenAI / Codex coding-agent surfaces | Codex CLI / coding-agent artifact changes, ChatGPT coding-agent workflow changes, model-routing/eval APIs, or multi-harness signals that affect the cross-vendor proof story | New `openai-codex.md` note, or [agent-substrate.md](./agent-substrate.md) when the signal is infrastructure/dispatch-shaped | On notable release; monthly sweep during release planning |
| Local dashboard competitors: Sniffly, agentsview, Claude Code dashboard cluster | Search, prompt-level cost, plan-limit bars, multi-agent breadth, live updates, shareable dashboards, IDE distribution, or error/session forensics that become expected table stakes | [sniffly.md](./sniffly.md), [agentsview.md](./agentsview.md), [claude-code-dashboards.md](./claude-code-dashboards.md) | On notable release; quarterly comparison refresh |
| Usage monitors (`ccusage`, `ccstatusline`, `ccflare`, related tools) | Plan-limit forecasts, burn-rate projections, statusline delivery, pricing calibration, or community usage semantics that improve spend/limit communication | [usage-monitors.md](./usage-monitors.md) | On notable release; monthly during plan-limit / burn-rate work |
| Category-threat research/projects: SIA-shaped proof/eval loops and benchmark self-improvement systems | Any move from benchmark-only improvement toward live developer workflow proof: repo-as-task evaluators, run-log-derived fitness signals, persistent cross-run corpora, or positioning around "your agent on your work" | [hexo-sia.md](./hexo-sia.md), or a new note for a distinct project; file follow-ups against success-proxy/proof epics when actionable | On notable release or paper; monthly while v0.4 proof receipt work is active |
| LLM observability/eval platforms: Arize Phoenix + Langfuse | Any recommendations/insights layer over coding-agent sessions; session replay or agent-config experiment features; retroactive transcript ingest (both are forward-only hook capture today); PXI emitting cost/model-routing output; ClickHouse bundling Langfuse into data-stack deals | [phoenix.md](./phoenix.md), [langfuse.md](./langfuse.md); file follow-ups against positioning/proof epics when a signal fires | Quarterly changelog sweep; immediately on recommendations-layer or replay-runner news |

## Classification

- **Direct competitor:** solves the same core job for the same user.
- **Adjacent product:** solves a neighboring job for Claude Code, Codex, or
  agentic coding users.
- **Inspiration:** has mechanics, language, architecture, or UX patterns worth
  learning from, even if the product category is different.
- **External reference:** standards, docs, research, blog posts, or examples that
  inform a narrow implementation or product decision.

## Capture Rule

Each source note should preserve:

1. What the source is.
2. Which user job it serves.
3. What it does better than this app.
4. What this app does better.
5. Product implications for Claude History Dashboard.
6. What is already implemented here.
7. Open follow-up issues, if any.
8. Explicit non-goals or deferred ideas, so we do not re-file them by accident.

Use [template.md](./template.md) for new sources.

## Status Discipline

Before adding a product implication or follow-up, check GitHub issues and the
repo for existing work. Use these labels in source notes:

- **Implemented:** already present in code or docs.
- **Backlog:** already captured in a GitHub issue.
- **Gap:** product-relevant and not yet captured.
- **No action:** useful positioning context, but not something we intend to
  build.
- **Deferred:** a real idea intentionally parked outside the current scope.

When a gap becomes actionable, create or link a GitHub issue. Do not leave
actionable implementation scope only in these docs.

## Product Boundary

The dashboard's current strongest position is observability and optimization
over real Claude Code history: cost, context health, retry behavior, tool usage,
permissions, file impact, sessions, and recommendations.

Competitive notes should protect that boundary. Borrow workflow ideas only when
they make the dashboard better at explaining what happened, why it happened,
what it cost, what was risky, and what the user should change next.
