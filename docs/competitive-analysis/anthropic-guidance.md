# Anthropic And Claude Code Guidance

## Source

- Anthropic docs, changelogs, blog posts, cookbook examples, pricing pages, and
  Claude Code release material.
- Date captured: 2026-06-09
- Category: External reference
- Related issues: #656, #189, #926

## What It Is

This note tracks Anthropic and Claude Code material as an input stream for the
dashboard. These sources are not competitors. They are upstream guidance for:

- Parser updates when Claude Code writes new artifacts or fields.
- Recommendation rules when Anthropic documents a best practice.
- Pricing and model updates that affect cost attribution.
- UX language for features such as prompt caching, context management, tool use,
  model selection, and agent workflows.

## User Job

When Anthropic changes Claude Code, model behavior, pricing, or recommended
agent patterns, dashboard users need the app's analysis and recommendations to
stay current without losing auditability.

## What It Does Well

- Provides authoritative semantics for Claude Code and Anthropic API behavior.
- Names model, pricing, prompt-caching, and tool-use details that should not be
  guessed.
- Supplies source material for recommendation rules and threshold changes.
- Helps distinguish first-party capabilities from community conventions.

## Where Claude History Dashboard Is Stronger

- Applies guidance to the user's observed local history.
- Keeps request-time recommendation evaluation deterministic and offline.
- Can show whether a rule fires, whether a fix is already applied, and whether
  behavior changes over time.

## Product Implications

- Anthropic material belongs in this docs area when it informs product direction
  or recommendation design.
- Parser-level source facts still belong in [../REFERENCES.md](../REFERENCES.md).
- Executable recommendation logic belongs in code and must be reviewed through
  normal PRs.
- Do not add live LLM-generated recommendations at request time just because an
  external source suggests a new practice. #189 keeps the engine deterministic:
  external guidance proposes rule changes; the app evaluates reviewed rules.

## Existing Coverage

| Observation | Status | Evidence / issue |
|---|---|---|
| External guidance ingestion as a durable product stream | Backlog | #656 |
| Dynamic rule-engine design that emits reviewed PRs, not runtime rules | Implemented docs / design | #189, [../adr/0002-dynamic-recommendation-rule-engine.md](../adr/0002-dynamic-recommendation-rule-engine.md) |
| Parser/source mapping for Claude Code artifacts | Implemented / active backlog | [../REFERENCES.md](../REFERENCES.md), #704 |
| Pricing updates for cost attribution | Implemented / ongoing | `src/lib/pricing.ts`, cost and v0.4 efficiency issues |
| Ask Claude direct API use | Implemented with explicit user key | `src/lib/claude-api.ts`, Settings |

## Follow-up

Use #656 for new external-guidance ingestion work. When a specific Anthropic
source implies a parser change, check REFERENCES.md and #704 before filing a
new issue. When it implies a recommendation rule, check existing detector IDs
and ADR 0002 before creating a rule-authoring issue.
