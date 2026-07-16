# 0010 — Kubernetes substrate: reuse over build, harness-native seam stays ours

Status: Proposed (records the settled architecture of epic #1247 + a first principle)
Date: 2026-06-11
Renumbered: from ADR 0009 (2026-06-11) — resolves a number collision with the hosted-operator
ADR [0009](0009-hosted-k8s-operator-dispatch-aggregation.md) (#1254), which shipped under the same
number in parallel.
Supersedes: none
Related: epic [#1247](https://github.com/shpwrck/claude-history-dashboard/issues/1247)
(vendor-neutral agent-ops substrate — the full spec), #1248 (artifact-source boundary),
#1249 (operator + RemoteSession CRD + shipper), #1250 (config bake + OAuth path),
#1255 (enforced-policy sub-epic — the narrower "don't invent an enforcement runtime"
invariant), #1256 (MCP in pods), ADR [0008](0008-server-llm-usage-governance.md)
(server LLM-usage governance — the egress-scrub + cost-cap rules this composes with),
#467 (multi-tenant, deferred)

## Context

Epic #1247 moves the dashboard from a single-laptop worker to a hosted control plane that
dispatches agent sessions as Kubernetes pods (`RemoteSession` CRD), aggregates their
history from everywhere, and enforces policy at the pod boundary instead of in-process. The
full architecture is specced in #1247 and its sub-issues; this ADR records the load-bearing
*decision posture*, not the spec.

Adopting k8s drags in the whole CNCF ecosystem — and with it a standing temptation: every
cross-cutting concern (network egress, admission control, per-credential budgets, secret
delivery, scheduling, observability, LLM/MCP brokering) has a battle-tested off-the-shelf
component, **and** a tractable-looking custom version. The architecture review in #1247 and
the policy grill in #1255 both kept landing on the same rule from different directions:
reuse the ecosystem enforcer, compile our intent onto it, and reserve custom code for the
seam no ecosystem tool models. #1255 states the narrow form ("don't invent an enforcement
runtime"). This ADR generalizes it to the whole substrate so the next sub-issue doesn't
re-litigate it concern by concern.

A concrete sanity-check that motivated writing this down: the custom "policy engine" was at
risk of re-implementing what an LLM proxy already does. LiteLLM owns per-credential budgets,
rate limits, spend attribution, and pre-call egress scrubbing in the model HTTP path;
agentgateway owns per-identity MCP allowlisting and tool-call/payload policy. Those are
exactly #1255's layer-2-budget, layer-3-scrub, and #1256's allowed-MCP sub-problems — and we
were about to write them by hand.

## Decision

### 1. Reuse over build is the substrate default

Before building any mechanism for a cross-cutting concern, **name the off-the-shelf
component that already does it and justify in the sub-issue why it is insufficient.** Custom
code is the exception and carries the burden of proof. The design work is *compiling one
policy/operational intent onto existing enforcers*, not writing new ones.

Known-good owners, by concern (extend this table as the substrate grows):

| Concern | Reuse | Not |
| --- | --- | --- |
| Network egress allow/deny | NetworkPolicy / Cilium | a custom firewall sidecar |
| Admission / authz at dispatch | Kyverno / OPA-Gatekeeper + admission webhook | a bespoke gatekeeper |
| Per-credential budget / rate / spend | an LLM proxy (LiteLLM) as the credential chokepoint | hand-rolled counters |
| Outbound LLM content scrubbing | proxy pre-call guardrails (Presidio/regex/Bedrock) | a bespoke scrubber in the request path |
| Allowed MCP servers + tool-call policy | an MCP gateway (agentgateway) | per-server NetworkPolicy CIDRs only |
| Secret delivery | k8s Secrets / External Secrets Operator | env-file plumbing |
| Resource / concurrency ceilings | ResourceQuota / LimitRange | custom admission math |
| Syscall confinement | seccomp / AppArmor | a new sandbox |
| Scheduling / pod lifecycle | the operator + k8s Job/Deployment primitives | a custom queue |

### 2. The harness-native seam stays ours

Reuse is the default, **not** a mandate to contort an ecosystem tool into a job it does not
model. Three things are genuinely ours because no off-the-shelf component represents them:

- **The operator's reconcile of `RemoteSession`** (#1249) — dispatch → pod → run → ship →
  appears in the dashboard. LLM proxies have no compute lifecycle; MCP gateways broker
  traffic and explicitly punt orchestration (agentgateway → kagent). kagent is worth
  cribbing for CRD/status ergonomics, but it is harness-agnostic and carries none of our
  bake/shipper/credential model.
- **The config bake + native-sidecar shipper** (#1250, #1249) and the canonical
  `claude-tree-classification` (`config | session-data | secret`) — making a pod behave like
  the laptop and returning its telemetry. No ecosystem tool knows the `~/.claude` tree.
- **The subscription-OAuth credential path** (#1250) — LLM proxies are built for API keys.
  The personal-subscription OAuth path, its in-pod refresh, and ADR 0008's hard rule that
  this credential must never carry `~/.claude` content are ours to enforce. A proxy cleanly
  absorbs the **enterprise-API** credential path's budgets/scrub/spend; the **subscription**
  path does not route through it.

### 3. Precedence is unchanged: enforced policy is a ceiling

Reusing an ecosystem enforcer does not relax #1255's precedence rule. The outer enforced
layer (NetworkPolicy, proxy budget, admission) is authoritative; an in-pod `settings.json`
may only *narrow* it, never widen it. Reuse changes *who enforces*, not *who wins*.

## Consequences

- The #1255 policy spike must evaluate "LLM-proxy-as-PEP for the budget + scrub + MCP-egress
  sub-layers" as a first-class candidate alongside the custom-operator and Kyverno/OPA
  options — with the explicit scope note that a proxy covers the API-key credential path
  only, not subscription OAuth.
- Sub-issues that introduce a custom mechanism for a concern in the §1 table without naming
  the reuse candidate and why it is insufficient should be sent back in review.
- We take on operational dependencies (Cilium, a proxy, an MCP gateway) instead of code we
  own. That is the trade: less bespoke surface to secure and maintain, more ecosystem
  components to deploy and version. For a substrate meant to be vendor-neutral and durable,
  that trade favors reuse.
- This is a default, not a dogma. A justified "build" — recorded in the sub-issue — is a
  valid outcome; an unjustified one is not.
