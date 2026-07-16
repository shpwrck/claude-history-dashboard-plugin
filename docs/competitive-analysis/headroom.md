# headroom

## Source

- GitHub: https://github.com/chopratejas/headroom
- Date captured: 2026-06-09
- Category: Inspiration
- Related issues: #727, #926

## What It Is

Headroom is a context-compression layer for AI agents. Its README positions it
as reducing tokens by compressing tool outputs, logs, files, and RAG chunks
before they reach the model. It ships as a library, proxy, MCP server, wrapper,
and integration layer across multiple agents and SDKs.

Notable concepts include:

- Content routing to choose compression strategy by content type.
- JSON, AST/code, prose, image, and learned compression approaches.
- Cache alignment to stabilize prefixes so provider caches hit more often.
- Reversible compression with local originals retrievable on demand.
- Shared cross-agent memory and provenance.
- Compatibility with Claude Code, Codex, Cursor, Aider, Copilot CLI, OpenClaw,
  OpenAI-compatible clients, and MCP-native clients.

## User Job

When running token-heavy agent workflows, the user wants lower context cost and
less prompt bloat without losing the information needed to answer correctly.

## What It Does Well

- Attacks context cost before model calls happen, not only after observing them.
- Treats compression as an infrastructure layer that can sit under many agents.
- Connects token savings to cache behavior, shared memory, and reversible
  retrieval.
- Offers a broad integration story: wrapper, proxy, library, SDK, MCP, and
  multi-agent memory.
- Makes "context headroom" a concrete operational primitive.

## Where Claude History Dashboard Is Stronger

- Measures actual historical context pressure and token spend from Claude Code
  traces.
- Can identify which projects, sessions, files, tools, and workflows would
  benefit most from a compression or context-diet intervention.
- Can verify whether context-related recommendations improve over time.
- Avoids mutating prompt content; the dashboard is observational unless the user
  applies a recommendation or policy change.

## Product Implications

- Headroom is not a direct dashboard competitor, but it is strong inspiration for
  the dashboard's cost/context roadmap. This is already captured in #727.
- The dashboard can be the measurement layer that tells a user where a tool like
  Headroom would pay off.
- Future recommendations could distinguish:
  - context to remove,
  - context to pin,
  - context to compress,
  - context to retrieve on demand,
  - context that should remain verbatim.
- Cache-alignment and reversible-retrieval ideas are relevant to v0.4
  efficiency accounting and context-health recommendations.

## Existing Coverage

| Observation | Status | Evidence / issue |
|---|---|---|
| Explore Headroom-style context compression for agents | Backlog | #727 |
| Measure context pressure, cache-read share, compactions, and repeated reads | Implemented | Context Health, File Impact, Recommendations |
| Dollarize context and workflow levers more rigorously | Backlog / design draft | [../v0.4-efficiency-accounting.md](../v0.4-efficiency-accounting.md), #724 |
| Cache-compress dashboard API responses | Implemented | #43, #80 |

## Follow-up

Do not create a duplicate Headroom exploration issue. Use #727 for the current
product question. Any implementation split should be a child or follow-up from
that issue after the analysis is narrowed.
