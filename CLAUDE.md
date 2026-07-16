# Project conventions — Claude Code

@AGENTS.md

The shared, harness-agnostic conventions live in `@AGENTS.md` (imported above and used by
any coding agent in this repo). Everything below is **specific to running Claude Code here**.
If a rule would apply to any harness, move it up into `AGENTS.md` instead.

## Working effectively

At the start of a multi-step task, run `/recs` — it pulls this dashboard's own
local recommendation engine (`/api/recommendations.json`) and surfaces
agent-behaviour findings (workflow, context, reliability, safety) to fold into
how you work. This free/automatic path is local only and never calls
`api.anthropic.com`.

That local `/recs` rule is scoped, not a blanket ban on every dashboard server
component. Server-side LLM analysis may call Anthropic only under the governance
invariant in [ADR 0008](docs/adr/0008-server-llm-usage-governance.md): registered
call site, explicit opt-in, Console API key, egress scrub, and cost caps. The
subscription OAuth credential must never send `~/.claude`-derived content.
