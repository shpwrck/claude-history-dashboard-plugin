# Agent Substrate

## Source

- URL: https://github.com/agent-substrate/substrate
- Date captured: 2026-06-11
- Category: Adjacent product (infrastructure layer) / Inspiration for the hosted operator
- Related issues: #1247 (hosted operator epic), #1249 (RemoteSession), #467 (multi-tenant, deferred), ADR 0009

## TL;DR

Agent Substrate is a **Kubernetes-native runtime that multiplexes many stateful
agent sessions onto a small pool of worker pods** — sub-second suspend/resume
("teleport"), full RAM + filesystem snapshots across hibernation, and 30x+
oversubscription (their demo: ~250 actor sessions on 8 physical pods). It is
**framework-agnostic and explicitly lists Claude Code, Codex, and MCP** among
supported workloads. Apache 2.0, mostly Go, by Google (not an official product),
and self-described as in **VERY early development, not production-ready, APIs
guaranteed to change** (v0.0.0, ~512 stars, May 2026).

It is **not a competitor to the analytics/coaching dashboard** — it has no
observability-over-history product. The honest overlap is with the *other half*
of our roadmap: it is a near drop-in implementation of the **pod-per-dispatch
remote-session layer that [ADR 0009](../adr/0009-hosted-k8s-operator-dispatch-aggregation.md)
describes building ourselves**. That makes it a buy-vs-build signal for #1247's
dispatch half, not a threat to the dashboard.

## What It Is

> "A system built on top of Kubernetes which manages agent-like workloads to
> achieve higher scale and efficiency than Kubernetes alone can offer, with lower
> latency."

It takes the K8s control plane out of the critical path so it can juggle many
idle-heavy, stateful agent applications ("actors") across shared "ready" worker
pods instead of dedicating resources per agent.

### Key facts

| Dimension | Agent Substrate |
|---|---|
| Layer | Agent **execution substrate** (hosts/dispatches the running agent) |
| Primary language | Go (~81%); Python; Shell |
| Components | `ateapi` (control plane), `atelet` (node DaemonSet), `atecontroller` (reconciler), `atenet` (networking) |
| CRDs | `WorkerPool`, `ActorTemplate`, `Secrets`, `Volumes` |
| Supported workloads | ADK, LangChain, **Claude Code & Codex**, MCP servers |
| Distribution | Any K8s cluster; GKE tooling provided |
| License | Apache 2.0 |
| Maturity | v0.0.0, ~512 stars / 94 forks, ~126 commits; **"VERY early… not ready for production… APIs almost guaranteed to change"** |
| Headline mechanics | Instant Session Teleport (sub-second); full-state snapshots (RAM + FS) across hibernation; 30x+ oversubscription (~250 sessions / 8 pods) |

## User Job

For platform teams running **many** stateful, long-lived, mostly-idle agent
sessions: pack them densely onto shared compute without losing per-session state,
and reactivate any one in under a second. It is infrastructure for *operators of
agent fleets*, not for the individual developer reflecting on their own history.

## What It Does Well

- **Dense multiplexing of idle agents.** 30x+ oversubscription is the core trick —
  most agent sessions are waiting on a human or a model, so dedicating a pod each
  is wasteful. This is exactly the cost shape of remote `claude -p` dispatch.
- **Stateful hibernate/resume.** Full RAM + filesystem snapshots survive a
  suspend, and resume is sub-second. This is the hard part of "pod-per-dispatch
  but don't pay for idle" and the part ADR 0009 hand-waves as future work.
- **Framework-agnostic, Claude Code + Codex already listed.** Our neutrality
  thesis (ADR 0009: "Codex as the second source proving neutrality") is *their*
  baseline assumption — they don't privilege any one harness.
- **K8s-native CRD model** that maps cleanly onto the operator we are designing
  (`WorkerPool`/`ActorTemplate` ≈ our worker-pool + RemoteSession dispatch).

