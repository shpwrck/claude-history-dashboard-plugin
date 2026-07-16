# Competitive / substrate analysis: agent-sandbox (Kubernetes SIG)

_Repo: [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) ·
Site: [agent-sandbox.sigs.k8s.io](https://agent-sandbox.sigs.k8s.io) · Analysis date: 2026-06-16_

## TL;DR

agent-sandbox is **not a product competitor** — it is a candidate **execution substrate**
for Probaitio's operator. It is a `kubernetes-sigs` project (SIG Apps, Apache-2.0, Go,
~2.9k stars, **v1beta1 / ~v0.4.x**, actively maintained) that adds the exact Kubernetes
primitive our operator currently hand-rolls: *"isolated, stateful, singleton workloads,
ideal for AI agent runtimes,"* with its stated #1 use case being **"isolated environments
for executing untrusted, LLM-generated code."**

Probaitio's operator today reconciles `RemoteSession{headless}` → a raw **`Job` running
`claude -p`**. A `Job` is the wrong primitive (batch, no real isolation beyond the SCC, no
pause/resume, cold-start every run, hand-built churn-guard/FIFO to tame it). agent-sandbox's
`Sandbox` CRD is purpose-built for this and is governed by k8s-sigs rather than a single
vendor. **Recommendation: adopt `Sandbox`/`SandboxClaim` as the execution substrate under
our operator, gated on confirming a gVisor/Kata `RuntimeClass` exists on the target
cluster.**

## What it is

> **Tagline:** *"agent-sandbox enables easy management of isolated, stateful, singleton
> workloads, ideal for use cases like AI agent runtimes."*

It fills a gap between Kubernetes primitives: Deployments handle stateless replicas,
StatefulSets handle numbered stateful sets, but nothing natively models a **single-instance,
persistent workload with stable identity** — which is what an agent session is.

**Core CRD — `Sandbox`** (`agents.x-k8s.io/v1beta1`): wraps a single Pod (via `podTemplate`)
and adds:
- **Stable identity** — persistent hostname / network identity across restarts.
- **Persistent storage** — survives pod restarts.
- **Lifecycle** — create / delete / **pause / resume**, plus **deep hibernation** (save
  state to persistent storage, archive the object) and **automatic resume on network
  connection**.

```yaml
apiVersion: agents.x-k8s.io/v1beta1
kind: Sandbox
metadata:
  name: my-sandbox
spec:
  podTemplate:
    spec:
      containers:
        - name: agent
          image: <IMAGE>
```

**Extensions module (three more CRDs):**
- **`SandboxTemplate`** — reusable definition for many similar sandboxes.
- **`SandboxWarmPool`** — pre-warmed instances for **rapid allocation** (kills cold-start).
- **`SandboxClaim`** — allocate a sandbox from a warm pool, hiding configuration.

**Isolation — runtime-neutral.** The Sandbox abstracts the node runtime; isolation is
delegated to the node's `RuntimeClass`. Design goal, quoted: *"Supporting different runtimes
like gVisor or Kata Containers to provide enhanced security and isolation between the
sandbox and the host, including both kernel and network isolation"* — *"crucial for running
untrusted code or multi-tenant scenarios."* Without a gVisor/Kata RuntimeClass it falls back
to runc (no extra isolation).

**Other:** Python SDK for programmatic sandbox access. Governed under **SIG Apps**. Maturity
**v1beta1** (beta); stale-PR automation (30-day stale / 15-day close) signals active velocity.

## Relationship to Probaitio — it replaces the lowest layer we built

```
 Control plane / UX / measurement source   →  Omnigent (optional)  OR  Probaitio dashboard
 Domain controller (our logic)             →  Probaitio operator:
                                                 RemoteSession → SandboxClaim,
                                                 DashboardInstance
 Execution substrate (in-cluster, isolated)→  agent-sandbox: Sandbox + WarmPool (gVisor/Kata)
 Proof engine                              →  Probaitio core (unchanged)
```

We keep our controller (the `RemoteSession` / `DashboardInstance` domain logic); we delegate
the *pod-running* to `Sandbox`. Concretely, `RemoteSession` reconciles to a `SandboxClaim`
against a `SandboxWarmPool` instead of building a `Job`.

