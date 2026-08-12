# 0009 — Hosted Kubernetes operator: aggregate-everywhere ingestion + pod-per-dispatch remote sessions

Status: Accepted (2026-07-22 — implemented in probaitio-operator/; originally Proposed from a grilling session, 2026-06-11)
Date: 2026-06-11
Supersedes: none — extends the SPA/server deployment split (ADR [0003](0003-public-spa-hosting.md)) with a third, hosted flavor
Related: epic #1247 (decomposition + sequencing), ADR [0003](0003-public-spa-hosting.md) (public SPA hosting),
ADR [0008](0008-server-llm-usage-governance.md) (server LLM-usage governance — the enterprise-API path obeys it),
#467 (public multi-tenant Coach — **deferred**, but its zero-knowledge constraint shapes the storage choice below),
#1016 (enterprise org readiness — adjacent, distinct), #513/#588 (shadow/replay — candidate off-laptop fan-out consumers),
#627 (the incremental SQLite ingest this builds on), the `add-remote` skill (the systemd predecessor this generalizes)

## Context

Today there are two deployment flavors: the **server** build (reads one host's live
`~/.claude` from disk, incrementally ingests into a signature-keyed SQLite cache, #627) and the
historical browser-upload build (retired by #3735). Remote sessions "like my
laptop" are systemd-managed `claude remote-control` instances, one per project dir, all reading
that one host's `~/.claude` (the `add-remote` skill).

The stated motivation was "the SPA doesn't scale — it crashes uploading my full history." That
specific pain is **already solved** by the server build's incremental ingest; it is not what
justifies new infrastructure. The real, unbuilt capability is the *full loop*: a **hosted,
always-on dashboard that aggregates session history from everywhere Claude runs** — laptop, other
machines, and ephemeral pods — into one store, plus **elastic pod-per-dispatch remote sessions**
(the compute analog of "doesn't scale"). The laptop stops being the only worker and becomes a
controller.

Two planes were conflated in the original framing and must be kept distinct: the **data plane**
(aggregate + render history) and the **compute plane** (dispatch sessions). They couple only
through `~/.claude` artifacts.

This is **single-tenant** (the maintainer's own data). Multi-tenant (#467, zero-knowledge at
rest) stays **deferred** — but because un-deferring it must not force a rewrite, its constraint
is honored as a boundary-shape today, not as built code.

## Decision

1. **Source-of-truth is raw artifacts behind an `artifact-source` interface**
   (`list`/`read` by `source_id + rel_path + signature`), **not** parsed SQL rows. The
   file-shaped parsers survive unchanged (the hot-path parsers already take `text: string`);
   parsing stays server-side for now, isolated behind the interface. **Postgres-of-parsed-models
   is rejected**: it is precisely the model a future zero-knowledge (#467) layer cannot keep
   (the server would hold only ciphertext), so building it is the corner we were told to avoid.
   The storage substrate (blobs in PVC/R2 + a small index) hides behind the interface; the
   existing SQLite parse-cache remains the single-writer local accelerator. SQLite's single-writer
   nature is *why* pods never write the store directly.

2. **Compute is a Kubernetes operator reconciling a `RemoteSession` CRD.** `spec.mode:
   interactive` reconciles to a long-lived pod running `claude remote-control` that registers in
   claude.ai/code; `spec.mode: headless` reconciles to a Job running `claude -p`. One shared pod
   substrate; only entrypoint and lifecycle differ. The operator (not a bare Job) is justified by
   the interactive mode's desired-state reconciliation.

3. **Data capture is a native-sidecar shipper**, signature-incremental, PreStop-flushed,
   capturing **all** session-generated artifact types (not just the main transcript — the
   out-of-band `telemetry/`, `debug/`, `stats-cache.json`, `file-history/` feed the reliability
   detectors and Agent Report Card). It is the durability backbone; a Stop **hook** under-captures
   and couples durability to hook success, so it is at most a latency nudge, never the delivery
   path. Rejected alternatives: operator-copy-on-completion (loses everything on an unclean kill;
   collapses into a volume anyway) and per-session PVCs (PVC sprawl, node attach limits, no live
   read).

4. **Pod auth is a per-dispatch `credentialRef`, orthogonal to mode**: `personal-oauth` (flat-rate
   subscription — narrow `maxConcurrent`, in-pod refresh, crown-jewel token) or `enterprise-api`
   (Console key — wide concurrency, per-token cost, governed by ADR 0008). Both exist because the
   personal subscription is leaned on to drive enterprise-API spend down. `account` flows into
   ingested metadata for per-dispatch cost attribution.

5. **Workspace is clone-per-dispatch** (the k8s analog of a worktree; honors the
   never-share-a-checkout rule), returning work via **branch + PR** through a scoped GitHub-token
   Secret. Two return channels: work product → git, telemetry → shipper.

6. **Config is a golden image that is a config *snapshot*, produced by a dynamic bake**
   (content-hash-tagged; the `RemoteSession` pins it; an old tag reproduces old config). Secrets
   and session history are excluded from the bake.

7. **Dispatch is API-first, human-only first.** The create-`RemoteSession` API backs a dashboard
   button now; an agent-facing **MCP tool** is a guarded fast-follow (#1252), unlocked only behind
   recursion caps (max dispatch depth + per-credential `maxConcurrent` + per-orchestration budget
   ceiling). Agent dispatch buys off-laptop fan-out and routines that survive a closed laptop, but
   it reintroduces the nesting deliberately disabled elsewhere (cf. the #321 ~86-agent burn), so
   it ships only once the core loop is proven and guarded.

## Invariants (cross-cutting, must not drift)

- **One canonical `claude-tree-classification`** maps every `~/.claude` path to
  `config | session-data | secret`. The bake consumes `config`, the shipper consumes
  `session-data`, both refuse `secret`. This is the single home of the `.credentials*` /
  `paste-cache/` exclusion. A misroute here either exfiltrates the OAuth refresh token into the
  artifact store or silently drops a reliability signal — so there is exactly one classifier, not
  one per consumer.
- **The shipper never echoes seeded config or credentials.** Config-in and data-out are opposite
  directions over the same tree; the shipper is allowlisted to `session-data`.

## Consequences

- The biggest refactor is mechanical and front-loaded: hoisting the ~53 filesystem read sites in
  `ingest.mjs` (and the 16 directory-walking parsers) behind the `artifact-source` interface. The
  content-string parsers are untouched. Sequenced first (#1248) so it de-risks everything and
  already delivers multi-host aggregation without any Kubernetes.
- "Like my laptop" is honest for skills/instructions/agents but **partial for MCP**: baking
  config files does not make MCP server processes run and authenticate in-pod. Named as an open
  problem, not solved here.
- The zero-knowledge seam for #467 is *designed-for* (the sidecar is the natural place to encrypt
  before push) but not built; the `artifact-source` interface is the slot it occupies.

## Sequencing

Decomposed in epic #1247 → #1248 (artifact-source interface + push-ingest), #1249 (one headless
pod end-to-end), #1250 (config-snapshot bake + tree-classification + personal-OAuth), #1251
(interactive mode + claude.ai/code registration), #1252 (agent-native dispatch MCP tool,
recursion-guarded). Smallest end-to-end proof first; no Kubernetes until the data-plane boundary
exists.

## Status / open questions

Proposed. Unresolved: MCP-in-pod fidelity; OAuth refresh vs long interactive session length; the
interactive chicken/egg (operator pre-creates the pod before claude.ai/code can register it); the
CRD `status` schema; blobs on PVC vs R2; GC of completed Jobs, stale images, and ingested blobs.
