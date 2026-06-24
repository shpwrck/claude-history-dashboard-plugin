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

  // The DASHBOARD_ALLOW_INSECURE_BIND override lets it boot (does NOT exit at
  // startup) — also proves the guard doesn't break a normal boot.
  const overridden = await spawnServerExpectExit(
    {
      ...env,
      PORT: '5994',
      DASHBOARD_BIND_HOST: '0.0.0.0',
      DASHBOARD_ALLOW_INSECURE_BIND: '1',
    },
    5000
  );
  check(
    'exposed bind with override boots instead of failing closed',
    overridden.timedOut === true,
    overridden.output.slice(-2000)
  );
});

const serverSource = await readFile(join(SCRIPTS_DIR, 'server.mjs'), 'utf8');
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
  /build = \{ sourceSig, promise, lastAccess: Date\.now\(\) \};/.test(serverSource)
);
check(
  'reused recommendation builds refresh last access',
  /build\.lastAccess = Date\.now\(\);/.test(serverSource)
);
check(
  'recommendationsBuilds is pruned after insertion',
  /state\.recommendationsBuilds\.set\(key, build\);\s*pruneRecommendationsBuilds\(state\);/s.test(
    serverSource
  )
);

if (failures > 0) process.exit(1);
