# AX (Agent eXecutor)

## Source

- URL: https://github.com/google/ax
- Companion substrate: [agent-substrate.md](./agent-substrate.md) (AX runs *on* Agent Substrate)
- Date captured: 2026-06-17
- Category: Adjacent product (infrastructure layer) / Inspiration for the hosted operator
- Related issues: #1247 (hosted operator epic), #1249 (RemoteSession), #467 (multi-tenant, deferred), ADR 0009, #926

## TL;DR

AX is **"Google's open source distributed agent runtime"** — the *harness* layer
that sits on top of [Agent Substrate](./agent-substrate.md). Where Substrate is
the K8s multiplexing fabric (suspend/resume, oversubscription), AX is the agent
loop and durable-execution plumbing: it runs controllers, skills, tools, and
agents in isolation, keeps a **durable event log** of every execution, uses a
**single-writer** model for consistent state, and **auto-recovers/resumes** work
after failure. It ships a built-in Gemini agent with a bash tool. Mostly Go (with
Python), by Google (not an official product), and explicitly **early-stage —
external PRs are paused while the core stabilizes**.

Like Substrate, it is **not a competitor to the analytics/coaching dashboard** —
it has no observability-over-history product. The overlap is again with the
*other half* of our roadmap: AX is a reference shape for the **agent harness +
durable-execution layer** that would sit inside [ADR 0009](../adr/0009-hosted-k8s-operator-dispatch-aggregation.md)'s
pod-per-dispatch remote sessions. It is a buy-vs-build / prior-art signal for
#1247's dispatch half, not a threat to the dashboard.

## What It Is

> "Google's open source distributed agent runtime."

AX coordinates agentic applications at scale: it executes controllers, skills,
tools, and agents in isolation, logs executions durably, and brokers
communication between local and remote actors with built-in recovery. It is
designed to run on [Agent Substrate](./agent-substrate.md) as its execution
platform — the README frames AX as a demonstration of "a secure, hyper-scalable
agent harness on Agent Substrate."

### Key facts

| Dimension | AX (google/ax) |
|---|---|
| Layer | Agent **harness / runtime** (the agent loop + durable execution), above the substrate |
| Primary language | Go (~83%); Python (~13%) |
| Core mechanics | Single-writer state; durable event log of executions; automatic recovery/resumption; local + remote actor communication |
| Batteries included | Built-in Gemini agent with a bash tool; custom skills, tools, remote agents |
| Substrate | Built to run on [Agent Substrate](./agent-substrate.md) (K8s-native) |
| Distribution | Open source; by Google (not an official Google product) |
| Maturity | Early development; **external PRs paused while the core stabilizes**; issues/feature requests welcomed |
| Headline framing | "A secure, hyper-scalable agent harness on Agent Substrate" |

## User Job

For a platform team running agentic applications at scale, AX provides the
runtime that turns fragile one-shot agent scripts into **durable, resumable
services**: each execution is logged, state has a single writer, and in-flight
work recovers after a crash. It is infrastructure for *operators of agent
fleets* — the harness an operator would dispatch onto Substrate — not a tool for
the individual developer reflecting on their own history.

## What It Does Well

- **Durable execution as a first-class primitive.** An event log of every
  execution plus single-writer state plus automatic recovery is exactly the
  reliability shape ADR 0009's pod-per-dispatch sessions need — and the part the
  ADR currently hand-waves.
- **Local + remote actor communication.** Agents can span workers, which pairs
  naturally with Substrate's multiplexing fabric beneath it.
- **Vendor-credible reference architecture.** Google publishing "what a
  distributed agent harness looks like" is useful prior art for the operator's
  harness layer, independent of whether we adopt it.
- **Batteries-included agent + tools** (Gemini + bash, custom skills/tools) make
  it a runnable end-to-end demonstration, not just a spec.

## Where Claude History Dashboard Is Stronger

- **No observability/coaching product at all.** AX emits execution logs but does
  not parse transcripts, attribute cost, measure context health, or recommend
  changes. Our entire moat (Claude-Code-deep retrospective analytics + the recs
  engine) is untouched.
- **Local-first, zero-infra default.** Our primary user runs one bind-mounted
  server on a laptop. AX is cluster-tier runtime infrastructure — irrelevant to
  that user until they operate a fleet.
- **Harness-neutral over history.** AX is Gemini-first as its built-in agent; the
  dashboard reads Claude Code and Codex history neutrally and is the proof layer
  *above* whatever harness ran.

## Product Implications

1. **Prior art for the #1247 dispatch half, paired with Substrate.** Read AX and
   [Agent Substrate](./agent-substrate.md) together: Substrate is the dispatch
   fabric (WorkerPool/ActorTemplate/hibernation), AX is the harness +
   durable-execution loop that runs on it. Together they are a credible
   off-the-shelf answer to ADR 0009's pod-per-dispatch remote sessions (#1249) —
   the aggregation/`artifact-source` half and the analytics/proof product on top
   stay ours.
2. **Reinforces the layering, not a pivot.** AX makes agents *run durably*; that
   is not the defensible layer. As with Substrate, a Google-adjacent OSS project
   will out-build us on the runtime; the vendor-neutral proof/observability layer
   above it is the part a model/infra vendor is structurally disinclined to
   build. Don't chase the harness; consider standing on it.
3. **Durable execution log as a future history source.** If the operator ever
   dispatches onto an AX/Substrate-style runtime, AX's per-execution event log
   becomes another `~/.claude`-adjacent history source the dashboard could ingest
   — an instrumentation target, not a rival. Capture whether its event shape maps
   onto our session/timeline parsers if that spike happens.
4. **Maturity caveat.** Early-stage with PRs paused — do not take a hard
   dependency now. Track it; treat any integration as a reversible spike behind
   the dispatch seams ADR 0009 already defines.

## Existing Coverage

| Observation | Status | Evidence / issue |
|---|---|---|
| Pod-per-dispatch remote sessions | Backlog | ADR 0009; #1247 epic; #1249 RemoteSession |
| Durable agent-execution / recovery layer for dispatched sessions | Deferred | Not in scope; AX/Substrate could supply it under the dispatch seam |
| Multi-harness neutrality (Claude Code + Codex) | Backlog | ADR 0009 strategic frame; #1260 |
| Reading durable agent-execution logs as a history source | Gap | Would extend ingestion to hosted sessions; no issue yet |

## Follow-up

- No new backlog issue filed — AX is early-stage (external PRs paused) and is
  captured alongside [agent-substrate.md](./agent-substrate.md) as the harness
  half of the same execution-layer reference. The actionable next step is the
  same **spike under #1247** that the Substrate note proposes: evaluate the
  AX-on-Substrate stack as the dispatch fabric for RemoteSession (#1249); file it
  as a sub-issue only when the hosted operator reaches the dispatch milestone.
- Documentation issue: tracked under #926 (competitive-analysis docs).
- Non-goal: do **not** build our own distributed agent runtime to "match" AX —
  that is the layer ADR 0009 explicitly declines to defend.

## Sources

- AX README and repo: https://github.com/google/ax (fetched 2026-06-17)
- Companion: [agent-substrate.md](./agent-substrate.md)
- Our positioning: [ADR 0009](../adr/0009-hosted-k8s-operator-dispatch-aggregation.md),
  [README.md](../../README.md), project memory ("v0.4 proof-engine pivot",
  "#467 OpenShift operator MVP")
