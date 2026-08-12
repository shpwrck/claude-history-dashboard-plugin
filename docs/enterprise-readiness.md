# Enterprise Readiness Brief

This brief summarizes the enterprise controls in the server build of Claude
History Dashboard. It is intended for CTO or security review before deploying the
dashboard beyond a single local user.

## Buyer-Facing Position

Claude History Dashboard can run as a private, self-hosted organization console
for Claude Code history. The default mode remains single-user and local. When
enterprise auth is enabled, every live data surface is bearer-authenticated,
same-organization scoped, audited, and served with hardened cache and browser
security defaults.

The current product is ready for a bootstrap enterprise pilot where principals
come from static token config or RS256 JWTs from an IdP/JWKS endpoint. Full
directory sync, seat lifecycle management, and paid multi-tenant SaaS control
planes remain follow-on work.

## Implemented Controls

| Area | Current capability |
| --- | --- |
| Authentication | Enterprise mode requires a bearer token, JWT, or encrypted HttpOnly browser session cookie before returning `/api/*`, `/sessions-manifest.json`, `/history.jsonl`, or `/projects/*`. Browser users exchange a valid bearer/JWT once with `POST /api/auth/session`; the frontend then clears browser-held bearer storage and uses the same-origin cookie. Principals can be static token records, SHA-256 token fingerprints, one-admin bootstrap tokens, one-admin bootstrap token fingerprints, static RS256 JWKS, or remote HTTPS JWKS. Static JWKS payloads and remote JWKS fetches have byte and key-count bounds; remote JWKS also has timeout, cache, and refresh-throttle bounds. Redirects are rejected, explicit non-signing keys are ignored, duplicate or malformed key ids fail closed, JWT RSA signing keys below the configured bit floor are ignored, and weak-only JWKS config fails closed. |
| Authorization | Principals carry role, org, team, scope, and optional data-root metadata. Admins retain organization-wide views. Members and viewers can read only their scoped data root when configured. Unclassified enterprise-protected API routes fail closed until explicitly mapped. `DASHBOARD_AUTH_DATA_ROOT_BASE` can constrain static and JWT-derived scoped roots to one approved tenant directory, with normalized-path and realpath escapes treated as unconfigured. Optional scope enforcement adds least-privilege checks on top of roles. Mutating write routes require both an authorized principal and a same-origin per-process CSRF token. |
| Organization boundary | Principals outside `DASHBOARD_ORG_ID` are denied before route authorization and omitted from the admin roster. JWT principals are mapped into the configured organization only after signature, expiration, bounded lifetime, issuer, audience, and optional org-claim checks. Admin posture marks JWT signing-key deployments without issuer and audience pinning as action-required. |
| Team visibility | The admin organization endpoint returns a tokenless principal page plus team rollups for admins, members, viewers, and scoped roots. It also returns a redacted identity coverage summary derived only from principal metadata, so reviewers can see user/team/alias coverage without transcript-derived identity inference. Admin/global recommendations receive the same redacted principal identity dataset for explicit task-owner alias matching; scoped member/viewer recommendations do not receive the global identity map. |
| Auditability | Enterprise auth decisions, denied routes, privileged route reads/writes, egress skips, and rate-limit hits append to a private audit JSONL log with request id, bounded strings, principal metadata, token fingerprints, and remote address. Raw tokens are never written. The admin organization endpoint also returns a redacted audit activity summary with counts by outcome, event type, and principal role without request paths, request ids, token fingerprints, remote addresses, or transcript content. |
| Retention | Audit reads tail a bounded byte window. Audit writes create and tighten active logs with `0600` file mode, rotate the active log before it exceeds configured size, and retain a bounded number of private backups. |
| Scale guardrails | Organization rosters are paged in the API and Enterprise admin UI, and serialized organization admin responses have a byte cap. Security posture controls are counted and ordered by severity in the admin UI so `action-required` items stay visible during review. Sessions manifest enumeration is capped and reports truncation through headers while preserving the legacy array body. Team rollups still cover the full configured set. Scoped ingest state is capped and evicted least-recently-used. Recommendation response caches are capped per dataset state, serialized recommendation bodies have byte caps, and repeated builds are single-flighted. Rate-limit bucket state is capped and pruned. Project/session discovery, merged session ingest, lazy transcript decompression, dataset responses, and persisted auxiliary artifact cache rows are capped. Memory API reads have per-file, per-response, returned-file, and directory-discovery caps. Workflow manifest reads have per-file, run-count, projected-array, projected-string, and directory-discovery caps. Optional artifact reads, parser directory discovery, insights status report discovery, and cache-invalidation signature walks are capped. Persistent SQLite caches are keyed by data-root hash and tightened to private filesystem modes. Dataset compression runs off the event loop. HTTP request, header, keep-alive, and idle socket timeouts are explicit and bounded by environment overrides. |
| Abuse controls | Enterprise auth/session attempts and invalid-token protected route attempts have in-process address-keyed rate limits, and authenticated API routes have token-plus-address rate limits with retry headers and audit events. Forwarded client addresses are ignored in enterprise mode unless exact trusted proxy peers are configured. Slow or stalled HTTP clients are bounded by explicit listener timeouts. Authenticated policy and adoption writes reject request bodies above the configured cap before JSON parsing, raw history/transcript downloads reject oversized files before compression or merge concatenation, oversized cached transcript BLOBs return 413 before unbounded inflation, oversized merged sessions are omitted from dataset ingest, and oversized memory markdown or workflow manifest files are skipped. Deployments should still use distributed gateway limits for multi-node production. |
| Egress governance | Server LLM audits, server usage-gauge calls, browser-side LLM calls, and GitHub review sync are disabled or CSP-blocked by default in enterprise mode unless operators explicitly opt in. Skipped server egress is audited, and the GitHub sync posture reports disabled/enabled/action-required state without returning the token or raw repository allowlist. Public LLM exposure is release-gated: `npm run gate:llm-egress` rejects reachable entries without auth, caps, or non-stub scrub, and multi-tenant exposure also requires `DASHBOARD_LLM_PUBLIC_EXPOSURE_MODE=multi-tenant`. |
| HTTP and browser security | Responses get CSP, frame denial, nosniff, no-referrer, permissions policy, same-origin isolation headers, bounded exact write-origin checks, realpath-contained static bundle serving, HttpOnly `SameSite=Strict` enterprise session cookies, and no-store cache policy for auth/session and protected enterprise data routes. Auth-sensitive responses vary on Authorization and Cookie. The production image and base compose service probe a `/healthz` liveness endpoint that returns no organization, principal, transcript, or path data. Custom CSP overrides are marked action-required in the admin posture. |
| Container runtime posture | The runtime image runs as the unprivileged `node` user, and the base compose service makes the image filesystem read-only, drops all Linux capabilities, denies privilege escalation, keeps Claude mounts read-only, and limits writable state to `/app/.cache` plus bounded `/tmp` tmpfs. |
| Transport posture | Enterprise posture marks loopback or HSTS-enabled deployments as clean and broad service binds without app-level HSTS as action-required. |
| Credential hygiene | Admin posture flags raw static bearer secrets, short raw bearer tokens, malformed SHA-256 fingerprints, and recommends SHA-256 fingerprints or RS256 JWTs for production. Duplicate static/bootstrap credentials fail closed, static token config parsing is byte-capped, raw static credentials are converted to fingerprints in principal records after parsing, and oversized bearer credentials, including the raw bootstrap admin token, are rejected before hashing or JWT parsing. |
| SPA boundary | The upload-only SPA build remains separate: no `/api/*`, no host mounts, and no backend attack surface. The server build remains the live-data, auth-gated product. |

