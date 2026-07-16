# Enterprise Pilot Deployment Guide

This guide describes the recommended deployment shape for a paid enterprise
pilot of the server build. It is intentionally self-hosted and private: the app
reads local Claude Code artifacts from mounted storage and does not provide a
multi-tenant SaaS control plane.

## Target Architecture

- Run the server build behind HTTPS, a private tunnel, or a trusted loopback-only
  reverse proxy.
- Bind the dashboard container to loopback unless a reverse proxy is the only
  reachable public surface.
- Use enterprise bearer auth with either RS256 JWTs from the organization's IdP
  or SHA-256 static token fingerprints for a limited bootstrap pilot.
- Store user Claude data under one approved parent directory and configure
  per-principal scoped roots for non-admin users.
- Send audit logs to a private local path with `0600` file mode, rotation, and an
  external retention pipeline if the pilot requires long-term evidence.
- Keep the base compose runtime hardening enabled: unprivileged image user,
  read-only image filesystem, all Linux capabilities dropped, no-new-privileges,
  read-only Claude mounts, writable `/app/.cache`, and bounded `/tmp` tmpfs.
- Keep distributed gateway rate limits in front of any multi-node deployment.

## Required Baseline

Set these before asking a CTO or security reviewer to evaluate a live instance:

```bash
DASHBOARD_AUTH_MODE=enterprise
DASHBOARD_ORG_ID=acme
DASHBOARD_ORG_NAME="Acme AI"
DASHBOARD_AUTH_ENFORCE_SCOPES=true
DASHBOARD_AUTH_DATA_ROOT_BASE=/srv/claude-history
DASHBOARD_ALLOWED_ORIGINS=https://dashboard.example.com
DASHBOARD_ENABLE_HSTS=true
DASHBOARD_AUTH_SESSION_SECRET=replace-with-32-plus-byte-random-secret
DASHBOARD_AUTH_SESSION_EPOCH=pilot-2026-06
DASHBOARD_AUTH_SESSION_COOKIE_SECURE=true
```

For IdP-backed access, prefer:

```bash
DASHBOARD_AUTH_JWKS_URL=https://idp.example.com/.well-known/jwks.json
DASHBOARD_AUTH_JWT_ISSUER=https://idp.example.com/
DASHBOARD_AUTH_JWT_AUDIENCE=claude-history-dashboard
DASHBOARD_AUTH_JWT_ORG_ID_CLAIM=org_id
DASHBOARD_AUTH_JWT_ADMIN_ROLES=dashboard-admin
DASHBOARD_AUTH_JWT_MEMBER_ROLES=dashboard-member
DASHBOARD_AUTH_JWT_VIEWER_ROLES=dashboard-viewer
DASHBOARD_AUTH_JWT_DATA_ROOT_TEMPLATE=/srv/claude-history/users/{sub}/.claude
```

For a small bootstrap roster before IdP integration, prefer a mounted file
secret over a large inline environment value:

```bash
DASHBOARD_AUTH_TOKENS_FILE=/run/secrets/dashboard-auth-tokens.json
```

The file uses the same JSON object or array shape as `DASHBOARD_AUTH_TOKENS`,
must be an absolute in-container path, and is mutually exclusive with
`DASHBOARD_AUTH_TOKENS`. Keep the file read-only and inside an explicit secret
mount; the app reads it once at startup under the same byte and entry caps as the
environment form.

For the browser session encryption secret, use either the inline environment
value from the baseline or a mounted secret file when the deployment platform can
provide one:

```bash
DASHBOARD_AUTH_SESSION_SECRET_FILE=/run/secrets/dashboard-session-secret
```

`DASHBOARD_AUTH_SESSION_SECRET_FILE` must be an absolute in-container path, is
mutually exclusive with `DASHBOARD_AUTH_SESSION_SECRET`, and is read once at
startup under a 4096-byte cap. The file content must still contain a 32+ byte
high-entropy secret, stay identical on every replica, and be readable through a
read-only secret mount.

