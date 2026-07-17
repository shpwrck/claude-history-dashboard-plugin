---
# Declared doc-freshness contract (#2488). The competitive dashboard landscape
# gains and loses tools quickly, so this survey needs a periodic re-check;
# warn/error when the last authoritative Git edit is older than the window.
freshness.warn_after: 90d
freshness.error_after: 180d
---

# Claude Code dashboard cluster

## Source

- claude-usage (phuryn): https://github.com/phuryn/claude-usage
- Token Dashboard: https://www.toolhunter.cc/tools/token-dashboard
- claude-code-viewer (d-kimuson): https://github.com/d-kimuson/claude-code-viewer
- claude-code-analytics (sujankapadia): https://github.com/sujankapadia/claude-code-analytics
- Claude Code Dashboard (VS Code ext, jspw): https://open-vsx.org/extension/jspw/claude-code-dashboard
- claude-view: https://recca0120.github.io/en/2026/04/07/claude-view-mission-control/
- Date captured: 2026-06-09
- Category: Direct competitor
- Related issues: #926

## What It Is

A cluster of local Claude Code dashboards that all parse `~/.claude` JSONL and
render usage/cost/session views. Grouped here because individually they overlap
heavily; the distinct ideas worth tracking are called out below. (Sniffly and
agentsview are large enough to warrant their own notes — see `sniffly.md`,
`agentsview.md`.)

| Tool | Form | Distinct idea worth noting |
|---|---|---|
| claude-usage (phuryn) | local web (`:8080`), Chart.js, 30s auto-refresh, model filter | **Pro/Max subscription progress bar** (plan-limit framing) |
| Token Dashboard | on-device, SQLite-backed | **Prompt-level** cost & cache analytics — which prompts/tools/files burn tokens |
| claude-code-viewer (d-kimuson) | full web Claude Code *client* | Interactive project management, not just analytics |
| claude-code-analytics (sujankapadia) | capture/search/analyze | **Hybrid FTS + semantic-embedding session search**, MCP tool tracking, archiving |
| Claude Code Dashboard (VS Code) | IDE extension | **In-editor distribution**; 30-day trends, heatmaps, no API key |
| claude-view | local | "Mission control": live session monitoring + cost + analytics |

## User Job

A Claude Code user wants a local view of usage/cost/sessions, each tool with a
slightly different emphasis (plan limits, prompt-level cost, in-editor, search).

## What It Does Well

- **Prompt-level cost/cache attribution** (Token Dashboard) — finer than
  per-session, directly aligned with our efficiency-accounting direction.
- **Semantic + full-text session search** (claude-code-analytics) — ahead of our
  current full-text-only Search.
- **IDE distribution** (VS Code extension) — a channel we do not occupy.
- **Plan-limit progress bar** (claude-usage) — ties spend to the 5h/weekly cap,
  which our session-usage tooling understands but the dashboard UI underplays.
- Same on-device, no-data-leaves-machine privacy stance as us.

## Where Claude History Dashboard Is Stronger

- One integrated product spanning cost, context, permissions, files, errors,
  recommendations, and native `/insights` — versus single-emphasis tools.
- Live-from-disk recompute with a mtime+size SQLite ingest cache.
- A recommendation engine, not just visualization.

## Product Implications

- **Semantic search is a concrete, bounded gap** (claude-code-analytics). Our
  Search is full-text; hybrid FTS + embeddings is a clear next step. Candidate
  issue — note it must respect the SPA/server free-paid line (embeddings likely
  server-side or local model only; never `api.anthropic.com` for the free path).
- **Prompt-level cost attribution** (Token Dashboard) reinforces the v0.3/v0.4
  efficiency-accounting work — confirm our cost views can drill to the prompt.
- **Plan-limit progress bar** (claude-usage): surface remaining 5h/weekly window
  in the dashboard UI, reusing the `session-usage` logic.
- IDE distribution is a channel decision, likely No action for now.

## Existing Coverage

| Observation | Status | Evidence / issue |
|---|---|---|
| Integrated multi-surface local dashboard | Implemented | README feature list |
| Per-session / per-project cost attribution | Implemented | Cost Attribution view |
| Prompt-level cost/cache drill-down | Backlog / Gap | v0.3/v0.4 efficiency accounting; verify prompt granularity |
| Hybrid semantic + FTS session search | Backlog | #985 — decided server/paid-tier (2026-06-09); free build stays FTS-only |
| Plan-limit (5h/weekly) progress in UI | Backlog | #986 — reuse `session-usage` logic |
| IDE / VS Code distribution | No action | channel decision |

## Follow-up

- **Semantic/hybrid session search → #985** (server/paid-tier; respects the
  spa/server boundary and the no-`api.anthropic.com`-on-free-path invariant).
- **Plan-limit progress bar → #986** (pairs with the burn-rate view #987 — shared
  5h/weekly windows).
- Prompt-level cost is covered by the efficiency-accounting epics — verify, don't
  re-file.