## Route Access Policy Matrix

The server route inventory is enforced by
`scripts/check-enterprise-route-inventory.mjs`. Every live data route handled by
`scripts/server.mjs` must appear in `ENTERPRISE_ROUTE_INVENTORY`, and every
inventory `access` category must have a matching
`ENTERPRISE_ROUTE_ACCESS_POLICIES` entry. Unknown categories, stale policy
entries, and missing posture fields fail `npm run gate:enterprise-routes`; the
full CTO receipt also runs that gate through `npm run gate:enterprise-readiness`.

| Access category | Representative routes | Who can read/write | Data exposure |
| --- | --- | --- | --- |
| `public-auth-status` | `/api/auth/session` | Anonymous callers can receive auth status; valid admin/member/viewer bearers receive their own principal metadata. | Authentication metadata only; no transcript or organization dataset. |
| `admin-audit` | `/api/enterprise/audit-log`, `/api/enterprise/audit-export.ndjson` | Admin with `canReadAuditLog` (`audit:read` or `org:read`). | Bounded enterprise audit events and bounded NDJSON export; raw bearer tokens are redacted; no transcript text. |
| `admin-organization`, `admin-organization-rollup` | `/api/enterprise/organization`, `/api/organization/rollup.json` | Admin with `canReadOrganizationData` / `canReadOrganizationRollup` (`org:read`). | Organization roster, team rollups, security posture, and redacted aggregate usage. Raw prompts, session ids, project paths, tool inputs, and transcript text are excluded from rollups. |
| `admin-readiness-receipt` | `/api/enterprise/readiness-receipt` | Admin with `canReadOrganizationRollup` (`org:read`). | Redacted CTO/buyer handoff evidence: posture states, identity coverage, audit activity counts, response bounds, and route-access assertions. No principal roster, raw audit rows, request paths, token fingerprints, transcript text, session ids, raw project paths, or security-control details. |
| `policy-write` | `/api/csrf-token`, `/api/policy/write` | Admin with `canWritePolicy` (`org:write` or `policy:write`), plus same-origin CSRF for writes. | Mutating policy/adoption write surface; bounded request body; no transcript read surface. |
| `organization-data` | `/api/adoption/receipts`, `/api/usage`, `/api/audit.json` | Admin with `canReadOrganizationData` (`org:read`). | Organization-derived dashboard data and optional audit findings. Server LLM audit egress remains opt-in and separately gated. |
| `scoped-or-admin-data` | `/api/dataset.json`, `/api/recommendations.json`, `/api/live` | Admin can read organization data; member/viewer can read only when a configured scoped data root grants `canReadOwnSessions`. | Parsed session content and derived recommendations, bounded to the organization for admins or the principal data root for non-admins. Admin recommendations may use redacted principal identity aliases; scoped member/viewer recommendations cannot use the global identity map. |
| `scoped-data` | `/api/memories`, `/api/workflows` | Admin organization read, or member/viewer with scoped data root and session-read scope. | Derived memory/workflow data from the allowed root; oversized files and manifests are skipped or capped. |
| `scoped-session-list`, `scoped-session-detail`, `scoped-history` | `/sessions-manifest.json`, `/api/session/:id/timeline`, `/history.jsonl` | Admin organization read, or member/viewer with scoped data root and session-read scope. | Session metadata, timeline detail, or raw history log from the allowed boundary. |
| `raw-transcript`, `scoped-raw-session` | `/api/transcript/*`, `/projects/*` | Admin or scoped-root member/viewer with `canReadRawTranscripts` / session-read capability. | Highest-sensitivity raw transcript or project session file reads; realpath containment, byte caps, and merged-part caps apply. |

