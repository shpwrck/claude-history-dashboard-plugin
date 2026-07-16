# Claude How To

## Source

- URL: https://github.com/luongnv89/claude-howto
- Date captured: 2026-06-10
- Captured commit: `733c0882c3a83db86ce279759659c9c76fafe172`
- GitHub metadata at capture: 36,388 stars, 4,403 forks, MIT license
- Category: External reference / inspiration
- Related issues: #1062, #1063, #656, #926

## What It Is

Claude How To is a third-party Claude Code learning and reference corpus. It is
not a dashboard competitor. It packages a feature catalog, learning roadmap,
copy-paste examples, and tutorial modules for slash commands, memory, skills,
subagents, MCP, hooks, plugins, checkpoints, advanced features, and the CLI.

Treat it as community guidance, not schema authority. Any parser or settings
work still needs confirmation against first-party docs, the installed Claude
Code bundle, or live `~/.claude` artifacts.

## User Job

A Claude Code user or team wants to move from ad hoc prompting to a structured
setup: project memory, reusable commands/skills, subagents, hooks, MCP servers,
plugins, and safe recovery workflows.

## What It Does Well

- Organizes Claude Code concepts into a progressive learning path instead of a
  flat reference.
- Shows concrete resource locations for user and project setup, including
  `.claude/skills`, `.claude/agents`, `.claude/commands`, and project settings.
- Makes feature combinations explicit: skills plus hooks, MCP plus subagents,
  plugins as bundled commands/agents/MCP/hooks, and checkpoints for recovery.
- Captures newer operational knobs worth monitoring for drift, including skill
  override behavior, skill shell execution governance, bundled-skill disabling,
  hook types, MCP transports, and CLI/plugin commands.
- Uses examples that are useful fixtures for future parser or recommendation
  tests, especially hook configs and skill/subagent frontmatter.

## Where Claude History Dashboard Is Stronger

- The dashboard explains what actually happened in a user's local history:
  cost, token growth, tool use, permissions, runtime events, and recommendations.
- It can prove whether configured resources were used, not just explain how to
  install them.
- It preserves a local-first boundary and avoids calling external LLMs for free
  analysis paths.
- Its source-of-truth mapping in [../REFERENCES.md](../REFERENCES.md) keeps
  implementation tied to observed Claude Code artifacts rather than tutorial
  prose.

## Product Implications

- **Project-scoped resource coverage is the main actionable gap.** Claude How To
  treats project `.claude/skills`, `.claude/agents`, `.claude/commands`, and
  project `.claude/settings*.json` as normal team setup. Today
  `src/lib/config-loader.ts` enumerates user-level resources and plugin bundles,
  while `claudeMd.perProject` is intentionally empty because project roots are
  not mounted into the container. #1063 tracks this gap.
- **Use the repo as an external-guidance source, not a runtime dependency.**
  Items like hook event names, skill settings, and CLI commands can seed backlog
  review, but product changes should be validated through official docs or live
  artifact inspection before implementation.
- **Do not turn the dashboard into a tutorial clone.** The durable product job is
  usage evidence and coaching. The relevant adaptation is "which of these
  resources are present and earning their keep?", not "teach every Claude Code
  feature from scratch."
- **Hook examples are useful, but hook attribution remains constrained by live
  artifacts.** The dashboard already notes that transcript `stop_hook_summary`
  is sparse and lacks stable per-hook ids, so richer hook docs do not by
  themselves unlock per-hook latency.

## Existing Coverage

| Observation | Status | Evidence / issue |
|---|---|---|
| User-level skills, subagents, commands, and plugin bundles are inventoried | Implemented | `src/lib/config-loader.ts`, `src/lib/config-hygiene.ts` |
| Project-scoped `.claude/skills`, `.claude/agents`, `.claude/commands`, and project settings are not in `liveConfig` | Backlog | #1063 |
| MCP server inventory includes global and project-scoped servers from `~/.claude.json` | Implemented | `src/lib/config-loader.ts`, idle-MCP detector |
| Hook timing can be observed only through available transcript runtime events | Partial / constrained | [../hook-timing-spike.md](../hook-timing-spike.md), `src/lib/parse-runtime-events.ts` |
| Checkpoint/file-history signal is parsed without reading snapshot bodies | Implemented | `src/lib/parse-file-history.ts` |
| Claude Code `/insights` output is rendered from local `~/.claude/usage-data` artifacts | Implemented | `src/lib/parse-insights.ts`; Ask Claude impersonation is explicitly out of scope |
| External guidance ingestion for recurring source review | Backlog | #656 |

## Follow-up

- Backlog issue: #1063 for project-scoped resource coverage.
- Documentation issue: #1062 tracks this source capture.
- No new issue for tutorial UX, hook examples, or broad command-catalog parity.
  Revisit only when a specific observed artifact or recommendation rule needs
  implementation.
