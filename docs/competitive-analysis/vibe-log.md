# vibe-log

## Source

- URL: https://vibe-log.dev/ ; https://github.com/vibe-log/vibe-log-cli
- Date captured: 2026-06-09
- Category: Direct competitor
- Related issues: #926

## What It Is

vibe-log is a CLI ("Strava for coders") that logs and analyzes Claude Code and
Cursor sessions to extract productivity insights and recommendations. It is the
most direct rival to this product's **recommendation / "Claude Coach"** angle
rather than its raw analytics. Local-first: prompts are analyzed on-machine and
"no data leaves your machine."

## User Job

A developer wants ongoing, personalized coaching on how to work better with their
AI coding agent — surfaced in-flow, not just as historical charts.

## What It Does Well

- **Recommendations in the status line**: feedback with concrete next steps
  appears where the user is already working, not only in a separate dashboard.
- Uses Claude Code **sub-agents to analyze sessions in parallel** for reports.
- Personalized standup/productivity summaries from the terminal.
- Turns Claude Code's `/insights` report into **actionable skills, rules, and
  workflows** — directly overlapping our `/insights` ingestion + Recommendations.
- A "share your building journey" social loop.

## Where Claude History Dashboard Is Stronger

- A rich **visual** dashboard across many analytic surfaces, not a statusline +
  report. We can show evidence, trends, and drill-downs vibe-log cannot.
- A **deterministic** recommendation engine with auditable evidence and an
  adoption-scorecard direction (ADR 0005; #573/#575–584), versus model-narrated
  productivity summaries.
- Native `/insights` rendering with all charts, plus our own cross-session
  analytics layered on top.

## Product Implications

- **Statusline delivery is the sharpest competitive lesson.** Our recs engine
  produces agent-facing findings (the SessionStart hook already injects them);
  a vibe-log-style *human* statusline/CLI surface for the same recs would extend
  reach beyond the dashboard tab. Candidate gap.
- vibe-log validates the "/insights → actionable artifacts" thesis we are
  already pursuing — confirms direction, raises the bar on actionability.
- The "Strava for coders" framing (streaks, shareable journey) is a retention
  pattern; pairs with the Sniffly shareable-snapshot gap.

## Existing Coverage

| Observation | Status | Evidence / issue |
|---|---|---|
| Local recommendation engine over `~/.claude` | Implemented | recs engine; `/api/recommendations.json` |
| Agent-facing recs injection | Implemented | SessionStart hook (#511) |
| `/insights` → actionable CLAUDE.md / skills / prompts | Implemented | Recommendations view; `/insights` ingestion |
| Human-facing statusline / CLI rec delivery | Backlog | #988 — build it (decided 2026-06-09); human counterpart to the agent hook #511 |
| Adoption / efficacy measurement of recs | Backlog | ADR 0005; #573, #575–584 |
| Streak / shareable productivity journey | No action | overlaps the Sniffly share decision (No action, 2026-06-09) |

## Follow-up

- **Statusline/CLI surface for the recs engine → #988** (human counterpart to
  the existing agent-facing SessionStart hook #511; local engine only).
- Adoption/efficacy already tracked under ADR 0005 and the #573 family.
- Streak / shareable journey: No action (tracks the Sniffly share decision).
