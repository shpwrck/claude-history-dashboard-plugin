# Overnight autonomous run — warm sessions + centralized auth

User went to sleep 2026-06-15 ~02:24 UTC: "keep working towards the mvp goal (warm sessions and
centralized auth), take a note of any complications but push through them." No questions possible
(asleep) → every fork is an MVP-call-and-document. This file is the resumable record + complications
log; update it after each slice.

## Where things already stand (DONE + LIVE)
- MVP operator + dashboard MERGED to master (#1559) and **running in-cluster on the hub** (ns
  `probaitio-system`): operator reconciles RemoteSessions (churn-safe), dashboard reachable at
  `https://probaitio-dashboard-probaitio-system.apps.hub.k8socp.com`, the provisioning card
  dispatches in-cluster (`/api/sessions` → configured:true). #1562 (OpenShift readiness) merged +
  deployed. #1251/#1558 closed.
- Aggregation epic **#1563** filed (HTTP push-ingest, per-session history parts, per-member
  attribution). **Slice 1 done + committed (be1a090, branch fix/dashboardinstance-openshift-ready)**:
  `POST /api/ingest/<sourceId>/artifacts` + the canonical `claude-tree-classification`
  (config|session-data|secret; ingest accepts session-data only). All gates green; NOT yet PR'd.

## KEY PROVEN FINDING (drives both pillars)
The "claimed/active" state of a warm pod is **NOT visible in the remote-control pod log** (the TUI
only shows the static `Connected`/`Single session` banner; user interaction flows through the remote
channel, never to stdout). The real signal is **transcript-presence**: a claimed session writes
`/workspace/.claude/projects/<slug>/<sessionId>.jsonl` (proven live — user's "hello" produced an
8-line `ac8d22a7-...jsonl`; idle-warm pods have none). UUID filename = collision-free aggregation
confirmed live. So one transcript-watcher signal drives BOTH the warm guarantee AND the shipper.

## Plan (autonomous, in priority order)

### A. WARM SESSIONS — refill-on-claim (named goal #1)  [IN PROGRESS]
- New issue under epic #1247. Mechanism: a watcher (extend cred-sync OR new tiny sidecar) sets pod
  label `probaitio.com/claimed=true` when a non-empty transcript appears in `/workspace/.claude/
  projects`. Operator: warm = running && !claimed; target `poolSize` WARM; create when warm<poolSize
  → a claimed pod immediately triggers a replacement so there's ALWAYS a warm one waiting.
- RBAC: the sidecar self-patches its pod label → dispatch SA needs `pods patch` (on its own pod).
- Test live: the warm-marker session is already claimed → its pod should get labeled → operator
  refills to keep 1 warm. (warm-marker RemoteSession still on cluster.)

### B. AGGREGATION shipper + endpoints (centralized data; epic #1563)
- Slice 1 (ingest endpoint) DONE.
- Slice 2: dashboard ingest reads/merges ALL `<ingestDir>/<sourceId>/` roots into the combined
  dataset with per-source/member provenance (the "first source only" gap, ingest.mjs:36-38).
- Slice 3: shipper sidecar (`artifact-ship.mjs`, cred-sync shape) — watches projects/+history,
  POSTs deltas (signature dedup) to the dashboard ingest Service, PreStop flush; history →
  `history.d/<sessionId>.jsonl`. SHARES the transcript-watch with (A).
- Slice 4: per-member attribution (RemoteSession carries member/sourceId; operator threads it).
- Slice 5: wire-up (DashboardInstance exposes ingest endpoint + token; operator sets shipper env).

### C. CENTRALIZED AUTH (named goal #2)  [DESIGN + unambiguous plumbing only]
Interpretation (DOCUMENT, user confirms on wake): the central dashboard is the auth hub — each org
member uses THEIR OWN claude.ai account (per the original vision), onboarded/managed centrally, and
the operator binds the right per-member credential to their sessions. Today auth is a SINGLE
operator-bound `claude-oauth` secret (centralized but not per-member). Build the unambiguous parts:
- RemoteSession gains an OPTIONAL `credentialRef` (per ADR 0009 §4) so a session can name a per-
  member oauth secret (default = the shared `claude-oauth`). Operator binds it (the security
  invariant: operator binds creds, never the CR-spec-controller arbitrary path).
- Document the OPEN forks for the user: how members authenticate to the dashboard (reuse the
  existing enterprise auth mode? `DASHBOARD_AUTH_MODE=enterprise` + per-principal dataRoot exists),
  and the self-service credential-onboarding UX (#1558's deferred slice). DO NOT unilaterally pick
  the member-login UX — note it.

## Autonomous constraints / complications log
- Cluster: NEW `oc apply` of resources is classifier-GATED (needed approval for the initial operator
  deploy); `rollout restart` of an existing deployment is NOT gated (worked). So: build/PR/merge/
  publish freely; redeploy via rollout-restart; if a NEW resource apply gates, NOTE it for the user.
- Publish flakes on proxy.golang.org → the operator Dockerfile already retries (5x). 
- Merging to master: allowed on CI-green + self-review (run the adversarial review workflow or
  /code-review). Keep PRs single-squash.
- (log new complications below as they arise)

### Complications encountered
- (none yet this run)
