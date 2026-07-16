# Team / org observability (OTel + LLM observability platforms)

## Source

- claude-code-otel (ColeMurray): https://github.com/ColeMurray/claude-code-otel
- SigNoz + Claude Code OTel hooks: https://signoz.io/
- Langfuse: https://langfuse.com/ (MIT, self-hostable; acquired by ClickHouse 2026-01-16)
- Arize Phoenix: https://phoenix.arize.com/
- Helicone, LangSmith: https://www.langchain.com/langsmith/observability
- Date captured: 2026-06-09
- Category: Adjacent product (becomes a direct competitor if we move to teams)
- Related issues: #926, #467

## What It Is

The team/org layer. Two flavors:

1. **Claude-Code-specific team observability** — claude-code-otel wires Claude
   Code's built-in OpenTelemetry hooks into a self-hosted stack (Grafana/Prometheus
   or SigNoz) for centralized, multi-seat usage/cost/security monitoring.
2. **General LLM observability platforms** — Langfuse, Arize Phoenix, Helicone,
   LangSmith. API/trace-level tracing, cost dashboards, eval/prompt management.
   Provider-agnostic; self-hostable (Langfuse/Phoenix) or SaaS.

## User Job

An engineering manager or platform team wants centralized, multi-developer
visibility into agent usage, cost, and risk — with data residency control.

## What It Does Well

- **Multi-seat aggregation** out of the box (claude-code-otel) — our product is
  single-user / single-`~/.claude` today.
- **OTel-native**: rides Claude Code's official telemetry hooks, so it captures
  live emitted metrics rather than parsing transcript files after the fact.
- General platforms (Langfuse et al.) bring mature **eval, prompt management, and
  trace tooling**, large ecosystems, and proven self-hosting at scale.
- Data-residency story for enterprises (self-host via Docker/K8s).

## Where Claude History Dashboard Is Stronger

- **Claude-Code-native depth**: we parse the actual transcript shape — subagents,
  permissions, `/insights`, retry semantics, file impact — detail that generic
  OTel metrics and provider-agnostic tracers do not capture.
- **Coaching, not just dashboards**: a recommendation engine over real history.
- Zero-setup local-first: no collector, no Grafana, no instrumentation.

## Product Implications

- **claude-code-otel is the competitor we'd meet if we move toward teams.** The
  multi-tenant Coach epic (#467: invite-only SaaS, zero-knowledge at rest) is the
  strategic response — note that #467 deliberately chose client-side encryption
  over a shared OTel backend. Keep that contrast sharp in positioning.
- **OTel ingestion as an alternative data source** is worth a spike: today we
  parse files; Claude Code also emits OTel metrics. Supporting both could capture
  data the transcript lacks and ease the team story. Candidate spike, gated on
  the team-direction decision.
- Do **not** chase generic LLM-observability parity (evals, prompt mgmt) — that
  is a different product. Our wedge is Claude-Code-history depth + coaching.

## Existing Coverage

| Observation | Status | Evidence / issue |
|---|---|---|
| Single-user local analytics depth | Implemented | README; live server |
| Multi-seat / org aggregation | Backlog | #467 (multi-tenant Coach), distinct architecture (client-side encryption, not shared OTel) |
| OTel-metric ingestion as a data source | Gap / Deferred | spike candidate; gate on team direction |
| Eval / prompt-management tooling | No action | different product category |

## Follow-up

- Multi-tenant direction is tracked by #467 — do not re-file; reference it.
- Candidate spike: **OTel-metric ingestion** as a complementary data source
  (deferred until team direction is committed).
