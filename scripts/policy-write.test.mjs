// Regression test for the Policy Builder write-back route (#199).
//
// This repo has no formal test runner, so this is a standalone runnable check:
//   node scripts/policy-write.test.mjs
// (also wired as `npm run test:policy-write`). Exits non-zero on the first
// failure. It boots the real server.mjs against a throwaway CLAUDE_DIR via the
// CLAUDE_DIR env override and exercises validation, backup, append+dedupe,
// idempotency, and the corrupt-file refusal — never touching the real
// ~/.claude/settings.json.

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir, networkInterfaces as osNetworkInterfaces } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, '..');
// The server imports the app's .ts parsers (via ingest.mjs), which only resolve
// under the register-ts loader — exactly how the container launches it
// (`node --import ./scripts/register-ts.mjs scripts/server.mjs`). Spawn it the
// same way, with cwd at the project root so the relative loader path resolves.
const REGISTER = './scripts/register-ts.mjs';
const SERVER = 'scripts/server.mjs';
const PORT = 5987;
const base = `http://127.0.0.1:${PORT}`;
// Origins the server treats as same-origin. Used by the legitimate-write
// requests; the rejection cases deliberately diverge from them.
const SAME_ORIGIN = `http://127.0.0.1:${PORT}`;
const PUBLIC_ORIGIN = 'https://dashboard.example.com';
const PATH_CONFIGURED_ORIGIN = 'https://path-origin.example.com';
// Deterministic token override (#308). The server uses POLICY_WRITE_TOKEN when
// set instead of a random per-boot secret, so the test can assert exact
// match/mismatch behavior of the auth gate.
const TOKEN = 'test-csrf-token-deadbeef';
const MUTATING_BODY_MAX_BYTES = 4096;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

const claudeDir = await mkdtemp(join(tmpdir(), 'policy-write-test-'));
const settingsPath = join(claudeDir, 'settings.json');
const distDir = await mkdtemp(join(tmpdir(), 'policy-write-dist-'));

// Seed an existing settings.json: one allow + one deny rule + an unrelated key.
await writeFile(
  settingsPath,
  JSON.stringify(
    { model: 'claude-opus-4-8', permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm -rf:*)'] } },
    null,
    2
  ) + '\n'
);

const proc = spawn('node', ['--import', REGISTER, SERVER], {
  cwd: PROJECT_DIR,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    CLAUDE_DIR: claudeDir,
    DIST_DIR: distDir,
    POLICY_WRITE_TOKEN: TOKEN,
    DASHBOARD_MUTATING_BODY_MAX_BYTES: String(MUTATING_BODY_MAX_BYTES),
    DASHBOARD_ALLOWED_ORIGINS: `${PUBLIC_ORIGIN},${PATH_CONFIGURED_ORIGIN}/write`,
  },
  stdio: 'ignore',
});

