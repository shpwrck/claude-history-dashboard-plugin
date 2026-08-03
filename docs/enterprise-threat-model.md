# Enterprise Threat Model

This threat model covers the server build when `DASHBOARD_AUTH_MODE=enterprise`
is enabled. It is scoped to a private, self-hosted organization deployment that
reads Claude Code artifacts from mounted storage. It does not claim SaaS
multi-tenancy, OIDC browser login, or centralized audit export.

## Security Objectives

- Require authentication before any live organization data is returned.
- Keep every principal inside the configured organization boundary.
- Let admins retain a global organization view while members and viewers read
  only their own scoped data roots.
- Prevent one request or artifact from forcing unbounded memory, decompression,
  parsing, or network work.
- Avoid raw credential disclosure in responses, audit logs, browser caches, or
  static config when fingerprint alternatives are available.
- Make risky deployment choices visible in the admin security posture.

## Assets

| Asset | Examples | Primary controls |
| --- | --- | --- |
| Claude history data | `history.jsonl`, `projects/*`, session transcripts, cached BLOBs | Enterprise bearer/JWT/session-cookie auth, role/scope checks, scoped data roots, realpath containment, no-store cache policy |
| Organization metadata | Principal roster, team rollups, admin posture, recent audit events | Admin-only organization API, tokenless public-principal shape, roster paging |
| Credentials | Static bearer tokens, token fingerprints, file-backed static principal rosters, JWTs, current and previous browser session encryption secrets, encrypted browser session cookies, basic-auth credentials, Claude OAuth usage credential, GitHub review-sync token | Byte caps, SHA-256 fingerprints, redaction, mutually exclusive static roster/session-secret sources, absolute file-secret paths, decrypt-only previous session secrets during rolling rotation, JWT issuer/audience/org pinning, HttpOnly SameSite session cookies, no raw tokens in audit logs or review-event caches |
| Audit trail | Enterprise audit JSONL and rotated backups | Private file mode, bounded strings, bounded tail reads, rotation and retention caps |
| Host filesystem | Mounted `~/.claude` roots, scoped tenant roots, scoped SQLite caches, and the container image filesystem | Normalized path joins, realpath containment, data-root base boundary, symlink escape rejection, private cache directory and DB file modes, read-only image root with explicit writable cache volume |
| Server resources | Memory, CPU, decompression work, parser work, outbound fetches, listener sockets | Per-surface byte caps, streaming/tail readers, bounded response caches, single-flight rebuilds, rate limits, HTTP listener timeouts, JWKS and GitHub sync timeout/cache/throttle bounds |

## Trust Boundaries

| Boundary | Trusted side | Untrusted side | Controls |
| --- | --- | --- | --- |
| Browser to dashboard server | Authenticated dashboard origin | Other origins and unauthenticated clients | Bearer/JWT bootstrap, HttpOnly SameSite session cookie, same-origin CSRF token for writes, exact `Origin` allowlist, CSP, no-store protected responses |
| Reverse proxy to app | Configured proxy peer addresses | Client-supplied forwarding headers | `DASHBOARD_TRUSTED_PROXY_ADDRESSES`, fail-safe ignored forwarded headers, posture warnings |
| IdP/JWKS to app | Configured HTTPS JWKS endpoint or static JWKS | Redirects, oversized JWKS, duplicate or weak keys | HTTPS-only URL validation, redirect rejection, byte/key caps, RSA bit floor, kid ambiguity rejection |
| Admin global data to member scoped data | Admin role and org scopes | Member/viewer principals | Role/scope route checks, scoped data-root checks, no fallback to global data for rootless users |
| Mounted artifact storage to parser | Expected Claude artifact files | Oversized, malformed, or symlinked files | Byte caps, tolerant parser skips, realpath checks on file-backed routes, no body reads for file-history |

## Threats And Mitigations