For non-emergency session-secret rotation, deploy a new current secret on every
replica and keep the old value temporarily as `DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET`
or `DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET_FILE`. Previous secrets are
decrypt-only: existing cookies keep working during the rolling window, while all
new cookies are issued with the current secret. Previous file-backed secrets use
the same absolute-path, 4096-byte, and 32+ byte secret rules as the current
file-backed secret. Remove the previous secret after
`DASHBOARD_AUTH_SESSION_MAX_AGE_SECONDS` has elapsed. Use
`DASHBOARD_AUTH_SESSION_EPOCH` instead when the intent is immediate logout-all
revocation.

Browser users exchange a valid bearer/JWT credential once with
`POST /api/auth/session`. The server then sets an encrypted HttpOnly
`SameSite=Strict` session cookie and the frontend clears the bearer from browser
storage. Set `DASHBOARD_AUTH_SESSION_SECRET` or
`DASHBOARD_AUTH_SESSION_SECRET_FILE` to the same high-entropy value on every
replica so browser sessions survive restarts and load-balancer movement.
`DASHBOARD_AUTH_SESSION_EPOCH` is a non-secret logout-all switch: keep the same
value on every replica, and change it when existing browser sessions should be
invalidated without rotating the encryption secret.
For HTTPS deployments behind a reverse proxy, set
`DASHBOARD_AUTH_SESSION_COOKIE_SECURE=true` so browsers only send the session
cookie over HTTPS.

For reverse-proxied deployments that need client IP attribution:

```bash
DASHBOARD_TRUST_PROXY_HEADERS=true
DASHBOARD_TRUSTED_PROXY_ADDRESSES=127.0.0.1
```

Enterprise mode ignores forwarded headers until `DASHBOARD_TRUSTED_PROXY_ADDRESSES`
is set, so spoofed `X-Forwarded-For` values cannot split auth rate-limit buckets.
Oversized proxy allowlists are ignored fail-safe; over-entry allowlists preserve
the bounded prefix and require cleanup in the admin posture.

## Recommendation Identity Mapping

Admin/global recommendations derive a redacted organization identity dataset
from configured principal metadata so task-owner aliases such as user ids and
email addresses can resolve to stable contributors. That identity dataset is
not passed to scoped member/viewer recommendation responses.

## Optional GitHub Review Sync

To power organization-wide PR review bottleneck recommendations, configure the
server-only GitHub sync. It is disabled by default, uses an explicit server-held
token, requires an HTTPS GitHub API base URL without embedded credentials,
writes only a transcript-free review-event cache, and is exposed only through
the admin/global dataset. Scoped member/viewer datasets keep `reviewEvents`
null.

```bash
DASHBOARD_REVIEW_EVENTS_SOURCE=github
DASHBOARD_GITHUB_REVIEW_TOKEN=github_pat_or_app_installation_token
DASHBOARD_GITHUB_REVIEW_REPOS=acme/app,acme/api
# Optional for GitHub Enterprise Server:
DASHBOARD_GITHUB_REVIEW_API_BASE=https://github.example.com/api/v3
```

Use a least-privilege token that can read pull requests and issue timeline
events for the configured repositories. The cache stores repository, PR number,
reviewer id, request state, request timestamp, optional PR title/URL, and a
token fingerprint-derived config hash; it never stores the raw GitHub token or
Claude transcript content. The admin organization posture reports
`github-review-sync` as disabled until `DASHBOARD_REVIEW_EVENTS_SOURCE=github`
is set, enabled only when the token, HTTPS API base, and bounded repository
allowlist are valid, and action-required when the opt-in config is incomplete or
oversized. The posture returns counts and limits, never the token or raw repo
allowlist.

## Bound Every Variable Surface

Keep these defaults unless the customer has a measured need and an approved
compensating control:

