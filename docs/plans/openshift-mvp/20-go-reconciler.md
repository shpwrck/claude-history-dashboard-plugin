# 20 — Go Reconciler (Hybrid Helm Operator)

> **Status:** reconciled to ADR 0011 (single-tenant #1247 substrate, Probaitio naming). The
> multi-tenant/zero-knowledge pieces (Keycloak, client-side encryption, encrypted-blob store,
> public write gate, compute proxy) are **deferred to #467** and collected in a section below.
>
> **Superseded by what shipped (as of 2026-07-22):** the operator that actually shipped (#1559)
> is a plain **controller-runtime** reconciler, **not** the operator-sdk `hybrid.helm` design
> below (#1956). Treat the hybrid-Helm packaging in this doc as a point-in-time proposal; see
> `probaitio-operator/` for the shipped controller-runtime implementation.

Implementation-ready design for the **hybrid Helm operator** that packages the single-tenant
Probaitio substrate (epic #1247, ADR 0011). The operator is built with the operator-sdk
**hybrid.helm** plugin (`operator-sdk init --plugins hybrid.helm.sdk.operatorframework.io/v1-alpha`):
**one Helm chart** templates the always-present app resources, and a **thin Go reconciler**
does the cross-CR work a pure-Helm operator cannot — wait-for-Ready ordering, reading
async-generated resources, conditional sub-resource lifecycle. The chart deliberately does
**not** own any external-dependency CR.

There is **one operator, one API group (`probaitio.com/v1alpha1`), multiple kinds** (ADR 0011 §2):

- **`RemoteSession`** (`remotesessions.probaitio.com`) — the agent-session **dispatch** kind
  (`spec.mode: headless | interactive`). This is the **MVP's primary kind**: the reconciler's
  main job is turning a `RemoteSession{headless}` into a `Job` running `claude -p`.
- **`DashboardInstance`** (`dashboardinstances.probaitio.com`) — the hosted-dashboard
  **deployment** kind (what the earlier `ClaudeCoach` CRD was): the always-on dashboard
  Deployment/Service/Route/PVC that ingested telemetry lands in.

This document is normative for: `watches.yaml`, `cmd/main.go` wiring, the
`RemoteSession`/`DashboardInstance` custom `Reconcile()`s, status conditions, RBAC markers,
and the chart-vs-reconciler ownership boundary. It builds on the LOCKED INFRA and ADR 0011
decisions; do not re-litigate those here.

## 0. Why hybrid, and the one rule that drives everything

The hybrid plugin gives us a `helm-operator-plugins` `reconciler.Reconciler` (the Helm face)
*and* a hand-written controller-runtime `Reconciler` (the Go face) on **one** manager,
**one** binary, **one** Deployment, all on **one** API group/version: `probaitio.com/v1alpha1`.
The Helm face renders the always-present app resources for a `DashboardInstance`; the Go face
reconciles `RemoteSession` dispatch (the genuinely harness-native seam no chart can model) and
does the cross-CR orchestration for `DashboardInstance`.

The single rule that decides who creates each resource:

> **The Helm chart may template only resources that exist for every install, in every
> cluster, with no runtime discovery.** Anything whose GVK, name, or generated output is
> only knowable at runtime — every external-dependency CR, and every Secret/ConfigMap those
> CRs *generate* — is created/owned by the **Go reconciler**, never templated. Likewise the
> per-dispatch `Job`/pod, clone workspace, and sidecar wiring for a `RemoteSession` are pure
> runtime-generated state: reconciler-owned, never chart-templated.

That is why `VaultStaticSecret` (the GitHub-token + enterprise-API-key Secrets), and the
per-dispatch `Job`, are reconciler-owned: a CRD may be absent at chart-render time, an API
version may straddle, and a per-dispatch Job name is computed at reconcile time. Templating
any of them into the chart makes `helm template` / `helm install` fail on a fresh cluster
before the operator can requeue.

## 1. Project layout

```
operator/
  Dockerfile
  Makefile
  PROJECT                       # plugin chain records hybrid.helm + go layout
  watches.yaml                  # Helm face: maps DashboardInstance -> the app chart
  cmd/
    main.go                     # wires BOTH reconcilers onto one manager
  api/
    v1alpha1/
      remotesession_types.go    # Spec/Status for the dispatch kind (Go face owns it)
      dashboardinstance_types.go# Spec/Status for the hosted-dashboard kind
      groupversion_info.go      # group = probaitio.com, version = v1alpha1
      zz_generated.deepcopy.go
  internal/
    controller/
      remotesession_controller.go    # dispatch Reconcile() (this doc, §3)
      dashboardinstance_controller.go # hosted-dashboard Reconcile() (this doc, §3.8)
      discovery.go              # RESTMapper/discovery helper (this doc, §3.1)
      conditions.go             # condition setters (this doc, §4)
      dispatch.go               # ensureJob / ensureWorkspace / ensureSidecar steps
      credential.go             # resolveCredentialRef (enterprise-api | personal-oauth)
      vault.go                  # ensureVaultStaticSecrets (GitHub token + API key)
  helm-charts/
    probaitio/                   # the app chart (dashboard Deployment/Service/Route/PVC only)
      Chart.yaml
      values.yaml
      templates/...
  config/
    rbac/role.yaml              # GENERATED from kubebuilder markers (§5)
    crd/bases/...
```

The `hybrid.helm` plugin scaffolds `SkipPrimaryGVKSchemeRegistration` already wired so the
Helm reconciler can share the scheme with our typed `DashboardInstance` API. We keep **typed**
`RemoteSession` and `DashboardInstance` (not `unstructured`) because the Go reconciler reads
`spec.mode`, `spec.credentialRef`, `spec.image`/`configVersion` and writes structured status
conditions (claude.ai/code link, pod phase, ingest watermark, PR URL — ADR 0011 "Open").

## 2. The Helm face

### 2.1 `watches.yaml`

The chart owns *only* the always-present hosted-dashboard app resources (§6) and is keyed to
`DashboardInstance`. `RemoteSession` is **not** in `watches.yaml` — it has no chart; it is
reconciled entirely by the Go face (§3). The Helm reconciler renders the chart from the same
`DashboardInstance` CR. `overrideValues` is how the Go face forces values the chart must never
let a caller set (replica pin):

```yaml
# operator/watches.yaml
- group: probaitio.com
  version: v1alpha1
  kind: DashboardInstance
  chart: helm-charts/probaitio
  # Force these regardless of CR spec / chart defaults. $VAR pulls from the
  # operator pod's env (set on the operator Deployment).
  overrideValues:
    # SQLite parse-cache is RWO single-process: never let the chart scale past 1.
    replicaCount: "1"
    image.tag: $OPERATOR_APP_IMAGE_TAG
  # Dependent-resource watching is fine for chart-owned objects; the external
  # CRs / dispatch Jobs are watched by the Go controllers via Owns()/Watches() in §3.
  watchDependentResources: true
  reconcilePeriod: 1m
```

`overrideValues` semantics (verified against the `helm-operator-plugins` reconciler API):
an override **always wins** over both the chart's `values.yaml` default and a value set on
the CR spec — exactly the enforcement we want for the replica pin. The
`$OPERATOR_APP_IMAGE_TAG` form is the library's documented env-var interpolation.

> **Important:** `overrideValues` is applied by the **Helm** reconciler. The Go reconciler
> does not edit `watches.yaml` at runtime. We do **not** mutate `watches.yaml` live; the Go
> face patches owned resources (the dashboard Deployment's `envFrom`, the per-dispatch Job)
> directly.

### 2.2 `cmd/main.go` — both reconcilers on one manager

This is the load-bearing wiring. The Helm reconciler is constructed from the parsed
`watches.yaml` entry (the `DashboardInstance` chart); the Go reconcilers are our typed
`RemoteSession` and `DashboardInstance` controllers. All call `SetupWithManager(mgr)` before
`mgr.Start`.

```go
// operator/cmd/main.go
package main

import (
	"flag"
	"os"

	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"

	"github.com/operator-framework/helm-operator-plugins/pkg/annotation"
	helmreconciler "github.com/operator-framework/helm-operator-plugins/pkg/reconciler"
	"github.com/operator-framework/helm-operator-plugins/pkg/watches"

	probaitiov1alpha1 "github.com/shpwrck/probaitio-operator/api/v1alpha1"
	"github.com/shpwrck/probaitio-operator/internal/controller"
)

var (
	scheme   = runtime.NewScheme()
	setupLog = ctrl.Log.WithName("setup")
)

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(probaitiov1alpha1.AddToScheme(scheme)) // typed RemoteSession + DashboardInstance
	// NOTE: we do NOT add the Vault scheme here. Its CRD may be absent at boot;
	// the Go reconciler talks to it via *unstructured* + runtime discovery (§3.1)
	// so the manager starts even when a CRD is missing.
}

func main() {
	var metricsAddr, probeAddr, watchesFile string
	flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080", "")
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "")
	flag.StringVar(&watchesFile, "watches-file", "watches.yaml", "")
	flag.Parse()
	ctrl.SetLogger(zap.New(zap.UseDevMode(false)))

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme:                 scheme,
		Metrics:                server.Options{BindAddress: metricsAddr},
		HealthProbeBindAddress: probeAddr,
		LeaderElection:         true,
		LeaderElectionID:       "probaitio-operator.probaitio.com",
	})
	if err != nil {
		setupLog.Error(err, "unable to start manager")
		os.Exit(1)
	}

	// ---- Helm face: one reconciler per watches.yaml entry (DashboardInstance) ----
	ws, err := watches.Load(watchesFile)
	if err != nil {
		setupLog.Error(err, "failed to load watches.yaml")
		os.Exit(1)
	}
	for _, w := range ws {
		r, err := helmreconciler.New(
			helmreconciler.WithChart(*w.Chart),
			helmreconciler.WithGroupVersionKind(w.GroupVersionKind),
			helmreconciler.WithOverrideValues(w.OverrideValues),
			helmreconciler.SkipDependentWatches(
				w.WatchDependentResources != nil && !*w.WatchDependentResources),
			helmreconciler.WithMaxConcurrentReconciles(1), // SQLite RWO: keep it serial
			helmreconciler.WithReconcilePeriod(w.ReconcilePeriod.Duration),
			helmreconciler.WithInstallAnnotations(annotation.DefaultInstallAnnotations...),
			helmreconciler.WithUpgradeAnnotations(annotation.DefaultUpgradeAnnotations...),
			helmreconciler.WithUninstallAnnotations(annotation.DefaultUninstallAnnotations...),
			// Share the typed scheme so the Helm face uses our DashboardInstance struct.
			helmreconciler.SkipPrimaryGVKSchemeRegistration(true),
		)
		if err != nil {
			setupLog.Error(err, "unable to build Helm reconciler", "gvk", w.GroupVersionKind)
			os.Exit(1)
		}
		if err := r.SetupWithManager(mgr); err != nil {
			setupLog.Error(err, "unable to setup Helm reconciler", "gvk", w.GroupVersionKind)
			os.Exit(1)
		}
		setupLog.Info("registered Helm reconciler", "gvk", w.GroupVersionKind)
	}

	// ---- Go face: the RemoteSession dispatch controller (MVP primary) ----
	if err := (&controller.RemoteSessionReconciler{
		Client:    mgr.GetClient(),
		Scheme:    mgr.GetScheme(),
		Discovery: controller.NewDiscoveryHelper(mgr), // RESTMapper + discovery (§3.1)
		Recorder:  mgr.GetEventRecorderFor("remotesession"),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create RemoteSession controller")
		os.Exit(1)
	}

	// ---- Go face: the DashboardInstance dependency-orchestration controller ----
	if err := (&controller.DashboardInstanceReconciler{
		Client:    mgr.GetClient(),
		Scheme:    mgr.GetScheme(),
		Discovery: controller.NewDiscoveryHelper(mgr),
		Recorder:  mgr.GetEventRecorderFor("dashboardinstance"),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create DashboardInstance controller")
		os.Exit(1)
	}

	_ = mgr.AddHealthzCheck("healthz", healthz.Ping)
	_ = mgr.AddReadyzCheck("readyz", healthz.Ping)

	setupLog.Info("starting manager")
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		setupLog.Error(err, "problem running manager")
		os.Exit(1)
	}
}
```

**Distinct reconcilers, distinct work, no overlap.** The Helm reconciler owns the chart
release for a `DashboardInstance`; the `DashboardInstanceReconciler` reads the same CR and
reconciles its *external* deps (Vault secrets) plus envFrom wiring; the
`RemoteSessionReconciler` owns dispatch (Job/pod, workspace, sidecar) and never touches the
chart. Each is idempotent and touches disjoint resources.

## 3. The MVP reconcile pipeline — `RemoteSession` dispatch

This is the MVP's primary job (ADR 0011 §2–6, #1249). The Go reconciler turns a
`RemoteSession{headless}` into a running `claude -p` dispatch and verifies it ships telemetry
back. It runs an explicit, ordered, requeue-driven pipeline; each step is a guarded function
returning `(ctrl.Result, error)`, and a non-zero `RequeueAfter` short-circuits the rest so we
never race ahead of an unready dependency. **`Dispatched` / `SessionReady` is set only after
the prerequisite conditions are verified true** (§4).

```go
// operator/internal/controller/remotesession_controller.go
package controller

import (
	"context"
	"time"

	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	probaitiov1alpha1 "github.com/shpwrck/probaitio-operator/api/v1alpha1"
)

const (
	requeueShort = 10 * time.Second
	requeueCRD   = 30 * time.Second // CRD-absent backoff (operator install in progress)
)

type RemoteSessionReconciler struct {
	client.Client
	Scheme    *runtime.Scheme
	Discovery *DiscoveryHelper
	Recorder  record.EventRecorder
}

// +kubebuilder:rbac groups/verbs are declared in §5 (kept next to this type).

func (r *RemoteSessionReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	lg := log.FromContext(ctx)

	rs := &probaitiov1alpha1.RemoteSession{}
	if err := r.Get(ctx, req.NamespacedName, rs); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	// Snapshot status; we patch once at the end so partial progress is observable.
	base := rs.DeepCopy()
	defer func() { _ = r.patchStatus(ctx, base, rs) }()

	// --- Step 1: credential resolution (per-dispatch credentialRef) -------------
	// Resolve spec.credentialRef -> a Secret: enterprise-api (API-key, ADR 0008)
	// or personal-oauth (in-pod token refresh). Enforce per-credential
	// maxConcurrent (OAuth narrow, API wide) before admitting the dispatch.
	credSecret, res, err := r.resolveCredentialRef(ctx, rs)
	if err != nil || !res.IsZero() {
		if errors.IsNotFound(err) {
			setCondition(rs, CondCredentialReady, metav1.ConditionFalse,
				"SecretAbsent", "credentialRef Secret not found")
			setCondition(rs, CondSessionReady, metav1.ConditionFalse, "DependencyPending", "credential")
			return ctrl.Result{RequeueAfter: requeueShort}, nil
		}
		return res, err
	}
	setCondition(rs, CondCredentialReady, metav1.ConditionTrue, "Ready", "credentialRef resolved")

	// --- Step 2: workspace — clone-per-dispatch (the k8s analog of a worktree) ---
	// Honors "never share a checkout": each dispatch gets its own clone, never a
	// shared PVC. Returns the workspace volume spec to mount into the Job.
	if res, err := r.ensureWorkspace(ctx, rs); err != nil || !res.IsZero() {
		return res, err
	}
	setCondition(rs, CondWorkspaceReady, metav1.ConditionTrue, "Cloned", "clone-per-dispatch workspace ready")

	// --- Step 3: the dispatch Job (headless: claude -p) + native-sidecar shipper -
	// SSA a Job whose primary container runs `claude -p "<spec.task>"` against the
	// baked config image (spec.image / configVersion, #1250) with the resolved
	// credential mounted, alongside a NATIVE-SIDECAR shipper (initContainer with
	// restartPolicy:Always) that is signature-incremental, allowlists session-data,
	// denylists .credentials*/paste-cache (the canonical claude-tree-classification,
	// ADR 0011 invariants), and PreStop-flushes to the #1248 push-ingest endpoint.
	if res, err := r.ensureJob(ctx, rs, credSecret); err != nil || !res.IsZero() {
		return res, err
	}
	setCondition(rs, CondDispatched, metav1.ConditionTrue, "JobCreated", "dispatch Job + sidecar created")

	// --- Step 4: observe the dispatch + ingest watermark ------------------------
	// headless: surface Job phase. interactive (#1251): surface the claude.ai/code
	// registration link in status once the long-lived pod is up.
	phase, err := r.observeDispatch(ctx, rs)
	if err != nil {
		return ctrl.Result{}, err
	}
	if !phase.Settled() {
		setCondition(rs, CondSessionReady, metav1.ConditionFalse, "Running", "dispatch in progress")
		lg.Info("dispatch running, requeueing")
		return ctrl.Result{RequeueAfter: requeueShort}, nil
	}

	// --- Step 5: SessionReady — VERIFIED ---------------------------------------
	// SessionReady is only True when the credential resolved, the workspace cloned,
	// the Job was dispatched, AND the shipper has reported an ingest watermark
	// (telemetry reached the push-ingest endpoint). Verified, not assumed (§4).
	if allTrue(rs, CondCredentialReady, CondWorkspaceReady, CondDispatched) && phase.Succeeded() && rs.Status.IngestWatermark != "" {
		setCondition(rs, CondSessionReady, metav1.ConditionTrue, "Ready", "dispatch complete; telemetry ingested")
		return ctrl.Result{}, nil
	}
	setCondition(rs, CondSessionReady, metav1.ConditionFalse, "AwaitingIngest",
		"dispatch settled; waiting on shipper ingest watermark")
	return ctrl.Result{RequeueAfter: requeueShort}, nil
}
```

### 3.1 Discovery / requeue helper (no hardcoded apiVersion)

External-dependency CRDs (Vault's `VaultStaticSecret` in the MVP, and the #467-deferred CRDs)
may be absent at boot and their API versions may straddle — so we resolve the **preferred**
served version at runtime via the RESTMapper rather than pinning one. A
`meta.NoKindMatchError` (or `NoResourceMatchError`) means the CRD is not installed yet → the
caller sets a condition and requeues.

```go
// operator/internal/controller/discovery.go
package controller

import (
	"context"

	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/runtime/schema"
	ctrl "sigs.k8s.io/controller-runtime"
)

type DiscoveryHelper struct {
	mapper meta.RESTMapper
}

func NewDiscoveryHelper(mgr ctrl.Manager) *DiscoveryHelper {
	// The manager's RESTMapper is a *restmapper.DeferredDiscoveryRESTMapper*:
	// it lazily refreshes from discovery, so newly-installed CRDs become
	// resolvable on the next reconcile without an operator restart.
	return &DiscoveryHelper{mapper: mgr.GetRESTMapper()}
}

// PreferredGVK resolves group+kind to the API server's PREFERRED served version.
// Returns a meta.NoKindMatchError when the CRD is not (yet) installed.
func (d *DiscoveryHelper) PreferredGVK(ctx context.Context, group, kind string) (schema.GroupVersionKind, error) {
	m, err := d.mapper.RESTMapping(schema.GroupKind{Group: group, Kind: kind})
	if err != nil {
		// Force a one-shot discovery refresh, then retry once: a CRD installed
		// since boot won't be in the deferred mapper's cache yet.
		if meta.IsNoMatchError(err) {
			if rm, ok := d.mapper.(interface{ Reset() }); ok {
				rm.Reset()
				if m2, err2 := d.mapper.RESTMapping(schema.GroupKind{Group: group, Kind: kind}); err2 == nil {
					return m2.GroupVersionKind, nil
				}
			}
		}
		return schema.GroupVersionKind{}, err
	}
	return m.GroupVersionKind, nil
}
```

Because the helper returns the *resolved* GVK, every `ensure*` step that touches an external CR
builds an `*unstructured.Unstructured`, stamps that GVK, and uses **server-side apply**
(`client.Apply` with a stable field-manager `probaitio-operator`). SSA means we declare only the
fields we own; the dependency operators (VSO today; RHBK/ODF when #467 lands) own the rest, and
re-applying is idempotent without read-modify-write races.

### 3.2 `SetupWithManager` — owns + watches

```go
func (r *RemoteSessionReconciler) SetupWithManager(mgr ctrl.Manager) error {
	b := ctrl.NewControllerManagedBy(mgr).
		For(&probaitiov1alpha1.RemoteSession{}).
		Owns(&batchv1.Job{}).         // per-dispatch headless Job
		Owns(&corev1.Pod{}).          // interactive long-lived pod (#1251)
		WithOptions(controller.Options{MaxConcurrentReconciles: 1})

	// Dynamically watch the external CRs *only if their CRDs exist at setup*.
	// For CRDs that appear later, the requeue loop (§3.1) still converges; these
	// Watches just make convergence event-driven instead of poll-driven.
	for _, w := range []struct{ group, kind string }{
		{"secrets.hashicorp.com", "VaultStaticSecret"},
	} {
		if gvk, err := r.Discovery.PreferredGVK(context.Background(), w.group, w.kind); err == nil {
			u := &unstructured.Unstructured{}
			u.SetGroupVersionKind(gvk)
			b = b.Watches(u, handler.EnqueueRequestForOwner(
				mgr.GetScheme(), mgr.GetRESTMapper(), &probaitiov1alpha1.RemoteSession{}))
		}
	}
	return b.Complete(r)
}
```

### 3.3 `resolveCredentialRef` — per-dispatch credential, orthogonal to mode

`spec.credentialRef` names a Secret resolved per dispatch (ADR 0011 §4). Two flavors:

- **`enterprise-api`** — an API-key Secret, governed by ADR 0008 (egress scrub + cost caps).
  Wide `maxConcurrent`.
- **`personal-oauth`** — lean on the personal subscription to keep enterprise-API spend down;
  in-pod token refresh. Narrow `maxConcurrent`.

The step enforces the per-credential `maxConcurrent` ceiling (counting live owned Jobs/pods for
that credential) before admitting the dispatch, and stamps `spec`'s `account` into the Job's
env so it flows into ingested metadata for per-dispatch cost attribution. The API-key /
GitHub-token / OAuth-seed Secrets themselves are synced from Vault (§3.6).

### 3.4 `ensureWorkspace` — clone-per-dispatch

Each dispatch gets its **own clone** (the k8s analog of a worktree — honors "never share a
checkout", ADR 0011 §5), never a shared PVC across dispatches. A per-dispatch `emptyDir` (or a
short-lived ephemeral PVC for large repos) is provisioned and the Job's init clones the target
repo into it via the scoped GitHub-token Secret (§3.6). Work product returns via **branch + PR**
through that token; telemetry returns via the shipper (§3.5) — the two return channels are
independent.

### 3.5 `ensureJob` — the headless dispatch + native-sidecar shipper

SSA a `Job` (operator-owned, owner-ref to the `RemoteSession`) whose pod is:

- **primary container** — runs `claude -p "<spec.task>"` against the **baked config image**
  (`spec.image` / `spec.configVersion`, the #1250 golden-image bake — config-only, secrets +
  session history excluded), with the resolved credential mounted and the clone workspace
  (§3.4) as its working dir.
- **native-sidecar shipper** — a `restartPolicy: Always` **initContainer** (k8s native
  sidecar, so it starts before and outlives the main container for `PreStop` flush). It is
  **signature-incremental**, captures **all** session-generated artifact types (not just
  transcripts), is live + crash-resilient, and ships deltas to the #1248 push-ingest endpoint.
  It **allowlists `session-data`** and **denylists `.credentials*` / `paste-cache/`** via the
  one canonical `claude-tree-classification` (ADR 0011 invariants) — the single home of that
  exclusion. An OOMKilled pod loses only the last unflushed delta; `PreStop` flushes on
  graceful teardown. The shipper provably never transmits `.credentials.json` and never echoes
  back seeded config (config-in and data-out are opposite directions over the same tree).

The Job name is derived deterministically from the `RemoteSession` UID so re-reconcile is
idempotent (a Job already present is observed, not recreated). The kill switch
(`killswitch off` / `SHADOW_CALLS_OFF`) is honored cluster-wide at admission and polled by the
pod, so an in-flight cluster dispatch halts with the laptop ones (ADR 0011 budget invariant).

### 3.6 `ensureVaultStaticSecrets` — GitHub token + enterprise-API key (CARRIES into MVP)

The dispatch needs two real secrets at runtime: the **scoped GitHub-token** Secret (for
clone + branch + PR, §3.4) and, for `enterprise-api` dispatches, the **enterprise-API-key**
Secret (ADR 0008). Both are synced from **HashiCorp Vault** via the **Vault Secrets Operator**
(VSO). The reconciler SSA-ensures the `VaultStaticSecret` CRs (CRD may be absent → condition +
requeue per §3.1) and verifies their target Secrets are populated before admitting a dispatch
that depends on them. VSO owns the synced target Secret; we only **read** it.

```go
// resolveable target Secrets, synced by VSO, read by the dispatch Job:
//   - github-token       (clone/branch/PR; scoped, least-privilege)
//   - enterprise-api-key  (ADR 0008 Console key; only for enterprise-api credentialRef)
```

> Vault/VSO **for the subscription-OAuth seed + enterprise-API-key + GitHub-token Secrets
> CARRIES into the MVP.** Vault/VSO for the *OIDC client config* is part of the #467
> multi-tenant layer and is deferred (see below).

### 3.7 (Reserved)

The Half-2 compute-proxy gate that previously lived here is **deferred to #467** — see the
deferred section below. The MVP has no compute proxy.

### 3.8 `DashboardInstanceReconciler` — the hosted dashboard

`DashboardInstance` reconciles the always-on hosted dashboard (the kind the old `ClaudeCoach`
CRD was). Its custom `Reconcile()` is the cross-CR orchestration the Helm chart cannot do:

1. Ensure the Vault-synced Secrets the dashboard server needs (the **artifact-blob** S3
   credentials, §3.9; any server config) exist and are populated.
2. After the OBC/blob substrate is `Bound` (§3.9), SSA-patch the chart-owned dashboard
   Deployment's `envFrom` to reference the generated CM+Secret (the runtime-named contract the
   chart cannot template).
3. Set `AppReady=True` only when every dependency condition is verified True **and** the
   dashboard Deployment reports `Available=True` (§4).

It uses the same discovery/requeue/SSA patterns as §3.1–§3.2 (its `SetupWithManager`
`For(&DashboardInstance{}).Owns(&Deployment{}).Owns(&Service{})`), the same condition gate, and
the same chart-vs-reconciler boundary (§6). It does **not** dispatch sessions — that is
`RemoteSession`'s job.

### 3.9 `ensureObjectBucketClaim` + `obcBound` — the artifact-blob substrate

The hosted dashboard's source of truth is **raw artifacts behind the `artifact-source`
interface** (ADR 0011 §1) backed by a blob substrate, **not** a parsed-SQL store. For the
in-cluster blob backing we SSA an `ObjectBucketClaim` (operator-owned, reconciled by
`DashboardInstance`). Once the claim reaches `status.phase == "Bound"`, the OBC controller
generates — **with the same name as the OBC, in the same namespace** — a ConfigMap (keys
`BUCKET_HOST`, `BUCKET_PORT`, `BUCKET_NAME`, `BUCKET_REGION`) and a Secret (keys
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`). This is exactly why the OBC is reconciler-owned
and not chart-templated: those names/keys are a runtime contract, and the Deployment cannot
reference them until they exist.

> **Note (vs. the earlier framing):** this OBC backs the **artifact-blob substrate** (opaque
> session artifacts behind `artifact-source`), **not** a ciphertext/encrypted-blob store. The
> encrypted-blob store is the #467 zero-knowledge layer (deferred). Because the source of truth
> is already opaque blobs behind the interface, adding client-side encryption later is an
> encryption step at the boundary, not a re-architecture (ADR 0011 MVP-scope note).

### 3.10 `patchAppEnvFrom` — wiring the generated CM+Secret into the dashboard

After `Bound`, SSA-patch the **dashboard** Deployment (the one the Helm chart created) to add
`envFrom` referencing the generated ConfigMap and Secret. We patch the chart-owned Deployment
with our distinct field-manager so we don't fight Helm over the rest of the pod spec:

```go
patch := []byte(`{
  "spec":{"template":{"spec":{"containers":[{
    "name":"probaitio-dashboard",
    "envFrom":[
      {"configMapRef":{"name":"` + obcName(di) + `"}},
      {"secretRef":{"name":"` + obcName(di) + `"}}
    ]}]}}}}`)
err := r.Patch(ctx, dep, client.RawPatch(types.StrategicMergePatchType, patch))
```

`BUCKET_HOST`/`BUCKET_PORT` give the S3 endpoint the server's **hand-rolled SigV4** client
(ADR 0011 §8: no `@aws-sdk`) targets; the credential keys feed the same client. The endpoint is
in-cluster NooBaa today and swaps to R2/MinIO by changing only the OBC's storage class and the
endpoint env — the server code is endpoint-agnostic.

## 4. Status conditions

Standard `metav1.Condition` (type/status/reason/message/observedGeneration), set via
`apimachinerymeta.SetStatusCondition`.

**`RemoteSession` (MVP primary):**

| Condition | True when (verified) | False reasons |
|---|---|---|
| `CredentialReady` | `spec.credentialRef` resolves to a populated Secret **and** the credential's `maxConcurrent` ceiling is not exceeded | `SecretAbsent`, `ConcurrencyExceeded` |
| `WorkspaceReady` | the clone-per-dispatch workspace is provisioned | `CloneFailed` |
| `Dispatched` | the headless `Job` (or interactive pod) + native-sidecar shipper are created | `JobCreateFailed`, `KillSwitchActive` |
| `SessionReady` | **all three above are True** **and** the dispatch settled (Job Succeeded / pod registered) **and** the shipper reported an ingest watermark | `DependencyPending`, `Running`, `AwaitingIngest` |

**`DashboardInstance`:**

| Condition | True when (verified) | False reasons |
|---|---|---|
| `SecretsSynced` | every required `VaultStaticSecret` exists and its target Secret is populated | `CRDAbsent`, `Syncing`, `VaultAuthError` |
| `BucketBound` | OBC `status.phase==Bound` **and** generated CM+Secret present **and** dashboard `envFrom` patched | `CRDAbsent`, `Pending`, `EnvFromNotWired` |
| `AppReady` | **all above are True** **and** dashboard Deployment `Available=True` | `DependencyPending`, `AppRollout` |

```go
// operator/internal/controller/conditions.go
const (
	// RemoteSession
	CondCredentialReady = "CredentialReady"
	CondWorkspaceReady  = "WorkspaceReady"
	CondDispatched      = "Dispatched"
	CondSessionReady    = "SessionReady"
	// DashboardInstance
	CondSecretsSynced = "SecretsSynced"
	CondBucketBound   = "BucketBound"
	CondAppReady      = "AppReady"
)

func setCondition(obj conditionsHolder, t string, st metav1.ConditionStatus, reason, msg string) {
	meta.SetStatusCondition(obj.GetConditions(), metav1.Condition{
		Type:               t,
		Status:             st,
		Reason:             reason,
		Message:            msg,
		ObservedGeneration: obj.GetGeneration(),
	})
}

// allTrue is the strict gate for the terminal condition: it reads back the
// conditions just set in THIS reconcile pass, so the terminal condition can
// never be True on stale/assumed state.
func allTrue(obj conditionsHolder, types ...string) bool {
	for _, t := range types {
		c := meta.FindStatusCondition(*obj.GetConditions(), t)
		if c == nil || c.Status != metav1.ConditionTrue {
			return false
		}
	}
	return true
}
```

**Transition logic (verified, not assumed):** the pipeline is fail-fast — the first unready
dependency sets its own condition `False`, sets the terminal condition `False/DependencyPending`,
and requeues, so later conditions are never falsely left `True` from a previous pass. The
terminal condition (`SessionReady` / `AppReady`) is computed last from `allTrue(...)` of the
prerequisite conditions **as set in the current pass** plus a live observation (the dispatch
phase + ingest watermark for `RemoteSession`; the app Deployment `Available` for
`DashboardInstance`). There is no code path that sets a terminal condition `True` without all
facts being observed in the same reconcile.

## 5. RBAC — kubebuilder markers → `config/rbac/role.yaml`

Markers live above the `Reconcile` methods; `make manifests` (controller-gen) generates the
ClusterRole. The operator SA needs the external CRs **and** the core objects it patches.

```go
// --- RemoteSession dispatch ---
// Per-dispatch Jobs/Pods (create/observe/teardown), the clone workspace volumes:
// +kubebuilder:rbac:groups=batch,resources=jobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=pods,verbs=get;list;watch;create;delete
// +kubebuilder:rbac:groups="",resources=persistentvolumeclaims,verbs=get;list;watch;create;delete
// Credential + Vault-synced Secrets (read), events:
// +kubebuilder:rbac:groups="",resources=secrets;configmaps,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=events,verbs=create;patch
//
// --- External-dependency CRs (create/ensure + read status) ---
// Vault Secrets Operator (GitHub-token + enterprise-API-key Secrets — CARRIES into MVP):
// +kubebuilder:rbac:groups=secrets.hashicorp.com,resources=vaultstaticsecrets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=secrets.hashicorp.com,resources=vaultstaticsecrets/status,verbs=get
// ObjectBucketClaim (artifact-blob substrate for the hosted DashboardInstance):
// +kubebuilder:rbac:groups=objectbucket.io,resources=objectbucketclaims,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=objectbucket.io,resources=objectbucketclaims/status,verbs=get
//
// --- DashboardInstance app objects (patch/manage) ---
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=services,verbs=get;list;watch;create;update;patch
//
// OpenShift Route (chart-owned, but operator may read for AppReady cross-check):
// +kubebuilder:rbac:groups=route.openshift.io,resources=routes,verbs=get;list;watch
//
// --- Our own CRs + status/finalizers ---
// +kubebuilder:rbac:groups=probaitio.com,resources=remotesessions;dashboardinstances,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=probaitio.com,resources=remotesessions/status;dashboardinstances/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=probaitio.com,resources=remotesessions/finalizers;dashboardinstances/finalizers,verbs=update
//
// CRD discovery (RESTMapper refresh for runtime GVK resolution, §3.1):
// +kubebuilder:rbac:groups=apiextensions.k8s.io,resources=customresourcedefinitions,verbs=get;list;watch
```

Note the **delete** verbs on Jobs/Pods/PVCs (per-dispatch teardown + GC of completed
dispatches), on OBC and VaultStaticSecret (clean CR deletion via owner references), and on
Deployments. The Keycloak/compute-proxy markers that previously lived here move with the #467
deferral (below). The Helm reconciler's own chart-resource RBAC (PVC, etc.) is generated
separately by the hybrid plugin's scaffolding; the markers above are the *additive* set the Go
face requires.

## 6. Ownership boundary — every resource, who creates it

| Resource | Owner | Why |
|---|---|---|
| `RemoteSession` CR | **User/admin** (or a dispatch caller: `/race`, `/replay`, shadow loop) | The desired-state dispatch input the Go face reconciles. |
| `DashboardInstance` CR | **User/admin** (provisioning flow) | The desired-state input both the Helm + Go faces reconcile. |
| per-dispatch `Job` / interactive `Pod` | **Go reconciler** (`RemoteSession`) | Runtime-named; the genuinely harness-native dispatch seam no chart models. |
| clone-per-dispatch workspace volume | **Go reconciler** (`RemoteSession`) | Per-dispatch, never shared; honors "never share a checkout". |
| native-sidecar shipper (in the Job pod) | **Go reconciler** (`RemoteSession`) | Part of the dispatch pod spec; signature-incremental, PreStop-flush. |
| dashboard `Deployment` (`probaitio-dashboard`) | **Helm chart** | Always present; `replicaCount=1` pinned via `overrideValues`. Go face only *patches* its `envFrom` (§3.10). |
| dashboard `Service` | **Helm chart** | Always present. |
| `Route` (or `Ingress`) | **Helm chart** | Always present; public ingress. |
| `PVC` (SQLite parse-cache `/app/.cache`) | **Helm chart** | Always present; RWO single-writer local accelerator (ADR 0011 §1). |
| `envFrom` wiring on the dashboard Deployment | **Go reconciler** (`DashboardInstance`, SSA patch) | References OBC-generated CM+Secret whose names are runtime-only. |
| `ObjectBucketClaim` (artifact-blob substrate) | **Go reconciler** (`DashboardInstance`) | Generates CM+Secret consumed by envFrom; runtime contract. |
| OBC-generated `ConfigMap` + `Secret` | **NooBaa/OBC controller** (operator only *reads*) | Provisioner-owned; never templated, never written by us. |
| `VaultStaticSecret` CRs (GitHub token, enterprise-API key) | **Go reconciler** | CRD may be absent; secrets must sync before a dependent dispatch. |
| Vault-synced target `Secret`s | **Vault Secrets Operator** (operator only *reads*) | VSO-owned. |

**The line:** chart = always-present, no discovery, no generated-name dependency. Reconciler =
everything conditional, discovered, ordered, runtime-named, or per-dispatch. The OBC-generated
CM/Secret and the Vault-synced Secret are owned by *their* operators — we only read them.

## 7. How this connects to the public server boundary

The server image (`node:24-slim`, **zero node_modules**, runs `src/lib` TS via
`scripts/register-ts.mjs`, ADR 0011 §8) gets its S3 endpoint + credentials for the
`DashboardInstance` purely through the `envFrom` this reconciler wires (§3.10), and its
Vault-synced Secrets through VSO — so the server stays **dependency-free** (hand-rolled SigV4
over native `fetch`, no `@aws-sdk`). A `RemoteSession` dispatch pod ships to the **#1248
push-ingest endpoint**; the server lands those artifacts behind `artifact-source` and the
existing parse + SQLite-cache pipeline ingests them unchanged. The reconciler does **not** touch
the public-upload write gate — that gate is part of the #467 multi-tenant layer (deferred).

## 8. CI gate (referenced, owned elsewhere)

Per ADR 0011 §8, a CI job must **boot the actual runtime image and curl `/healthz`** to prove
the dependency-free server boots (catching a #1013-style dependency drag-in in CI, not
production), and assert no `node_modules` in the image. The operator side adds an envtest /
`make test` run of both `Reconcile()`s against a fake API server with the external CRDs
installed, asserting the condition-transition tables in §4 — including the load-bearing one:
`RemoteSession.SessionReady` is never `True` without an observed ingest watermark. Those gates
are specified in the testing refinement, not here.

The image runs under OpenShift `restricted-v2` SCC (arbitrary UID, GID 0 group-writable
`/app/.cache`, no hardcoded `runAsUser`) — the arbitrary-UID/SCC fix carries into the MVP.

---

## Deferred to #467 (multi-tenant / zero-knowledge layer)

Everything below is **NOT MVP**. ADR 0011 establishes the MVP as the single-tenant #1247
substrate; #467 (invite-only public multi-tenant SaaS, zero-knowledge at rest) is **deferred and
built *onto* this substrate**, not beside it. The content here is retained as future reference —
it is the original multi-tenant reconciler design, re-labelled. The zero-knowledge seam is
**designed-for, not built**: because the source of truth is already opaque blobs behind
`artifact-source`, adding it later is an encryption step at the boundary (the sidecar holds the
key and encrypts before push), not a re-architecture.

The #467 layer adds three external-dependency CRs to the `DashboardInstance` reconcile pipeline
(Keycloak/RHBK, the OBC re-purposed as a **ciphertext/encrypted-blob** store, and Vault for the
**OIDC client config**), plus an operator-gated **compute proxy**. Each follows the same
discovery → ensure → wait-Ready → set-condition patterns as the MVP (§3.1–§3.2); they are
sequenced *before* `AppReady` exactly as the MVP deps are.

### 467.1 Keycloak realm + the create-only hash guard (DEFERRED)

Invite-only auth via **Keycloak OIDC** (RHBK). The reconciler SSA-ensures a `Keycloak` CR
(operator-owned, owner-ref to the `DashboardInstance`; runtime GVK — the CRD straddles
`v2alpha1`/`v2beta1` with no schema difference, resolved via the RESTMapper, not pinned),
waits for its status `Ready==True`, then applies a `KeycloakRealmImport`.

`KeycloakRealmImport` is **CREATE-ONLY**. Per the Keycloak operator: *"The Realm Import CR only
supports creation of new realms and does not update or delete those,"* and *"if a Realm with the
same name already exists in Keycloak, it will not be overwritten."* Its status exposes condition
types **`Started`**, **`Done`**, **`HasErrors`** (not `Ready`).

The hash guard:

- Compute `sha256` of the realm JSON; store it as an annotation `probaitio.com/realm-hash` on the
  `KeycloakRealmImport`, and mirror it into `DashboardInstance.status.realmImportHash`.
- On reconcile: no import → create with current hash; existing + hash **matches** → no-op (wait
  for `Done`); hash **differs** → desired realm spec changed.

**What the hash guard CAN do:** detect that the desired realm config drifted from what was
imported, and surface it (event + `RealmImportStale` condition reason) — drift becomes *visible
and idempotent*; we never blindly recreate on every reconcile.

**What it CANNOT do:** actually re-import. Because the CR is create-only and the operator won't
overwrite an existing realm, deleting+recreating the `KeycloakRealmImport` re-runs the *import
job* but it still **will not overwrite** the already-existing realm. Therefore, on a hash
mismatch the reconciler does **not** silently recreate; it sets `KeycloakReady=False,
reason=RealmImportStale` and records an event instructing an operator to reconcile realm config
out-of-band (admin API / a future migration step). Realm mutation is explicitly out of scope and
documented as a known limitation, not faked by the guard.

Condition (re-introduced when #467 lands): `KeycloakReady` — True when the `Keycloak` CR is
`Ready=True` **and** `KeycloakRealmImport` reached `Done` (no `HasErrors`); False reasons
`CRDAbsent`, `Provisioning`, `RealmImportStale`, `ImportFailed`. It is sequenced before
`AppReady` in the `DashboardInstance` pipeline.

RBAC markers re-introduced with this layer:

```go
// +kubebuilder:rbac:groups=k8s.keycloak.org,resources=keycloaks,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=k8s.keycloak.org,resources=keycloaks/status,verbs=get
// +kubebuilder:rbac:groups=k8s.keycloak.org,resources=keycloakrealmimports,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=k8s.keycloak.org,resources=keycloakrealmimports/status,verbs=get
```

### 467.2 OIDC client config via Vault, + `node:crypto` PKCE (DEFERRED)

When #467 lands, the OIDC client config + its secret sync through **Vault/VSO** as well, and the
dependency-free server does OIDC via **`node:crypto` PKCE** (no `openid-client`, ADR 0011 §8).
(Vault/VSO for the GitHub-token + enterprise-API-key Secrets is **not** deferred — it carries
into the MVP, §3.6. Only the OIDC *client config* sync is part of this layer.)

### 467.3 Ciphertext / encrypted-blob store (DEFERRED)

In the MVP the OBC backs the **artifact-blob** substrate (opaque session artifacts behind
`artifact-source`, §3.9). The #467 zero-knowledge layer re-purposes that same blob substrate to
hold **ciphertext only**: the sidecar holds the client-side encryption key and encrypts artifacts
*before* push, so the store never sees plaintext. A parsed-SQL / Postgres-of-models store remains
explicitly rejected (ADR 0011 §1) precisely because it is the model this zero-knowledge layer
cannot keep. The OBC reconcile mechanics (§3.9 — Bound phase, generated CM+Secret, hand-rolled
SigV4 client) are unchanged; only the *contents* become ciphertext and an encryption step is
added at the sidecar boundary.

### 467.4 Public same-origin / CSRF write gate (DEFERRED)

The server's public-upload auth gate — `isSameOrigin` / `passesWriteAuth`
(`scripts/server.mjs`, currently loopback-only and 403-ing all public uploads, and which must
**NOT** trust `X-Forwarded-Host`) — is a multi-tenant write-path concern tracked as its own
server-side security deliverable under #467. The MVP push-ingest endpoint (#1248) is the
single-tenant ingress for dispatch telemetry and is not this gate.

### 467.5 Compute proxy — operator-gated, fail-closed (DEFERRED)

The Half-2 **API-key compute proxy** Deployment is **operator-owned** so it can be
created/deleted atomically from a `spec.computeProxy.enabled` flag without a chart upgrade:

- `enabled == true` **AND** the Anthropic Console key Secret exists → SSA the proxy Deployment
  (owner-ref to the `DashboardInstance`).
- `false`, or the key Secret absent → **delete** the proxy Deployment if present and ensure the
  app's `/api/proxy` flag env is unset.

The chart's proxy template stays disabled via a `computeProxy.enabled: "false"` `overrideValue`;
the operator is the single source of truth for the proxy's existence. `/api/proxy` is
fail-closed on **both** missing key **and** flag. The MVP ships with no proxy at all.

RBAC marker re-introduced with this layer: the **delete** verb on Deployments (already present
in the MVP set for per-dispatch/clean-deletion) covers proxy teardown; no new group is needed.

---

### Sources

- [helm-operator-plugins tutorial (main.go wiring, watches.yaml, reconciler.New)](https://github.com/operator-framework/helm-operator-plugins/blob/main/docs/tutorial.md)
- [reconciler package API — all Option funcs incl. WithOverrideValues, SkipPrimaryGVKSchemeRegistration](https://pkg.go.dev/github.com/operator-framework/helm-operator-plugins/pkg/reconciler)
- [OpenShift 4.17 — Hybrid Helm Operator tutorial](https://docs.openshift.com/container-platform/4.17/operators/operator_sdk/helm/osdk-hybrid-helm.html)
- [Operator SDK — Define Watches in Helm-based operators](https://sdk.operatorframework.io/docs/building-operators/helm/reference/watches/)
- [Kubernetes — native sidecar containers (restartPolicy: Always initContainers)](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/)
- [ODF 4.18 — Object Bucket Claim (generated ConfigMap BUCKET_HOST/etc + Secret AWS_ACCESS_KEY_ID/etc)](https://docs.redhat.com/en/documentation/red_hat_openshift_data_foundation/4.18/html/managing_hybrid_and_multicloud_resources/object-bucket-claim)
- [HashiCorp Vault Secrets Operator — VaultStaticSecret](https://developer.hashicorp.com/vault/docs/platform/k8s/vso)
- _#467-deferred_ [Keycloak operator — automating a realm import (create-only; Started/Done/HasErrors)](https://www.keycloak.org/operator/realm-import)
- _#467-deferred_ [keycloak#45795 — Promote Keycloak/KeycloakRealmImport CRDs to v2beta1 (v2alpha1 still served, no schema diff)](https://github.com/keycloak/keycloak/issues/45795)
