# Unified Agentic Memory Across Harnesses Using Hooks (TDS, Bratanic)

## Source

- URL: https://towardsdatascience.com/unified-agentic-memory-across-harnesses-using-hooks/
  (archive: https://archive.ph/rYSlf)
- Author / date: Tomaz Bratanic (Neo4j), 2026-05-08, Towards Data Science
- Date captured: 2026-07-15
- Category: Inspiration / External reference
- Related issues: #1247 (vendor-neutral substrate epic), #1260 (Codex second
  harness), #2571 (OpenCode third harness), #2186 (context filesystem), #2233
  (memory lifecycle), #2644 (precedent for mined-article reference issues)
- Release/watch cadence: none (single article); the per-harness hooks docs it
  leans on are covered by the README watchlist rows for Anthropic, Cursor, and
  OpenAI/Codex
- Last checked: 2026-07-15

## What It Is

A worked demonstration that **lifecycle hooks are a harness-agnostic seam**: the
same two Python scripts give Claude Code, OpenAI Codex, and Cursor a shared,
externally-owned memory layer, with thin per-harness shell wrappers (a
`--client` flag) as the only glue. The framing is the vendor-lock-in debate —
"if you don't own your memory, you don't own your agent" — and the mechanism is
a three-layer architecture:

1. **Hooks (online).** Deterministic shell commands fire on lifecycle events
   and passively log every event into Neo4j as a per-session linked list of
   typed event nodes. No model calls, no context cost. The key contrast drawn
   with MCP: MCP tools are *agent-initiated* (the model must "remember to
   remember"), hooks are *deterministic* (they capture everything regardless of
   model judgment).
2. **Dream phase (offline).** A periodic batch job reads events since a
   watermark, hands them to Claude with the current memory store, and writes
   back durable notes. Notes are a markdown wiki: semantic file paths
   (`profile/role.md`, `tools/bash/common-flags.md`), YAML frontmatter + prose,
   **merged rather than appended** — a path is a living document, and
   contradicted notes get rewritten.
3. **Injection (online).** `SessionStart` output is prepended to the system
   prompt (profile/agent-level memory); `UserPromptSubmit` output is appended
   to the user message (turn-level, relevance-searched memory). Any harness
   picks up the same memory cold.

Two constraints the article is careful about: hooks run **outside the
harness's model session** (LLM work inside a hook means your own API call and
per-event latency — so hooks only log and inject pre-computed text), and
injection is append-only (you cannot rewrite other parts of the prompt).

## User Job

Developers who move between coding harnesses (or expect to) and want agent
memory — profile, preferences, project knowledge — to follow them rather than
live inside one vendor's walled garden.

## What It Does Well

- Names the **cross-harness hook contract** precisely: JSON on stdin (session
  id, event name, tool details, prompt), optional JSON on stdout to inject
  context, essentially the same five lifecycle events in all three harnesses.
  That is the strongest available public evidence that a hooks-based
  integration written once genuinely ports across Claude Code, Codex, and
  Cursor.
- Clean separation of concerns: deterministic capture (hooks) vs. judgment
  (offline consolidation) vs. delivery (injection points). The "dream phase"
  keeps LLM cost and latency off the interactive path.
- The memory format converges with what we already parse: files with YAML
  frontmatter + markdown prose at semantic paths — explicitly modeled on
  Anthropic skills and Karpathy's LLM-wiki pattern.
- Honest about MCP's limits for memory (consistency, "remember to remember")
  while still concluding you eventually want both hooks *and* MCP CRUD access.

## Where Claude History Dashboard Is Stronger

- The article's memory layer requires a running Neo4j and per-harness hook
  installation; the dashboard's free path reads artifacts that already exist on
  disk (`~/.claude`, `~/.codex`) with zero setup and zero side effects.