| Threat | Current mitigation | Residual risk |
| --- | --- | --- |
| Unauthenticated live-data access | Enterprise mode protects `/api/*`, `/sessions-manifest.json`, `/history.jsonl`, and `/projects/*`; missing or invalid tokens return 401/503 before data routes run. Static file serving realpath-checks targets under the built bundle before serving public assets. | Static assets remain public by design. Deploy private server build behind HTTPS, private tunnel, or loopback. |
| Cross-organization principal access | Static principal config containing any principal outside `DASHBOARD_ORG_ID` makes enterprise auth fail closed before protected routes run. JWT principals map into the configured org only after signature, issuer, audience, lifetime, and optional org-claim checks. | IdPs serving multiple tenants should set `DASHBOARD_AUTH_JWT_ORG_ID_CLAIM`. |
| Member reads global admin data | Members/viewers require scoped data roots for live data and cannot read organization/global APIs. Rootless non-admins fail closed. | Admins remain global by design. Protect admin token issuance outside the app. |
| Data-root path escape | Static and JWT-derived roots can be constrained to `DASHBOARD_AUTH_DATA_ROOT_BASE`; file-backed reads use normalized paths and realpath containment. | Non-existing roots cannot be realpath-checked until created, so keep the base boundary configured in production. |
| Cross-site request forgery on write routes | Mutating routes require an authenticated principal, same-origin `Origin`, JSON content type, and per-process `X-CSRF-Token`. | CSRF token is process-local and rotates on restart, not a durable user session secret. |
| Browser session theft or replay | Browser sign-in exchanges a valid bearer/JWT for an encrypted HttpOnly `SameSite=Strict` cookie with bounded lifetime. Invalid, tampered, expired, stale-epoch, or oversized cookies fail closed and are cleared. HTTPS deployments can force the `Secure` flag, `DASHBOARD_AUTH_SESSION_EPOCH` revokes existing browser sessions across replicas, `DASHBOARD_AUTH_SESSION_SECRET_FILE` can load the stable encryption secret from a read-only mounted file, previous secrets are accepted only for decrypting old cookies during rolling rotation, and posture flags missing stable session secrets or insecure non-loopback cookie config. | A stolen valid cookie can be replayed until expiry or until the session epoch changes. Use HTTPS, short lifetimes, endpoint protection, and external session controls for regulated deployments. |
| Credential disclosure in logs or responses | Public principal payloads omit tokens and data-root paths. Audit logs store bounded metadata and short token fingerprints only. Oversized or invalid config errors are bounded and redacted. | Operators can still place raw static tokens in env for bootstrap pilots; posture flags this. Prefer SHA-256 fingerprints or JWTs. |
| Oversized bearer/JWT abuse | Bearer tokens are rejected above `DASHBOARD_AUTH_MAX_BEARER_BYTES`; decoded JWT header, claims, and signature segments have independent caps before JSON parse or signature work. | Valid JWTs within caps still consume signature verification CPU. Use proxy rate limits for exposed deployments. |
| JWKS endpoint abuse | Remote JWKS uses HTTPS-only URL config, response byte cap, key-count cap, fetch timeout, cache TTL, refresh throttle, redirect rejection, duplicate-kid detection, and RSA bit floor. | Remote IdP outage can deny JWT auth until cache refresh succeeds; posture reports bounded runtime errors. |
| Parser memory denial of service | Transcript, live-session, config, auxiliary artifact, memory, workflow, adoption receipt, policy write, and audit read surfaces have byte caps or streaming/tail readers before parse. Raw merged-session parts, ingest project/session discovery, ingest session parts, sessions manifest enumeration, memory file lists, workflow run ledgers, and live-config resource lists have entry caps or truncation metadata before response assembly. | Directory enumeration itself is still local filesystem work. Keep mounted artifact trees under operator control. |
| Compressed transcript inflation | Cached transcript BLOB decompression is capped before inflated content can dominate memory. | Larger legitimate transcripts require explicit cap changes and should be reviewed before demo. |
| Audit log growth | Audit writes rotate before the active log exceeds configured size, retain a bounded number of backups, and admin reads tail a bounded byte window. | Centralized audit export is not built in; use external log shipping if required. |
| Brute-force, credential stuffing, or slow-client resource pinning | Auth/session attempts and invalid-token protected route attempts are address-keyed, authenticated API routes are token-plus-address keyed, retry headers are emitted, rate-limit events are audited, bucket state is capped, and HTTP request/header/keep-alive/idle socket timeouts are explicit. | In-process limits are per-node. Use gateway/distributed rate limits for multi-node deployments. |
| Browser data retention | Auth/session and protected enterprise responses set `Cache-Control: no-store` and vary on Authorization and Cookie where relevant. The `/healthz` liveness endpoint is also `no-store` and returns only `ok`, so orchestrators can probe it without a dashboard credential. | Browser extensions or client machines remain outside the app trust boundary. |
| Cache invalidation fanout | Optional artifact signature walks and repo-map root discovery have configurable entry caps before dataset cache invalidation stats tenant-controlled trees. | Changes beyond the bounded traversal may require a higher cap or artifact cleanup before production rollout. |
| Browser-side egress | Enterprise CSP blocks browser calls to `api.anthropic.com` unless `DASHBOARD_ENABLE_BROWSER_LLM_EGRESS=true`. | If enabled, each browser uses its own Anthropic key from that origin; review customer policy first. |
| Server-side egress | Server LLM audits and usage gauge are disabled by default; skipped egress is audited; usage credential reads are byte-capped. | If enabled, approved operators must accept transcript-derived audit prompts or host OAuth usage reads. |
| GitHub review-sync egress | GitHub review sync is disabled by default, requires an explicit server token, accepts only HTTPS API base URLs without embedded credentials, fetches bounded repo/PR/timeline pages through a bounded-concurrency pool under one total synchronization deadline plus per-request timeout and response-byte caps, writes a private transcript-free cache, is disabled for scoped member/viewer ingest, and reports a redacted `github-review-sync` admin posture control. | GitHub token scope and repository allowlist remain operator responsibilities. Network failure can keep serving the last matching cached review-events dataset until the cache is refreshed or removed. |
| Container privilege escalation or filesystem writes | The published image runs as the unprivileged `node` user. The base compose service sets a read-only root filesystem, drops all Linux capabilities, denies no-new-privileges bypasses, mounts Claude artifacts read-only, and keeps writable state explicit under `/app/.cache` plus bounded `/tmp` tmpfs. | Custom compose overrides that move cache or audit paths must add explicit writable mounts for those paths. Container isolation still depends on the host runtime and kernel. |
| Misconfigured public exposure | Security posture flags broad binds without HSTS, custom CSP overrides, missing JWT pinning, proxy trust gaps, raw credentials, and scoped roots without a data-root base. | Posture is advisory. Operators must clear or accept each action-required item before paid deployment. |

