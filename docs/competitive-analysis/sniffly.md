# Sniffly

## Source

- URL: https://github.com/chiphuyen/sniffly ; https://sniffly.dev/
- Date captured: 2026-06-09
- Category: Direct competitor
- Related issues: #926

## What It Is

Sniffly (by Chip Huyen) is a local Claude Code analytics dashboard. After
`sniffly init` it serves a browser dashboard at `localhost:8081` built from the
user's `~/.claude` logs. It is the closest public analogue to this product:
same job, same user, same data source. It reached the Hacker News front page and
has a hosted marketing site at `sniffly.dev` with public shared examples.

## User Job

A Claude Code user wants a local, browsable view of their own usage — stats,
errors, and patterns — without sending data to a cloud service.

## What It Does Well

- **Error analysis** is a first-class section, not a buried chart.
- **Shareable dashboards**: a user can publish a snapshot to a `sniffly.dev/share/<id>`
  URL. This is a social/distribution loop we do not have.
- Performance work and memory caching for fast local loads.
- A clean CLI install (`sniffly init`) lowers the on-ramp.
- Established mindshare (HN front page, dedicated domain).

## Where Claude History Dashboard Is Stronger

- **Live-from-disk server**: data recomputes on every request; the "Reload from
  disk" button picks up brand-new sessions with no rebuild/restart. Sniffly is
  init-and-load oriented.
- Far broader view surface: cost attribution, context health, permissions, file
  impact, runtime events, recommendations, and native `/insights` ingestion.
- A local **recommendation engine** ("Claude Coach") that feeds both UI and
  agent behavior, plus the efficiency-accounting direction.
- Dual mode: live local server **and** public synthetic-data sample.

## Product Implications

- **Shareable dashboards are the headline gap.** A read-only, redacted snapshot
  export (single-file HTML or a short-lived share link) would close the most
  visible feature delta and create a distribution loop.
- Keep error analysis at least at parity — Sniffly makes it a primary section;
  verify our Error & Retry view reads as a destination, not a sub-tab.
- The `sniffly init` one-command on-ramp is worth matching for first-run UX.

## Existing Coverage

| Observation | Status | Evidence / issue |
|---|---|---|
| Local Claude Code analytics over `~/.claude` | Implemented | README; live server |
| Error & retry analysis | Implemented | Error & Retry view |
| Shareable / exportable dashboard snapshot | No action | decided not to build 2026-06-09 — collides with local-first / no-phone-home and is off the explanatory thesis |
| One-command install / first-run on-ramp | Gap | candidate issue |

## Follow-up

- Shareable dashboard snapshot: **No action** (decided 2026-06-09). Do not
  re-file; revisit only if the privacy stance changes or distribution becomes a
  priority. (Per-session transcript export remains separately tracked under #807.)
- No follow-up on error analysis (at parity).
