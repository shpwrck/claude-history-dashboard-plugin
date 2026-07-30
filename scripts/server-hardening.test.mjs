#!/usr/bin/env node
// Server hardening contracts (#1420): startup rejects unsafe listener/auth
// config, and recommendation single-flight maps stay bounded like the response
// cache beside them.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, '..');
const REGISTER = './scripts/register-ts.mjs';
const SERVER = 'scripts/server.mjs';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

async function withServerDirs(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const claudeDir = join(root, 'claude');
  const distDir = join(root, 'dist');
  const cacheDir = join(root, 'cache');
  await mkdir(claudeDir, { recursive: true });
  await mkdir(distDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(distDir, 'index.html'), '<!doctype html><main>ok</main>');
  try {
    return await fn({
      claudeDir,
      distDir,
      cacheDir,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        CLAUDE_DIR: claudeDir,
        DIST_DIR: distDir,
        CHD_DB_PATH: join(cacheDir, 'dashboard.db'),
        ADOPTION_RECEIPTS_PATH: join(cacheDir, 'adoption-receipts.jsonl'),
        ENTERPRISE_AUDIT_LOG_PATH: join(cacheDir, 'enterprise-audit.jsonl'),
        ADOPTION_SPOOL_PATH: join(cacheDir, 'adoption-spool.jsonl'),
        DASHBOARD_REVIEW_EVENTS_CACHE_PATH: join(cacheDir, 'review-events.json'),
        DASHBOARD_AUTH_MODE: '',
        DASHBOARD_AUTH_TOKENS: '',
        DASHBOARD_AUTH_TOKENS_FILE: '',
        DASHBOARD_AUTH_JWKS: '',
        DASHBOARD_AUTH_JWKS_URL: '',
        DASHBOARD_AUTH_JWT_ISSUER: '',
        DASHBOARD_AUTH_JWT_AUDIENCE: '',
        DASHBOARD_ADMIN_TOKEN: '',
        DASHBOARD_ADMIN_TOKEN_SHA256: '',
        DASHBOARD_USER: '',
        DASHBOARD_PASS: '',
        DASHBOARD_ENABLE_SERVER_LLM_AUDITS: '',
        DASHBOARD_ENABLE_SERVER_USAGE_GAUGE: '',
        DASHBOARD_ENABLE_BROWSER_LLM_EGRESS: '',
        DASHBOARD_REVIEW_EVENTS_SOURCE: '',
        DASHBOARD_GITHUB_REVIEW_TOKEN: '',
        DASHBOARD_GITHUB_REVIEW_REPOS: '',
        ANTHROPIC_API_KEY: '',
        POLICY_WRITE_TOKEN: '',
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function spawnServerExpectExit(env, timeoutMs = 10_000) {
  let stdout = '';
  let stderr = '';
  const proc = spawn(process.execPath, ['--import', REGISTER, SERVER], {
    cwd: PROJECT_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  proc.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const result = await new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    proc.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ timedOut, code, signal: timedOut ? 'timeout' : signal });
    });
  });
  return {
    ...result,
    output: [stdout, stderr].filter(Boolean).join('\n'),
  };
}

