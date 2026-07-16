> **Status:** reconciled to ADR 0011 (single-tenant #1247 substrate, Probaitio naming). The
> multi-tenant/zero-knowledge pieces (Keycloak OIDC, client-side encryption, encrypted-blob store,
> public write gate, compute proxy) are **deferred to #467** and collected in a section below.

# OpenShift MVP — Dependency-free artifact-blob client + boot-the-image gate

Implementation-ready refinement for the **Probaitio** single-tenant substrate (epic #1247,
OpenShift flavor). Every byte here is **dependency-free**: the server runtime image ships
**zero `node_modules`** (it strips TS in `src/lib/*.ts` via `scripts/register-ts.mjs`,
per ADR 0011 §8). Any `import` that drags an npm package into the boot graph is the #1013
crash-loop. So: the artifact-blob substrate client is a hand-rolled SigV4 signer over
native `fetch` — no `@aws-sdk`, no `jose`, no `openid-client`.

This document covers:
- The `src/lib/s3/sigv4.ts` hand-rolled SigV4 client (the artifact-blob S3 substrate per
  ADR 0011 §1/§8).
- The arbitrary-UID / OpenShift SCC image fix.
- The boot-the-image CI gate (the #1013 guard — now named `image-boot` rather than
  `public-image`).

OIDC, the AES-GCM session cookie, and the public write-auth gate are **deferred to #467**
(multi-tenant) — see the section at the bottom.

---

## 0. Files: what changes, what is new

### New files

| Path | Role | Dep-free? |
| --- | --- | --- |
| `src/lib/s3/sigv4.ts` | Hand-rolled AWS SigV4 signer (canonical request, HMAC signing-key chain, `Authorization` header, `x-amz-content-sha256`) + thin `s3Put`/`s3Get`/`s3List` over native `fetch`. Used by the push-ingest endpoint (#1248) and any server-side blob read. | yes |
| `scripts/image-smoke.test.mjs` | Local + CI assertion that `/healthz` answers and the image carries no `node_modules`. | yes |
| `.github/workflows/image-boot.yml` | CI gate: `docker build` the runtime image, `docker run`, `curl /healthz`, grep for absent `node_modules`. | n/a |

### Existing files edited

- **`scripts/server.mjs`** — adds a dependency-free `GET /healthz` route (before all auth
  gates) so the boot-the-image CI gate can verify the process starts without reaching any
  upstream.
- **`Dockerfile`** — image runs under OpenShift `restricted-v2` SCC: no hardcoded
  `USER`/`runAsUser`; `/app/.cache` is GID-0 group-writable so arbitrary UIDs can write.
  See §2.

All new server code is loaded via the **same dynamic-`import()` register-ts pattern** the
existing server uses for `usage-gauge.ts`, `policy-writer.ts`, etc. (`scripts/server.mjs`
L52-102) — so the `.ts` helpers strip cleanly under
`node --import ./scripts/register-ts.mjs`.

---

## 1. Hand-rolled AWS SigV4 for S3 (PUT / GET / LIST)

This is the artifact-blob substrate client (ADR 0011 §1/§8). It targets the ODF/NooBaa
`ObjectBucketClaim` endpoint or any S3-compatible store (PVC-backed MinIO, R2, etc. — the
blob substrate choice is open per ADR 0011 "Open / deferred"). The OBC injects
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` via its generated Secret, and the
endpoint/bucket via a ConfigMap — all surfaced as env. Path-style addressing
(`{endpoint}/{bucket}/{key}`) because NooBaa/MinIO don't do vhost-style by default.

```ts
// src/lib/s3/sigv4.ts  (~150 lines)
import { createHash, createHmac } from 'node:crypto';

const ENDPOINT = process.env.S3_ENDPOINT!;      // https://s3.openshift-storage.svc
const BUCKET   = process.env.S3_BUCKET!;         // from the OBC ConfigMap
const REGION   = process.env.S3_REGION || 'us-east-1';   // NooBaa ignores but signs
const AK       = process.env.AWS_ACCESS_KEY_ID!;
const SK       = process.env.AWS_SECRET_ACCESS_KEY!;
const SERVICE  = 's3';
const UNSIGNED = 'UNSIGNED-PAYLOAD';

const sha256hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();

// RFC3986 encode, but DON'T encode the path separator for the canonical URI.
function uriEncode(str: string, encodeSlash = true): string {
  let out = '';
  for (const ch of Buffer.from(str, 'utf8').toString('binary')) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else if (ch === '/' && !encodeSlash) out += ch;
    else out += '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

interface SignArgs {
  method: 'PUT' | 'GET' | 'HEAD';
  key?: string;                 // object key (PUT/GET); omitted for LIST
  query?: Record<string, string>;
  payloadHash?: string;         // sha256hex of body, or UNSIGNED
  extraHeaders?: Record<string, string>;
}

function signedRequest({ method, key = '', query = {}, payloadHash = UNSIGNED, extraHeaders = {} }: SignArgs) {
  const url = new URL(ENDPOINT);
  const host = url.host;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');   // 20260611T000000Z
  const dateStamp = amzDate.slice(0, 8);                            // 20260611

  // Canonical path: /{bucket}/{key} path-style, each segment URI-encoded.
  const canonicalUri =
    '/' + uriEncode(BUCKET, false) + (key ? '/' + uriEncode(key, false) : '/');

  // Canonical query string: sorted, encoded.
  const canonicalQuery = Object.keys(query).sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`).join('&');

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v])),
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h].trim()}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest),
  ].join('\n');

  // Signing-key HMAC chain: kSecret -> kDate -> kRegion -> kService -> kSigning.
  const kDate = hmac('AWS4' + SK, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${AK}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const finalUrl = `${ENDPOINT}${canonicalUri}${canonicalQuery ? '?' + canonicalQuery : ''}`;
  return { finalUrl, headers: { ...headers, Authorization: authorization } };
}

// PUT artifact blob (unsigned payload — body is opaque bytes, streamed).
export async function s3Put(key: string, body: Uint8Array, contentType = 'application/octet-stream') {
  const { finalUrl, headers } = signedRequest({
    method: 'PUT', key, payloadHash: UNSIGNED, extraHeaders: { 'content-type': contentType },
  });
  const res = await fetch(finalUrl, { method: 'PUT', headers, body });
  if (!res.ok) throw new Error(`S3 PUT ${res.status}: ${await res.text()}`);
}

export async function s3Get(key: string): Promise<Uint8Array> {
  // GET has no body -> sign the empty-payload hash, not UNSIGNED, for strict S3.
  const { finalUrl, headers } = signedRequest({ method: 'GET', key, payloadHash: sha256hex('') });
  const res = await fetch(finalUrl, { method: 'GET', headers });
  if (!res.ok) throw new Error(`S3 GET ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function s3List(prefix = ''): Promise<string[]> {
  const { finalUrl, headers } = signedRequest({
    method: 'GET', query: { 'list-type': '2', prefix }, payloadHash: sha256hex(''),
  });
  const res = await fetch(finalUrl, { method: 'GET', headers });
  if (!res.ok) throw new Error(`S3 LIST ${res.status}`);
  const xml = await res.text();
  // Minimal <Key>…</Key> scrape — no XML parser dependency.
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
}
```

**`x-amz-content-sha256` decision:** PUT uses `UNSIGNED-PAYLOAD` so we can stream the
artifact blob without buffering it to hash (blobs can be tens of MB). GET and LIST have no
body, so they sign the empty-string SHA-256 (`e3b0c4…`) which some strict S3
implementations require over `UNSIGNED`. Both are header-only on the canonical request —
no chunked-signing complexity, which would pull in far more code. The signer is
`Authorization`-header style (not presigned URL) because all calls are server-to-server
within the cluster.

---

## 2. Arbitrary-UID / OpenShift SCC image fix

The runtime image must boot under OpenShift `restricted-v2` SCC, which assigns an
arbitrary UID from the namespace's UID range at pod scheduling time. The Dockerfile must
not hardcode `USER` or `runAsUser`, and any writable path the process needs must be
group-writable by GID 0:

```dockerfile
# In the runtime stage of Dockerfile (or Dockerfile.probaitio):
RUN mkdir -p /app/.cache && chown -R 0:0 /app && chmod -R g+rwX /app
# No USER instruction — OpenShift assigns UID at admission.
```

This means `node -e 'process.getuid()'` will print an unpredictable UID, but GID is
always 0, so the `/app/.cache` path (used by register-ts for TS transpile caching) is
always writable. The boot-the-image CI gate (§3) validates this path by running the image
without `--user` (simulating OpenShift's arbitrary-UID assignment).

---

## 3. Boot-the-image CI gate

A new job `image-boot` in `.github/workflows/image-boot.yml`, sitting alongside `test`
and `spa-boundary`. It builds the runtime image, runs it with a stub env (`/healthz`
must answer **without** any upstream — it only proves the process boots and serves),
curls `/healthz`, and greps the image filesystem to prove **no `node_modules`** rode in
(the #1013 guard).

`scripts/server.mjs` adds a dependency-free liveness route:

```js
// in the route table, before any auth or data gates:
if (pathname === '/healthz') return sendJson(res, 200, { ok: true });
```

```yaml
# .github/workflows/image-boot.yml
name: Image boot gate
on:
  pull_request:
    types: [opened, synchronize, reopened]
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
permissions:
  contents: read
jobs:
  image-boot:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - name: Build runtime image
        run: docker build -f Dockerfile -t probaitio:ci .
      - name: Assert image carries NO node_modules (the #1013 guard)
        run: |
          if docker run --rm --entrypoint sh probaitio:ci \
               -c 'find / -name node_modules -type d -print -quit 2>/dev/null' \
             | grep -q node_modules; then
            echo "FAIL: node_modules present in runtime image"; exit 1
          fi
          echo "OK: zero node_modules in runtime image"
      - name: Boot the image and curl /healthz (arbitrary-UID, no upstream)
        run: |
          docker run -d --name probaitio -p 5173:5173 \
            -e S3_ENDPOINT=https://example.invalid -e S3_BUCKET=ci \
            -e AWS_ACCESS_KEY_ID=ci -e AWS_SECRET_ACCESS_KEY=ci \
            probaitio:ci
          for i in $(seq 1 30); do
            if curl -fsS http://127.0.0.1:5173/healthz | grep -q '"ok":true'; then
              echo "healthz OK"; docker rm -f probaitio; exit 0
            fi
            sleep 1
          done
          echo "FAIL: /healthz never came up"; docker logs probaitio; docker rm -f probaitio; exit 1
```

`/healthz` deliberately does **no** S3 or upstream call, so the gate proves the boot
graph is clean (no crash-loop, no missing-`node_modules` import) even with unreachable
upstream URLs — which is exactly the failure mode #1013 describes. The SigV4 signer code
paths are unit-tested in `src/lib/s3/*.test.ts` against a fixture endpoint (vitest `test`
job), so the boot gate stays fast.

---

## 4. Decision summary (MVP-carries)

- **SigV4 is a ~150-line hand-rolled signer** (`src/lib/s3/sigv4.ts`): canonical request,
  `kSecret→kDate→kRegion→kService→kSigning` HMAC chain, `AWS4-HMAC-SHA256` Authorization
  header, path-style OBC endpoint, PUT with `UNSIGNED-PAYLOAD` (stream artifact blob) and
  GET/LIST with empty-payload SHA-256; creds/endpoint/bucket all from OBC-provided env.
  This is the artifact-blob substrate client per ADR 0011 §1/§8 — not a ciphertext store
  (the zero-knowledge encryption layer is #467).
- **Arbitrary-UID image** runs under OpenShift `restricted-v2` SCC: no hardcoded
  `runAsUser`; GID-0 group-writable `/app/.cache`; Dockerfile `chown 0:0` + `chmod g+rwX`.
- **A new `image-boot` CI gate** builds the runtime image, asserts **zero `node_modules`**
  (#1013 guard), boots it with a stub env, and curls a dependency-free `/healthz` — wired
  beside `test`/`spa-boundary`.
- **`node_modules`-free principle (ADR 0011 §8):** any server-side dependency is
  implemented dependency-free; future additions (OIDC when #467 lands, any new S3 op) must
  not break the boot gate.

---

## Deferred to #467 (multi-tenant / zero-knowledge layer)

The following pieces are **NOT MVP**. They are preserved here as the reference
implementation spec for when #467 (invite-only public multi-tenant SaaS) is built onto
the #1247 single-tenant substrate.

### D1. Keycloak OIDC — node:crypto PKCE + fetch only

The multi-tenant server flavor authenticates users via the RHBK/Keycloak OIDC
authorization-code + PKCE flow — fully dependency-free: discovery/JWKS fetched and
cached, PKCE S256 with `node:crypto`, RS256 ID-token verify via
`createPublicKey({format:'jwk'})` + `crypto.verify('RSA-SHA256', …)`, no `openid-client`,
no `jose`. The OIDC handlers live in `src/lib/auth/oidc.ts` and mount from a new
`scripts/server.public.mjs` entrypoint.

#### D1.1 Discovery + JWKS, fetched and cached

Keycloak (RHBK operator) exposes the realm's discovery doc at
`${ISSUER}/.well-known/openid-configuration`. We fetch it once and cache it; same for
the JWKS. Both live in `src/lib/auth/oidc.ts`.

```ts
// src/lib/auth/oidc.ts
import {
  createHash, randomBytes, createPublicKey, verify as cryptoVerify,
} from 'node:crypto';

const ISSUER = process.env.OIDC_ISSUER!;           // e.g. https://kc.../realms/probaitio
const CLIENT_ID = process.env.OIDC_CLIENT_ID!;
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET || ''; // confidential client
const REDIRECT_URI = process.env.OIDC_REDIRECT_URI!;        // https://probaitio.../api/auth/callback

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

let _disc: { at: number; doc: Discovery } | null = null;
const DISC_TTL_MS = 10 * 60_000;

export async function discovery(): Promise<Discovery> {
  if (_disc && Date.now() - _disc.at < DISC_TTL_MS) return _disc.doc;
  const res = await fetch(`${ISSUER}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery ${res.status}`);
  const doc = (await res.json()) as Discovery;
  if (doc.issuer !== ISSUER) throw new Error('issuer mismatch');
  _disc = { at: Date.now(), doc };
  return doc;
}

// JWKS cache, keyed by `kid`. We import each JWK as a node:crypto KeyObject once.
let _jwks: { at: number; keys: Map<string, import('node:crypto').KeyObject> } | null = null;
const JWKS_TTL_MS = 60 * 60_000;

export async function jwksKey(kid: string) {
  if (!_jwks || Date.now() - _jwks.at > JWKS_TTL_MS) {
    const { jwks_uri } = await discovery();
    const res = await fetch(jwks_uri);
    if (!res.ok) throw new Error(`JWKS ${res.status}`);
    const { keys } = (await res.json()) as { keys: any[] };
    const map = new Map<string, import('node:crypto').KeyObject>();
    for (const jwk of keys) {
      // node:crypto imports a JWK directly — no jose needed.
      map.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
    }
    _jwks = { at: Date.now(), keys: map };
  }
  let key = _jwks.keys.get(kid);
  if (!key) { _jwks = null; key = (await jwksKey(kid)); } // one forced refresh on rotation
  return key;
}
```

#### D1.2 PKCE, state, nonce

```ts
// src/lib/auth/oidc.ts (cont.)
const b64url = (b: Buffer) =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function pkcePair() {
  const verifier = b64url(randomBytes(32));             // 43-char high-entropy
  const challenge = b64url(createHash('sha256').update(verifier).digest()); // S256
  return { verifier, challenge };
}

export const randState = () => b64url(randomBytes(16));
export const randNonce = () => b64url(randomBytes(16));

export async function authorizeUrl(p: {
  challenge: string; state: string; nonce: string;
}): Promise<string> {
  const { authorization_endpoint } = await discovery();
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid profile email',
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    state: p.state,
    nonce: p.nonce,
  });
  return `${authorization_endpoint}?${q}`;
}
```

#### D1.3 Token exchange + RS256 ID-token verification

The ID token is a JWS (`header.payload.sig`). We verify RS256 with
`node:crypto.verify` against the JWKS `KeyObject` — **the exact calls**:

```ts
// src/lib/auth/oidc.ts (cont.)
export interface Claims {
  sub: string; email?: string; nonce?: string;
  iss: string; aud: string | string[]; exp: number; iat: number;
}

export async function exchangeCode(code: string, verifier: string) {
  const { token_endpoint } = await discovery();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
  if (CLIENT_SECRET) body.set('client_secret', CLIENT_SECRET);
  const res = await fetch(token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`token endpoint ${res.status}`);
  return (await res.json()) as { id_token: string; access_token: string; expires_in: number };
}

function fromB64url(s: string) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export async function verifyIdToken(jwt: string, expectedNonce: string): Promise<Claims> {
  const [h, p, s] = jwt.split('.');
  if (!h || !p || !s) throw new Error('malformed jwt');
  const header = JSON.parse(fromB64url(h).toString('utf8')) as { alg: string; kid: string };
  if (header.alg !== 'RS256') throw new Error(`unexpected alg ${header.alg}`);
  const key = await jwksKey(header.kid);

  // RS256 = RSASSA-PKCS1-v1_5 over SHA-256 of the ASCII `header.payload`.
  const ok = cryptoVerify(
    'RSA-SHA256',
    Buffer.from(`${h}.${p}`),   // signing input is the exact base64url segments
    key,                        // KeyObject from JWKS
    fromB64url(s),              // decoded signature bytes
  );
  if (!ok) throw new Error('bad signature');

  const claims = JSON.parse(fromB64url(p).toString('utf8')) as Claims;
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== ISSUER) throw new Error('iss');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(CLIENT_ID)) throw new Error('aud');
  if (claims.exp <= now) throw new Error('expired');
  if (claims.iat > now + 60) throw new Error('iat in future');
  if (claims.nonce !== expectedNonce) throw new Error('nonce');  // replay defense
  return claims;
}
```

`createPublicKey({ format: 'jwk' })` (Node >= 16) and `crypto.verify('RSA-SHA256', …)`
are core — no `jose`. This is the crux that keeps the boot graph clean.

### D2. AES-256-GCM encrypted session cookie (Vault-keyed)

```ts
// src/lib/auth/session-cookie.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// 32-byte key, base64, delivered by the Vault Secrets Operator as a
// VaultStaticSecret -> Secret -> env var. NEVER baked into the image.
const KEY = Buffer.from(process.env.SESSION_COOKIE_KEY || '', 'base64');
export const COOKIE_NAME = 'probaitio_sess';

export interface Session { sub: string; email?: string; exp: number; }

export function seal(sess: Session): string {
  if (KEY.length !== 32) throw new Error('SESSION_COOKIE_KEY must be 32 bytes (base64)');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const pt = Buffer.from(JSON.stringify(sess), 'utf8');
  const ct = Buffer.concat([c.update(pt), c.final()]);
  const tag = c.getAuthTag();
  // iv.ct.tag, all base64url, dot-joined
  const e = (b: Buffer) => b.toString('base64url');
  return `${e(iv)}.${e(ct)}.${e(tag)}`;
}

export function open(token: string): Session | null {
  try {
    const [ivB, ctB, tagB] = token.split('.');
    if (!ivB || !ctB || !tagB) return null;
    const d = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB, 'base64url'));
    d.setAuthTag(Buffer.from(tagB, 'base64url'));
    const pt = Buffer.concat([d.update(Buffer.from(ctB, 'base64url')), d.final()]);
    const sess = JSON.parse(pt.toString('utf8')) as Session;
    if (sess.exp <= Math.floor(Date.now() / 1000)) return null;
    return sess;
  } catch {
    return null; // tamper / wrong key / expired -> unauthenticated
  }
}

export function serializeCookie(value: string, maxAgeSec: number): string {
  // HttpOnly: JS can't read it. Secure: TLS-only (Route is HTTPS). SameSite=Lax:
  // survives the top-level OIDC redirect GET back from Keycloak, blocks CSRF POSTs.
  return [
    `${COOKIE_NAME}=${value}`,
    'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/',
    `Max-Age=${maxAgeSec}`,
  ].join('; ');
}
export const clearCookie = () =>
  `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
```

The transient `verifier`/`state`/`nonce` between `/login` and `/callback` ride a
**second** short-lived sealed cookie (`probaitio_pkce`, `SameSite=Lax`, `Max-Age=600`)
sealed with the same key — no server-side session store needed (keeps `replicas:1`
honest and avoids a shared store in multi-tenant Half 1).

### D3. Public multi-tenant OIDC handlers (`scripts/server.public.mjs`)

These reuse the existing `sendJson` (L815) and `readRequestBody` (L867) primitives.
Cookies are parsed with a 6-line splitter (no `cookie` package).

```js
// scripts/server.public.mjs (sketch — mounted before the static/data routes)
const oidc = await import(join(PROJECT_DIR, 'src', 'lib', 'auth', 'oidc.ts'));
const sc   = await import(join(PROJECT_DIR, 'src', 'lib', 'auth', 'session-cookie.ts'));

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// GET /api/auth/login  -> mint PKCE+state+nonce, set probaitio_pkce, 302 to Keycloak
async function handleLogin(req, res) {
  const { verifier, challenge } = oidc.pkcePair();
  const state = oidc.randState();
  const nonce = oidc.randNonce();
  const pkce = sc.seal({ sub: `${verifier}|${state}|${nonce}`, exp: Math.floor(Date.now()/1000) + 600 });
  const url = await oidc.authorizeUrl({ challenge, state, nonce });
  res.writeHead(302, {
    Location: url,
    'Set-Cookie': `probaitio_pkce=${pkce}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
    'Cache-Control': 'no-store',
  });
  res.end();
}

// GET /api/auth/callback?code=&state= -> verify state, exchange, verify id_token,
//   set probaitio_sess, clear probaitio_pkce, 302 to the SPA root.
async function handleCallback(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const code = u.searchParams.get('code');
  const state = u.searchParams.get('state');
  const pkceCookie = parseCookies(req)['probaitio_pkce'];
  const opened = pkceCookie && sc.open(pkceCookie);
  if (!code || !state || !opened) return sendJson(res, 400, { ok: false, error: 'bad callback' });
  const [verifier, expState, nonce] = opened.sub.split('|');
  if (state !== expState) return sendJson(res, 400, { ok: false, error: 'state mismatch' });

  try {
    const tok = await oidc.exchangeCode(code, verifier);
    const claims = await oidc.verifyIdToken(tok.id_token, nonce);
    const exp = Math.floor(Date.now() / 1000) + 8 * 3600;
    const sess = sc.seal({ sub: claims.sub, email: claims.email, exp });
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': [sc.serializeCookie(sess, 8 * 3600),
                     'probaitio_pkce=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'],
      'Cache-Control': 'no-store',
    });
    res.end();
  } catch (e) {
    return sendJson(res, 401, { ok: false, error: 'authentication failed' });
  }
}

// GET /api/auth/session -> who am I (SPA reads on boot via the chokepoint)
function handleSession(req, res) {
  const sess = (() => { const c = parseCookies(req)['probaitio_sess']; return c ? sc.open(c) : null; })();
  return sendJson(res, 200, sess ? { authenticated: true, sub: sess.sub, email: sess.email }
                                 : { authenticated: false });
}

// POST /api/auth/logout -> clear cookie
function handleLogout(req, res) {
  res.writeHead(200, { 'Set-Cookie': sc.clearCookie(), 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}
```

Wired into the public route table in the same `if (pathname === …)` style as
`scripts/server.mjs` L1261-1302, **above** the data routes and the upload route, so an
unauthenticated request never reaches `~/.claude`-derived compute or the blob store.

### D4. Public same-origin / CSRF write gate

Today `isSameOrigin` (`scripts/server.mjs` L1014-1028) hardcodes
`127.0.0.1:${PORT}` / `localhost` / `[::1]` and `passesWriteAuth` (L1040-1058)
403s everything else — correct for the loopback build, fatal for the public one.

**The rewrite must NOT trust `X-Forwarded-Host`.** Behind the OpenShift Route, an
attacker controls that header end-to-end unless the Route is the sole ingress and
strips it; we don't rely on that. Instead:

1. Extract the same-origin check into a pluggable `originPolicy(req)` chosen by
   `PROBAITIO_FLAVOR`. Loopback flavor = today's literal set (unchanged behavior).
   Public flavor compares `Origin` against the **server-configured** `PUBLIC_ORIGIN` env
   (`https://probaitio.example.com`) — a value the operator sets, never a request header.

```js
// scripts/server.mjs — replace the body of isSameOrigin with a policy lookup.
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || '';   // set only in public flavor
function originAllowed(req) {
  const origin = req.headers['origin'];
  if (typeof origin !== 'string' || origin === '') return false;
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  if (PUBLIC_ORIGIN) {
    try { return host === new URL(PUBLIC_ORIGIN).host; } catch { return false; }
  }
  return new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]).has(host);
}
```

2. `passesWriteAuth` keeps its three layers (origin -> `application/json` -> token) but
   in the public flavor the third layer is the **authenticated session**, not the
   per-process CSRF token: require a valid `probaitio_sess` cookie (`sc.open(...)` non-null)
   AND a double-submit CSRF token. The session cookie is `SameSite=Lax`, which already
   blocks cross-site POSTs; the double-submit token (random value set as a readable cookie
   + echoed in `X-CSRF-Token`) is defense in depth for same-site sub-resource confusion.
   The existing `extractToken`/`tokensMatch` helpers (L990-1008) are reused verbatim — the
   "expected" value just comes from the request's own readable CSRF cookie rather than
   `POLICY_WRITE_TOKEN`.

3. The upload route (the public flavor's `POST /api/blob`, ciphertext-only) runs through
   this same gate; an unauthenticated or cross-origin upload gets `401`/`403` exactly like
   policy-write does today.

The loopback/enterprise builds set neither `PUBLIC_ORIGIN` nor `PROBAITIO_FLAVOR`, so
`server.mjs` behaves **byte-identically** to today (verified by the existing
`scripts/policy-write.test.mjs` continuing to pass unchanged).

### D5. Chokepoint (#324) touch for OIDC session — keep `spa-boundary` green

`src/lib/api-client.ts` gains three exports for the multi-tenant SPA:

```ts
export async function fetchSession(): Promise<{ authenticated: boolean; email?: string }> {
  try { const r = await fetch('/api/auth/session'); return r.ok ? await r.json() : { authenticated: false }; }
  catch { return { authenticated: false }; }
}
export function loginRedirect() { window.location.assign('/api/auth/login'); }
export async function logout() { await fetch('/api/auth/logout', { method: 'POST' }); }
```

`api-client.spa.ts` mirrors them as no-ops (`fetchSession` -> `{ authenticated: false }`,
`loginRedirect`/`logout` -> no-op) so the upload-only SPA bundle keeps
`SERVER_AVAILABLE === false` and the `spa-boundary` grep finds no `/api/auth/...` literal
in the SPA `dist/`.