Reviewer shorthand: admins get the global organization view; non-admin users do
not get global fallback data. A member/viewer without an approved scoped
`dataRoot` can authenticate, but cannot read live session data.

## Operational Model

1. Deploy the server build privately, usually behind Caddy, a trusted HTTPS
   reverse proxy, a private tunnel, or loopback-only host publishing.
2. Enable `DASHBOARD_AUTH_MODE=enterprise`.
3. Configure one of:
   - `DASHBOARD_AUTH_TOKENS_FILE` with a read-only mounted JSON principal
     roster secret.
   - `DASHBOARD_AUTH_TOKENS` with principals or token fingerprints.
   - `DASHBOARD_ADMIN_TOKEN_SHA256` for a one-admin bootstrap without storing a
     raw bearer token in app config.
   - `DASHBOARD_AUTH_JWKS` or `DASHBOARD_AUTH_JWKS_URL` for RS256 JWTs.
4. Set `DASHBOARD_ORG_ID` and `DASHBOARD_ORG_NAME`.
5. Set `DASHBOARD_AUTH_JWT_ORG_ID_CLAIM` when JWTs carry a tenant or
   organization claim that should match `DASHBOARD_ORG_ID`.
6. Prefer per-principal `dataRoot` or `DASHBOARD_AUTH_JWT_DATA_ROOT_TEMPLATE`
   for member/viewer isolation, and set `DASHBOARD_AUTH_DATA_ROOT_BASE` to the
   approved tenant data directory before production rollout.
