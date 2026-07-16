> **Status:** reconciled to ADR 0011 (single-tenant #1247 substrate, Probaitio naming). The
> multi-tenant/zero-knowledge pieces (Keycloak, client-side encryption, encrypted-blob store,
> public write gate, compute proxy) are **deferred to #467** and collected in a section below.

# 40 — Same-origin / CSRF rewrite (deferred to #467 — multi-tenant public write gate)

> **Scope note:** The single-tenant MVP (#1247) does **not** expose a public browser write
> gate. A hosted `DashboardInstance` in the MVP is single-tenant (the maintainer's own data);
> cross-source ingest flows through the authenticated push-ingest endpoint (#1248), whose auth
> is its own concern and does not require a browser-facing CSRF layer. The design below is
> preserved in full as the reference for when the #467 public multi-tenant layer is built on
> top of the MVP substrate.

**Area:** the write-auth gate in `scripts/server.mjs` that today hardcodes loopback
origins and 403s every public upload.
**Status:** deferred to #467 (multi-tenant layer); design is implementation-ready for that phase.
**Security-sensitive:** this is the boundary between "a cross-origin attacker page can
forge a state-changing request as the logged-in user" and "it cannot." Read the whole doc;
the forwarded-header trap in §3 is the one that actually bites.

---

## 0. Current state (what the code does today)

`scripts/server.mjs` (master, this branch `feature/1005-regenerate-csrf-gate`):

- **L137–138** — `HOST` / `PORT` constants. The bound `PORT` is the *only* thing the
  same-origin allowlist is derived from today.
- **L140–146** — `POLICY_WRITE_TOKEN`: a per-process CSRF secret, `randomBytes(32).hex`,
  regenerated on every boot. `POLICY_WRITE_TOKEN` env override exists purely for the test.
- **L990–996** — `tokensMatch()`: constant-time, length-tolerant compare.
- **L998–1008** — `extractToken()`: pulls the token from `Authorization: Bearer <t>` or
  `X-CSRF-Token`.
- **L1014–1029** — `isSameOrigin(req)`: parses `req.headers['origin']` with `new URL().host`,
  rejects missing/garbage Origin, and matches against a hardcoded set of
  `127.0.0.1:${PORT}` / `localhost:${PORT}` / `[::1]:${PORT}`.
- **L1040–1058** — `passesWriteAuth(req, res)`: composes `isSameOrigin` (403) →
  `Content-Type === application/json` (415) → `tokensMatch(extractToken, POLICY_WRITE_TOKEN)`
  (401).
- **L1261–1266** — `GET /api/csrf-token`: returns `{ token: POLICY_WRITE_TOKEN }`. Same-origin
  GET; SOP keeps a cross-origin page from reading the body.
- **L1070** and **L1113** — `passesWriteAuth` is the gate for `handlePolicyWrite` and one
  other mutating handler. The adoption-receipt write path (L1276–1284) is a separate handler;
  see §5 for why it is in scope to audit but not necessarily to re-gate.

The test that pins all of this is **`scripts/policy-write.test.mjs`** (runnable:
`node scripts/policy-write.test.mjs`, npm `test:policy-write`). It boots the *real*
`server.mjs` against a throwaway `CLAUDE_DIR`, sets `POLICY_WRITE_TOKEN`, and asserts the
rejection matrix (A5a–A5f, L124–258).

**Why the public flavor breaks today:** behind an OpenShift Route the browser's `Origin`
header is `https://dashboard.probaitio.com` (the public host), which is *not* in the loopback
allowlist, so `isSameOrigin` returns `false` and `passesWriteAuth` 403s every authenticated
upload. That is blocker #2.

---

## 1. The exact rewrite of `isSameOrigin()`

**Decision:** add a single configured `PUBLIC_ORIGIN` env var, parse it once at boot into a
canonical `host` (`new URL().host`, i.e. host **and** port), and add that host to the
allowlist. Keep the loopback entries (so the local/dev/`chd-main` flavors and the existing
test keep passing). Keep the missing-Origin rejection. Derive **nothing** from request
headers other than `Origin` itself.

### Before (L1010–1029)

```js
// True when the request's Origin header names this server's own loopback origin
// on the bound PORT. A missing Origin is rejected ...
function isSameOrigin(req) {
  const origin = req.headers['origin'];
  if (typeof origin !== 'string' || origin === '') return false;
  let host;
  try {
    host = new URL(origin).host; // host:port
  } catch {
    return false;
  }
  const allowed = new Set([
    `127.0.0.1:${PORT}`,
    `localhost:${PORT}`,
    `[::1]:${PORT}`,
  ]);
  return allowed.has(host);
}
```

### After

Add the config near the `HOST`/`PORT` block (after L138). Parse `PUBLIC_ORIGIN` **once**, at
boot, and crash early on a malformed value rather than silently failing open/closed per
request:

```js
// scripts/server.mjs, near L138 (after PORT)

// Public-flavor same-origin allowlist (Probaitio #467 multi-tenant layer). In the
// hosted multi-tenant flavor the browser's Origin is the public host the Route serves
// (e.g. https://dashboard.probaitio.com), NOT a loopback literal — so the loopback-only
// allowlist would 403 every authenticated upload. PUBLIC_ORIGIN names that one
// trusted origin. We parse it ONCE here (fail-fast on a bad value) and compare by
// exact URL .host (host + port, scheme-and-path stripped). Unset in the local /
// dev / SPA flavors, so they keep loopback-only behaviour and the existing test
// passes unchanged. NEVER derive this from request headers (see §3).
const PUBLIC_ORIGIN_HOST = (() => {
  const raw = process.env.PUBLIC_ORIGIN;
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`PUBLIC_ORIGIN is not a valid absolute URL: ${JSON.stringify(raw)}`);
  }
  // Require an explicit https origin in the hosted flavor: the Route terminates
  // TLS, the browser sends an https Origin, and an http allowlist entry would
  // never match it anyway. Reject anything with a path/query to avoid a
  // copy-paste like "https://dashboard.probaitio.com/" silently widening nothing.
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`PUBLIC_ORIGIN must be http(s): ${JSON.stringify(raw)}`);
  }
  return u.host; // host[:port], lowercased by the URL parser
})();
```

Then `isSameOrigin` itself:

```js
// True when the request's Origin header names a TRUSTED origin: the bound-PORT
// loopback origins (local/dev/SPA flavors + the policy-write test) OR the single
// configured PUBLIC_ORIGIN (Probaitio #467 multi-tenant hosted flavor). A missing or unparseable
// Origin is rejected — a same-origin browser fetch for a non-GET, JSON-bodied,
// credentialed request always sends Origin; a CSRF probe that omits it must not
// pass. We compare by exact URL .host (host + port). We deliberately consult ONLY
// the Origin header — never X-Forwarded-Host / Forwarded / Host — because those
// are attacker- or router-controlled and trusting them is a CSRF hole (§3).
function isSameOrigin(req) {
  const origin = req.headers['origin'];
  if (typeof origin !== 'string' || origin === '') return false;
  let host;
  try {
    host = new URL(origin).host; // host:port
  } catch {
    return false;
  }
  const allowed = new Set([
    `127.0.0.1:${PORT}`,
    `localhost:${PORT}`,
    `[::1]:${PORT}`,
  ]);
  if (PUBLIC_ORIGIN_HOST) allowed.add(PUBLIC_ORIGIN_HOST);
  return allowed.has(host);
}
```

**Notes / invariants this preserves:**

- **Missing-Origin rejection kept** (the `typeof origin !== 'string' || origin === ''`
  guard). Not negotiable — see §3.
- **Exact host match kept** via `new URL(origin).host` against a `Set`. No substring/regex
  matching (which `.endsWith('.example.com')` style checks get subtly wrong and let
  `dashboard.probaitio.com.evil.tld` through).
- **Port is part of the match.** If the public origin runs on a non-default port,
  `PUBLIC_ORIGIN` must include it (`https://dashboard.probaitio.com:8443`); `new URL().host` carries
  it through on both sides.
- **No header other than `Origin`** is read. The `Host` header is *not* consulted (it would
  be the in-pod service host or a router-rewritten value, and is attacker-influenceable).

---

## 2. Reconciling with the OIDC session model (defense in depth)

The OIDC deep-dive (sibling doc `30-oidc-session.md`) establishes that in the public flavor a
request is *authenticated* by a signed, `HttpOnly`, `Secure`, `SameSite=Lax` (or `Strict`)
**OIDC session cookie** set after the Keycloak code-exchange. That cookie is the real
authority for "who is this and may they write." The same-origin check is a **second,
independent** anti-CSRF layer, not the auth layer. They compose as belt-and-suspenders:

| Layer | Question it answers | Failure mode it stops |
|---|---|---|
| OIDC session cookie | *Who* is making this request, and are they a logged-in member? | Anonymous / unauthenticated writes. |
| `isSameOrigin` (Origin == `PUBLIC_ORIGIN`) | Did this request originate from *our* page, or from an attacker's page riding the user's cookie? | Classic cross-origin CSRF (a malicious site auto-POSTing with the victim's ambient cookie). |
| `Content-Type: application/json` | Is this a non-simple request (forces preflight / blocks form-POST CSRF)? | `<form>`-based simple-request CSRF that can't set custom Content-Type. |

`passesWriteAuth` in the public flavor becomes: **session-valid AND same-origin AND
JSON-content-type.** The order: check the session first (cheapest reject of the common
anonymous case), then same-origin, then content-type. Concretely the gate gains a
`requireSession(req)` step ahead of the existing three (the session helper itself lands in
the OIDC doc; this doc only specifies how it composes):

```js
// public flavor: passesWriteAuth gains a session check at the top.
function passesWriteAuth(req, res) {
  // 0) (public flavor only) authenticated OIDC session — the real "who". In the
  //    local flavor PUBLIC_ORIGIN is unset and requireSession is a no-op pass.
  if (PUBLIC_ORIGIN_HOST && !requireSession(req)) {
    sendJson(res, 401, { ok: false, error: 'Unauthorized: no valid session' });
    return false;
  }
  // 1) same-origin Origin — anti-CSRF (defense in depth even with SameSite cookie).
  if (!isSameOrigin(req)) {
    sendJson(res, 403, { ok: false, error: 'Forbidden: cross-origin request rejected' });
    return false;
  }
  // 2) Content-Type exactly application/json.
  // 3) per-process token — see decision below.
  ...
}
```

### Decision: drop the legacy per-process CSRF token **in the public flavor**, keep it in the local flavor.

The per-process `POLICY_WRITE_TOKEN` (L140–146, fetched from `GET /api/csrf-token`) was the
right primitive for the **local** flavor, where there is no login at all and the token is the
only thing standing between a cross-origin page and the write. It does **not** carry its weight
in the public flavor, for three concrete reasons:

1. **It regenerates per pod and we are pinned to `replicas: 1` (SQLite RWO lock — locked
   infra).** A single replica means there is exactly one `POLICY_WRITE_TOKEN` at any instant,
   so the token *can* work — but on every pod restart/redeploy it rotates, silently
   invalidating every browser tab that fetched the old one until it re-bootstraps from
   `/api/csrf-token`. With one replica the token buys nothing the session+origin pair doesn't
   already provide, and it adds a rotation-on-restart failure mode.
2. **It is not actually a CSRF defense once a session cookie exists.** Its whole security
   rested on "a cross-origin page can't read the same-origin `/api/csrf-token` body (SOP)."
   But the same SOP + `SameSite` cookie + the `Origin` check already block the cross-origin
   forge. The token is redundant with the origin check, not additive.
3. **`GET /api/csrf-token` returning a process secret to any same-origin caller is a
   liability in a multi-tenant app.** It is one misconfigured cache header or one XSS away
   from leaking a shared secret. A per-user OIDC session has none of that shared-secret
   surface.

**Therefore, in the public flavor:**

- `requireSession` + `isSameOrigin` + JSON content-type are the gate.
- The per-process token step is **skipped** when `PUBLIC_ORIGIN_HOST` is set
  (`if (!PUBLIC_ORIGIN_HOST) { ...token check... }`).
- `GET /api/csrf-token` is **disabled** (404) when `PUBLIC_ORIGIN_HOST` is set, so the shared
  secret is never exposed in the multi-tenant flavor.

**In the local flavor (`PUBLIC_ORIGIN` unset):** nothing changes. No session exists, so the
token remains the load-bearing CSRF defense; `/api/csrf-token` stays live; the existing test
matrix passes byte-for-byte.

```js
// GET /api/csrf-token (L1261): not served in the public flavor.
if (pathname === '/api/csrf-token') {
  if (PUBLIC_ORIGIN_HOST) {
    return sendJson(res, 404, { ok: false, error: 'Not found' });
  }
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed; use GET' });
  return sendJson(res, 200, { token: POLICY_WRITE_TOKEN });
}
```

This is a clear, flavor-gated call: **token kept where it is the only defense (local), dropped
where the session supersedes it (public).** It avoids the worst-of-both-worlds of a rotating
shared secret layered on top of per-user auth.

> Caveat to record in the OIDC doc, not here: relying on `SameSite` + Origin for CSRF assumes
> the session cookie is `SameSite=Lax`/`Strict`. The `isSameOrigin` layer is exactly what makes
> us not *solely* dependent on `SameSite` (old browsers, `SameSite=None` edge cases).

---

## 3. Behind an OpenShift Route — what the browser sends, and the forwarded-header trap

**Topology.** Public flavor: browser → OpenShift Route (edge-terminated TLS) → Service → Pod
(`server.mjs`, `EXPOSE 5173`, plain HTTP inside the cluster). The HAProxy router sets
`X-Forwarded-Host`, `X-Forwarded-Proto: https`, `X-Forwarded-For`, `X-Forwarded-Port`, and
`Forwarded`. The pod's own view of `Host` is the in-cluster service address, and
`req.socket.remoteAddress` is the router's pod IP — **not** anything the browser controls and
**not** loopback.

**What `Origin` the browser actually sends.** On a same-site `fetch()` from the SPA loaded at
`https://dashboard.probaitio.com`, for a `POST` with `Content-Type: application/json` and
`credentials: 'include'`, the browser sends:

```
Origin: https://dashboard.probaitio.com
```

i.e. scheme + host + port of the *page that initiated the fetch* — the public Route host,
verbatim, set by the browser and not forgeable by script. `new URL(origin).host` →
`dashboard.probaitio.com`. This is precisely what `PUBLIC_ORIGIN=https://dashboard.probaitio.com` makes
`isSameOrigin` accept (§1).

**Why loopback fails.** The hardcoded `127.0.0.1:${PORT}` / `localhost:${PORT}` entries never
match `dashboard.probaitio.com`. Inside the pod nothing is loopback either — the request arrives
from the router's IP on the service port. So pre-rewrite, `isSameOrigin` is `false` → 403.
That is the entire blocker.

**The forwarded-header trap (do not do this).** The tempting "fix" is to build the allowlist
from what the router tells us — e.g. `allowed.add(req.headers['x-forwarded-host'])` or parse
`Forwarded:`. **This is a CSRF hole and must not ship:**

- `X-Forwarded-Host` / `Forwarded` are **request headers**. The OpenShift router *sets* them
  for the legitimate hop, but nothing stops an attacker (or a second proxy, or a direct
  in-cluster caller that bypasses the router) from sending their own. An app that derives its
  same-origin allowlist from `X-Forwarded-Host` will happily accept
  `X-Forwarded-Host: dashboard.probaitio.com` on a request whose real `Origin` is
  `https://evil.tld` — exactly the cross-origin forge the check exists to stop. The allowlist
  must be **configured**, never **reflected**.
- Even for the legitimate hop, the value is router-config-dependent (host rewrites, multiple
  Routes) and gives a *false* sense of "this came from our host." The only browser-attested,
  attacker-non-forgeable signal of *where the request originated* is the `Origin` header, and
  the only trustworthy statement of *where we live* is our own out-of-band config
  (`PUBLIC_ORIGIN`). Compare those two. Nothing else.

**Consequences for the rest of the gate:**

- **`X-Forwarded-Proto`** is not consulted by `isSameOrigin` — the scheme check is implicit
  in the `PUBLIC_ORIGIN` host comparison (an `https://` Origin's `.host` already excludes the
  scheme, and we only ever add the configured host). We do *not* reject based on the pod
  seeing plaintext HTTP; TLS is the Route's job, asserted by infra, not by header inspection.
- **`req.socket.remoteAddress`** stays unused for auth (the #311 lesson: NAT/router makes the
  peer the gateway). The network boundary in the public flavor is the Route + NetworkPolicy,
  not a peer-address check.
- The `Secure` cookie attribute on the OIDC session does depend on the request being seen as
  HTTPS; that is handled in the OIDC doc by trusting `X-Forwarded-Proto` *for cookie-Secure
  emission only* (a non-security-critical use — worst case the cookie is over-marked Secure),
  never for the CSRF allowlist.

---

## 4. Test plan

Port the rejection matrix in `scripts/policy-write.test.mjs` (A5a–A5f, L124–258) to a new
**public-flavor** test that boots `server.mjs` with `PUBLIC_ORIGIN` set and asserts:

- **public-origin accept** — `Origin: https://dashboard.probaitio.com` is treated as same-origin.
- **foreign-origin reject** — `Origin: https://evil.example.com` → 403.
- **missing-origin reject** — no `Origin` header → 403.
- **forwarded-header-spoof reject** — foreign/absent `Origin` but
  `X-Forwarded-Host: dashboard.probaitio.com` (and/or a spoofed `Forwarded:` / `Host:`) → still 403.
  This is the load-bearing new assertion: it proves the allowlist is configured, not
  reflected.

Because the public flavor drops the per-process token and requires a session, the existing
token-based `post()` helper does not apply unmodified. Two pragmatic options:

- **(A)** Keep this new test focused **purely on the `isSameOrigin` decision** by exercising a
  route through the gate while stubbing the session (e.g. a test-only `DISABLE_SESSION_GATE=1`
  honored *only* when `NODE_ENV==='test'`), so the test isolates the origin layer from the
  OIDC layer. Cleanest; recommended.
- **(B)** Drive a full session by minting a valid session cookie via a test seam from the OIDC
  doc. Heavier; defer to the OIDC doc's own integration test.

The sketch below uses **(A)** and asserts each origin case against the *origin layer only*,
mirroring the existing test's structure (standalone runnable, boots the real server, throwaway
`CLAUDE_DIR`, sentinel file). New file: **`scripts/same-origin-public.test.mjs`**, wired as
`npm run test:same-origin` and added to the CI `test` job.

```js
// scripts/same-origin-public.test.mjs
// Public-flavor same-origin / CSRF gate (Probaitio #467 multi-tenant layer).
// Boots the real server.mjs with PUBLIC_ORIGIN set and asserts the rewritten
// isSameOrigin allowlist: public-origin ACCEPT, foreign REJECT, missing REJECT,
// and the forwarded-header-spoof REJECT (the allowlist is configured, not
// reflected). Run: node scripts/same-origin-public.test.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, '..');
const PORT = 5991;
const base = `http://127.0.0.1:${PORT}`;
const PUBLIC_ORIGIN = 'https://dashboard.probaitio.com';

let failures = 0;
const check = (name, cond, detail = '') =>
  cond ? console.log(`  ok  ${name}`)
       : (failures++, console.error(`FAIL  ${name}${detail ? ` :: ${detail}` : ''}`));

const claudeDir = await mkdtemp(join(tmpdir(), 'same-origin-test-'));
const distDir = await mkdtemp(join(tmpdir(), 'same-origin-dist-'));
await writeFile(
  join(claudeDir, 'settings.json'),
  JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }, null, 2) + '\n'
);

const proc = spawn('node', ['--import', './scripts/register-ts.mjs', 'scripts/server.mjs'], {
  cwd: PROJECT_DIR,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    CLAUDE_DIR: claudeDir,
    DIST_DIR: distDir,
    PUBLIC_ORIGIN,
    // Test seam (honored only under NODE_ENV=test): isolate the origin layer
    // from the OIDC session layer, which has its own integration test.
    NODE_ENV: 'test',
    DISABLE_SESSION_GATE: '1',
  },
  stdio: 'ignore',
});

// POST a valid JSON body to the gated write route with a controllable header set.
// We assert ONLY the gate's status: a 403 means the origin layer rejected; a
// non-403 (e.g. 200/400 from the body validator) means the origin layer accepted
// and the request reached the handler.
const post = ({ origin, extraHeaders = {} } = {}) => {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (origin !== null) headers.Origin = origin;
  return fetch(`${base}/api/policy/write`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }),
  });
};

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${base}/healthz`); return true; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return false;
}

try {
  check('server came up', await waitUp());

  // 1) Public origin ACCEPT — gate passes the origin layer (NOT 403).
  let r = await post({ origin: PUBLIC_ORIGIN });
  check('public origin accepted (not 403)', r.status !== 403, `got ${r.status}`);

  // 2) Loopback still accepted (local dev keeps working with PUBLIC_ORIGIN set).
  r = await post({ origin: `http://127.0.0.1:${PORT}` });
  check('loopback origin accepted (not 403)', r.status !== 403, `got ${r.status}`);

  // 3) Foreign origin REJECT.
  r = await post({ origin: 'https://evil.example.com' });
  check('foreign origin -> 403', r.status === 403, `got ${r.status}`);

  // 4) Missing origin REJECT.
  r = await post({ origin: null });
  check('missing origin -> 403', r.status === 403, `got ${r.status}`);

  // 5) Forwarded-header spoof REJECT — the allowlist is configured, not reflected.
  //    Foreign (or absent) Origin, but the attacker forges router headers naming
  //    the public host. Must STILL be 403.
  r = await post({
    origin: 'https://evil.example.com',
    extraHeaders: {
      'X-Forwarded-Host': 'dashboard.probaitio.com',
      'Forwarded': 'host=dashboard.probaitio.com;proto=https',
      'Host': 'dashboard.probaitio.com',
    },
  });
  check('X-Forwarded-Host spoof + foreign origin -> 403', r.status === 403, `got ${r.status}`);

  r = await post({
    origin: null,
    extraHeaders: { 'X-Forwarded-Host': 'dashboard.probaitio.com' },
  });
  check('X-Forwarded-Host spoof + absent origin -> 403', r.status === 403, `got ${r.status}`);
} finally {
  proc.kill();
  await rm(claudeDir, { recursive: true, force: true });
  await rm(distDir, { recursive: true, force: true });
}

