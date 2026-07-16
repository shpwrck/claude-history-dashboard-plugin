# Her / हेर

## Source

- Article: https://huggingface.co/blog/build-small-hackathon/her-blog
- Date captured: 2026-06-09
- Category: Adjacent product
- Related issues: #807, #926

## What It Is

Her is positioned as a detective for Claude Code sessions. Users drop one or
more session files into the app, and it reconstructs what happened, explains the
session in plain English, flags risky moves, traces findings back to exact
turns, and supports questions through an "Ask Her" copilot.

The article says Her reads Claude Code JSONL traces, shows where tokens went,
which tools/subagents/skills/MCP servers were used, and suggests improvements
only when named, fixable patterns fire. Its deterministic engine owns the
findings; the model is used for English and softer suggestions.

## User Job

When reviewing a Claude Code session, the user wants a forensic answer to what
happened, why risky actions occurred, where tokens went, and which exact turns
support those conclusions.

## What It Does Well

- Strong forensic framing: a session detective rather than a generic dashboard.
- Exact-turn evidence is central to the experience.
- Risky actions such as deploys, config changes, production changes, database
  actions, and secret-sensitive behavior are product-level concepts.
- The graph/report split gives both deep investigation and executive summary.
- Ask answers cite trace evidence and open the relevant tool call.
- Tool identification goes beyond command names by using a tool database.
- Clear trust boundary: deterministic findings first, generated language second.

## Where Claude History Dashboard Is Stronger

- Already has broad cross-session analytics over live `~/.claude` data.
- Includes persistent views for cost, context, permissions, files, tools,
  errors, recommendations, `/insights`, and session timelines.
- Has a local recommendation engine that feeds both UI and agent behavior.
- Supports both live server mode and upload-only SPA mode.
- Tracks long-term trends and repeated patterns across the user's history.

## Product Implications

- The dashboard should make evidence links a first-class data model, not a UI
  afterthought.
- Ask Claude should cite exact deterministic evidence: session, turn, timeline
  entry, and tool call where possible.
- Risky-action scanning deserves a deterministic parser/recommendation pathway.
- A session-level forensic graph could complement Session Timeline and
  SessionTranscript for deep investigations.
- The product language "detective" is a useful reminder: not every chart needs
  to exist, but every important claim should have evidence.

## Existing Coverage

| Observation | Status | Evidence / issue |
|---|---|---|
| Broad Claude Code session analytics over local/uploaded data | Implemented | README feature list, live server, upload-only SPA |
| Session timeline and detail drill-in | Implemented | Session Timeline, SessionTranscript, #205, #817 |
| Trace-bound citations for Ask answers | Backlog | #807 |
| Value-flow / provenance detection | Backlog | #807 |
| Session forensic graph | Backlog | #807 |
| Risky action scanner parity | Backlog | #807 |
| Model-deceit / false-claim detection | Backlog | #683, #924 |

## Follow-up

Issue #807 tracks the first parity epic:

- Her-style value-flow/provenance detection.
- Her-style graph visualization.
- Trace-bound Ask citations.
- Risky action scanner parity.

Static transcript export and Gist publishing are intentionally outside that
epic and should be tracked separately if pursued.