7. Turn on `DASHBOARD_AUTH_ENFORCE_SCOPES=true` when the IdP or static config
   can issue least-privilege scopes; enterprise posture marks this
   action-required until it is enabled.
8. Set `DASHBOARD_AUTH_SESSION_SECRET` or
   `DASHBOARD_AUTH_SESSION_SECRET_FILE` to a stable 32+ byte random secret
   shared by every replica. Keep `DASHBOARD_AUTH_SESSION_EPOCH` consistent
   across replicas, and change it to invalidate existing browser sessions
   without rotating the encryption secret. For planned secret rotation, set the
   old value temporarily as `DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET` or
   `DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET_FILE` on every replica, then remove
   it after the maximum session-cookie lifetime. Set
   `DASHBOARD_AUTH_SESSION_COOKIE_SECURE=true` when browsers reach the app over
   HTTPS through a proxy.
9. Review `GET /api/enterprise/organization` as an admin and clear every
   action-required posture item before a paid deployment.

Use [`enterprise-deployment-guide.md`](./enterprise-deployment-guide.md) for the
paid-pilot deployment shape, required environment, and pre-demo validation steps.
Use [`enterprise-threat-model.md`](./enterprise-threat-model.md) for the asset,
trust-boundary, threat, mitigation, and residual-risk review.

Run `npm run gate:enterprise-readiness` before a CTO demo or paid-pilot
handoff. It composes the mechanical auth/posture, LLM-egress, server-scale,
route-inventory, repo-map, server-bundle, SPA-boundary, and SPA-bundle checks
into one pass/fail receipt. It complements, but does not replace, the live host
checks in the deployment guide.

## CTO Review Checklist

- `npm run gate:enterprise-readiness` passes, and the receipt is attached to the
  release-gate issue or buyer handoff.
- `GET /api/enterprise/readiness-receipt` succeeds for an admin and its JSON
  receipt is attached to the buyer handoff. It should report aggregate posture,
  identity, audit, route, and bound evidence without request paths, token
  fingerprints, raw transcript text, session ids, data roots, raw project paths,
  or security-control details.
- The deployed container reports healthy through the image or compose
  healthcheck, and `GET /healthz` returns only `ok` without requiring dashboard
  credentials.
- The base compose service keeps least-privilege runtime settings enabled:
  read-only root filesystem, all capabilities dropped, no-new-privileges,
  read-only Claude mounts, writable `/app/.cache`, and bounded `/tmp` tmpfs.
