# Code-search "graph tools" — SCIP / LSP / ast-grep landscape

**Category:** External reference / adjacent products. The third tier of the
agent code-search stack (lexical → structural → graph), and the products that
ship it to coding agents.

**Captured:** 2026-06-28 (fan-out web research). Numbers are vendor/preprint
figures unless noted; flag before re-citing externally.

---

## 1. What the source is

A cluster of tools that give AI coding agents **reference-resolving** search —
"who actually calls `processPayment()`" — instead of text matching. This is the
third tier above `grep` (lexical) and `ast-grep` (structural). Two mechanisms:

- **Protocol-indexed code graphs (SCIP / LSIF).** Sourcegraph's SCIP (2022,
  replaced LSIF) is a Protobuf schema with human-readable symbol strings
  (`scheme package descriptor`), compiler-accurate per-language indexers
  (scip-typescript, scip-java, rust-analyzer, scip-clang), cross-repo resolution
  by joining on the symbol string. Adopted by Meta/Glean and Mozilla Searchfox.
  Exposed to agents via the **Sourcegraph MCP server** (`go_to_definition`,
  `find_references`, `read_file` with ranges, …). Lexical layer is **Zoekt**
  (trigram index, sub-50ms on Android-scale).
- **LSP / AST live tools (no heavy pre-index).** Wrap a Language Server behind
  MCP for go-to-def / find-refs / call-hierarchy / rename. Maturity gradient:
  - **Serena** (oraios, ~25.8k stars) — symbol-level, 40+ languages, the mature
    one; "collapses 8–12 steps into one atomic call."
  - **agent-lsp** (Blackwell) — 65 CI-verified tools, 30 langs, `blast_radius`.
  - **mcp-language-server** (isaacphi) — the reference bridge.
  - **gopls native MCP** (Go team, experimental, first-party).
  - **Claude Code native LSP** (v2.0.74, Dec 2025) — exists, 11 langs, but HN
    reports it as "janky" and *the model rarely reaches for it without prompting*
    (~50ms find-refs vs ~45s grep).
  - **ast-grep** — Tree-sitter structural matching (code *shape* not text);
    MCP + Claude Code skill; ~75% fewer tokens (text mode). Nov-2025 note: the
    model "cannot automatically detect when to use ast-grep."
  - **codebase-memory-mcp** (DeusData) — already tracked separately; Tree-sitter
    (158 langs) + hybrid LSP (9 families) + vector + git-diff impact.

## 2. Which user job it serves

Coding agents (and their harnesses) doing **retrieval over a large codebase**:
finding definitions, all callers, type/impl hierarchies, and impact radius —
where flat grep returns false positives on same-named symbols and full-file
reads blow the context budget.

## 3. What it does better than this app

It is *retrieval infrastructure* — it actually resolves references. The dashboard
does not retrieve code; it analyzes agent history. Token-efficiency evidence:

- **Sourcegraph CodeScaleBench** (370 tasks, 40+ repos, 1,281 runs): MCP graph
  vs baseline grep/read → file recall **0.127 → 0.277**, P@5 **0.140 → 0.478**,
  cost **$0.73 → $0.51 (~30%)**, **38% faster**. Understanding one function's
  cross-repo usage ≈ **4K tokens (graph) vs ~48K (grep+read)**.
- **codebase-memory-mcp preprint** (arxiv 2603.27277, 31 repos, 372 Qs): **10x
  fewer tokens, 2.1x fewer tool calls, at 83% of file-read quality** (the "120x"
  is best-case call-chain only). ⚠️ verify arxiv id before external citation.

Costs they carry: build-time indexing (scip-clang +30–50% compile), staleness
(point-in-time snapshots), language gaps (no Terraform/SQL/protobuf, weak on
macro-heavy C / dynamic dispatch), self-host infra, and "MCP death spirals" when
the index breaks and the agent burns context retrying.

## 4. What this app does better

Nobody in this space measures **whether the agent routed to the right tool.**
Cursor ships instant grep, Sourcegraph ships the graph, Serena ships the LSP
tools — they ship the *capability*, not the meta-analysis of whether the agent
*chose* it. The recurring failure mode across every source is identical: **the
tool exists but the model doesn't reach for it** (Claude Code's native LSP goes
unused; ast-grep needs explicit injection). That routing gap, measured over real
`~/.claude` history, is exactly the dashboard's lane.

## 5. Product implications

- **Validates the right-tool / routing thesis** behind the recs engine and the
  `fff-file-search-mcp-cost` and `codebase-memory-mcp` trial notes: when search
  is ~free, the *choice* of tier becomes the dominant lever on cost + accuracy.
- The defensible recommendation is **"the agent didn't route to the available
  tool,"** not "use grep" (table stakes) or "build a code graph" (commoditized,
  and explicitly out of the dashboard's product boundary — see §7).
- Three-tier framing for any future tool-selection detector: lexical (grep/Zoekt)
  → structural (ast-grep/Tree-sitter) → graph (SCIP/LSP). But the signal is the
  **routing miss**, and it is harness-dependent (don't flag a tool the active
  harness lacks).

## 6. What is already implemented here

- Repo-map is **syntactic Tree-sitter only** (ADR 0007) — imports + symbol
  signatures, no type resolution, no call graph. The
  `context.repo-map-context-waste` detector computes centrality from import edges.
- **No "right tool" / tool-appropriateness detector exists.** The catalog scores
  tool *effectiveness / utilization / cost* (`tool-call-right-sizing`,
  `idle-mcp-tools`, `low-tool-effectiveness`, `tool-errors`), not whether the
  right tool was *chosen*.
- Domain language (`CONTEXT.md`, `REFERENCES.md:84`) **bans** "code graph / AST
  dump / symbol table" as naming — name the artifact/outcome, not the mechanism.

## 7. Open follow-up issues

- **#2254** — net-new `workflow.right-tool-selection` (routing-gap) detector.
- Related: **#2020** (codebase-memory-mcp trial), `fff` trial note.

## 8. Non-goals / deferred

- **Do not build a code graph / SCIP indexer / LSP integration in the dashboard.**
  That is retrieval infrastructure, outside the observability-and-coaching
  product boundary (README §Product Boundary). These tools are *instrumentation
  targets* (does the agent route to them?), not features to clone.
- Cursor instant grep mechanics (sparse n-gram index, 13ms) are captured for the
  routing thesis, not as something to reimplement.
