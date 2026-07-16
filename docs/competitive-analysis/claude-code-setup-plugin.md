# Competitive analysis: Anthropic `claude-code-setup` plugin

## Source

- URL: https://github.com/anthropics/claude-plugins-official
- Date captured: 2026-07-09
- Category: Adjacent product — first-party static setup recommender
- Related issues: #1312, #2178
- Release/watch cadence: periodic checks of
  `anthropics/claude-plugins-official` releases and Claude Code guidance/changelog
- Last checked: 2026-07-09

## What It Is

The `claude-code-setup` plugin is part of Anthropic’s official plugin bundle and
currently exposes a read-only skill (`claude-automation-recommender`) that scans a
repository and recommends setup artifacts (hooks, skills, MCP servers, subagents,
plugins). It is primarily static analysis of codebase structure and existing
config references. It is a one-shot, stateless, template/lookup-driven pass over
five reference inputs and a short web-refresh path, then emits a concise set of
first-recommendations.

## User Job

For a new or evolving Claude Code workspace, users need the “quickest way to
stand up a reasonable agent setup” without first understanding the entire
ecosystem of hooks, subagents, tools, MCP, and plugin surfaces.

## What It Does Well

- **First-party, free, and low-friction**: it is bundled under official Anthropic
  plugin channels with minimal install burden.
- **Cold-start ownership**: it solves the setup question well by scanning a codebase
  and recommending an initial stack before any session history exists.
- **Template and catalog alignment**: recommendations map to current official
  conventions and can bootstrap users to known-good resource families quickly.
- **Stable recommendation scope**: generally 1–2 recommendations per category, so
  users get a compact first action list.

## Where Claude History Dashboard Is Stronger

- **Real history over static assumptions**: recommendations are grounded in local
  run-time evidence (`~/.claude` transcripts, usage history, sessions), not
  static repository shape alone.
- **Auditability and trust signals**: recommendations are linked to observed
  artifacts with explicit provenance and fix validity labels in the recommendation
  engine.
- **Causal proof loop**: the dashboard can test whether a recommendation changed
  behavior via replay experiments and outcomes, rather than only proposing a setup
  pattern.
- **Vendor neutrality and continuity**: the engine remains positioned on cross-run,
  cross-model workflow optimization, not a “best-practices recipe catalog” tied to
  one provider’s current recommendations.

## Product Implications

- Treat the plugin as a **conceded cold-start surface**. The dashboard should
  frame itself as a “setup-started, now evidence-driven” layer that activates after
  history accrues.
- Tighten language around setup framing to distinguish static recommendations from
  behavioral proof: “what to configure” versus “what actually changed outcomes.”
- The principal threat is not the initial static recommender itself, but if Anthropic
  enriches it with transcript/history/usage inputs; that is where static and
  behavioral competitors converge.
- This makes the **static-setup → behavioral-proof funnel** explicit:
  onboarding bootstrap (plugin) → real-session evidence (`Claude History Dashboard`).

## Existing Coverage

| Observation | Status | Evidence / issue |
|---|---|---|
| Static setup recommendation surfaced from repo shape | Implemented / Deferred (as first-party product) | This note tracks threat posture only |
| Real history/causal recommendation loop | Implemented | Recommendation engine + `/recs` provenance (`src/lib/detectors/`, `src/types.ts`) |
| Dynamic recommendations from usage/transcript history | Gap / Deferred | would erode static-vs-behavioral distinction; monitor as threat signal |
| Recs that can prove outcome changes | Implemented | Shadow/replay + evidence flow in recommendations pipeline |

## Release / Watch Signals

- Meaningful signals: plugin adds history usage / usage API / transcript inputs; changes
  recommendation granularity from static scan to behavioral adaptation.
- Notable release signals: first-party plugin starts recommending from `~/.claude`
  history, usage data, or transcript-derived evidence.
- Follow-up issue: #1312; continue tracking under #926
- No-action notes: no automation; docs-only watch updates until signal becomes
  strategically executable.

## Follow-up

- No new implementation issue for this static-setup watch item.
- Documentation issue: keep this note and watch entries synchronized under
  `docs/competitive-analysis/README.md` and `#1312`.
- No follow-up: avoid implementation overlap with existing docs-only competitive watch.
