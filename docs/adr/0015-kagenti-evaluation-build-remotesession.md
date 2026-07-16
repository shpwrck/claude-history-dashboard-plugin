# 0015 — Kagenti evaluation: build `RemoteSession`, defer Kagenti to an enrollment layer

- **Status:** Accepted (researched 2026-06-17)
- **Date:** 2026-06-17
- **Deciders:** repo owner
- **Related:** ADR [0009](./0009-hosted-k8s-operator-dispatch-aggregation.md) (operator + `RemoteSession`
  dispatch — the architecture this defends), ADR [0010](./0010-k8s-substrate-reuse-over-build.md)
  (reuse-over-build default), ADR [0013](./0013-swappable-compute-substrate.md) (swappable compute
  substrate; altitudes 1/2). Issue [#1885](https://github.com/shpwrck/claude-history-dashboard/issues/1885);
  epic #1247; future seams #467 (multi-tenant), #1252 / #1256 (MCP/A2A agent-dispatch).
  Competitive context: Kagenti, Omnigent (Databricks).

## Context

[Kagenti](https://github.com/kagenti/kagenti) (IBM Research + Red Hat Emerging Technologies,
Apache-2.0) is a cloud-native platform for **deploying and governing** AI agents on Kubernetes —
framework-neutral, A2A + MCP, zero-trust (SPIFFE/SPIRE + Keycloak + Istio), OTel observability. It is
mature, enterprise-backed, and overlaps the deployment tier ADR 0009 builds toward. The question
this ADR settles: **can we adopt Kagenti as the dispatcher for Claude remote sessions instead of
building our own `RemoteSession` operator (ADR 0009 §2)?**

This matters because ADR 0010 makes reuse-over-build the default ("compile our intent onto an
existing enforcer; do not write a new one"), and ADR 0013 makes the compute substrate pluggable.
Kagenti is exactly the kind of off-the-shelf substrate those ADRs tell us to prefer — *if it fits the
workload*.

### What Kagenti actually is (read from its live operator API)

Inspected `kagenti/kagenti-operator` `api/v1alpha1`. The live CRDs are:

- **`AgentRuntime`** — an *enrollment overlay*, **not** a workload definer. Spec is
  `{type, targetRef, identity.SPIFFE, authBridgeMode, mtlsMode, egressEnforcement}`; `targetRef`
  points at an **already-existing** Deployment/StatefulSet, onto which the operator injects SPIFFE +
  Keycloak-OAuth-client sidecars, mTLS, and egress policy.
- **`AgentCard`** — auto-generated A2A discovery (fetches `/.well-known/agent-card.json`, verifies
  signature, records the SPIFFE ID).
- **`AuthorizationPolicy`** — Istio authz.

Agents themselves run as plain `apps/v1` **Deployments + Services** ("operator-free deployment
model") and **must be long-running HTTP servers that speak the A2A protocol**
(`GET /.well-known/agent-card.json`, `POST /`, `GET /tasks/{id}`). There is **no Job, CronJob, batch,
or run-to-completion primitive anywhere** in the operator. (An earlier Tekton-build `Component` CRD
existed in a separate `platform-operator` but was explicitly superseded by this simpler enrollment
model.)

## Decision

**Build our own `RemoteSession` operator (ADR 0009 §2). Do not adopt Kagenti as the Claude-session
dispatcher.** The workload shapes do not match, and the harness-native seams are precisely the ones
Kagenti does not model.

### Why the workload model does not fit

| Need (ADR 0009 §2–§6) | Claude remote-session shape | Kagenti fit |
|---|---|---|
| `headless` mode | a **Job** running `claude -p` to completion (seconds–minutes) | ✗ no Job/ephemeral primitive — the model assumes a persistent meshed endpoint to discover + rotate identity for |
| `interactive` mode | long-lived pod running `claude remote-control`, registered in **claude.ai/code** | ✗ wrong protocol — Kagenti discovers/verifies via the **A2A agent-card**; a Claude control endpoint exposes none and speaks Claude's own remote-control handshake |
| clone-per-dispatch workspace, branch+PR return (§5) | git clone + scoped GitHub-token push | ✗ not modeled |
| native-sidecar `~/.claude` artifact shipper, signature-incremental, PreStop-flush (§3) | the durability backbone | ✗ not modeled — its sidecars are SPIFFE + Keycloak registration |
| per-dispatch `credentialRef` (personal-OAuth vs enterprise-API) + `maxConcurrent` (§4) | Anthropic subscription-OAuth, in-pod refresh | ✗ its identity is SPIFFE/Keycloak for east-west agent auth, not Anthropic OAuth |
| golden-image config bake (§6), budget-authority decrement + killswitch | harness-native | ✗ not modeled |

ADR 0009's "reuse-over-build" section already named "the operator's `RemoteSession` reconcile, the
bake, the shipper, and the subscription-OAuth path" as the **genuinely-custom seams no ecosystem tool
models** — Kagenti confirms it does not model them.

Two further mismatches:

- **Direction of trust.** Kagenti's identity story is **east-west** (agent A authenticating to agent
  B / a tool over the mesh via SPIFFE). Claude sessions are mostly **north-south** (outbound to
  `api.anthropic.com` + GitHub), so the zero-trust-mesh value proposition maps poorly.
- **Stack collision.** Adopting Kagenti drags in **Istio/Ambient + SPIRE + Keycloak** as hard
  dependencies, partly competing with ADR 0009/0010's already-chosen enforcers (Cilium NetworkPolicy
  for egress, Kyverno/OPA admission, Vault/VSO secrets, OTLP) — heavy and redundant for the
  single-tenant MVP.

### Locating Kagenti against ADR 0013

Kagenti is **neither** altitude of the swappable substrate:

- It is **not an altitude-1 workload-runtime swap** for Claude sessions — it cannot run a
  run-to-completion Job, and it requires the session to be an A2A service.
- It is **not an altitude-2 dispatch-control swap** (the Omnigent case) — it does not *decide or
  govern* dispatch; it *enrolls existing workloads* into a mesh/identity fabric.

It is a **third thing**: a cross-cutting enrollment / identity / mesh / egress fabric. Under ADR 0010
that is a candidate *enforcer to reuse* for the identity/egress/observability concerns — orthogonal
to who dispatches the session.

## Consequences

- The `RemoteSession` operator stays ours, as ADR 0009 §2 specifies. No change to sequencing.
- **Layered future, tracked not built:** Kagenti's `AgentRuntime` enrollment is a real off-the-shelf
  candidate for two later seams, where our operator *creates* the workload and Kagenti *overlays*
  identity/mesh/egress:
  1. **#467 multi-tenant zero-trust** — when invite-only public SaaS needs per-tenant workload
     identity + OAuth client provisioning, Kagenti's SPIFFE + Keycloak enrollment beats hand-rolling.
  2. **#1252 / #1256 MCP/A2A agent-dispatch** — if Probaitio dispatches *other frameworks'* agents as
     long-running meshed A2A services (the multi-harness future), those *are* Kagenti-shaped.
- **Revisit trigger:** re-evaluate Kagenti adoption at the #467 / MCP-agent-dispatch seam, not before.
- This is consistent with the defensibility thesis (ADR 0009/0013): the moat is the vendor-neutral
  proof/eval layer above any runtime, not the dispatcher itself — so building the harness-native
  dispatcher while reusing commodity enrollment later is the correct division of labor.
