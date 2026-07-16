# 0012 — Probaitio operator MVP: realization on the hub OpenShift cluster

- **Status:** Superseded (2026-06-19, #1956)
- **Related:** ADR [0009](./0009-hosted-k8s-operator-dispatch-aggregation.md) (the architecture),
  ADR [0011](./0011-probaitio-openshift-mvp.md) (OpenShift packaging plan).

The original "zero-dependency Node control loop" operator this ADR recorded (a small Node
reconciler under `operator/` watching `RemoteSession`/`DashboardInstance` over the kube REST API)
was **removed in #1956** in favor of the `operator-sdk` Go controller-runtime operator now in
`probaitio-operator/` — the upgrade path ADR 0009 §8 / this ADR's D1 always named as the durable
target. The shared dispatch sidecars (`cred-sync.mjs`, `artifact-ship.mjs`, `Dockerfile.dispatch`)
were relocated into `probaitio-operator/dispatch/` since the Go operator still execs them as native
sidecars. The CRD + status-condition contract is unchanged; only the controller language and home
moved. See ADR 0009 (architecture) and ADR 0011 (OpenShift packaging) for the current operator.
