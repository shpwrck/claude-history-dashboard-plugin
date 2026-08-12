# 0008 — Server LLM-usage governance: scoped API invariant, enforced call-site registry, phased abuse controls

Status: Accepted (2026-08-11 — browser-direct LLM egress retired by #3734; server paths remain CI-enforced via the check-llm-egress gate and generated registry; originally Proposed from a grilling session, 2026-06-09)
Date: 2026-06-09
Supersedes: none — **scopes** (does not amend) the blanket "no api.anthropic.com" phrasing
Related: epic #930 (decomposition), ADR [0003](0003-public-spa-hosting.md) (public SPA hosting),
ADR [0005](0005-recs-adoption-measurable-impact.md) (recs free-path rule — **unchanged**),
#467 (public multi-tenant Coach), #683/#687/#923 (judge-audit family), #605/#594 (product tiers),
the `spa-boundary` CI job (the enforcement precedent)

## Context

The dashboard grew up local-first, and several docs state the rule as a blanket **"never
api.anthropic.com"** (dashboard `CLAUDE.md`, `AGENTS.md`, #687, the global `~/.claude`
shadow-calls rules, ADR 0005's build constraint). But that rule is **already de facto lifted in
shipped code**: `/api/audit.json` — the #738/#923 judge-audit family, including #687's
judge-deceit — calls `api.anthropic.com`, gated on an explicit `ANTHROPIC_API_KEY`
(`scripts/server.mjs`). Meanwhile `/api/usage` (#130) calls the API with the user's *subscription
OAuth* credential to read rate-limit headers, sending no content.

So "never api.anthropic.com" is neither true nor the real invariant. The real invariant is about
**not exfiltrating the user's `~/.claude` history**, and it always had unstated exceptions. We are
about to make server LLM use **load-bearing for public exposure** (tier-3/tier-4 server auditing
per #605/#594; the multi-tenant zero-knowledge public Coach per #467). Before any server component
goes public we need: a precise invariant, a *hard* (machine-checked) guarantee that every API
call-site is documented and reviewable, and protections against abuse — designed once so the
multi-tenant phase slots in without re-cutting the model.

## Decision

### 1. Replace the blanket rule with a two-rule invariant

- **Rule A — data-exfiltration invariant (absolute).** No path may send `~/.claude`-derived
  content to `api.anthropic.com` using the user's **subscription OAuth credential**. That
  credential is for interactive Claude Code use only. (`/api/usage` complies: headers only, no
  body content.)
- **Rule B — server-analysis carve-out (conditional).** A **server component** may send
  **scrubbed** `~/.claude` content to `api.anthropic.com` **only** when all five hold: it uses an
  explicitly-configured **Console API key** (never the subscription credential), it is **opt-in**,
  it is **registered**, it is **cost-capped**, and the content passed the **egress scrub**.
Browser-direct model calls are prohibited. #3734 removed the former user-key
surface, its browser credential custody, and its CSP exception. The standing
egress gate now enforces a zero-browser-entry registry and rejects raw model
origins outside the approved server chokepoint and Gate-2702 enforcement points.

**Free / automatic / local paths stay local** — the recs engine, the parsers, the
deterministic recommendation surfaces, and **ADR 0005's recs Adoption Card**. ADR 0005's
`no api.anthropic.com` line is **correct and is not amended**: this ADR records that the blanket
phrasing was always *scoped* to free/automatic paths. The global `~/.claude` shadow-calls
"never api.anthropic.com" rule is a *different context* (the recs/shadow engine) and is also left
untouched.

### 2. The hard guarantee is machine-checked, not a doc

A single server **chokepoint** `callAnthropic(registryId, req)` — the `spa-boundary` pattern
(centralize-then-stub through one seam) applied to *outbound* LLM calls. Rule A and Rule B both
route through it. The chokepoint enforces the registry entry **per call**:

- Rule `A` (`credential: oauth`) → **refuse any non-empty `~/.claude` body**. Rule A becomes
  impossible to violate, not merely documented.
- Rule `B` (`credential: console-key`) → **require the egress-scrub stage ran and the cap check
  passed** before the request leaves.

A `spa-boundary`-style CI gate asserts (a) no raw `api.anthropic.com` / Messages-API call exists
in server code outside the chokepoint, and (b) every `registryId` has a complete manifest entry.
The human-readable `docs/llm-usage-registry.md` is **generated from the manifest** so it cannot
drift. Result: "undocumented call" and "wrong-credential-for-the-data" are both structurally
unreachable — the same way "the SPA reaches a server route" is unreachable today.

### 3. The registry schema is a frozen call-site descriptor + a per-phase exposure policy

Both layers ship **from day one** (ADR 0005's hard-learned lesson: *"the adoption schema must be
… from day one (#467) or the local design silently becomes the SaaS telemetry schema"*).

- **Call-site descriptor (frozen across phases):** `id`, `file:symbol`, `rule (A|B)`,
  `purpose`, `credential`, `dataClass (none | scrubbed)`,
  `trigger (automatic | opt-in)`, `caps`, `egressScrub (none | stub | redact)`.
- **Exposure policy (set per deployment phase):** `whoPays (operator)`,
  `authRequired`, `tenancyBoundary (single | per-tenant)`, `publiclyReachable`. Phase-1 defaults:
  `operator / false / single / false`.

Phase 2 changes the *exposure policy*, never the call-site descriptor.

### 4. The egress scrub is a seam, stubbed now

The eventual pipeline is `transcript → local scrub-model → Anthropic judge`. There is no local
scrub-model yet, so the chokepoint runs a **logged pass-through** `egressScrub()`
(`egressScrub: stub`) over the existing ingest-scrubbed `getTranscript()` content. **Phase-1 safety
does not rest on the scrub** — it rests on two other facts: the content is the **operator's own
data**, sent with the operator's **own opt-in consent**. The scrub only becomes load-bearing when
both stop holding — which is exactly phase 2 (it is another tenant's data; there is no per-content
consent). The pre-public gate therefore **physically refuses** `publiclyReachable: true` while any
reachable Rule-B entry is `egressScrub: stub`.

> **Update (2026-06-24, #1581):** the identity stub was upgraded to a real
> **transmission-grade local redactor** (`egressScrub: redact`) — it strips API keys,
> bearer/OAuth tokens, JWTs, absolute home paths, emails, and env-style secret assignments
> from the prompt before egress (`src/lib/anthropic-egress.ts`). The `stub`/identity mode is now
> **fail-closed**: `egressScrub` refuses to return content for any non-`redact` mode, and the
> `server.audit-judge` route disables itself (`egress_scrub_not_transmission_grade`) unless the
> registered mode is `redact` — even when the operator opt-in flag is set. The v0.5.0 security
> sweep escalated the original stub to CRITICAL because the pass-through leaked raw transcript
> text to Anthropic the moment the opt-in was enabled, *before* public exposure; the redactor +
> fail-closed gate close that. (The two-fact Phase-1 rationale above still holds as the
> consent/ownership backstop.)

### 5. Abuse controls are phased honestly

Today's server is single-tenant, serving one operator's private `~/.claude`. So "end-user abuse"
is **structurally a phase-2 concept**: a publicly-reachable single-tenant instance is only sane if
auth-gated to the operator alone, which collapses "abuse" to *runaway spend*. Phase 1 ships *don't
expose your own data, don't let your own key run away*; the genuine adversarial anti-abuse layer is
inseparable from #467 and lands with it.

| Control | Threat it answers | Phase |
|---|---|---|
| Auth-gate the whole server (no anonymous) | Operator data exposure | **1** (prerequisite to any exposure) |
| Per-key/session token-spend caps + bounded judge calls/output tokens + input-size caps | Runaway spend | **1** |
| Kill switch (LLM endpoints off) | Both | **1** |
| Console workspace spend-limit | Both | **1** (Console config) |
| Per-IP / anonymous rate limits | Adversarial end-user abuse | **2** (#467) |
| Tenancy isolation | Cross-tenant abuse + zero-knowledge | **2** (#467) |
| Local-model egress scrub (transmission-grade) | Sending non-own data to a 3rd party | **2** (#467) |

### 6. The pre-public gate is mechanical **and** human

Mechanical: for every `publiclyReachable: true` entry, assert
`authRequired && caps != null && egressScrub != 'stub' && (tenancyBoundary == 'per-tenant' when
multi-tenant)`. `npm run gate:llm-egress` enforces the single-tenant form, and
`DASHBOARD_LLM_PUBLIC_EXPOSURE_MODE=multi-tenant npm run gate:llm-egress`
enforces the per-tenant boundary for multi-tenant exposure. Human: a required
sign-off receipt in the security release-gate epic (see `docs/RELEASING.md`) -
a machine cannot certify "safe to expose."

### 7. Subscription-authenticated experiment workers are OS-contained

The opt-in #2702 C5 bridge is a local Claude Code worker, not a server Messages-API call, but its
GitHub issue body is untrusted. The worker therefore runs under the existing
`@anthropic-ai/sandbox-runtime` 0.0.52 enforcer on Linux (Bubblewrap, Socat, and SRT's network
proxy/seccomp layer). The bridge fails before trial preparation if that exact runtime or a required
host tool is unavailable. With `CHD_EXPERIMENT_2702` unset, this path remains byte-for-byte off and
makes no external call.

Each arm gets an isolated `HOME` beneath its registered run directory. The host home is denied and
only the disposable worktree, its Git metadata, the registered run directory, the pinned Sidekick
snapshot, and exact runtime executables are re-exposed beneath that denial. Production network
access is limited to `api.anthropic.com`; test dispatch has no allowed domain. The bridge copies no
credential into the isolated home. A per-arm host process reads only the bounded
`claudeAiOauth.accessToken` from `~/.claude/.credentials.json`, then SRT routes the model domain
through that process over its external-MITM Unix-socket seam. The worker receives a fixed,
non-secret OAuth placeholder and a public ephemeral CA certificate; the broker terminates TLS,
removes worker-supplied authentication headers, and adds the real bearer token only on the trusted
upstream leg. The token, broker socket, and transient CA private key remain outside every sandbox
read root. The broker accepts only the observed Claude Code calls (`GET /api/hello` and
`POST /v1/messages?beta=true`), pins upstream host and SNI to `api.anthropic.com`, rejects ambiguous
framing and upgrades, bounds headers/body/idle time, and never follows redirects. The placeholder
is not an authority boundary: any jailed process can present it. The host broker therefore also
pins each Messages body to the arm's registered worker model (plus the treatment's exact Sidekick
and triage models when enabled), requires streaming JSON, and independently reserves the registered
dollar ceiling before every upstream call. The reservation treats body bytes as an upper bound on
input tokens and requested `max_tokens` as the output bound, using the maximum 1-hour-cache input
and output rates for the allowed Haiku/Sonnet families. The trusted leg pins `service_tier` to
`standard_only`; remote MCP, container, URL/file source, and typed server-tool expansion is rejected
because it could add unreserved input or flat fees. A reservation is never refunded after a failed call.
Fixed ceilings of eight physical broker connections, four concurrently active proxy requests,
an 8 MiB aggregate declared-body reservation, 256 upstream requests, 8 MiB per request, 65,536
requested output tokens per call, and 1,800,000 requested output tokens per arm remain defense in
depth. Connection and request admission happen before body collection, and every reservation is
released on completion or abort. An access token
that cannot remain valid through the Definition's full 50-minute arm limit plus teardown buffer
fails dispatch before the jail starts; the operator must refresh it outside the jail because the
bridge deliberately does not reimplement the vendor's rotating OAuth protocol. Broker process,
socket, and public CA are torn down after the process group quiesces; the parent repeats artifact
cleanup after an unexpected broker exit. Sidekick's per-session ledger
remains arm-local for accounting and sealing.

The child environment allowlist is fixed in `scripts/gate-2702/sandbox-dispatch.mjs` and asserted
by the hostile-canary acceptance test:

- Registration: `CHD_EXPERIMENT_2702_ATTEMPT`, `CHD_EXPERIMENT_2702_BASE_SHA`,
  `CHD_EXPERIMENT_2702_RUN_DIR`, `CHD_EXPERIMENT_2702_SUBJECT`,
  `CHD_EXPERIMENT_2702_TREATMENT`, `CHD_EXPERIMENT_2702_TRIAL_ID`.
- Isolated runtime: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `CLAUDE_CODE_TMPDIR`,
  `CLAUDE_CONFIG_DIR`, `DISABLE_AUTOUPDATER`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`, `HOME`,
  `LANG`, `LC_ALL`, `NO_COLOR`, `NPM_CONFIG_CACHE`, `NPM_CONFIG_USERCONFIG`, `PATH`, `SHELL`,
  `TERM`, `TMPDIR`, `TZ`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`; the fixed
  non-secret `CLAUDE_CODE_OAUTH_TOKEN` placeholder; and public-CA trust paths `AWS_CA_BUNDLE`,
  `CARGO_HTTP_CAINFO`, `CURL_CA_BUNDLE`, `DENO_CERT`, `GIT_SSL_CAINFO`, `NODE_EXTRA_CA_CERTS`,
  `PIP_CERT`, `REQUESTS_CA_BUNDLE`, and `SSL_CERT_FILE`.
- Fixed Sidekick treatment: `SIDEKICK_AUDITS`, `SIDEKICK_BACKOFF_AFTER`, `SIDEKICK_BACKOFF_MAX`,
  `SIDEKICK_CALL_BUDGET_USD`, `SIDEKICK_CONCURRENCY`, `SIDEKICK_ENABLE`, `SIDEKICK_GATE`,
  `SIDEKICK_MIN_DELTA`, `SIDEKICK_MODEL`, `SIDEKICK_NEARDUP`, `SIDEKICK_NEARDUP_MIN_SHARED`,
  `SIDEKICK_NESTED`, `SIDEKICK_SESSION_BUDGET_USD`, `SIDEKICK_SHIP_COOLDOWN`,
  `SIDEKICK_SIGHTED`, `SIDEKICK_SYNC`, `SIDEKICK_TRIAGE_MODEL`, `SIDEKICK_TRIGGERS`,
  `SIDEKICK_TRIGGER_RESERVE_USD`, `SIDEKICK_VERIFY_LENS`, `SIDEKICK_WARMUP_TOKENS`.
- SRT-owned proxy/shell variables: `ALL_PROXY`, `CLAUDE_CODE_HOST_HTTP_PROXY_PORT`,
  `CLAUDE_CODE_HOST_SOCKS_PROXY_PORT`, `CLOUDSDK_PROXY_ADDRESS`, `CLOUDSDK_PROXY_PORT`,
  `CLOUDSDK_PROXY_TYPE`, `DOCKER_HTTP_PROXY`, `DOCKER_HTTPS_PROXY`, `FTP_PROXY`,
  `GIT_SSH_COMMAND`, `GRPC_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `OLDPWD`, `PWD`,
  `RSYNC_PROXY`, `SANDBOX_RUNTIME`, `SHLVL`, and the lowercase `all_proxy`, `ftp_proxy`,
  `grpc_proxy`, `http_proxy`, `https_proxy`, `no_proxy` variants.

The immutable pre-dispatch receipt binds the exact enforcer package digests, policy and roots,
launcher environment, worker environment keys, prompt digest, worker argv, and registration. The
terminal receipt binds retained stdout/stderr byte counts and digests. This makes the boundary
independently auditable by the sealer rather than relying on the issue prompt's instructions
(security fix #3085).

## Consequences

### Positive
- The guarantee is structural, not aspirational: an undocumented or wrong-credential API call
  cannot compile/pass CI, mirroring the proven `spa-boundary` enforcement.
- The schema is forward-compatible: the #467 multi-tenant model flips exposure fields, with no
  call-site re-cut and a gate that *starts requiring* the phase-2 controls automatically.
- The named public-release dependencies (local-model egress scrub, tenancy isolation, per-IP
  limits) are tracked issues the gate physically enforces, not tribal memory.

### Negative / accepted limits
- `egressScrub: stub` is a display-grade bar standing in for a transmission-grade one; it is only
  sound because phase-1's operator-own-data + opt-in guarantees carry it. The gate, not discipline,
  is what prevents it leaking into phase 2.
- A transmission-grade scrub is genuinely hard and trades scrub fidelity against judge signal;
  that tradeoff is deferred, not solved here.
- Routing every server call through one chokepoint adds a refactor cost to existing call-sites
  (`/api/audit.json`, `/api/usage`) and a small indirection tax on new ones.

## Rejected alternatives

1. **Keep "never api.anthropic.com" as written.** Already false in shipped code; would force the
   judge family to be deleted or to lie about its compliance.
2. **Amend ADR 0005's free-path rule.** That rule governs the *free, local* Adoption Card and is
   correct; weakening it would license the exact exfiltration the invariant exists to stop.
3. **A human-maintained registry doc + a grep gate.** A grep can only check that a string is
   *mentioned*, not that the row's claims (scrubbed? capped?) are *true*; it is evadable. The
   chokepoint makes the claims structural.
4. **Reuse the subscription OAuth credential for the judge.** Either fails, or burns the operator's
   plan-limit windows for analysis — and conflates "logged into Claude Code" with "consented to
   paid third-party analysis." Rule A forbids it.
5. **Ship the exposure layer only when #467 starts.** Reproduces ADR 0005's failure mode — the
   phase-1 schema silently becomes the multi-tenant schema, and the pre-public gate gets bolted on
   under deadline instead of existing (and passing trivially) from day one.
6. **Build the transmission-grade scrub now.** Not feasible at this stage (needs a local model);
   blocking phase-1 framing on it would stall the whole effort. Deferred as a named, gate-enforced
   release dependency instead.
7. **Treat phase-1 exposure as needing adversarial anti-abuse.** Single-tenant exposure has no
   non-operator end user; per-IP/tenancy controls answer a threat that does not exist until #467.
