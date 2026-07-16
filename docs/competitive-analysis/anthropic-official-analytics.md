# Anthropic official Claude Code analytics

## Source

- Analytics dashboard: https://code.claude.com/docs/en/analytics (claude.ai/analytics/claude-code)
- Analytics Admin API: https://platform.claude.com/docs/en/build-with-claude/claude-code-analytics-api
- Agent SDK cost tracking: https://platform.claude.com/docs/en/agent-sdk/cost-tracking
- Date captured: 2026-06-09
- Category: Direct competitor (the build-vs-buy baseline)
- Related issues: #926, #656, #2178
- Related notes: [claude-code-setup-plugin.md](./claude-code-setup-plugin.md)

## What It Is

Anthropic's own first-party analytics for Claude Code. Org admins/owners get a
hosted dashboard (usage metrics, contribution metrics, leaderboards), and an
**Analytics Admin API** exposes daily aggregated per-user metrics for building
custom dashboards. This is the "why not just use the official thing" baseline
every competitor in this space is measured against.

(Distinct from `anthropic-guidance.md`, which tracks Anthropic docs/pricing as an
*input stream*. This note tracks the official analytics product as a *competitor*.)

## User Job

An org admin wants official, authoritative usage and productivity metrics across
their team without trusting a third-party tool.

## What It Does Well

- **Authoritative and first-party**: numbers come straight from Anthropic, no
  parsing or estimation. Our cost is estimated (`src/lib/pricing.ts`); theirs is
  ground truth.
- **Org/team aggregation and leaderboards** built in.
- **Admin API** for custom dashboards — a programmatic surface we cannot match
  for billing-accurate, cross-org data.
- Zero setup for orgs already on Claude Code.

## Where Claude History Dashboard Is Stronger

- **Per-session forensic depth on the individual's own machine**: context health,
  permissions, file impact, tool/retry behavior, subagents, `/insights`
  rendering — the official dashboard is aggregate org metrics, not session-level
  introspection.
- **Local-first / no-cloud**: works air-gapped, no org admin, no data leaving the
  machine. The official dashboard requires org membership and is cloud-hosted.
- **Coaching**: a recommendation engine, not just metrics and leaderboards.
- Works for **individuals** (incl. Pro/Max solo users) who have no org dashboard
  at all.

## Product Implications

- Our defensible position is exactly what the official product is not: **local,
  individual, session-level, explanatory, coaching**. Keep positioning there;
  do not try to out-aggregate the first party.
- The Analytics API could be an **optional reconciliation source** — calibrate our
  estimated cost against Anthropic's authoritative numbers where a user has API
  access. Candidate, but it touches the "no api.anthropic.com on the free path"
  invariant: must be opt-in / server-side, never the default local path. Relates
  to external-guidance ingestion (#656).

## Existing Coverage

| Observation | Status | Evidence / issue |
|---|---|---|
| Individual local session-level analytics | Implemented | README; live server |
| Estimated cost from pricing table | Implemented | `src/lib/pricing.ts` |
| Authoritative cost via official Analytics API | Gap / Deferred | opt-in only; respects no-free-path-egress invariant; relates #656 |
| Org aggregation / leaderboards | No action | first-party owns this; not our wedge |

## Follow-up

- Candidate (Deferred): **opt-in cost reconciliation** against the Analytics API
  for users with org/API access — gated on the server LLM-usage governance rules.
- Org-aggregation parity: No action — deliberately not our market.
