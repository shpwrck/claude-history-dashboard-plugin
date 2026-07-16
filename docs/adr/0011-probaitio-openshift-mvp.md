# 0011 — Probaitio: OpenShift packaging + single-tenant MVP of the #1247 substrate

- **Status:** Accepted (the 2026-06-11 infra planning session, building on the #1247 design grill)
- **Date:** 2026-06-11
- **Deciders:** repo owner
- **Builds on:** [ADR 0009](0009-hosted-k8s-operator-dispatch-aggregation.md) — the hosted-operator
  architecture (aggregate-everywhere ingestion, pod-per-dispatch `RemoteSession`, the
  data/compute-plane split, single-tenant scope, #467-deferral) — and
  [ADR 0010](0010-k8s-substrate-reuse-over-build.md) — the reuse-over-build posture. This ADR does
  **not** restate that architecture or posture. It records the **OpenShift packaging**, the
  **Probaitio naming / API group**, and the **single-tenant MVP packaging scope** of that substrate.
- **Related:** #1247 (epic), #1248–#1262 (children), #467 (multi-tenant, deferred onto this),
  #1016 / #1263 (enterprise storage), #845 (Probaitio rename), ADR 0008 (server LLM governance).
  Implementation detail: `docs/plans/openshift-mvp/` (`00`–`40`), `docs/plans/naming-brainstorm.md`.

## Context

ADR 0009 settles *what* the #1247 substrate is; ADR 0010 settles the reuse-over-build posture for
building it. Neither picks a deployment platform or a product name. The maintainer's target is
**OpenShift, a single cluster, everything in-cluster**. This ADR records the packaging decisions
that follow and the product rename the public/enterprise surface forces. §1–§6 are one-line recaps
of the ADR 0009 architecture, kept only so the implementation docs can cite a section; §7, §8, and
the naming + scope sections are this ADR's own contribution.

## Decision

### 1. Source of truth — `artifact-source` (recap)
Raw artifacts behind an `artifact-source` interface; SQLite is a single-writer local accelerator; a
parsed-SQL store is rejected (keeps #467 zero-knowledge possible). **Authoritative:** ADR 0009 §
"Decision". The OpenShift blob substrate for it is §7 below.

### 2. Compute — operator + `RemoteSession` (recap, + this ADR's kinds/group)
One operator reconciles `RemoteSession` (headless | interactive) dispatch. **Authoritative:** ADR
0009. This ADR fixes the **API group `probaitio.com/v1alpha1`** and **two kinds on the one operator**
— `RemoteSession` (dispatch) + `DashboardInstance` (the hosted-dashboard deployment) — see §Naming.

### 3. Data capture — native-sidecar shipper (recap)
Signature-incremental sidecar shipper, PreStop-flush, to the push-ingest endpoint. **Authoritative:**
ADR 0009 + #1249.

### 4. Auth — per-dispatch `credentialRef` (recap)
`personal-oauth | enterprise-api`, per-credential `maxConcurrent`. **Authoritative:** ADR 0009 §
"Decision" + #1250. The Secret delivery for it is §7 (Vault/VSO).

### 5. Workspace — clone-per-dispatch (recap)
Clone-per-dispatch ("never share a checkout"); work product returns via branch + PR, telemetry via
the shipper. **Authoritative:** ADR 0009.

### 6. Config — golden-image bake + `claude-tree-classification` (recap)
Content-hash-tagged config bake; the canonical `config | session-data | secret` classification.
**Authoritative:** ADR 0009 "Invariants".

### 7. Packaging — a hybrid Helm operator, OpenShift-first

`operator-sdk` **hybrid Helm plugin**: one Helm chart renders the always-present app resources; a
thin Go reconciler does the cross-CR work a pure-Helm operator cannot (wait-for-Ready ordering,
reading async-generated resources, conditional sub-resource lifecycle). The chart owns **only**
always-present app resources; **every external-dependency CR is created by the Go reconciler**,
resolving GVKs at runtime via discovery (no hardcoded apiVersions) and requeuing behind CRD-exists
checks. Shipped via **OLM Classic** (v1 `ClusterExtension` cannot authenticate a private catalog)
with an **ordered prerequisite bootstrap** — the owning operators installed + Ready before the
Probaitio `Subscription`, whose CSV `required` CRDs otherwise fail admission. Secrets come from
**HashiCorp Vault** via the **Vault Secrets Operator** (per ADR 0010: reuse the enforcer, don't
hand-roll secret plumbing); the MVP carries only the per-dispatch `credentialRef` Secrets (GitHub
token, enterprise-API key). The **blob substrate** behind §1's `artifact-source` is a PVC or an
in-cluster S3 (NooBaa/ODF `ObjectBucketClaim`) — see Open. A vanilla-k8s Helm path is kept as
provider-block seams in `values` but is an explicitly **documented-future**, untested deliverable.

### 8. Dependency-free server runtime

The runtime image ships **zero `node_modules`** (it runs `src/lib` TS via `register-ts.mjs`). Any
server-side dependency is therefore implemented dependency-free: the artifact-blob client uses a
**hand-rolled SigV4** signer over native `fetch` (no `@aws-sdk`); OIDC, when the #467 layer lands,
uses **`node:crypto` PKCE** (no `openid-client`). A CI gate **boots the actual runtime image** and
asserts no `node_modules` + a working `/healthz`, so a dependency drag-in (the #1013 crash-loop)
fails in CI, not production. The image runs under OpenShift `restricted-v2` SCC: arbitrary UID,
GID 0 group-writable `/app/.cache`, no hardcoded `runAsUser`.

### Naming — Probaitio

Product **Probaitio**; API group **`probaitio.com/v1alpha1`**; kinds `RemoteSession` +
`DashboardInstance` (replacing the `ClaudeCoach` sketch); operator `probaitio-operator`; images
`ghcr.io/probaitio/*` (+ Quay mirror for OpenShift); npm `@probaitio/cli`. Rationale and the rejected
alternatives are in #845 and `docs/plans/naming-brainstorm.md`. `CONTEXT.md` still says "Claude
Coach" and is migrated separately under #845.

## MVP scope

The MVP exposes the **single-tenant** #1247 substrate (per ADR 0009): operator + `RemoteSession`
dispatch + `artifact-source` ingest + sidecar shipper + a `DashboardInstance` hosted deployment —
"one pod end-to-end" (#1249 acceptance). The **#467 multi-tenant / zero-knowledge layer** (invite-only
Keycloak OIDC, client-side encryption, an encrypted-blob store, the public same-origin/CSRF write
gate, the API-key compute proxy) is built **onto** this substrate later and is collected in the
plan docs' "Deferred to #467" sections. The zero-knowledge seam is designed-for: because the source
of truth is opaque blobs behind `artifact-source` (§1), adding client-side encryption is a step at
that boundary, not a re-architecture.

## Invariants

Unchanged from ADR 0009 (the `claude-tree-classification` config/session-data/secret split; the
shipper never echoing seeded config or credentials; a single budget authority across laptop +
cluster + the kill switch) and ADR 0010 (reuse-over-build; enforced policy is a ceiling). This ADR
adds no new invariant.

## Consequences

- New cluster dependencies for the MVP: Vault + VSO and a blob substrate; RHBK/Keycloak and ODF
  only enter when #467 lands. An OLM catalog + ordered bootstrap to own.
- The same app image serves local, single-tenant-hosted, and (later) multi-tenant flavors — the
  OpenShift packaging is a reversible wrapper; ADR 0009's architecture is platform-neutral.
- `etcd` encryption-at-rest is a documented cluster prerequisite before the #467 layer (the server
  holds opaque ciphertext, but Secret material and metadata still live in etcd).

## Open

- Operator type may graduate hybrid-Helm → full Go if day-2 reconcile (Keycloak client rotation,
  OBC lifecycle, kill-switch-as-status) earns it.
- Blob substrate: PVC vs R2 vs in-cluster S3 (NooBaa/ODF OBC); GC of completed Jobs, stale images,
  ingested blobs.