- HTTP listener timeouts (`DASHBOARD_REQUEST_TIMEOUT_MS`,
  `DASHBOARD_HEADERS_TIMEOUT_MS`, `DASHBOARD_KEEP_ALIVE_TIMEOUT_MS`, and
  `DASHBOARD_SOCKET_TIMEOUT_MS`) match the organization's proxy and slow-client
  policy without disabling app-level backstops.
- The server-scale receipt target (`DASHBOARD_SCALE_SESSIONS`,
  `DASHBOARD_SCALE_TURNS`, `DASHBOARD_SCALE_PROJECTS`,
  `DASHBOARD_SCALE_USERS`, `DASHBOARD_SCALE_TEAMS`, timing budgets, retained
  heap/RSS growth budgets, and dataset byte budget) matches the buyer's pilot
  corpus and expected growth.
- Auth is enabled and no unauthenticated live data route returns organization
  data.
- Static raw bearer secrets are absent or explicitly accepted for a short pilot.
- Token fingerprints and JWT signing keys are valid; malformed fingerprints fail
  closed as configuration errors, and JWT RSA signing keys meet the configured
  bit floor.
- Static principal config uses exactly one source (`DASHBOARD_AUTH_TOKENS_FILE`
  or `DASHBOARD_AUTH_TOKENS`), fits within `DASHBOARD_AUTH_TOKENS_MAX_BYTES`
  and `DASHBOARD_AUTH_TOKENS_MAX_ENTRIES`, and large organization deployments
  use JWTs instead of a large static bearer roster.
- Browser sessions use the server-issued HttpOnly `SameSite=Strict` cookie from
  `POST /api/auth/session`; exactly one of `DASHBOARD_AUTH_SESSION_SECRET` or
  `DASHBOARD_AUTH_SESSION_SECRET_FILE` is configured and stable across
  restarts/replicas, `DASHBOARD_AUTH_SESSION_EPOCH` is documented as the
  logout-all revocation switch, any `DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET` or
  `DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET_FILE` is temporary, decrypt-only, and
  removed after the rotation window, file-backed secrets use an absolute
  read-only in-container path, cookie lifetime is bounded by
  `DASHBOARD_AUTH_SESSION_MAX_AGE_SECONDS`, and HTTPS deployments set
  `DASHBOARD_AUTH_SESSION_COOKIE_SECURE=true`.
- Any raw static roster token and `DASHBOARD_ADMIN_TOKEN` bootstrap credential
  fit within `DASHBOARD_AUTH_MAX_BEARER_BYTES`.
- Principal identifiers and display metadata fit within
  `DASHBOARD_AUTH_PRINCIPAL_FIELD_MAX_CHARS`.
- Principal scope sources and lists fit within
  `DASHBOARD_AUTH_SCOPE_SOURCE_MAX_BYTES`,
  `DASHBOARD_AUTH_SCOPE_MAX_ENTRIES`, and `DASHBOARD_AUTH_SCOPE_MAX_CHARS`.
- Admin organization responses fit within
  `DASHBOARD_ORGANIZATION_RESPONSE_MAX_BYTES` after roster paging, team rollup,
  posture, and audit summary assembly.
- Optional server audit responses fit within `DASHBOARD_AUDIT_RESPONSE_MAX_BYTES`
  before compression when server-side judge audits are enabled.
- Optional server audit judge fanout fits within
  `DASHBOARD_AUDIT_MAX_JUDGE_CALLS` for each `/api/audit.json` request.
- Optional server audit judge responses fit within
  `DASHBOARD_AUDIT_MAX_OUTPUT_TOKENS` for each Anthropic message call.
- Optional server audit input transforms fit within
  `DASHBOARD_AUDIT_INPUT_MAX_ROWS` per dataset array.
- Server LLM egress is registered in `src/lib/llm-registry.ts`, routed through
  `callAnthropic()`, and covered by the CI `gate:llm-egress` check so new
  server call sites cannot bypass the chokepoint silently.