## Security Posture Contract

`GET /api/enterprise/organization` is the admin-facing control summary. A paid
pilot should treat every `action-required` control as either fixed before demo or
explicitly accepted in writing. The current posture covers:

- Authentication configuration and credential hygiene.
- Organization and data-root authorization.
- JWT issuer, audience, lifetime, role-map, claim-path, JWKS, key-strength, and
  org-claim checks.
- Audit logging, retention, and bounded reads.
- Browser security headers, CSP, HSTS posture, and browser/server egress.
- Production liveness through a no-data `/healthz` endpoint and image
  healthcheck.
- Container runtime least-privilege settings in the base compose service.
- HTTP listener request, header, keep-alive, and idle socket timeouts.
- GitHub review sync opt-in state, HTTPS API-base validation, credential-free
  API-base enforcement, and bounded repository/fetch/cache limits.
- Proxy trust, write-origin allowlist, rate limits, scoped cache, and every
  major read/body/parser byte cap.

## Verification Evidence

Run these gates before presenting a build:

```bash
npm run lint
npm test
npm run test:enterprise-auth
rm -rf dist && npx vite build && node scripts/check-bundle-size.mjs --flavor server
rm -rf dist && npm run build:spa && node scripts/check-bundle-size.mjs --flavor spa
```

For the SPA build, also scan the emitted bundle for server strings as documented
in `AGENTS.md`; the upload-only SPA must not contain `/api/*`, CSRF,
policy-write, or `EventSource` server surfaces.

## Out Of Scope

- Full OIDC browser redirect login and IdP-initiated logout.
- Durable organization, seat, and team lifecycle management.
- IdP directory sync beyond JWT claims.
- Distributed rate limiting and centralized audit export.
- Third-party penetration test and regulated-production hardening review.