async function spawnServerExpectResponse(env, path, timeoutMs = 10_000) {
  let stdout = '';
  let stderr = '';
  const proc = spawn(process.execPath, ['--import', REGISTER, SERVER], {
    cwd: PROJECT_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  proc.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const deadline = Date.now() + timeoutMs;
  let response = null;
  let requestError = null;
  try {
    while (Date.now() < deadline && proc.exitCode === null) {
      try {
        const res = await fetch(`http://127.0.0.1:${env.PORT}${path}`);
        response = {
          status: res.status,
          authenticate: res.headers.get('www-authenticate'),
          body: await res.text(),
        };
        break;
      } catch (error) {
        requestError = error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  } finally {
    if (proc.exitCode === null) {
      proc.kill();
      await new Promise((resolve) => proc.once('close', resolve));
    }
  }

  return {
    response,
    requestError,
    output: [stdout, stderr].filter(Boolean).join('\n'),
  };
}

await withServerDirs('server-hardening-port', async ({ env }) => {
  const result = await spawnServerExpectExit({ ...env, PORT: '0' });
  check(
    'invalid PORT exits before binding',
    !result.timedOut && result.code !== 0,
    result.output.slice(-2000)
  );
  check(
    'invalid PORT reports the accepted range',
    /PORT must be an integer between 1 and 65535/.test(result.output),
    result.output.slice(-2000)
  );
});

await withServerDirs('server-hardening-jwt', async ({ env }) => {
  const result = await spawnServerExpectExit({
    ...env,
    PORT: '5989',
    DASHBOARD_AUTH_MODE: 'enterprise',
    DASHBOARD_AUTH_JWKS_URL: 'http://127.0.0.1:9/.well-known/jwks.json',
  });
  check(
    'JWT auth without issuer exits before binding',
    !result.timedOut && result.code !== 0,
    result.output.slice(-2000)
  );
  check(
    'JWT issuer pin is required when JWT auth is configured',
    /DASHBOARD_AUTH_JWT_ISSUER is required when enterprise JWT auth is configured/.test(
      result.output
    ),
    result.output.slice(-2000)
  );
});

await withServerDirs('server-hardening-bind', async ({ env }) => {
  // Exposed beyond loopback (DASHBOARD_BIND_HOST non-loopback) with no auth must
  // refuse to start (#2064).
  const refused = await spawnServerExpectExit({
    ...env,
    PORT: '5993',
    DASHBOARD_BIND_HOST: '0.0.0.0',
  });
  check(
    'exposed bind without auth exits before binding',
    !refused.timedOut && refused.code !== 0,
    refused.output.slice(-2000)
  );
  check(
    'exposed bind refusal explains the fix',
    /Refusing to start: the dashboard is bound beyond loopback/.test(refused.output),
    refused.output.slice(-2000)
  );

  // #3295: there is NO override that disarms the guard. The legacy
  // DASHBOARD_ALLOW_INSECURE_BIND=1 knob is inert — an unauthenticated
  // beyond-loopback bind stays unrepresentable, so the server still refuses to
  // start rather than serving ~/.claude to the LAN with no auth.
  const legacyOverride = await spawnServerExpectExit(
    {
      ...env,
      PORT: '5994',
      DASHBOARD_BIND_HOST: '0.0.0.0',
      DASHBOARD_ALLOW_INSECURE_BIND: '1',
    },
    5000
  );
  check(
    'legacy insecure-bind override no longer starts an unauthenticated LAN bind',
    !legacyOverride.timedOut && legacyOverride.code !== 0,
    legacyOverride.output.slice(-2000)
  );

  // Auth is the gate: with DASHBOARD_USER/DASHBOARD_PASS configured the same
  // beyond-loopback bind boots, but a request without those credentials gets a
  // Basic challenge before any live-history route can run (acceptance #1/#2).
  const authed = await spawnServerExpectResponse(
    {
      ...env,
      PORT: '5995',
      DASHBOARD_BIND_HOST: '0.0.0.0',
      DASHBOARD_USER: 'ops',
      DASHBOARD_PASS: 'strong-lan-secret',
    },
    '/sessions-manifest.json',
    5000
  );
  check(
    'exposed bind with auth configured boots',
    authed.response !== null,
    authed.output.slice(-2000)
  );
  check(
    'unauthenticated LAN request receives a Basic auth challenge',
    authed.response?.status === 401 &&
      /^Basic\b/.test(authed.response.authenticate || ''),
    `${authed.response?.status ?? authed.requestError}; ${authed.output.slice(-1000)}`
  );
  check(
    'unauthenticated LAN request cannot retrieve live-history data',
    authed.response?.status === 401 &&
      !authed.response.body.includes('"sessions"'),
    authed.response?.body.slice(0, 1000)
  );
});

const serverSource = await readFile(join(SCRIPTS_DIR, 'server.mjs'), 'utf8');
const deploymentRunbook = await readFile(
  join(PROJECT_DIR, 'docs/runbooks/chd-deploy-master/README.md'),
  'utf8'
);
check(
  'live deployment recovery no longer tells operators to inspect insecure-flag propagation',
  !deploymentRunbook.includes('insecure-flag propagation')
);
const recommendationBuildInitializers = [
  ...serverSource.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*\{([^{}]*\bsourceSig\b[^{}]*\bpromise\b[^{}]*)\};/g),
];
const recommendationBuildInsertions = [
  ...serverSource.matchAll(
    /state\.recommendationsBuilds\.set\(key,\s*([A-Za-z_$][\w$]*)\);\s*pruneRecommendationsBuilds\(state\);/g
  ),
];
check(
  'recommendationsBuilds has a pruning function',
  /function pruneRecommendationsBuilds\(state\)/.test(serverSource)
);
check(
  'recommendationsBuilds uses the response-cache entry bound',
  /state\.recommendationsBuilds\.size <=\s*DASHBOARD_RECOMMENDATIONS_CACHE_MAX_ENTRIES/s.test(
    serverSource
  )
);
check(
  'new recommendation builds record last access',
  recommendationBuildInitializers.length >= 2 &&
    recommendationBuildInitializers.every((match) =>
      /\blastAccess:\s*Date\.now\(\)/.test(match[2])
    )
);
check(
  'reused recommendation builds refresh last access',
  /build\.lastAccess = Date\.now\(\);/.test(serverSource)
);
check(
  'recommendationsBuilds is pruned after insertion',
  // An invalidated in-flight owner may be re-reserved after pruning removed its
  // original slot, so there can be more guarded insertions than initializers.
  recommendationBuildInsertions.length >= recommendationBuildInitializers.length &&
    recommendationBuildInsertions.every((match) =>
      recommendationBuildInitializers.some((initializer) => initializer[1] === match[1])
    ) &&
    recommendationBuildInitializers.every((initializer) =>
      recommendationBuildInsertions.some((match) => match[1] === initializer[1])
    )
);

if (failures > 0) process.exit(1);