- `DASHBOARD_AUTH_MAX_BEARER_BYTES=8192`
- `DASHBOARD_AUTH_TOKENS_MAX_BYTES=1048576`
- `DASHBOARD_AUTH_TOKENS_MAX_ENTRIES=256`
- `DASHBOARD_AUTH_PRINCIPAL_FIELD_MAX_CHARS=512`
- `DASHBOARD_AUTH_SCOPE_MAX_ENTRIES=64`
- `DASHBOARD_AUTH_SCOPE_SOURCE_MAX_BYTES=8192`
- `DASHBOARD_AUTH_SCOPE_MAX_CHARS=128`
- `DASHBOARD_AUTH_SESSION_EPOCH` has a fixed 1024-byte cap
- `DASHBOARD_AUTH_SESSION_MAX_AGE_SECONDS=28800`
- `DASHBOARD_AUTH_JWKS_URL_MAX_BYTES=2048`
- `DASHBOARD_AUTH_JWKS_MAX_BYTES=65536`
- `DASHBOARD_AUTH_JWKS_MAX_KEYS=32`
- `DASHBOARD_AUTH_JWT_CLAIM_PATH_MAX_BYTES=512`
- `DASHBOARD_AUTH_JWT_CLAIM_PATH_MAX_SEGMENTS=16`
- `DASHBOARD_AUTH_JWT_PINNING_MAX_BYTES=2048`
- `DASHBOARD_AUTH_JWT_ROLE_MAP_MAX_BYTES=8192`
- `DASHBOARD_AUTH_JWT_ROLE_MAP_MAX_ENTRIES=128`
- `DASHBOARD_AUTH_JWT_ROLE_MAP_ENTRY_MAX_CHARS=128`
- `DASHBOARD_AUTH_JWT_ROLE_CLAIM_MAX_VALUES=128`
- `DASHBOARD_AUTH_JWT_DATA_ROOT_TEMPLATE_MAX_BYTES=4096`
- `DASHBOARD_CONTENT_SECURITY_POLICY_MAX_BYTES=16384`
- `DASHBOARD_TRUSTED_PROXY_ADDRESSES_MAX_BYTES=16384`
- `DASHBOARD_TRUSTED_PROXY_ADDRESSES_MAX_ENTRIES=64`
- `DASHBOARD_ALLOWED_ORIGINS_MAX_BYTES=16384`
- `DASHBOARD_ALLOWED_ORIGINS_MAX_ENTRIES=64`
- `DASHBOARD_REQUEST_TIMEOUT_MS=120000`
- `DASHBOARD_HEADERS_TIMEOUT_MS=60000`
- `DASHBOARD_KEEP_ALIVE_TIMEOUT_MS=5000`
- `DASHBOARD_SOCKET_TIMEOUT_MS=120000`
- `DASHBOARD_RAW_FILE_MAX_BYTES=67108864`
- `DASHBOARD_RAW_SESSION_MAX_PARTS=10000`
- `DASHBOARD_INGEST_PROJECT_MAX_DIRS=50000`
- `DASHBOARD_INGEST_SESSION_DISCOVERY_MAX_ENTRIES=250000`
- `DASHBOARD_TRANSCRIPT_DECOMPRESS_MAX_BYTES=67108864`
- `DASHBOARD_INGEST_SESSION_MAX_BYTES=67108864`
- `DASHBOARD_INGEST_SESSION_MAX_PARTS=10000`
- `DASHBOARD_LIVE_SESSION_MAX_BYTES=67108864`
- `DASHBOARD_CONFIG_FILE_MAX_BYTES=1048576`
- `DASHBOARD_CONFIG_RESOURCE_MAX_ENTRIES=50000`
- `DASHBOARD_ARTIFACT_FILE_MAX_BYTES=67108864`
- `DASHBOARD_INSIGHTS_STATUS_REPORT_MAX_ENTRIES=50000`
- `DASHBOARD_SIGNATURE_TREE_MAX_ENTRIES=250000`
- `DASHBOARD_REPO_MAP_ARTIFACT_MAX_ENTRIES=50000`
- `DASHBOARD_MEMORY_FILE_MAX_BYTES=262144`
- `DASHBOARD_MEMORY_RESPONSE_MAX_BYTES=4194304`
- `DASHBOARD_MEMORY_MAX_FILES=50000`
- `DASHBOARD_WORKFLOW_MANIFEST_MAX_BYTES=1048576`
- `DASHBOARD_WORKFLOW_RUN_MAX_ENTRIES=50000`
- `DASHBOARD_GITHUB_REVIEW_REPOS_MAX_BYTES=8192`
- `DASHBOARD_GITHUB_REVIEW_MAX_REPOS=25`
- `DASHBOARD_GITHUB_REVIEW_MAX_PULLS_PER_REPO=100`
- `DASHBOARD_GITHUB_REVIEW_MAX_TIMELINE_REQUESTS=100`
- `DASHBOARD_GITHUB_REVIEW_MAX_TIMELINE_EVENTS_PER_PR=100`
- `DASHBOARD_GITHUB_REVIEW_MAX_RECORDS=5000`
- `DASHBOARD_GITHUB_REVIEW_FETCH_TIMEOUT_MS=5000`
- `DASHBOARD_GITHUB_REVIEW_MAX_RESPONSE_BYTES=1048576`
- `DASHBOARD_GITHUB_REVIEW_CACHE_TTL_MS=300000`
- `DASHBOARD_RECOMMENDATIONS_CACHE_MAX_ENTRIES=256`
- `DASHBOARD_MUTATING_BODY_MAX_BYTES=1048576`
- `ENTERPRISE_AUDIT_READ_MAX_BYTES=1048576`
- `ENTERPRISE_AUDIT_LINE_MAX_BYTES=65536`
- `ENTERPRISE_AUDIT_ROTATE_MAX_BYTES=67108864`