// A legitimate, fully-authenticated write: loopback peer (we connect to
// 127.0.0.1), same-origin Origin, application/json, and the Bearer token.
const post = (body, { headers = {}, origin = SAME_ORIGIN, token = TOKEN } = {}) => {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (origin !== null) h.Origin = origin;
  if (token !== null) h.Authorization = `Bearer ${token}`;
  return fetch(`${base}/api/policy/write`, {
    method: 'POST',
    headers: h,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
};

// Wait for the server to accept connections (a fully-authed no-op write).
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      await post('{}');
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
}

try {
  const up = await waitUp();
  check('server came up', up);

  // T1: malformed JSON -> 400, file unchanged.
  const before = await readFile(settingsPath, 'utf8');
  let r = await post('{not json');
  check('malformed JSON -> 400', r.status === 400, `got ${r.status}`);
  check('malformed leaves file intact', (await readFile(settingsPath, 'utf8')) === before);

  // T2: missing permissions object -> 400.
  r = await post({ foo: 'bar' });
  check('missing permissions -> 400', r.status === 400, `got ${r.status}`);

  // T3: wrong type for a bucket -> 400.
  r = await post({ permissions: { allow: 'Bash(x)' } });
  check('allow not array -> 400', r.status === 400, `got ${r.status}`);

  // T4: all buckets empty -> 400.
  r = await post({ permissions: { allow: [] } });
  check('all empty -> 400', r.status === 400, `got ${r.status}`);

  // T5: GET -> 405.
  r = await fetch(`${base}/api/policy/write`);
  check('GET -> 405', r.status === 405, `got ${r.status}`);

  // --- #308 auth gate: every rejection case must leave the file untouched. ---
  const guard = await readFile(settingsPath, 'utf8');
  const intact = async () => (await readFile(settingsPath, 'utf8')) === guard;

  // A5a: no token -> 401, file untouched.
  r = await post({ permissions: { allow: ['Bash(evil:*)'] } }, { token: null });
  check('no token -> 401', r.status === 401, `got ${r.status}`);
  check('no token leaves file intact', await intact());

  // A5b: wrong token -> 401, file untouched.
  r = await post({ permissions: { allow: ['Bash(evil:*)'] } }, { token: 'not-the-token' });
  check('bad token -> 401', r.status === 401, `got ${r.status}`);
  check('bad token leaves file intact', await intact());

  // A5c: foreign Origin -> 403, file untouched (cross-origin CSRF vector).
  r = await post({ permissions: { allow: ['Bash(evil:*)'] } }, { origin: 'http://evil.example.com' });
  check('foreign origin -> 403', r.status === 403, `got ${r.status}`);
  check('foreign origin leaves file intact', await intact());

  // A5d: absent Origin -> 403, file untouched.
  r = await post({ permissions: { allow: ['Bash(evil:*)'] } }, { origin: null });
  check('absent origin -> 403', r.status === 403, `got ${r.status}`);
  check('absent origin leaves file intact', await intact());

  // A5e: wrong Content-Type (simple-request CSRF vector) -> 415, file untouched.
  r = await post(JSON.stringify({ permissions: { allow: ['Bash(evil:*)'] } }), {
    headers: { 'Content-Type': 'text/plain' },
  });
  check('text/plain content-type -> 415', r.status === 415, `got ${r.status}`);
  check('text/plain leaves file intact', await intact());

  // A5f: X-CSRF-Token is the write credential when both headers are present.
  // Enterprise mode uses Authorization for the session bearer, so the write
  // gate must not compare that unrelated bearer against POLICY_WRITE_TOKEN.
  r = await post(
    { permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm -rf:*)'] } },
    { headers: { 'X-CSRF-Token': TOKEN }, token: 'enterprise-session-token' }
  );
  const xCsrfBody = await r.json();
  check('x-csrf token works alongside bearer authorization -> 200', r.status === 200, `got ${r.status} ${JSON.stringify(xCsrfBody)}`);
  check('x-csrf token write is idempotent', xCsrfBody.addedCount === 0, `got ${xCsrfBody.addedCount}`);

  // A5g: configured public origins support reverse-proxied HTTPS deployments
  // without weakening the foreign-origin rejection above.
  r = await post(
    { permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm -rf:*)'] } },
    { headers: { 'X-CSRF-Token': TOKEN }, origin: PUBLIC_ORIGIN, token: null }
  );
  const publicOriginBody = await r.json();
  check('configured public origin write -> 200', r.status === 200, `got ${r.status} ${JSON.stringify(publicOriginBody)}`);
  check('configured public origin write is idempotent', publicOriginBody.addedCount === 0, `got ${publicOriginBody.addedCount}`);

  // A5h: URL paths in DASHBOARD_ALLOWED_ORIGINS are invalid; the origin must
  // not be accepted after stripping the path.
  r = await post(
    { permissions: { allow: ['Bash(evil:*)'] } },
    {
      headers: { 'X-CSRF-Token': TOKEN },
      origin: PATH_CONFIGURED_ORIGIN,
      token: null,
    }
  );
  check('path-configured public origin -> 403', r.status === 403, `got ${r.status}`);
  check('path-configured public origin leaves file intact', await intact());

  // A5i: authenticated but oversized JSON body -> 413, file untouched. The
  // server preflights Content-Length before parsing, then still keeps a stream
  // cap for chunked clients.
  const oversizedBody = JSON.stringify({
    permissions: { allow: [`Bash(${'x'.repeat(MUTATING_BODY_MAX_BYTES)}:*)`] },
  });
  r = await post(oversizedBody);
  const oversizedResponse = await r.json().catch(() => ({}));
  check('oversized body -> 413', r.status === 413, `got ${r.status} ${JSON.stringify(oversizedResponse)}`);
  check(
    'oversized body reports cap',
    String(oversizedResponse.error || '').includes(`${MUTATING_BODY_MAX_BYTES} byte`),
    JSON.stringify(oversizedResponse)
  );
  check('oversized body leaves file intact', await intact());

  // A5i: container/NAT path (#311). Under podman's pasta NAT a host→container
  // request is NAT'd, so req.socket.remoteAddress is the pasta gateway, NOT a
  // loopback literal — yet it's the legitimate in-app SPA. We model this by
  // spinning up a second server bound to 0.0.0.0 and connecting via a real
  // non-loopback interface IP (so the peer address is non-loopback), while the
  // Origin header carries the loopback host:PORT the browser actually sends
  // through the loopback-bound published port. The #311 fix dropped the
  // remoteAddress gate, so this non-loopback-but-same-origin+tokened request
  // must now SUCCEED (200, writes) — while the SAME non-loopback peer WITHOUT a
  // token must still be rejected (401). The token + Origin + content-type
  // layers carry the security; the network boundary is the loopback-bound port.
  // Skipped only if the box has no external IPv4 interface.
  const extIp = (() => {
    const ifaces = osNetworkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const a of ifaces[name] || []) {
        if (a.family === 'IPv4' && !a.internal) return a.address;
      }
    }
    return null;
  })();
  if (extIp) {
    const PORT2 = PORT + 1;
    const proc2 = spawn('node', ['--import', REGISTER, SERVER], {
      cwd: PROJECT_DIR,
      env: {
        ...process.env,
        PORT: String(PORT2),
        HOST: '0.0.0.0',
        CLAUDE_DIR: claudeDir,
        DIST_DIR: distDir,
        POLICY_WRITE_TOKEN: TOKEN,
        DASHBOARD_MUTATING_BODY_MAX_BYTES: String(MUTATING_BODY_MAX_BYTES),
        DASHBOARD_ALLOWED_ORIGINS: PUBLIC_ORIGIN,
      },
      stdio: 'ignore',
    });
    try {
      // Wait for the 0.0.0.0 instance to come up (probe via the external IP, the
      // non-loopback address the requests below originate from — so we know the
      // NAT-like non-loopback peer path is exercised).
      const extBase = `http://${extIp}:${PORT2}`;
      // The Origin the SPA actually presents through the loopback-bound host
      // port: the server's own loopback host:PORT (NAT-independent), not extIp.
      const sameOrigin2 = `http://127.0.0.1:${PORT2}`;
      let up2 = false;
      for (let i = 0; i < 60; i++) {
        try {
          await fetch(`${extBase}/api/csrf-token`);
          up2 = true;
          break;
        } catch {
          await new Promise((res2) => setTimeout(res2, 100));
        }
      }
      check('second (0.0.0.0) server came up', up2);

      // The csrf-token bootstrap must be reachable over the NAT-like hop now
      // (was 403 loopback-only before #311).
      const tr = await fetch(`${extBase}/api/csrf-token`);
      check('NAT-path csrf-token -> 200', tr.status === 200, `got ${tr.status}`);

      // Non-loopback peer WITHOUT a token: still rejected 401, file untouched.
      r = await fetch(`${extBase}/api/policy/write`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: sameOrigin2,
        },
        body: JSON.stringify({ permissions: { allow: ['Bash(evil:*)'] } }),
      });
      check('NAT-path no token -> 401', r.status === 401, `got ${r.status}`);
      check('NAT-path no token leaves file intact', await intact());

      // Non-loopback peer WITH valid token + matching Origin + application/json:
      // now SUCCEEDS (200) and writes. Use rules already present in the seed so
      // addedCount === 0 and the file content stays equivalent for the later
      // dedupe assertions; a backup is still produced by the write contract.
      r = await fetch(`${extBase}/api/policy/write`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: sameOrigin2,
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm -rf:*)'] } }),
      });
      const natBody = await r.json();
      check('NAT-path tokened write -> 200', r.status === 200, `got ${r.status} ${JSON.stringify(natBody)}`);
      check('NAT-path tokened write adds nothing (idempotent seed)', natBody.addedCount === 0, `got ${natBody.addedCount}`);
    } finally {
      proc2.kill();
    }
    // Restore the seed so the T6+ append/dedupe assertions start from a known
    // state regardless of the successful NAT write above.
    await writeFile(
      settingsPath,
      JSON.stringify(
        { model: 'claude-opus-4-8', permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm -rf:*)'] } },
        null,
        2
      ) + '\n'
    );
  } else {
    console.log('  ..  NAT/container path case skipped (no external IPv4 interface)');
  }

  // T6: valid append + dedupe. Bash(ls:*) already exists -> not duplicated;
  //     Bash(git status:*) is new; an ask bucket is created.
  r = await post({ permissions: { allow: ['Bash(ls:*)', 'Bash(git status:*)'], ask: ['Bash(curl:*)'] } });
  const body = await r.json();
  check('valid write -> 200', r.status === 200, `got ${r.status} ${JSON.stringify(body)}`);
  check('reports added count = 2', body.addedCount === 2, `got ${body.addedCount}`);
  const after = JSON.parse(await readFile(settingsPath, 'utf8'));
  check(
    'allow deduped (Bash(ls:*) once)',
    after.permissions.allow.filter((x) => x === 'Bash(ls:*)').length === 1,
    JSON.stringify(after.permissions.allow)
  );
  check('allow gained Bash(git status:*)', after.permissions.allow.includes('Bash(git status:*)'));
  check('existing deny preserved', JSON.stringify(after.permissions.deny) === JSON.stringify(['Bash(rm -rf:*)']));
  check('ask created', JSON.stringify(after.permissions.ask) === JSON.stringify(['Bash(curl:*)']));
  check('unrelated key (model) preserved', after.model === 'claude-opus-4-8');

  // T7: backup created.
  const files = await readdir(claudeDir);
  check('backup file created', files.some((f) => f.startsWith('settings.json.backup-')), files.join(','));
  check('response reports backup path', typeof body.backup === 'string' && body.backup.includes('settings.json.backup-'));

  // T8: idempotent re-post adds nothing.
  r = await post({ permissions: { allow: ['Bash(ls:*)', 'Bash(git status:*)'] } });
  const body2 = await r.json();
  check('idempotent re-post -> addedCount 0', r.status === 200 && body2.addedCount === 0, `got ${r.status} ${JSON.stringify(body2)}`);

  // T9: corrupt existing file -> 409, untouched.
  await writeFile(settingsPath, '{ broken json');
  r = await post({ permissions: { allow: ['Bash(new:*)'] } });
  check('corrupt existing -> 409', r.status === 409, `got ${r.status}`);
  check('corrupt file untouched', (await readFile(settingsPath, 'utf8')) === '{ broken json');
} finally {
  proc.kill();
  await rm(claudeDir, { recursive: true, force: true });
  await rm(distDir, { recursive: true, force: true });
}

// Drop a sentinel file so test status is observable even where stdout capture
// is unreliable. Written before exit so it reflects both pass and fail.
if (process.env.POLICY_TEST_SENTINEL) {
  await writeFile(process.env.POLICY_TEST_SENTINEL, failures === 0 ? `PASS (${0} failures)\n` : `FAIL (${failures} failures)\n`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll policy-write checks passed.');
