# 00 — OpenShift MVP: Integrated Refinement Plan (#1247 single-tenant substrate)

> **Status:** reconciled to ADR 0011 (single-tenant #1247 substrate, Probaitio naming). The
> multi-tenant/zero-knowledge pieces (Keycloak, client-side encryption, encrypted-blob store,
> public write gate, compute proxy) are **deferred to #467** and collected in a section below.

> Cross-cutting integration of the four implementation-ready refinements for the hosted
> Kubernetes substrate (epic **#1247**, OpenShift flavor). This doc is the **single coherent
> contract**: it links the four refinements, fixes the build order, resolves the contradictions
> between them, consolidates the infra child-issue list, and records the new open questions they
> surfaced.
>
> Per ADR 0011 the real MVP is the **single-tenant** #1247 substrate — the operator + the
> `RemoteSession` dispatch kind (Job/pod, clone-per-dispatch workspace, native-sidecar shipper,
> per-dispatch `credentialRef`, golden-image config bake), the `artifact-source` interface +
> push-ingest (#1248), and a `DashboardInstance` hosted deployment. The earlier "public,
> invite-only, multi-tenant, zero-knowledge-at-rest" framing was an #467 framing; those pieces
> are now **deferred to #467** and collected in the section at the bottom of this doc.
>
> It does **not** re-litigate LOCKED INFRA or the accepted CORRECTED DECISIONS from the
> adversarial review (dependency-free server, chart-vs-reconciler ownership line, `replicas:1`,
> no `X-Forwarded-Host` trust). Where the four docs disagree on a detail *underneath* those locked
> decisions, this doc picks one.

## The four refinements

| # | File | Area | MVP / #467 |
|---|---|---|---|
| 10 | [`10-oidc-sigv4.md`](./10-oidc-sigv4.md) | Hand-rolled SigV4 S3 client (carries: the artifact-blob substrate) + `public-image` boot CI gate (carries). Dependency-free OIDC (node:crypto PKCE + JWKS verify) + the public write-auth gate + session cookie (**#467-deferred**) | mixed |
| 20 | [`20-go-reconciler.md`](./20-go-reconciler.md) | Hybrid Helm operator: one chart (always-present app resources) + Go reconciler (external-dependency CRs via runtime discovery), status conditions, RBAC, ownership boundary | **MVP** |
| 30 | [`30-olm-bootstrap.md`](./30-olm-bootstrap.md) | OLM Classic bundle + FBC catalog + CatalogSource + the ordered prereq bootstrap (RHBK/ODF/VSO/Vault before the Probaitio Subscription) | **MVP** |
| 40 | [`40-same-origin-csrf.md`](./40-same-origin-csrf.md) | The `isSameOrigin`/`passesWriteAuth` rewrite: configured `PUBLIC_ORIGIN` allowlist, no forwarded-header trust, CSRF-token disposition, public-flavor test | **#467-deferred** |

The **platform track (docs 20 + 30)** is the MVP spine: doc 20 = what the operator does
(now centered on the `RemoteSession` dispatch reconcile), doc 30 = how it's shipped and
bootstrapped. They must agree on owned/required CRD GVKs (see Contradiction C1/C5).

Docs 10 and 40 were the **two halves of the same public-server change** (10 = the auth/session/S3
mechanics + entrypoint; 40 = the same-origin gate the entrypoint installs). The **OIDC + same-origin
write-gate halves are now #467-deferred**; what **carries into the MVP** from doc 10 is the
infra-only spine: the **hand-rolled SigV4 S3 client** (now the artifact-blob substrate of ADR 0011 §1,
not a ciphertext store), the **`public-image`/boot-the-image CI gate** + dependency-free runtime, and
the unconditional **`/healthz`** route. See the #467-deferred section for the OIDC/session/write-gate
half (Contradictions C2/C4 apply there).

---

## 1. Integrated build order (what lands before what)

The MVP work centers on the **platform track** (the spine) plus the **carried server infra**
(SigV4/S3, image, `/healthz`). The OIDC + same-origin write-gate work is deferred to #467 and is
not on the MVP critical path. Within each track the order is strict.

### MVP server infra (carried from docs 10/40, dependency-free runtime)

1. **S1 — Hand-rolled SigV4 S3 client: `src/lib/s3/sigv4.ts` (doc 10).** Pure, dependency-free,
   unit-tested under vitest against fixtures. Backs the ADR 0011 §1 **artifact-blob substrate** (the
   blob store behind `artifact-source`), **not** a ciphertext store. No `@aws-sdk`. Leaf module;
   unblocks the blob client.
2. **S2 — `public-image` boot CI gate + runtime `Dockerfile` + `/healthz` (doc 10 §4/§5).** Proves the
   dependency-free image boots `/healthz` with **zero `node_modules`** (the #1013 crash-loop guard,
   ADR 0011 §8), keeps `spa-boundary` green, and runs under OpenShift `restricted-v2` SCC (arbitrary
   UID, GID-0 group-writable `/app/.cache`, no hardcoded `runAsUser`). `/healthz` is a single
   unconditional route, above any gate (C7).

> The same-origin gate rewrite (doc 40, A1 below) is a safe pure refactor that may still land to
> `master` on its own, but it is **not MVP-load-bearing** because the public flavor it serves is
> #467-deferred — it's tracked in the #467-deferred section, not here.

### Platform track (docs 20 + 30) — the MVP spine

3. **B1 — Operator scaffold + typed `RemoteSession` + `DashboardInstance` API + Helm chart of
   always-present app resources (doc 20 §1, §6).** `operator-sdk init --plugins hybrid.helm`. Fixes
   the GVK domain first (Contradiction C1) so every downstream artifact uses one group
   (`probaitio.com/v1alpha1`). **One operator, one API group, multiple kinds** (ADR 0011 §2):
   `RemoteSession` (the dispatch kind, the MVP's primary kind) and `DashboardInstance` (the hosted
   deployment kind that the old `ClaudeCoach` kind became).
4. **B2 — The Go reconciler: `RemoteSession` dispatch + discovery helper, ordered pipeline,
   conditions, RBAC (doc 20 §3–§5, ADR 0011 §2/§5).** Reconciles `RemoteSession{headless}` →
   a `Job` running `claude -p`, clone-per-dispatch workspace, per-dispatch `credentialRef`. Resolves
   external dependency CRs (OBC, Vault) at runtime via discovery; never templates them.
5. **B3 — OLM bundle (CSV with owned + required CRDs), FBC catalog, CatalogSource/OG/Subscription
   (doc 30 §1, §2).** The CSV `required` block and the FBC `olm.gvk.required` properties **must
   mirror exactly** the GVKs the reconciler discovers (Contradiction C5). `installPlanApproval:
   Manual`.
6. **B4 — Ordered prereq bootstrap + Vault seed (doc 30 §3).** Installs ODF/VSO/Vault and
   waits-Ready before the Probaitio CatalogSource/Subscription. (RHBK/Keycloak is **#467-deferred** —
   the MVP is single-tenant and does not log in users.) Depends on B3 (the things it installs
   *before*) and on the env contract (the keys it seeds, §2).
7. **B5 — `operator-publish.yml` Quay workflow (doc 30 §4).** Separate from `docker-publish.yml`.
   Publishes `ghcr.io/probaitio/*` (+ `quay.io/probaitio/*` mirror for OpenShift).

### MVP data plane (ADR 0011 §1, §3 — the highest-leverage, k8s-free first slice)

8. **D1 — `artifact-source` interface + push-ingest endpoint (#1248).** Extract the file-read
   boundary (the 53 fs-read sites in `ingest.mjs`, the 16 directory-walking parsers) into an
   `artifact-source` interface (`list`/`read` by `source_id + rel_path + signature`); add a
   push-ingest endpoint that lands artifacts from a second source so the existing parse + SQLite
   parse-cache pipeline ingests them **unchanged** (idempotent, signature-gated). This delivers
   multi-host aggregation **before any operator exists** and is the boundary everything downstream
   rides on (ADR 0011 Consequences). The SQLite cache is demoted to a single-writer local
   accelerator — **not** a source of truth (no parsed-SQL/Postgres-of-models store).
9. **D2 — Native-sidecar shipper (part of #1249).** Signature-incremental capture of all
   session-generated artifact types (not just transcripts), live + crash-resilient, `PreStop`-flush,
   shipping to D1's push-ingest. The canonical `claude-tree-classification` (ADR 0011 invariants)
   is the single home of the `config | session-data | secret` mapping, consumed by both the bake
   (takes `config`) and the shipper (takes `session-data`), both refusing `secret`.
10. **D3 — Golden-image config-snapshot bake + tree-classification + personal-OAuth path (#1250).**
    Dynamic bake snapshots live `~/.claude` *config* into a content-hash-tagged image (secrets +
    session history excluded); `RemoteSession` pins `spec.image`/`configVersion`.

### Convergence

11. **C — Deploy + verify (single-tenant).** Helm chart wires the artifact-substrate env (`S3_*` /
    `AWS_*`, §2) into the app Deployment env; the reconciler patches `envFrom` for the OBC-generated
    CM+Secret. End-to-end (ADR 0011 MVP acceptance / #1249): provision a `RemoteSession{headless}` CR
    → operator dispatches a Job → `claude -p` runs in a clone-per-dispatch workspace → the sidecar
    ships telemetry to push-ingest → the dispatch appears in the hosted `DashboardInstance` **and**
    produces a PR; an OOMKilled pod loses only the last unflushed delta; the shipper provably never
    transmits `.credentials.json`.

**Critical-path summary:** `S1 → S2` (server infra) and `B1 → B2 → B3 → B4` (platform) run in
parallel with the **k8s-free `D1` (#1248)** — which can land first and standalone. `D2`/`D3` join the
pod path. All converge at the **env contract (§2)** and at deploy/verify **C**. `B5` is an independent
leaf. The single hard cross-track dependency is the **env contract (§2)**, which the app consumes and
B2/B4 produce.

---

## 2. The unified env contract (resolves Contradiction C6)

The three docs each named the server's S3 + OIDC env differently. This table is now **normative**;
every doc's code and every Helm/reconciler/Vault artifact MUST use exactly these names. The
**S3_*/AWS_*** rows are the MVP **artifact-substrate** contract; the `OIDC_*` rows are
**#467-deferred** (kept here for reference, marked NOT-MVP), and `COACH_FLAVOR`/`PUBLIC_ORIGIN` are
`DashboardInstance`/#467 concerns.

| Env var | Meaning | Source | Consumed by | Scope |
|---|---|---|---|---|
| `S3_ENDPOINT` | S3 endpoint URL | reconciler `envFrom` (derived from OBC `BUCKET_HOST`/`BUCKET_PORT`) — see note | doc 10 `sigv4.ts` (artifact-blob client) | **MVP** |
| `S3_BUCKET` | Bucket name | reconciler `envFrom` (OBC `BUCKET_NAME`) — see note | doc 10 `sigv4.ts` | **MVP** |
| `S3_REGION` | SigV4 region (default `us-east-1`) | Helm chart default | doc 10 `sigv4.ts` | **MVP** |
| `AWS_ACCESS_KEY_ID` | S3 access key | reconciler `envFrom` (OBC-generated Secret, this exact key) | doc 10 `sigv4.ts` | **MVP** |
| `AWS_SECRET_ACCESS_KEY` | S3 secret key | reconciler `envFrom` (OBC-generated Secret, this exact key) | doc 10 `sigv4.ts` | **MVP** |
| `COACH_FLAVOR` | `public` selects the public entrypoint/gate; unset = loopback/single-tenant | Helm chart (app Deployment env) | `server.mjs` / entrypoint selection, gate policy | **#467 / DashboardInstance** |
| `PUBLIC_ORIGIN` | The one trusted browser origin, e.g. `https://probaitio.com` | Helm chart (always-present app wiring) | doc 40 `PUBLIC_ORIGIN_HOST`, doc 10 `originAllowed` | **#467 / DashboardInstance** |
| `OIDC_ISSUER` | Keycloak realm issuer URL | Vault-synced Secret | doc 10 `oidc.ts` | **#467** |
| `OIDC_CLIENT_ID` | OIDC client id (`probaitio`) | Vault-synced Secret | doc 10 `oidc.ts` | **#467** |
| `OIDC_CLIENT_SECRET` | Confidential-client secret (from realm import) | Vault-synced Secret | doc 10 `oidc.ts` | **#467** |
| `OIDC_REDIRECT_URI` | `${PUBLIC_ORIGIN}/api/auth/callback` | Helm chart (derived) or Vault | doc 10 `oidc.ts` | **#467** |
| `SESSION_COOKIE_KEY` | 32-byte base64 AES-256-GCM session key | Vault-synced Secret | doc 10 `session-cookie.ts` | **#467** |
| `COMPUTE_PROXY_ENABLED` | #467 proxy flag; fail-closed default `false` | operator (overrideValues / proxy reconcile) | `server.mjs` `/api/proxy` | **#467** |

**Decisions baked in (MVP, artifact substrate):**

- **S3 credential keys are `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`** (doc 10's SigV4 names),
  **not** doc 30's seed names `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`. Rationale: the OBC-generated
  Secret already uses the `AWS_*` names (doc 20 §3.5), and the reconciler wires that Secret straight
  in via `envFrom` (doc 20 §3.6) with no rename. Renaming would force the operator to copy/transform
  the Secret — extra moving parts for no gain. **Doc 30's `seed-vault.sh` must be corrected** to not
  seed S3 creds into Vault at all: the OBC is the source of truth for S3 creds, delivered by
  `envFrom`, not Vault.
- **`S3_ENDPOINT`/`S3_BUCKET` are derived by the reconciler from the OBC ConfigMap**
  (`BUCKET_HOST`/`BUCKET_PORT`/`BUCKET_NAME`), not seeded into Vault. Two options for delivery, pick
  one in B2: (a) the reconciler composes `S3_ENDPOINT=https://${BUCKET_HOST}:${BUCKET_PORT}` and adds
  it as explicit env on the patch; or (b) the server reads `BUCKET_HOST`/`BUCKET_PORT`/`BUCKET_NAME`
  directly and `sigv4.ts` is adjusted to build the endpoint from those. **Default: (a)** — keeps
  `sigv4.ts` reading a single `S3_ENDPOINT` and contains the OBC-specific naming entirely inside the
  reconciler. This is a small edit to doc 20 §3.6's `patchAppEnvFrom` (add a composed-env patch
  alongside the `envFrom` refs).

**Decisions baked in (#467-deferred):**

- For the MVP, Vault (B4) carries **no application secrets** — the only secrets the single-tenant
  substrate needs are the per-dispatch `credentialRef` (an enterprise-API key Secret under ADR 0008,
  or the personal-OAuth token refreshed in-pod) and a scoped GitHub-token Secret for the PR return
  channel. When the #467 layer lands, Vault additionally carries **`OIDC_*` + `SESSION_COOKIE_KEY`**
  (the secrets that are *not* generated by another operator). The OBC stays the source of truth for
  S3 creds in both eras.
- **`COMPUTE_PROXY_ENABLED`** is the canonical flag name across server + operator and is **#467**;
  doc 20 §3.7's proxy Deployment and the server's `/api/proxy` are part of the deferred compute-proxy
  layer (fail-closes when absent or `false`).

---

## 3. Contradictions found and how each is resolved

> C1 and C5 are **MVP** (the platform spine). C2, C4, C7, C8 govern the **#467-deferred** public
> OIDC/same-origin server half — they remain correct for that work and are noted as deferred. C3 and
> C6 are bookkeeping that apply to both eras.

### C1 — CR group/version/kind: `apps.claudecoach.dev` vs `coach.skrzypek.dev` (now **`probaitio.com`**) — **MVP**

- **Doc 20** uses `apps.claudecoach.dev/v1alpha1`, kind `ClaudeCoach`, operator module
  `github.com/shpwrck/claude-coach-operator`.
- **Doc 30** uses `coach.skrzypek.dev/v1alpha1`, CRD `claudecoaches.coach.skrzypek.dev`, and says
  "the reconciler's domain is `skrzypek.dev`."

These cannot both be true — the CSV `owned`/`required` CRD names, the FBC `olm.gvk` property, the
reconciler's `groupversion_info.go`, the `watches.yaml` `group:`, and the RBAC `apiGroups` must all
be one string.

**Resolution (ADR 0011 §2, §845): standardize on `probaitio.com/v1alpha1` with TWO kinds on the one
operator/group — `RemoteSession` (`remotesessions.probaitio.com`, the agent-session DISPATCH kind,
`spec.mode: headless | interactive`; the MVP's primary kind) and `DashboardInstance`
(`dashboardinstances.probaitio.com`, the hosted-dashboard DEPLOYMENT kind that the old single
`ClaudeCoach` CRD became).** There is **one operator, one API group, multiple kinds** — not a CRD per
concern. Rationale: ADR 0011 renames the product to **Probaitio** and pins the group to `probaitio.com`;
the earlier `apps.claudecoach.dev` / `coach.skrzypek.dev` strings and the single `ClaudeCoach` kind
are both superseded. **Action:** doc 20 and doc 30 must be edited to replace every
`apps.claudecoach.dev` / `coach.skrzypek.dev` with `probaitio.com` and the `ClaudeCoach` /
`claudecoaches.coach.skrzypek.dev` kind with the appropriate one of `remotesessions.probaitio.com` /
`dashboardinstances.probaitio.com` in `watches.yaml`, `cmd/main.go` scheme/import comments, the
controllers, the RBAC markers (`apiGroups=probaitio.com`), §6's ownership table, the CSV `owned` block,
the FBC `olm.gvk`, and the alm-examples. The operator becomes `probaitio-operator`; the Go module path
may stay `claude-coach-operator` or become `github.com/shpwrck/probaitio-operator` (cosmetic). The Helm
chart dir `helm/claude-coach` → `helm/probaitio`; CSV `claude-coach-operator.v0.1.0` →
`probaitio-operator.v0.1.0`.

### C2 — Does the legacy CSRF token survive in the public flavor? — **#467-deferred**

> Applies to the deferred public write-gate (the #467 multi-tenant layer). Recorded as settled for
> when that work lands.

- **Doc 10 §3** (its rewrite of the gate): the public flavor's third auth layer is
  `coach_sess` cookie **AND a double-submit CSRF token** (random readable cookie echoed in
  `X-CSRF-Token`, reusing `extractToken`/`tokensMatch`).
- **Doc 40 §2** (its rewrite of the same gate): **drop** the per-process token in the public
  flavor, **disable** `GET /api/csrf-token` (404), and rely on `requireSession` + `isSameOrigin` +
  JSON content-type.

This is a direct contradiction about the same `passesWriteAuth` code path.

**Resolution: adopt doc 40's decision — drop the *per-process* `POLICY_WRITE_TOKEN` in the public
flavor and 404 `/api/csrf-token`.** Doc 40's three reasons are sound and specific to our locked
infra: with `replicas:1` the per-process token rotates on every pod restart (a self-inflicted
failure mode), it is redundant with `SameSite=Lax` + the `Origin` check, and exposing a process
secret over `GET /api/csrf-token` is a multi-tenant liability.

**But doc 10's instinct is not discarded** — it was reaching for a CSRF defense that does *not*
depend on a shared process secret. Reconcile by noting that doc 10's "double-submit token" was
described as reusing `POLICY_WRITE_TOKEN`/`extractToken`/`tokensMatch`; that specific mechanism is
what doc 40 retires. If, when #467 lands, the team wants belt-and-suspenders beyond `SameSite` +
`Origin`, the correct primitive is a **per-session** double-submit token derived from the sealed
session (not a per-process secret) — recorded as Q3, not committed scope. Public-flavor gate =
`requireSession AND isSameOrigin AND Content-Type: application/json`. The local/single-tenant flavor
keeps the token unchanged (no conflict there).

### C3 — Filename drift: doc 40 cites a non-existent `30-oidc-session.md` — bookkeeping

Doc 40 §2 references "the OIDC deep-dive (sibling doc `30-oidc-session.md`)" and §5 says
`requireSession` is "defined in the OIDC deep-dive." The actual OIDC doc is **`10-oidc-sigv4.md`**,
and doc 10 names its session module `src/lib/auth/session-cookie.ts` with handlers in
`scripts/server.public.mjs` — it does not define a function literally called `requireSession`.

**Resolution:** (1) Fix doc 40's cross-references from `30-oidc-session.md` → `10-oidc-sigv4.md`.
(2) Define the contract for `requireSession(req)` (a thin wrapper over `session-cookie.ts`'s `open`
that returns truthy iff a non-expired session opens) — both halves of the **#467-deferred** public
server agree on it. Doc 10 adds the named export; doc 40 consumes it.

### C4 — One entrypoint (`server.mjs` patched) or two (`server.public.mjs`)? — **#467-deferred**

> Applies to the deferred public OIDC/same-origin server half. The MVP single-tenant server keeps
> `server.mjs`'s loopback behavior byte-identical and mounts none of the public auth handlers.

- **Doc 10** creates a **separate** `scripts/server.public.mjs` that mounts the OIDC handlers and
  the public gate, importing shared primitives.
- **Doc 40** patches **`scripts/server.mjs` in place**, gating new behavior on `PUBLIC_ORIGIN_HOST`
  (and references `COACH_FLAVOR`), and its test boots `scripts/server.mjs` (not `server.public.mjs`).

**Resolution: single entrypoint, `scripts/server.mjs`, flavor-gated at runtime.** Rationale: the
locked CORRECTED DECISIONS already require the gate refactor to keep `server.mjs`'s loopback behavior
byte-identical, and the dependency-free runtime loads `.ts` helpers via `register-ts` regardless of
entrypoint. Two entrypoints means two boot paths to keep in lockstep, two `/healthz` routes
(Contradiction C7), and a test that already assumes one binary. So the OIDC `/api/auth/*` handlers,
`requireSession`, and the public-gate composition mount **inside `server.mjs`**, conditionally on
`COACH_FLAVOR === 'public'`; `scripts/server.public.mjs` is dropped in favor of the env var
(`Dockerfile.public` sets `ENV COACH_FLAVOR=public`). The unconditional `/healthz` route (C7) **does**
carry into the MVP image (S2 above).

### C5 — Reconciler discovery boundary vs. OLM `required`-CRD declarations — **MVP**

- **Doc 20** resolves OBC / VaultStaticSecret (and, in the #467 era, Keycloak) GVKs **at runtime via
  discovery**, deliberately does **not** register their schemes, and requeues behind CRD-exists
  checks. It pins no apiVersion.
- **Doc 30** declares them as `required` CRDs in the CSV with **pinned versions**
  (`objectbucketclaims.objectbucket.io` `v1alpha1`, `vaultstaticsecrets.secrets.hashicorp.com`
  `v1beta1`; `keycloaks.k8s.keycloak.org` `v2alpha1` is **#467-only**) and mirrors them as
  `olm.gvk.required` FBC properties — which **fail the InstallPlan at admission** if absent.

These are not contradictory in *intent* (both want the CRDs present before the operator acts), but
they are inconsistent on **who enforces ordering** and they can **drift on version pins**. A
`required: vX` that the cluster no longer serves would **block install** even though the reconciler
would have happily discovered the new version.

**Resolution — make the two layers complementary, with discovery as the correctness mechanism and
OLM `required` as a *minimal, version-tolerant* admission hint:**

1. **The reconciler's runtime discovery is authoritative for which version to *act* on.** Keep doc 20
   exactly: no scheme registration, `PreferredGVK`, requeue behind CRD-exists.
2. **The CSV `required` block stays — it is the load-bearing fix for the InstallPlan blocker (doc 30
   §1a) — but the version pins are documented as a "resolution hint, kept in lockstep with the chosen
   operator channel."** The bootstrap (doc 30 §3) installs the owning operators first, so by admission
   time the CRD exists at whatever version that operator ships; the `required.version` must match that
   shipped version. Acceptable because the bootstrap and the CSV are released together.
3. **Single source of truth for the version pins:** the chosen ODF/VSO (and #467 RHBK) channel
   versions are recorded once (in doc 30's prereq subscriptions) and the CSV `required.version` + FBC
   `olm.gvk.required` are generated/checked against them. **Action:** add a CI/`make` lockstep check.
4. **OBC version discrepancy:** doc 30 pins OBC `v1alpha1`; confirm against the ODF release in the
   bootstrap. Fold into the same lockstep check.

The ownership boundary itself (chart = always-present; reconciler = discovered/conditional/runtime-
named) is **identical** across docs 20 and 30 — no contradiction there, only the version-pin lockstep
needs the guard above.

### C7 — Two `/healthz` routes — applies to MVP image

Consequence of C4. **Resolution:** `/healthz` is a single dependency-free route in `server.mjs`,
mounted **before** any auth gate in every flavor (it already needs to answer with unreachable
upstreams for the boot gate). The `public-image` boot gate (S2, an MVP carry) and the #467 public test
both hit the one route. **Action:** move doc 10's `/healthz` snippet into `server.mjs`'s route table
(unconditional, above the gate).

### C8 — `originAllowed` (doc 10) vs `isSameOrigin` (doc 40) — same function, two names/shapes — **#467-deferred**

> Applies to the deferred public same-origin gate.

Doc 10 §3 renames `isSameOrigin` → `originAllowed` and reads `PUBLIC_ORIGIN` *inside* the function;
doc 40 §1 keeps the name `isSameOrigin` and parses `PUBLIC_ORIGIN_HOST` **once at boot** (fail-fast),
adding it to the `Set` inside the function.

**Resolution: adopt doc 40's shape and name.** Keep the function named `isSameOrigin` (minimizes the
diff against the existing code + test), parse `PUBLIC_ORIGIN` once at boot into `PUBLIC_ORIGIN_HOST`
(fail-fast on a malformed value is strictly better than per-request silent failure), and add it to
the allowlist `Set`. **Action:** doc 10 §3 step 1 edited to defer to doc 40 §1 for the exact
`isSameOrigin` body; doc 10 keeps ownership of the session/token layers only.

---

## 4. Consolidated, deduplicated issue list

The MVP children file under epic **#1247**; the deferred items file under **#467**. Server issues are
dashboard-repo code (normal PRs); operator/OLM issues are also dashboard-repo code (the `operator/`
and `deploy/` trees live in this repo) — **none are `meta`**. Ordered by the build order in §1.

### MVP — #1247 children (ADR 0011)

1. **#1248 — `artifact-source` interface + push-ingest endpoint (multi-source aggregation)** —
   `list`/`read` by `source_id + rel_path + signature`; idempotent signature-gated push-ingest; the
   existing parse + SQLite parse-cache pipeline ingests pushed artifacts unchanged; SQLite demoted to
   a single-writer local accelerator. The k8s-free first slice (D1). Backed by the SigV4 blob client.
2. **#1249 — Operator + `RemoteSession` CRD (headless) + sidecar shipper: one pod end-to-end** —
   the operator scaffold (B1), the `RemoteSession{headless}` dispatch reconcile (B2: Job/`claude -p`,
   clone-per-dispatch, per-dispatch `credentialRef`, branch+PR return channel), and the
   native-sidecar shipper (D2) → push-ingest → hosted dashboard. Acceptance per ADR 0011 MVP scope.
3. **#1250 — Golden-image config-snapshot bake + canonical tree-classification + personal-OAuth
   path** — dynamic bake of live `~/.claude` *config* (secrets + session history excluded) into a
   content-hash-tagged image; the one canonical `claude-tree-classification`
   (`config|session-data|secret`) consumed by both the bake and the shipper; the personal-OAuth
   credential path (in-pod token refresh) (D3).
4. **#1251 — Interactive mode: `claude remote-control` pod + claude.ai/code registration** — the
   `RemoteSession{interactive}` mode on the shared pod substrate.

### MVP — carried infra issues (from docs 10/20/30/40)

5. **Hand-rolled SigV4 S3 client: `src/lib/s3/sigv4.ts`** — canonical request + HMAC signing-key
   chain, path-style OBC endpoint, `s3Put` (UNSIGNED-PAYLOAD stream) / `s3Get` / `s3List`
   (empty-payload sha256), reads the unified `S3_*` + `AWS_*` env (§2). The **artifact-blob
   substrate** client (ADR 0011 §1/§8), no `@aws-sdk`. (S1)
6. **`public-image`/boot-the-image CI gate + runtime `Dockerfile` + arbitrary-UID/SCC fix** — build
   the runtime image, assert **zero `node_modules`** (#1013 guard, ADR 0011 §8), boot it, curl
   `/healthz`; run under OpenShift `restricted-v2` SCC. (S2)
7. **Scaffold the hybrid.helm operator + typed `RemoteSession` + `DashboardInstance` API + app Helm
   chart** — `operator/` tree; chart (`helm/probaitio`) owns **only** the always-present
   `DashboardInstance` app resources (Deployment/Service/Route/PVC/envFrom-wiring); CR group
   **`probaitio.com/v1alpha1`**, two kinds (C1). `overrideValues` pins `replicaCount:1`. (B1)
8. **Go reconciler: `RemoteSession` dispatch + discovery + ordered dependency pipeline** — dispatch
   reconcile (Job/`claude -p`, clone-per-dispatch, `credentialRef`); `PreferredGVK` runtime discovery
   (no scheme registration, no hardcoded apiVersion); OBC→Vault ordered ensure/wait; status conditions
   (`BucketBound`/`SecretsSynced`/`AppReady` with verified `allTrue` gate). (B2)
9. **Reconciler envFrom + composed S3 env patch** — SSA-patch the app Deployment with `envFrom` for
   the OBC-generated CM+Secret **and** a composed `S3_ENDPOINT`/`S3_BUCKET` from `BUCKET_HOST`/
   `BUCKET_PORT`/`BUCKET_NAME` (§2 option (a)). (B2)
10. **Reconciler RBAC (kubebuilder markers → role.yaml)** — own-CR groups under `probaitio.com`, core
    Secret/ConfigMap read, Deployment/Service/Job manage, CRD discovery. (B2)
11. **OLM bundle (CSV) with owned + required CRDs** — owned `remotesessions.probaitio.com` +
    `dashboardinstances.probaitio.com`; required `ObjectBucketClaim`/`VaultStaticSecret`; install modes
    Own/Single only; `clusterPermissions` matching the reconciler; CSV `probaitio-operator.v0.1.0`. (B3)
12. **FBC catalog + CatalogSource/OperatorGroup/Subscription (OLM Classic)** — `opm`
    package/channel/bundle stanzas; grpc CatalogSource with `spec.secrets` (private Quay); SingleNamespace
    OG; `installPlanApproval: Manual`. (B3)
13. **Ordered prereq bootstrap (`deploy/openshift/bootstrap.sh` + prereqs)** — install + wait-Ready
    ODF (+ standalone MCG), VSO, and Vault **before** the Probaitio CatalogSource/Subscription; approve
    the Manual InstallPlan. (RHBK is #467-deferred.) (B4)
14. **Vault/VSO secrets (`seed-vault.sh`) — per-dispatch credential + GitHub-token only (MVP)** —
    kv-v2 enable, k8s auth + role; for the single-tenant MVP seed only the per-dispatch enterprise-API
    `credentialRef` (ADR 0008) and the scoped GitHub-token Secret. **Do NOT seed S3 creds** (OBC
    `envFrom` is the source of truth, §2). (`OIDC_*` + `SESSION_COOKIE_KEY` seeding is #467.) (B4)
15. **`operator-publish.yml` Quay workflow** — separate from `docker-publish.yml`; build/push operator
    + bundle + catalog images on `operator-v*` tags as `ghcr.io/probaitio/*` (+ `quay.io/probaitio/*`
    mirror); new `QUAY_*` secrets. (B5)
16. **CSV required-CRD version lockstep check** — CI/`make` check (or documented checklist) that the
    `required.version` pins in the CSV/FBC equal the versions the prereq operators actually serve (the
    C5 guard); fail loudly on drift. (B3/B4)

### Deferred to #467 (multi-tenant / zero-knowledge layer) — NOT MVP

These are **#467** children, built *onto* the substrate later (ADR 0011 MVP scope). Kept here for
reference; not on the MVP critical path.

- **Rewrite `isSameOrigin` for a configured `PUBLIC_ORIGIN` allowlist** (A1) — the same-origin public
  write gate. (doc 40)
- **Dependency-free OIDC core: `src/lib/auth/oidc.ts`** — discovery+JWKS, PKCE S256, RS256 ID-token
  verify via `node:crypto`; no npm deps. (doc 10)
- **Encrypted session cookie: `src/lib/auth/session-cookie.ts`** — AES-256-GCM seal/open, transient
  sealed PKCE cookie (no server session store; keeps `replicas:1` honest). (doc 10)
- **Public-flavor write-auth gate + `/api/auth/*` handlers in `server.mjs`** —
  `requireSession AND isSameOrigin AND JSON`; drop the per-process token + 404 `/api/csrf-token`
  (C2); single entrypoint (C4). (doc 10 + 40)
- **Public-flavor same-origin test: `scripts/same-origin-public.test.mjs`.** (doc 40)
- **Chokepoint (#324) auth helpers in `api-client.ts`** — `fetchSession`/`loginRedirect`/`logout`;
  SPA stub mirrors as `SERVER_AVAILABLE===false` no-ops. (doc 10/40)
- **Client-side encryption + encrypted-blob/ciphertext store** — the zero-knowledge-at-rest layer; the
  sidecar holds the key and encrypts before push. The ADR 0011 §1 `artifact-source` boundary is
  **designed-for** this (adding it later is an encryption step at the boundary, not a re-architecture).
- **API-key compute proxy + `COMPUTE_PROXY_ENABLED`** — operator-owned, fail-closed, off in MVP.
  (doc 20 §3.7, server `/api/proxy`)
- **Keycloak/RHBK prereq + realm import + `OIDC_*`/`SESSION_COOKIE_KEY` Vault seeding** — the invite-only
  OIDC login layer (bootstrap + `seed-vault.sh` additions). (doc 30 §3)

**Consolidations applied (deduplication record):**

- Doc 20 §8 and doc 30 §4's "boot the runtime image + curl `/healthz`" CI gate are **one** issue
  (MVP carried #6 above), owned by the server track, referenced by both platform docs.
- Doc 10's separate `scripts/server.public.mjs` entrypoint issue is **folded into** the deferred
  public-gate issue (single entrypoint, C4) rather than filed on its own.
- Doc 10's "double-submit CSRF token in the public flavor" is **not** a child issue — superseded by
  C2 (dropped); the per-session-token belt-and-suspenders is recorded as an open question (Q3).
- The Keycloak `v2alpha1`/`v2beta1` re-confirm note (doc 30 "Open items") is **folded into** the
  version lockstep check (#16), not a standalone doc-fix issue.

---

## 5. New open questions for the user

> Q2 (domain/API-group) is now **settled** by ADR 0011/§845: API group is `probaitio.com/v1alpha1`,
> kinds `RemoteSession` + `DashboardInstance`. Q1, Q4, Q5 are **#467-deferred** (they govern the
> public OIDC/same-origin server). Q3 and Q6 are recorded for the deferred era.

- **Q1 — One flavor selector or two? (#467)** The docs reference both `COACH_FLAVOR=public` (doc 10)
  and "is `PUBLIC_ORIGIN_HOST` set" (doc 40) as the thing that toggles public behavior. Pick one as
  canonical (recommend `COACH_FLAVOR=public`, with a boot-time assertion that `PUBLIC_ORIGIN` is also
  set). Decide when #467 lands.
- **Q3 — Belt-and-suspenders CSRF beyond `SameSite` + `Origin`? (#467)** When #467 lands, do you want a
  **per-session** double-submit token (derived from the sealed session, no shared secret) for
  old-browser / `SameSite=None` edge cases, or is `requireSession + isSameOrigin + JSON` sufficient?
- **Q4 — `OIDC_REDIRECT_URI` source. (#467)** Derived by the Helm chart from `PUBLIC_ORIGIN`
  (`${PUBLIC_ORIGIN}/api/auth/callback`, simplest) or seeded in Vault?
- **Q5 — Session cookie `SameSite=Lax` vs `Strict`. (#467)** Doc 10 uses `Lax` (survives the top-level
  OIDC redirect GET back from Keycloak — required for login). Recommend `Lax` (Strict would break the
  callback redirect).
- **Q6 — Realm-import / OIDC-client-secret two-pass handshake ownership. (#467)** `OIDC_CLIENT_SECRET`
  is produced by the realm import, which the reconciler creates, but Vault must be seeded before VSO
  syncs. Who closes the loop — does the reconciler write the realm-generated secret back into Vault
  (needs Vault write RBAC), or is it pre-generated and seeded into both Keycloak and Vault out of
  band? Unresolved; blocks a clean #467 Keycloak bootstrap.

---

## Decision summary (one-screen)

- **MVP (ADR 0011, single-tenant #1247):** the **platform spine** (B1 operator scaffold with
  `RemoteSession` + `DashboardInstance` on `probaitio.com/v1alpha1` → B2 reconciler/dispatch → B3 OLM
  bundle → B4 bootstrap+seed → B5 Quay publish) runs in parallel with the **k8s-free data plane**
  (D1 #1248 artifact-source+push-ingest, then D2 sidecar shipper + D3 bake) and the **carried server
  infra** (S1 SigV4 blob client, S2 boot-the-image gate + `/healthz`). All converge at the env
  contract (§2) and deploy/verify (C): a `RemoteSession{headless}` CR → Job → ship → appears in the
  hosted `DashboardInstance` + a PR.
- **Naming (ADR 0011/§845):** product **Probaitio**; API group **`probaitio.com/v1alpha1`**; kinds
  **`RemoteSession`** + **`DashboardInstance`** (replacing the single `ClaudeCoach` CRD); operator
  **`probaitio-operator`**; chart `helm/probaitio`; images `ghcr.io/probaitio/*` (+ `quay.io/probaitio/*`
  mirror); CSV `probaitio-operator.v0.1.0`.
- **Deferred to #467 (multi-tenant / zero-knowledge):** Keycloak OIDC, client-side encryption, the
  encrypted-blob/ciphertext store, the public same-origin/CSRF write gate, and the API-key compute
  proxy. The `artifact-source` boundary (§1 of ADR 0011) is designed-for the zero-knowledge encryption
  step. Contradictions C2/C4/C8 and questions Q1/Q3/Q4/Q5/Q6 govern this deferred work.
- **Contradictions resolved:** C1 → **MVP**: `probaitio.com/v1alpha1`, kinds `RemoteSession` +
  `DashboardInstance` (edit docs 20 + 30). C5 → **MVP**: discovery authoritative for *acting*; CSV
  `required` stays with a version-lockstep CI check (#16). C6 → unified env contract (§2): MVP uses
  `S3_*`/`AWS_*` from OBC `envFrom` (the artifact substrate); `COACH_FLAVOR`/`PUBLIC_ORIGIN`/`OIDC_*`
  are #467. C7 → single `/healthz` in `server.mjs` (carries to the MVP image). C2/C4/C8 →
  #467-deferred public gate (settled for that era).
- **Issues:** 16 MVP children (#1248–#1251 + 12 carried infra) + 9 #467-deferred (OIDC, session
  cookie, public gate + handlers + test, chokepoint auth, client-side encryption, blob/ciphertext
  store, compute proxy, Keycloak bootstrap); none `meta`.
