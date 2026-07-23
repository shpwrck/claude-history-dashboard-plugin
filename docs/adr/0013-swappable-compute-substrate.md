# 0013 — Swappable compute substrate (substrate neutrality)

- **Status:** Accepted (direction), **not implemented** — see the implementation-status note below
- **Date:** 2026-06-16
- **Deciders:** repo owner

> **Implementation status (as of 2026-07-22):** the substrate-driver interface this ADR
> accepts has **zero code presence** — there is no driver/substrate abstraction in
> `probaitio-operator/` (`grep -rni 'driver|substrate' --include='*.go' probaitio-operator/`
> is empty). The direction stands as an accepted *decision*, but the interface is unbuilt and
> its realization is tied to the operator carry-forward triage (the k8s substrate is a
> throwaway scaffold — build only the unblocking slice; see epic #1247 and ADR 0010).
> Treat the driver interface described below as design intent, not shipped code.
- **Related:** ADR [0009](./0009-hosted-k8s-operator-dispatch-aggregation.md) (operator + `RemoteSession`
  dispatch — the architecture this extends), ADR [0010](./0010-k8s-substrate-reuse-over-build.md)
  (reuse-over-build default), ADR [0012](./0012-probatio-operator-mvp-realization.md) (operator MVP),
  ADR [0008](./0008-server-llm-usage-governance.md) (server LLM governance / budget + egress).
  Competitive context: Omnigent (Databricks) as an adjacent meta-harness control plane.

## Context

ADR 0009 establishes a hosted Kubernetes operator that reconciles a `RemoteSession` CRD and
dispatches **pod-per-dispatch** agent sessions. Today that operator's reconcile knows how to
produce exactly one thing: an in-cluster `Job`/pod. The substrate that actually runs a session is
hard-wired to our own operator.

The product's defensibility thesis (ADR 0009 strategic frame) is a **vendor-neutral agent-operations
and proof layer above every coding agent and every model**. We already pursue multi-LLM and
multi-harness neutrality. But neutrality stops short if the *substrate* — where and by what a session
is actually executed — remains locked to our own k8s operator. Two forces make this concrete:

- **A meta-harness control plane may gain broad adoption** (e.g. Omnigent). It governs and dispatches
  sessions itself. It is adjacent to us and does **not** build the eval/proof layer that is our moat.
  If it wins, the right posture is to **sit above it as the proof layer**, dispatching sessions
  *through* it — not to compete with its dispatch.
- **Users may prefer a managed sandbox/environment provider** (e.g. Daytona, Modal) over running our
  operator at all. We should be able to execute a session there and still capture, aggregate, and
  prove over the result.

ADR 0009 already drew the symmetric seam on the **data plane**: source-of-truth is opaque artifacts
behind an `artifact-source` interface, so a laptop, a pod, or a blob store are all just sources. This
ADR adds the matching seam on the **compute plane**.

## Decision

**The compute substrate is pluggable behind an interface; our in-cluster operator is one
implementation, not the only one.** The `RemoteSession` reconcile delegates execution to a substrate
driver rather than constructing a pod directly. Adding a new substrate is writing a driver, not
re-architecting.

We distinguish **two altitudes of swap**, because the candidate substrates do not plug in at the same
layer and a single conflated interface would leak:

1. **Workload runtime** — *what executes the session.* Replaces the pod (our cluster pod / Daytona /
   Modal / …). Our reconcile, clone-per-dispatch, credential injection, telemetry shipping, and
   budget accounting stay; only the executor changes. This is the common, narrow swap.
2. **Dispatch control** — *who decides and governs the session.* Replaces the dispatch logic above the
   workload (our operator / an external meta-harness control plane such as Omnigent). This is the
   rarer, higher-altitude swap: we hand off "decide where/how this runs" and instrument what returns.

Most variation is at altitude 1. Altitude 2 is the meta-harness case and is treated as a distinct,
later interface — kept separate so the common runtime swap stays simple.

### Invariants travel in the driver contract, not per substrate

The cross-cutting safety guarantees from ADR 0009 **must be obligations of the substrate-driver
contract**, proven by every implementation — never re-derived inside each backend (that is how a
credential leaks or a budget double-spends). At minimum:

- **Single budget authority.** Every substrate's spend consults and decrements the one budget
  accountant; no substrate keeps its own books (ADR 0008 / ADR 0009 budget invariant).
- **Kill switch reaches every substrate.** A global stop must halt in-flight work on *any* backend
  (cluster pod, Daytona, Modal, an external control plane), not just our own pods.
- **Config-in / data-out direction holds everywhere.** The canonical artifact tree-classification and
  the rule that the telemetry shipper never echoes seeded config or credentials apply regardless of
  who runs the workload.

A driver that cannot honor these obligations is not eligible.

## Scope

- **The seam is the deliverable, not speculative drivers.** The MVP substrate remains the in-cluster
  operator (ADR 0009 / 0012). We build the driver interface plus that one reference implementation,
  so a second substrate (Daytona, Modal, a meta-harness) is a later driver, not a re-architecture.
- We do **not** pre-build Daytona/Modal/Omnigent drivers ahead of a concrete need. This ADR fixes the
  boundary and the invariant-carrying contract so they can be added cheaply when the need is real.
- This stays general by intent: it records the architectural commitment (substrate neutrality, the
  two-altitude split, invariants in the contract). Concrete interface signatures and any specific
  driver are settled when first implemented and recorded in a follow-on ADR.

## Consequences

- The compute plane gains the same neutrality the data plane already has — the product can sit
  *above* a winning meta-harness rather than be displaced by it, and can run on managed sandbox
  providers without abandoning capture/aggregation/proof.
- The `RemoteSession` reconcile grows an indirection (substrate driver) it does not have today; the
  in-cluster path becomes the reference driver behind that boundary.
- Every new substrate carries an obligation to prove the ADR 0009 invariants (budget, kill switch,
  config-in/data-out), which is a real per-driver cost — deliberately, so neutrality never trades
  away safety.
- Aligns the compute plane with the reuse-over-build default (ADR 0010): prefer compiling our intent
  onto an existing substrate over growing our own.
