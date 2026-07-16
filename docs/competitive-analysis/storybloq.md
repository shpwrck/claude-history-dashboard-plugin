# Storybloq

## Source

- Website: https://www.storybloq.com/
- Mac app page: https://www.storybloq.com/mac
- CLI page: https://www.storybloq.com/cli
- GitHub: https://github.com/Storybloq/storybloq
- Date captured: 2026-06-09
- Category: Adjacent product
- Related issues: #926

## What It Is

Storybloq is a project-memory and agent-workflow layer for Claude Code and
Codex. It stores tickets, issues, notes, lessons, roadmap phases, and handovers
in a repo-local `.story/` directory. The public positioning is that every AI
coding session should start with the state left by the previous one.

The product surface includes:

- A `.story/` file convention.
- A CLI that creates and manages project memory.
- An MCP server that lets Claude Code and Codex read and update that memory.
- A `/story` skill that primes a session with current project state.
- A native Mac app showing tickets, issues, handovers, and roadmap phases.
- Optional autonomous and review-loop workflows.
- Federation/orchestrator support for multi-repo projects.

## User Job

When starting or continuing AI-assisted development, the user wants the agent to
know current project state, open work, blockers, decisions, and prior handovers
without reconstructing everything from scratch.

## What It Does Well

- Makes project state explicit and repo-native through `.story/`.
- Gives agents a structured read/write substrate for tickets, issues, notes,
  lessons, handovers, and phases.
- Provides a simple session-start ritual with `/story`.
- Frames project continuity as the core product benefit.
- Offers a native Mac app for live project state instead of transcript analytics.
- Has a stronger story for multi-repo orchestration than this dashboard does.

## Where Claude History Dashboard Is Stronger

- Reconstructs what actually happened from `~/.claude` transcripts and history.
- Explains cost, tokens, context pressure, compactions, retries, tool usage, file
  impact, permissions, and session timelines.
- Surfaces evidence-backed recommendations from observed behavior.
- Reads Claude Code's native `/insights` artifacts without impersonating them.
- Can answer optimization questions Storybloq is not primarily designed for:
  where tokens went, which actions were risky, which workflows retried, and
  which changes would reduce waste.

## Product Implications

- Do not reposition the dashboard as a project-memory system; Storybloq owns
  that job more directly.
- Keep the dashboard positioned as observability, safety, and optimization for
  agentic coding history.
- Consider optional `.story/` ingestion only as context for analytics, not as a
  replacement for GitHub issues or this repo's release/epic model.
- Useful future questions:
  - Which Storybloq ticket or handover was active during a costly session?
  - Did sessions with explicit handovers have fewer context resets or retries?
  - Can recommendations export follow-up issues into Storybloq when a user uses
    that workflow?

## Existing Coverage

| Observation | Status | Evidence / issue |
|---|---|---|
| Project/session observability from actual Claude Code history | Implemented | README feature list |
| GitHub issue backlog remains the source of truth for this repo | Implemented / convention | AGENTS.md backlog rules |
| Memories and workflows from Claude artifacts | Implemented | #458, #537, #538, #617 |
| Multi-repo/session centralization direction | Backlog | #694, #697 |
| `.story/` ingestion | Gap | No issue yet |
| Export recommendations into Storybloq issues/notes | Gap | No issue yet |

## Follow-up

No implementation issue yet. If this becomes actionable, start with a narrow
source-mapping issue for `.story/` ingestion rather than a broad workflow clone.