| What we hand-rolled in the operator | agent-sandbox gives it |
|---|---|
| `RemoteSession` → raw `Job` + churn guard / single-Y FIFO | `Sandbox` / `SandboxClaim` — maintained k8s-sigs CRD |
| Custom SCC wrangling for in-cluster agent execution | gVisor/Kata `RuntimeClass` — real kernel+network isolation for untrusted LLM-generated code |
| Cold-start on every shadow/replay/race worker | `SandboxWarmPool` → pre-warmed, claim-and-go |
| Jobs run-to-exit; no interactive-session survival | pause / resume / hibernate (idle sessions cost nothing) |

The isolation win applies even single-tenant: shadow/replay/race and `claude -p` execute
agent-generated commands — untrusted code by definition — so gVisor/Kata is a genuine upgrade
over `Job` + restricted SCC, not just a multi-tenant nicety.

## How it composes with Omnigent

Different layers — complementary, not either/or. Omnigent (see
[`omnigent.md`](./omnigent.md)) is a **control plane** that deliberately runs agents
**off-cluster** (Modal/Daytona/Islo) *because* sandboxed in-cluster execution is hard.
agent-sandbox is the standard, k8s-native answer to that exact problem. So:

- Adopting it lets Probaitio offer what Omnigent cannot: **agents running safely inside your
  own cluster** — a real differentiator for the enterprise/OpenShift buyer.
- An agent-sandbox-backed runner could even register as an **Omnigent "host"/sandbox
  provider**, the same slot Modal/Daytona/Islo occupy today.

## Feasibility gate and caveats

1. **The deciding gate: does the target cluster expose a gVisor or Kata `RuntimeClass`?**
   Without it, `Sandbox` runs under runc and the isolation win evaporates (no better than
   today's Job). On our hub OCP this means the **OpenShift sandboxed-containers (Kata)
   operator** must be installed and a `RuntimeClass` wired up. Verify this first; everything
   else is straightforward CRD adoption.
2. **v1beta1** — the API is still moving. k8s-sigs governance makes it durable (it will not
   vanish like a startup project), but adoption means tracking an evolving spec.
3. **Networking is roadmap-stage** ("rich identity & connectivity," "routing without
   per-sandbox Services" are aspirational). Fine for our one-session-per-sandbox model.
4. **Is it overkill?** Our `Job`-based operator already works (proven on hub). The payoff for
   switching is isolation (security), warm pools (cold-start), and pause/resume (cost) — all
   independently valuable, and isolation becomes mandatory the moment we run untrusted or
   multi-tenant agents (#467). If none of those matter for a deployment, the raw Job remains
   a valid fallback.

## Recommendation

Adopt `Sandbox` / `SandboxClaim` as the execution substrate under the Probaitio operator,
replacing the raw `Job`, **gated on confirming Kata/gVisor `RuntimeClass` on the target
cluster.** This directly advances the operator re-scope: rather than out-building Databricks
on generic remote-run, we stand on the k8s-sigs standard for the one thing that is genuinely
our niche — safe, stateful, in-cluster agent execution — and delete the bespoke Job-taming
code.

**Suggested sequence (gate → adopt):**
1. **Verify the cluster gate** — confirm a gVisor/Kata `RuntimeClass` (OpenShift sandboxed
   containers operator on the hub). Spike only; no adoption until this passes.
2. **Prototype `RemoteSession` → `SandboxClaim`** against a `SandboxWarmPool`; measure
   cold-start improvement and how much churn-guard/FIFO code it retires.
3. **Decide and document** (ADR) the execution-substrate choice: `Sandbox` vs. raw `Job`,
   with the RuntimeClass dependency stated as a precondition.

## Sources

- [kubernetes-sigs/agent-sandbox README + repo](https://github.com/kubernetes-sigs/agent-sandbox)
  (verified directly: ~2,897★, created 2025-08-12, Apache-2.0, Go, v1beta1; `Sandbox` +
  `SandboxTemplate`/`SandboxWarmPool`/`SandboxClaim` CRDs, gVisor/Kata isolation, SIG Apps)
- [agent-sandbox.sigs.k8s.io](https://agent-sandbox.sigs.k8s.io) — project site / docs
- Related: [`docs/competitive/omnigent.md`](./omnigent.md) — the control-plane layer above
  this substrate
