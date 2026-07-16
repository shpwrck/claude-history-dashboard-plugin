# rh-agent (micytao/rh-agent)

## Source

- URL: https://github.com/micytao/rh-agent
- Date captured: 2026-06-17
- Category: Adjacent product (vertical skill-pack distribution of an agent runtime)
- Related issues: #1877 (this note); docs-tracking #926

## What It Is

A Node.js CLI that wraps the **Pi coding-agent runtime** with a Red Hat-specific
skill pack ("Lola" skills, sourced from `RHEcosystemAppEng/agentic-collections`).
From the README:

> "Red Hat Agent -- a Node.js CLI that embeds the Pi coding agent runtime with Red
> Hat agentic skills for CVE analysis, lifecycle management, diagnostics, and
> support case guidance."

It is a **vertical distribution** of an existing agent runtime — domain skills
(CVE Explainer, Diagnostics Guide, Product Lifecycle/EOL, Support Severity,
Security MCP) delivered through a packaged TUI. Multi-provider LLM front-end
(OpenAI / Anthropic / Gemini / Azure / custom OpenAI-compatible) with runtime
model switching, MCP integration for authoritative Red Hat security data, and a
container-native deploy story (rootless Podman/Docker, persistent container for
fast relaunch, non-interactive CI setup, keys in `~/.rh-agent/`).

Tech stack: TypeScript (~76%), Shell (~14%), JavaScript (~8%); `Containerfile`,
`install.sh`, `build.sh`.

## User Job

Give Red Hat enterprise customers (DevOps/SRE, security engineers, support
professionals) a ready-made agent that already knows Red Hat domain tasks — so
they can ask about CVEs, EOL dates, diagnostics collection (sos report,
must-gather), and support-case severity without assembling skills or wiring MCP
themselves. It is about domain *delivery*, not agent measurement.

## What It Does Well

- **Curated vertical skill pack** delivered turnkey on top of a generic runtime —
  the same skills-distribution mechanic we use for `~/.agents/skills`, but
  pre-loaded for a named domain.
- **Multi-provider, vendor-neutral** front-end with runtime model switching (not
  Claude-only); MCP wired to authoritative first-party (Red Hat security) data.
- **Container-native ergonomics:** rootless execution, persistent container for
  near-instant relaunch, non-interactive CI setup, local key storage.

## Where Claude History Dashboard Is Stronger

- **No session history, analytics, cost, recommendation, or evaluation layer at
  all.** rh-agent stores config in `~/.rh-agent/`; it does not read or analyze
  agent history. Our entire product — observability and coaching over real
  history — is absent here.
- **Local-history moat untouched.** We parse real `~/.claude` (and cross-harness)
  sessions to measure cost/speed/accuracy and run causal workflow experiments;
  rh-agent is a *producer* of sessions, not an analyzer of them.
- Same gap pattern as **Omnigent** (see [team-observability](./team-observability.md)
  framing and project memory `competitor-omnigent-databricks`): a consumer/
  distributor of agent runtimes with no retrospective-analytics ambition.

## Product Implications

- **Adjacent, not a rival.** It competes for "give users a useful agent in domain
  X," not for "prove which agent workflow is cheaper/faster/more accurate." The
  proof-engine / local-history / causal-experiment moat is uncontested.
- **Potential data source, not a threat.** Its multi-provider design means the
  sessions it produces are not even Claude-only — exactly the kind of
  cross-harness history Probaitio's engine is built to instrument. The
  "instrument it, don't fight it" response we settled on for Omnigent applies.
- **Vertical skill-pack as a distribution pattern** worth noting: a named-domain
  curated pack on top of a generic runtime is a credible go-to-market wedge. Our
  analog is recs-as-skills, but the packaging idea is reusable.

## Existing Coverage

| Observation | Status | Evidence / issue |
|---|---|---|
| No analytics/cost/recs/eval layer (pure delivery) | No action | Positioning context; our observability+coaching boundary is unchallenged |
| Multi-provider sessions are an instrumentation target | No action | Aligns with vendor-neutral / cross-harness direction (memory: `mission-statement-defensible`) |
| Vertical skill-pack distribution mechanic | No action | We already ship recs-as-skills; note only |

## Follow-up

- Backlog issue: none — no actionable implementation scope.
- Documentation issue: #1877 files this note; tracked under docs #926.
- No follow-up: this is positioning/instrumentation context only; do not re-file
  as a build item.