- No lifecycle/audit story for the memories themselves — notes are merged in
  place with no expiry/review semantics. Our memory-lifecycle contract
  ([../memory-lifecycle-schema.md](../memory-lifecycle-schema.md), epic #2233)
  treats a written note as a claim with a declared death condition.
- No observability: the article persists events but builds no analysis,
  recommendations, or proof on top of them. That layer is this product.

## Product Implications

- **Hooks are the harness-agnostic seam for live ingest.** Our multi-harness
  work (#1260 Codex, #2571 OpenCode, epic #1247) is currently parse-adapter
  shaped: read each harness's on-disk artifacts. The article demonstrates the
  complementary push path — one hook script + per-harness wrapper — that works
  even for harnesses whose transcript files we do not parse yet. If a
  push-ingest endpoint exists (#1248 landed the artifact-source interface), a
  hook emitting to it is the cheapest possible "N-th harness" adapter.
- **The per-harness event mapping below is directly reusable** as the
  compatibility table for any hook-based component: which event exists where,
  what it is called, and which events can inject context.
- **Injection points are the delivery channel `/recs` doesn't have.** A
  `SessionStart` hook that pre-computes recommendations locally and injects
  them would deliver `/recs` guidance automatically in any harness — same
  local-only guarantee, no skill invocation needed. (Cross-harness, unlike the
  Claude-only `/recs` skill.)
- **Convergent memory shape validates the parser target.** Markdown files with
  YAML frontmatter at semantic paths is now the shape used by Anthropic skills,
  Karpathy's LLM wiki, this article's memory store, and our own
  `~/.claude/projects/<slug>/memory/*.md` parsing (`parse-memories.ts`). Bets
  on that shape (frontmatter-declared lifecycle, #2233) are aging well.
- **Caution the article itself supplies:** hook latency is paid on every event.
  Any hook-based component we ship must stay log-and-inject only; consolidation
  belongs in a batch job (which is also where a *local* model per ADR 0018, or
  a governed server call per ADR 0008, would slot).

## Mined References (verified 2026-07-15)

Per the auditable-claims convention (and the #2644 precedent), every reference
was independently checked: the URL resolves, the attribution matches, and the
content supports the claim the article uses it for.

| # | Reference | URL | Supports | Verified |
|---|---|---|---|---|
| 1 | Harrison Chase, *Your harness, your memory*, LangChain blog, 2026-04-11 | https://www.langchain.com/blog/your-harness-your-memory | The vendor-lock-in framing: closed harnesses behind APIs mean you don't own your memory; open harnesses preserve switching freedom | ✓ resolves; author/date/argument match |
| 2 | `tomasonjo/agent-memory-hooks-neo4j` (the article's implementation) | https://github.com/tomasonjo/agent-memory-hooks-neo4j | Complete working code: shared `hooks/` + `dream/` scripts, per-harness configs `.claude/settings.json`, `.codex/hooks.json`, `.cursor/hooks.json` | ✓ exists; structure matches article; no license file found — treat as reference, not vendorable code |
| 3 | Claude Code hooks reference | https://code.claude.com/docs/en/hooks | Event names, JSON stdin/stdout contract, `hookSpecificOutput.additionalContext` injection at `SessionStart`/`UserPromptSubmit` | ✓ all five article events exist; see corrections below |
| 4 | Cursor agent hooks docs | https://cursor.com/docs/agent/hooks | Cursor fires the same lifecycle events; `beforeSubmitPrompt` is Cursor's `UserPromptSubmit`; config in `.cursor/hooks.json` (project) or `~/.cursor/hooks.json` (user) | ✓ verified; Cursor names are camelCase (`sessionStart`, `preToolUse`, `stop`) |
| 5 | OpenAI Codex hooks docs | https://developers.openai.com/codex/hooks | Codex supports `SessionStart`, `UserPromptSubmit`, `PreToolUse`/`PostToolUse`, `Stop` (plus `PermissionRequest`, `PreCompact`/`PostCompact`, `SubagentStop`); `SessionStart` stdout feeds model context via `hookSpecificOutput.additionalContext` | ✓ verified; contract mirrors Claude Code's |
| 6 | Karpathy, *LLM Knowledge Bases* + `llm-wiki` idea file, 2026-04-03/04 | https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f | "The same shape Karpathy and others have been gravitating toward for personal LLM memory": an LLM-owned directory of interlinked markdown files (entity/concept pages, index, log) | ✓ gist exists and predates the article by ~5 weeks; shape matches |
| 7 | Anthropic Agent Skills format | https://code.claude.com/docs/en/skills (open standard: https://agentskills.io) | "The same shape Anthropic's skills already use": a directory with `SKILL.md`, YAML frontmatter + markdown prose | ✓ verified, including the cross-tool Agent Skills standard |
| 8 | "Official Neo4j MCP" | https://github.com/neo4j/mcp | Plugging MCP CRUD access into the memory layer | ✓ official product server exists; note the Labs collection https://github.com/neo4j-contrib/mcp-neo4j also ships a dedicated `mcp-neo4j-memory` server, closer to the article's use case |
| 9 | Model Context Protocol (background) | https://modelcontextprotocol.io | The "MCP tools are agent-initiated" contrast | Background standard; not independently re-verified |

**Corrections / precision notes** (the article simplifies; components built on
this mapping should use these):

- The article calls `Stop` "when the session ends." In Claude Code and Codex,
  `Stop` fires at **end of turn**; session termination is `SessionEnd` (Claude
  Code) / `sessionEnd` (Cursor). A hook treating `Stop` as session-end will
  fire many times per session.
- Event names are **not** byte-identical across harnesses: Cursor uses
  camelCase (`sessionStart`, `beforeSubmitPrompt`, `preToolUse`, `stop`) and
  has extra shell/MCP/file-scoped events; Claude Code and Codex use PascalCase.
  "Remarkably standardized" holds at the semantic level — same payload shape,
  same stdout-injection idea — but a dispatcher still needs a name-mapping
  layer (the article's repo handles this with per-client wrappers).
- Claude Code's hook surface is far larger than the five events used here
  (30+ events, exit-code semantics where exit 2 blocks). The five-event subset
  is exactly the portable core — which is the useful fact for us.

## Existing Coverage

| Observation | Status | Evidence / issue |
|---|---|---|
| Multi-harness ingest via parse adapters (Codex) | Backlog | #1260, epic #1247; `CHD_INGEST_CODEX=1` (#1756) |
| Third-harness ingest (OpenCode) | Backlog | #2571 |
| Push-ingest endpoint / artifact-source interface | Implemented | #1248 (closed, epic-1247) |
| Hook-based live ingest as an N-th-harness adapter | Gap | This note; would be opt-in per the non-local-data rule if it needs a server endpoint |
| Cross-harness recs delivery via SessionStart injection | Gap | This note; `/recs` today is a Claude-only skill |
| Memory files as YAML-frontmatter markdown, parsed locally | Implemented | `src/lib/parse-memories.ts`; [../memory-lifecycle-schema.md](../memory-lifecycle-schema.md) |
| Memory consolidation lifecycle (merge, expiry, audit) | Backlog | Epic #2233; #2186 context filesystem |
| Hook timing observability from transcripts | No action | [../hook-timing-spike.md](../hook-timing-spike.md) — per-tool hook timing is not persisted (#134 closed as unsupported) |

## Release / Watch Signals

- Meaningful signals: changes to the hooks contract in any of the three
  harnesses (new events, payload changes, injection semantics) — already
  covered by the README watchlist rows for Anthropic/Claude Code, Cursor, and
  OpenAI/Codex.
- Notable release signals: a harness shipping first-party cross-session memory
  (would sharpen the lock-in argument and the value of external memory).
- Follow-up issue: none yet; file against epic #1247 when hook-based ingest or
  injection becomes actionable.
- No-action notes: we do not need Neo4j — the storage choice is incidental
  (author works there); the portable ideas are the hook seam, the three-layer
  split, and the markdown-wiki memory shape.

## Follow-up

- Backlog issue: none filed yet — capture "hook-based N-th-harness ingest
  adapter" and "SessionStart recs injection" against epic #1247 when groomed.
- Documentation issue: none.
- No follow-up: Neo4j-specific modeling (linked-list event graph) — interesting
  but our store is the filesystem + parsers.