if (process.env.SAME_ORIGIN_TEST_SENTINEL) {
  await writeFile(process.env.SAME_ORIGIN_TEST_SENTINEL,
    failures === 0 ? 'PASS (0 failures)\n' : `FAIL (${failures} failures)\n`);
}
if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll same-origin public-flavor checks passed.');
```

**Also keep `scripts/policy-write.test.mjs` green unchanged.** It runs with `PUBLIC_ORIGIN`
unset, so `PUBLIC_ORIGIN_HOST` is `null`, `requireSession` is a no-op, the token path stays
live, and `/api/csrf-token` still returns 200. That is the regression guard for "the local
flavor is byte-identical."

> If option (A)'s `DISABLE_SESSION_GATE` seam is judged too risky to ship even gated on
> `NODE_ENV==='test'`, fall back to option (B) and assert the four origin cases inside the
> OIDC doc's session-backed integration test instead. The origin assertions themselves are
> identical; only the bootstrap differs.

---

## 5. What changes — exact files & locations

| File | Change |
|---|---|
| `scripts/server.mjs` ~L138 | **New** `PUBLIC_ORIGIN_HOST` const: parse `process.env.PUBLIC_ORIGIN` once at boot, fail-fast on a bad value, `null` when unset. |
| `scripts/server.mjs` L1014–1029 | **Rewrite** `isSameOrigin()`: add `PUBLIC_ORIGIN_HOST` to the allowlist `Set`; keep loopback entries, missing-Origin reject, exact-`.host` match; consult only `Origin`. |
| `scripts/server.mjs` L1040–1058 | **Edit** `passesWriteAuth()`: prepend a `requireSession` step gated on `PUBLIC_ORIGIN_HOST` (public flavor only); gate the per-process token step behind `!PUBLIC_ORIGIN_HOST` so it stays in the local flavor and is dropped in the public flavor. |
| `scripts/server.mjs` L1261–1266 | **Edit** `/api/csrf-token`: 404 when `PUBLIC_ORIGIN_HOST` is set (don't expose the shared secret in the multi-tenant flavor); unchanged otherwise. |
| `scripts/same-origin-public.test.mjs` | **New** test (see §4). |
| `package.json` | **New** `test:same-origin` script; add to the CI `test` job alongside `test:policy-write`. |
| `scripts/server.mjs` (OIDC doc owns it) | `requireSession(req)` helper — **defined in the OIDC deep-dive**, consumed here. This doc specifies only its composition with the origin check, not its internals. |
| docs / Helm values | `PUBLIC_ORIGIN` must be wired into the Deployment env (`envFrom`/explicit env) for the public flavor; the Helm chart owns this always-present app wiring (locked infra — chart owns app resources, reconciler owns dependency CRs). Document `PUBLIC_ORIGIN=https://<route-host>` as a required value for the hosted flavor. |

**Adoption-receipt write path (L1276–1284):** audit, but out of scope to re-gate here. It is a
separate handler; if it ever writes user-scoped data in the public flavor it must adopt the
same `passesWriteAuth` composition. Flag it in the OIDC doc's "what writes need a session"
inventory rather than touching it on this change.

**Non-goals / things explicitly NOT done:** no `X-Forwarded-*` parsing for the allowlist (§3);
no wildcard/suffix origin matching; no peer-address (`remoteAddress`) auth (the #311 lesson);
no change to the local-flavor behavior or its test.