- Any `publiclyReachable: true` LLM registry entry has a security release-gate
  sign-off receipt with `npm run gate:llm-egress` output, and multi-tenant
  exposure also has
  `DASHBOARD_LLM_PUBLIC_EXPOSURE_MODE=multi-tenant npm run gate:llm-egress`
  output.
- Registered server audit egress runs `egressScrub()` before a Console-key call.
  The scrub mode is `redact` — a transmission-grade local redactor that strips
  API keys, bearer/OAuth tokens, JWTs, absolute home paths, emails, and env-style
  secret assignments from the prompt before egress. The enterprise audit log
  records the registry id, scrub mode, and input/output byte counts, but not the
  prompt body. The audit-judge path is fail-closed: it refuses to egress unless
  the registered scrub mode is `redact` (a `stub`/identity mode disables the
  feature), so a misconfiguration cannot leak unredacted transcript content.
- Every principal belongs to the configured organization.
- The admin identity coverage summary shows expected contributor, team, alias,
  and scoped-root coverage and remains redacted; it must not include raw bearer
  tokens, token fingerprints, data roots, transcript text, session ids, or
  project paths.
- Admin/global recommendations resolve explicit task-owner aliases from
  principal metadata, while scoped member/viewer recommendation responses do not
  receive the global identity map.
- The audit activity summary shows expected allowed, denied, rate-limited, and
  role/type counts without exposing request paths, request ids, token
  fingerprints, remote addresses, raw bearer tokens, or transcript content.
- JWT deployments pin issuer and audience, and require an org claim when the IdP
  serves more than one organization or tenant. Configured issuer/audience
  pinning values fit within `DASHBOARD_AUTH_JWT_PINNING_MAX_BYTES`.
- Remote JWKS endpoint config fits within
  `DASHBOARD_AUTH_JWKS_URL_MAX_BYTES`.
- Static and remote JWKS key sets fit within `DASHBOARD_AUTH_JWKS_MAX_BYTES` and
  `DASHBOARD_AUTH_JWKS_MAX_KEYS`, and runtime remote JWKS refresh failures are
  visible in the admin security posture.
- JWT claim paths for org, role, scope, and team fields fit within
  `DASHBOARD_AUTH_JWT_CLAIM_PATH_MAX_BYTES` and
  `DASHBOARD_AUTH_JWT_CLAIM_PATH_MAX_SEGMENTS`.
- JWT deployments cap token lifetime to the organization's approved access-token
  window.
- JWT role maps match the IdP group/role vocabulary exactly; admin access comes
  only from `DASHBOARD_AUTH_JWT_ADMIN_ROLES`, and each role map fits within
  `DASHBOARD_AUTH_JWT_ROLE_MAP_MAX_BYTES` and
  `DASHBOARD_AUTH_JWT_ROLE_MAP_MAX_ENTRIES`. Individual role labels fit within
  `DASHBOARD_AUTH_JWT_ROLE_MAP_ENTRY_MAX_CHARS`, and per-token role claim lists
  fit within `DASHBOARD_AUTH_JWT_ROLE_CLAIM_MAX_VALUES`.
- Member/viewer principals either have scoped data roots or cannot read live
  session data.
- JWT data-root templates fit within
  `DASHBOARD_AUTH_JWT_DATA_ROOT_TEMPLATE_MAX_BYTES`.
- Scoped member/viewer data roots are constrained by
  `DASHBOARD_AUTH_DATA_ROOT_BASE` in production, including symlink escape
  checks for existing roots.
- Scope enforcement is enabled when the IdP can supply route scopes.
- HTTPS, private tunnel, or loopback-only exposure is verified; HSTS is enabled
  at the app when TLS terminates at a trusted proxy.
- Forwarded client headers are enabled only behind exact
  `DASHBOARD_TRUSTED_PROXY_ADDRESSES` peers; the proxy allowlist fits within
  `DASHBOARD_TRUSTED_PROXY_ADDRESSES_MAX_BYTES` and
  `DASHBOARD_TRUSTED_PROXY_ADDRESSES_MAX_ENTRIES`.