## Server-Scale Receipt

`npm run gate:enterprise-readiness` includes the server-scale budget guard. The
default synthetic corpus is organization-shaped, not just one large local
history:

```bash
DASHBOARD_SCALE_SESSIONS=1200
DASHBOARD_SCALE_TURNS=3
DASHBOARD_SCALE_PROJECTS=120
DASHBOARD_SCALE_USERS=60
DASHBOARD_SCALE_TEAMS=12
```

The receipt prints observed project ids, generated project directories, users,
teams, transcript bytes, dataset rows, memory growth, and timing budgets. For a
buyer pilot, re-run `npm run gate:server-scale` with dimensions and budgets
that match the customer's expected corpus. If the configured target is truncated
by ingest, session discovery, or artifact caps, the guard fails instead of
producing a misleading pass receipt.

## Pre-Demo Validation

Before a paid demo, run the local mechanical gate:

```bash
npm run gate:enterprise-readiness
```

Attach its pass/fail receipt to the release-gate issue or buyer handoff. Then
verify these outcomes against the exact host and origin the buyer will use:

1. `GET /api/auth/session` without a bearer token returns `401` when auth is
   configured, not live organization data.
2. `POST /api/auth/session` with a valid admin token returns the expected
   organization id, role, team metadata, scopes, and no raw credential.
3. The same response sets an HttpOnly `SameSite=Strict` enterprise session
   cookie; on HTTPS buyer hosts it also has the `Secure` flag. Subsequent
   `GET /api/auth/session` and protected data requests work with only that
   cookie, and `DELETE /api/auth/session` clears it.
4. Changing `DASHBOARD_AUTH_SESSION_EPOCH` and restarting all replicas makes the
   previous browser session cookie return `401` and a clearing `Set-Cookie`
   header.
5. `GET /api/enterprise/organization` returns zero action-required posture items
   or a documented risk acceptance for each remaining item.
6. `GET /api/enterprise/readiness-receipt` returns a redacted JSON receipt for
   an admin. Attach it to the buyer handoff; it should contain aggregate
   posture, identity, audit, route, and bounds evidence without request paths,
   request ids, token fingerprints, remote addresses, raw bearer tokens, data
   roots, transcript content, session ids, raw project paths, or
   security-control details.
7. `GET /healthz` returns only `ok` without credentials, and the image or
   compose healthcheck reports healthy for the running server process.
