# agentsview

## Source

- URL: https://github.com/kenn-io/agentsview
- Date captured: 2026-06-09
- Category: Direct competitor
- Related issues: #926

## What It Is

agentsview (kenn-io) is a local-first session-intelligence and analytics tool
for coding agents. It explicitly positions as a "100× faster replacement for
ccusage" and, critically, supports **Claude Code, Codex, and 20+ other agents**
rather than Claude Code alone.

## User Job

A user who runs more than one coding agent wants a single local dashboard that
covers all of them, with live updates as sessions progress.

## What It Does Well

- **Multi-agent breadth.** One tool across 20+ agents (Claude Code, Codex, …) —
  the dashboard today is Claude-Code-only.
- **Live updates via SSE**: the dashboard refreshes as active sessions receive
  new messages, rather than on manual reload.
- Activity heatmaps, tool usage, velocity metrics, and project breakdowns.
- Speed positioning against ccusage as the explicit benchmark.

## Where Claude History Dashboard Is Stronger

- Depth over breadth for Claude Code specifically: cost attribution, context
  health, permissions, file impact, retry semantics, and native `/insights`
  ingestion — analyses that depend on Claude-Code-specific transcript shape.
- A recommendation engine and efficiency-accounting direction, not just metrics.
- Live recompute from disk with a SQLite ingest cache keyed by mtime+size.

## Product Implications

- **Multi-agent support is a strategic fork.** If Codex/other-agent history is in
  scope, the parser layer (`src/lib/*.ts`) is the place to abstract over agent
  transcript formats. This is a large bet, not a small feature — decide
  deliberately. (Note: the recs engine already reads global `~/.claude`; Codex
  history lives under `~/.codex`.)
- **Live SSE updates** are a smaller, high-value borrow: push new-session
  detection to the client instead of relying on the "Reload from disk" button.
- "100× faster than ccusage" shows speed is a marketed axis; our cold-load
  budget + CI gate (#706) already defends this — keep it visible in positioning.

## Existing Coverage

| Observation | Status | Evidence / issue |
|---|---|---|
| Multi-agent (Codex + 20 others) coverage | Gap | strategic decision, not yet scoped |
| Live push updates as sessions change | Gap | currently manual "Reload from disk" |
| Activity heatmap / velocity / project breakdown | Implemented | Project Activity, breakdown, timeline views |
| Fast local load | Implemented | SQLite ingest cache; cold-load CI gate #706 |

## Follow-up

- No follow-up filed yet. Two candidate issues: (1) live SSE session updates;
  (2) a spike on multi-agent parser abstraction (gate behind explicit product
  decision — likely a No action / Deferred until the Claude-Code surface is
  saturated).