- Reverse-proxied or private-tunnel write actions have exact
  `DASHBOARD_ALLOWED_ORIGINS` entries for the browser origins users open. The
  entries are origins only; path/query/credential typos are ignored and flagged
  in posture. The config also fits within `DASHBOARD_ALLOWED_ORIGINS_MAX_BYTES`
  and `DASHBOARD_ALLOWED_ORIGINS_MAX_ENTRIES`.
- Enterprise auth and API rate-limit buckets are non-zero unless an approved
  maintenance window has accepted the action-required posture item.
- Sessions manifest enumeration cap (`DASHBOARD_SESSIONS_MANIFEST_MAX_ENTRIES`)
  matches the largest expected top-level transcript list while bounding response
  assembly for large mounted history trees.
- Raw history/transcript download bounds (`DASHBOARD_RAW_FILE_MAX_BYTES` and
  `DASHBOARD_RAW_SESSION_MAX_PARTS`) match the organization's expected largest
  transcript and subagent fanout while still preventing one raw read from
  dominating memory.
- Lazy transcript response bounds (`DASHBOARD_TRANSCRIPT_DECOMPRESS_MAX_BYTES`)
  match the largest expected assistant transcript drill-in while preventing
  compressed BLOBs from inflating without limit.
- Dataset ingest bounds (`DASHBOARD_INGEST_PROJECT_MAX_DIRS`,
  `DASHBOARD_INGEST_SESSION_DISCOVERY_MAX_ENTRIES`,
  `DASHBOARD_INGEST_SESSION_MAX_BYTES`, and
  `DASHBOARD_INGEST_SESSION_MAX_PARTS`) match the largest expected project
  roster and merged session while preventing one project tree, transcript, or
  subagent fanout from dominating live dataset rebuild memory.
- Live-session polling bounds (`DASHBOARD_LIVE_SESSION_MAX_BYTES`) match the
  largest expected in-flight session while preventing a single active transcript
  from dominating `/api/live` parser memory.
- Configuration artifact bounds (`DASHBOARD_CONFIG_FILE_MAX_BYTES` and
  `DASHBOARD_CONFIG_RESOURCE_MAX_ENTRIES`) match the largest expected settings,
  skill, plugin, config backup, CLAUDE.md, or repo instruction file and
  live-config resource counts while preventing optional config reads from
  dominating dataset rebuild memory.
- Auxiliary artifact bounds (`DASHBOARD_ARTIFACT_FILE_MAX_BYTES` and
  `DASHBOARD_ARTIFACT_DIR_MAX_ENTRIES`) match the largest expected task, team
  inbox, plan, session registry, telemetry, debug log, history, insights,
  stats, shadow-call, or repo-map artifact while preventing optional dataset
  artifacts and parser discovery from dominating rebuild memory.
- Insights status bounds (`DASHBOARD_INSIGHTS_STATUS_REPORT_MAX_ENTRIES`) match
  the expected number of dated `/insights` report rotations while preventing the
  status/regenerate endpoints from walking an unbounded usage-data directory.
- Memory read bounds (`DASHBOARD_MEMORY_FILE_MAX_BYTES`,
  `DASHBOARD_MEMORY_RESPONSE_MAX_BYTES`, `DASHBOARD_MEMORY_MAX_FILES`, and
  `DASHBOARD_MEMORY_DIR_MAX_ENTRIES`) match expected shared memory-file volume
  while preventing on-demand memory reads or directory scans from dominating a
  request.
- Workflow read bounds (`DASHBOARD_WORKFLOW_MANIFEST_MAX_BYTES`,
  `DASHBOARD_WORKFLOW_RUN_MAX_ENTRIES`,
  `DASHBOARD_WORKFLOW_PHASE_MAX_ENTRIES`,
  `DASHBOARD_WORKFLOW_PROGRESS_MAX_ENTRIES`, and
  `DASHBOARD_WORKFLOW_FIELD_MAX_CHARS`) match expected workflow ledger volume
  while preventing per-run projected arrays or long manifest fields from
  dominating request or ingest memory.