8. The base compose app service keeps `read_only: true`, `cap_drop: [ALL]`,
   `security_opt: [no-new-privileges:true]`, writable `/app/.cache`, and a
   bounded `/tmp` tmpfs. Any custom audit/cache path is backed by an explicit
   writable mount.
9. Static bootstrap principals, if used, come from exactly one source:
   `DASHBOARD_AUTH_TOKENS` or a read-only `DASHBOARD_AUTH_TOKENS_FILE` secret.
   File-backed rosters use an absolute in-container path and stay within the
   static config byte and entry caps. Browser session encryption uses exactly
   one source: `DASHBOARD_AUTH_SESSION_SECRET` or a read-only
   `DASHBOARD_AUTH_SESSION_SECRET_FILE` secret. During planned rotation, any
   previous session secret uses exactly one temporary decrypt-only source:
   `DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET` or
   `DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET_FILE`.
10. The boot log reports the intended HTTP listener timeouts for request,
   headers, keep-alive, and idle socket handling.
11. A member/viewer token with a scoped data root can read only its own manifest,
   dataset, transcript, live, memory, and workflow routes.
12. A member/viewer token without an allowed scoped data root cannot fall back to
   global organization data.
13. Cross-origin write attempts fail unless the `Origin` exactly matches
   `DASHBOARD_ALLOWED_ORIGINS` and the request has the same-origin CSRF token.
14. Audit events include request id, path, outcome, redacted principal metadata,
   and token fingerprints, but no raw bearer tokens.
15. The audit log and scoped SQLite cache files are private on disk; audit reads
   are per-line bounded and audit logs rotate under the configured bounds.
16. The admin audit activity summary reports counts by outcome, type, and role
   without request paths, request ids, token fingerprints, remote addresses, raw
   bearer tokens, or transcript content.
17. The bounded audit export downloads sanitized NDJSON for external handoff
   through the same admin audit-read gate; it is a pilot artifact, not centralized
   fleet logging.
18. Custom CSP, proxy-header trust, browser LLM egress, server LLM audits, and
   server usage-gauge egress are either disabled or explicitly approved. Enabled
   server LLM audits have finite judge-call, output-token, and input-row caps
   plus an Anthropic Console workspace spend limit.
19. Before any public LLM exposure, `npm run gate:llm-egress` passes and the
    security release-gate epic contains a human sign-off receipt. For
    multi-tenant exposure, also run
    `DASHBOARD_LLM_PUBLIC_EXPOSURE_MODE=multi-tenant npm run gate:llm-egress`.
20. If GitHub review sync is enabled, `reviewEvents` appears for the admin/global
    dataset, remains null for scoped member datasets, the `github-review-sync`
    posture control is enabled, and the cache file is private on disk.
21. `npm run gate:enterprise-routes` passes and the route access matrix in
    [`enterprise-readiness.md`](./enterprise-readiness.md#route-access-policy-matrix)
    matches the intended pilot boundary: admin/global views for admins, scoped
    roots for non-admin users, raw transcript routes treated as highest
    sensitivity, and writes limited to admin plus CSRF.

Review [`enterprise-threat-model.md`](./enterprise-threat-model.md) alongside
this checklist before the demo. Each residual risk should be fixed, accepted, or
out of scope for the pilot.

## Evidence Commands

Run these from the repository before shipping a branch or image:

```bash
npm run lint
npm test
npm run test:enterprise-auth
rm -rf dist && npx vite build && node scripts/check-bundle-size.mjs --flavor server
rm -rf dist && npm run build:spa && node scripts/check-bundle-size.mjs --flavor spa
```

For the upload-only SPA build, also scan the emitted bundle for server strings as
documented in `AGENTS.md`; the SPA must not include `/api/*`, CSRF, policy-write,
or `EventSource` surfaces.

## Limits To State Clearly

- This is suitable for a private enterprise pilot, not a multi-tenant SaaS sale.
- Full OIDC browser redirect login, durable seat lifecycle, IdP directory sync,
  distributed rate limiting, and centralized audit export remain follow-on work.
- A regulated-production sale still needs a third-party penetration test and
  customer-specific deployment hardening review.
