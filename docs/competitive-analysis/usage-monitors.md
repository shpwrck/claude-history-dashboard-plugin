# Usage monitors and CLI cost tools

## Source

- ccusage (ryoppippi): https://github.com/ryoppippi/ccusage ; https://ccusage.com/
- Claude-Code-Usage-Monitor (Maciek-roboblog): https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor
- ccflare / ccstatusline / claude-doctor: the JSONL-parsing tool family (see https://claudefa.st/blog/tools/monitors/claude-code-usage-monitor)
- MyTokenTracker: https://mytokentracker.io/
- Date captured: 2026-06-09
- Category: Direct competitor (narrow: spend & limits)
- Related issues: #926

## What It Is

The narrow-but-popular layer of the market: CLI/terminal tools focused on token
spend and rate-limit prediction rather than full analytics. ccusage is the
category-defining baseline everyone benchmarks against.

| Tool | Form | Emphasis |
|---|---|---|
| ccusage | CLI | The baseline: token/cost from local data; the reference point |
| Claude-Code-Usage-Monitor | terminal, live (~3s refresh) | **ML burn-rate prediction**, limit warnings, color progress bars |
| ccflare | proxy/dashboard | Routing/proxy plus usage view |
| ccstatusline | statusline | Spend in the Claude Code statusline |
| claude-doctor | CLI | Diagnostics over local session files |
| MyTokenTracker | **cloud** | Per-project cost; **community calibration** (the non-local counterpoint) |

## User Job

A solo dev wants fast, low-friction answers to "how much have I spent" and "when
will I hit my limit" — in the terminal, not a browser.

## What It Does Well

- **Lowest friction**: `npx ccusage` and you have numbers, no server.
- **Burn-rate prediction and limit warnings** (Claude-Code-Usage-Monitor) — a
  forward-looking lens we mostly lack (we are historical/explanatory).
- Statusline presence (ccstatusline) keeps spend in-flow.
- **Community calibration** (MyTokenTracker) — crowd-sourced cost baselines to
  judge whether your spend is normal.

## Where Claude History Dashboard Is Stronger

- We explain *why* spend happened (context = ~84% of bill, per project memory),
  not just the total. CLIs report; we attribute and recommend.
- Persistent visual analytics, context health, recommendations, `/insights`.
- Live-from-disk server architecture.

## Product Implications

- **Predictive / burn-rate lens is a gap.** We are strong on hindsight; a
  "projected spend / time-to-limit" view (reusing `session-usage` window data)
  would answer the question these monitors own. Candidate issue.
- **Community calibration** (MyTokenTracker) is interesting but collides with our
  local-first / no-phone-home stance — only viable as opt-in aggregate, and it
  intersects the multi-tenant Coach epic (#467). Likely Deferred.
- We should not try to out-CLI ccusage; our wedge is explanation + coaching, not
  a faster number. Keep positioning on "why and what next," not "the total."

## Existing Coverage

| Observation | Status | Evidence / issue |
|---|---|---|
| Token/cost totals from local data | Implemented | Cost Attribution, Token Usage views |
| Cost attribution by project/session (the "why") | Implemented | Cost Attribution view |
| Predictive burn-rate / time-to-limit | Backlog | #987 — build a projection view (decided 2026-06-09); reuse `session-usage` windows |
| Statusline spend surface | Gap | overlaps vibe-log statusline gap (recs statusline → #988) |
| Community / crowd cost calibration | Deferred | collides with local-first; intersects #467 multi-tenant |

## Follow-up

- **Predictive spend / time-to-limit view → #987** (pairs with the plan-limit
  bar #986 — shared 5h/weekly windows; keep the projection explanatory).
- Community calibration: Deferred (do not re-file; revisit only via #467).