## Where Claude History Dashboard Is Stronger

- **It has no observability/coaching product at all.** No transcript parsing, no
  cost attribution, no context-health, no recommendation engine. It runs agents;
  it does not explain or improve them. Our entire moat (Claude-Code-deep
  retrospective analytics + the recs engine) is untouched.
- **Local-first, zero-infra default.** Our primary user runs one bind-mounted
  server on a laptop. Substrate is a K8s platform — irrelevant to that user until
  they are operating a fleet.
- **Proof / provenance layer.** ADR 0009's defensible position is the
  *vendor-neutral operations + proof layer above* every agent. Substrate is a
  layer *below* — it makes agents run; it does not prove anything about whether
  they ran well or cheaply.

## Product Implications

1. **Buy-vs-build for the #1247 dispatch half.** ADR 0009 splits the hosted loop
   into (a) **aggregation** of history into one store behind `artifact-source`,
   and (b) **pod-per-dispatch** remote sessions. Substrate is a credible
   off-the-shelf answer to (b): WorkerPool + ActorTemplate + hibernation is the
   dispatch fabric we were going to hand-roll. The artifact-source/aggregation
   half — and the entire analytics/proof product on top — stays ours. Worth a
   spike: could a RemoteSession dispatch (#1249) target a substrate WorkerPool
   instead of bespoke pod orchestration?
2. **Reinforces the layering, not a pivot.** This validates ADR 0009's strategic
   frame: the substrate (running agents densely) is *not* the defensible layer — a
   Google-adjacent OSS project will out-build us there. The proof/observability
   layer above it is the part a model vendor (and an infra vendor) is structurally
   disinclined to build. Don't chase the substrate; consider standing on it.
3. **Their hibernation is a cost lever we measure.** 30x oversubscription is a
   real dollar reduction for fleet operators — and exactly the kind of "you ran
   250 sessions but only paid for 8 pods' worth of idle" story our v0.4
   efficiency-accounting could *quantify* if we ever ingest substrate-hosted
   sessions. Measure-the-bill complements lower-the-bill again (cf. Helmdeck).
4. **Maturity caveat.** v0.0.0 with self-declared unstable APIs — do not take a
   hard dependency now. Track it; treat any integration as a reversible spike
   behind the `artifact-source` / dispatch interface seams ADR 0009 already
   defines.

## Existing Coverage

| Observation | Status | Evidence / issue |
|---|---|---|
| Pod-per-dispatch remote sessions | Backlog | ADR 0009; #1247 epic; #1249 RemoteSession |
| Aggregation behind `artifact-source` interface | Backlog | ADR 0009 §1; #1247 children #1248–#1262 |
| Multi-harness neutrality (Claude Code + Codex) | Backlog | ADR 0009 strategic frame; #1260 |
| Dense multiplexing / hibernation of idle agent sessions | Deferred | Not in scope; substrate could supply it under the dispatch seam |
| Quantifying oversubscription savings for fleet operators | Gap | Would extend v0.4 efficiency-accounting to hosted sessions; no issue yet |

## Follow-up

- No new backlog issue filed yet — substrate is too early (v0.0.0, unstable APIs)
  to commit work against. The actionable next step is a **spike under #1247** to
  evaluate substrate as the dispatch fabric for RemoteSession (#1249); file that
  as a sub-issue only if/when the hosted operator reaches the dispatch milestone.
- Documentation issue: tracked under #926 (competitive-analysis docs).
- Non-goal: do **not** build our own agent-multiplexing runtime to "match"
  substrate — that is the layer ADR 0009 explicitly declines to defend.

## Sources

- Agent Substrate README and repo: https://github.com/agent-substrate/substrate
  (fetched 2026-06-11)
- Our positioning: [ADR 0009](../adr/0009-hosted-k8s-operator-dispatch-aggregation.md),
  [README.md](../../README.md), project memory ("v0.4 proof-engine pivot",
  "#467 OpenShift operator MVP")