- Serialized response and cache bounds (`DASHBOARD_DATASET_RESPONSE_MAX_BYTES`,
  `DASHBOARD_RECOMMENDATIONS_RESPONSE_MAX_BYTES`,
  `DASHBOARD_AUDIT_RESPONSE_MAX_BYTES`, and
  `DASHBOARD_ARTIFACT_CACHE_JSON_MAX_BYTES`) match the organization's expected
  largest live dataset, recommendation body, optional audit body, and
  per-artifact parsed payload while preventing one tenant corpus from dominating
  response memory or durable SQLite cache rows.
- Signature walk bounds (`DASHBOARD_SIGNATURE_TREE_MAX_ENTRIES` and
  `DASHBOARD_REPO_MAP_ARTIFACT_MAX_ENTRIES`) match the largest expected
  optional artifact trees and repo-map corpus while preventing cache
  invalidation from statting unbounded tenant files before serving a request.
- Memory read bounds (`DASHBOARD_MEMORY_FILE_MAX_BYTES`,
  `DASHBOARD_MEMORY_RESPONSE_MAX_BYTES`, and `DASHBOARD_MEMORY_MAX_FILES`) match
  the organization's expected agent memory size while preventing one request
  from loading unbounded markdown or file lists.
- Workflow manifest and run-ledger bounds
  (`DASHBOARD_WORKFLOW_MANIFEST_MAX_BYTES` and
  `DASHBOARD_WORKFLOW_RUN_MAX_ENTRIES`) match the organization's expected
  run-ledger size while preventing embedded logs, results, discovery entries, or
  unbounded run lists from dominating request memory.
- Recommendation response cache cardinality
  (`DASHBOARD_RECOMMENDATIONS_CACHE_MAX_ENTRIES`) matches expected concurrent
  global and project-filtered consumers without allowing user-controlled
  filters to grow in-process cache state without bound.
- Audit log path, read cap, per-line cap, rotation size, and retained file count
  match the organization's compliance window and log pipeline.
- Gateway or proxy rate limits exist in front of any multi-node deployment, with the app's address-keyed invalid-token throttle treated as a node-local backstop.
- Mutating JSON body limits remain small enough for expected policy and adoption
  receipt writes.
- Usage credential bounds (`DASHBOARD_USAGE_CREDENTIAL_MAX_BYTES`) match the
  expected Claude OAuth credential file while preventing optional usage-gauge
  token discovery from parsing unbounded JSON.
- Server LLM egress remains disabled unless the organization has approved the
  exact credential and data path; enabled server judge audits use a
  registered Console-key path plus finite `DASHBOARD_AUDIT_MAX_JUDGE_CALLS`
  request budget, `DASHBOARD_AUDIT_MAX_OUTPUT_TOKENS` per-call output cap, and
  `DASHBOARD_AUDIT_INPUT_MAX_ROWS` pre-judge row cap. Operators set Anthropic
  Console workspace spend limits before enabling `ANTHROPIC_API_KEY` on the
  server.
- Custom CSP overrides have been reviewed for `connect-src`, `script-src`,
  `object-src`, `base-uri`, and `frame-ancestors`, and fit within
  `DASHBOARD_CONTENT_SECURITY_POLICY_MAX_BYTES`.

## Known Follow-On Work

- Full OIDC browser redirect login and IdP-initiated logout.
- Durable organization/user/team storage and admin-managed seat lifecycle.
- IdP directory synchronization and group-to-team mapping beyond JWT claims.
- Distributed rate limiting and centralized audit export for multi-node fleets.
- Third-party penetration test and customer-specific deployment hardening review
  for a regulated-production sale.
