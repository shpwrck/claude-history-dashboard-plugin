#!/usr/bin/env node
// Guard the production server boot graph against npm package imports.
//
// The runtime Docker image intentionally ships no node_modules. This boots the
// real server with DASHBOARD_RUNTIME_IMPORT_GUARD=1, which makes ts-resolver.mjs
// reject bare package imports from runtime scripts and src/lib/**. A future
// web-tree-sitter-style leak fails before release.

import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildGate2702Runtime } from './build-gate-2702-runtime.mjs';

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

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => resolve(addr.port));
    });
  });
}

async function expectScriptRuntimeImportsBlocked() {
  const probeName = `.runtime-import-guard-probe-${process.pid}.mjs`;
  const probePath = join(SCRIPTS_DIR, probeName);
  await writeFile(probePath, "import 'web-tree-sitter';\n");
  try {
    const result = await new Promise((resolve) => {
      let probeStdout = '';
      let probeStderr = '';
      const probe = spawn(
        'node',
        ['--import', REGISTER, `scripts/${probeName}`],
        {
          cwd: PROJECT_DIR,
          env: {
            ...process.env,
            DASHBOARD_RUNTIME_IMPORT_GUARD: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      probe.stdout.on('data', (chunk) => {
        probeStdout += String(chunk);
      });
      probe.stderr.on('data', (chunk) => {
        probeStderr += String(chunk);
      });
      probe.on('close', (code) => {
        resolve({ code, output: `${probeStdout}\n${probeStderr}`.trim() });
      });
    });

    check(
      'runtime script package imports are blocked',
      result.code !== 0 &&
        /Server runtime import guard blocked bare package "web-tree-sitter"/.test(
          result.output
        ),
      result.output.slice(-2000)
    );
  } finally {
    await rm(probePath, { force: true });
  }
}

await expectScriptRuntimeImportsBlocked();

const gateRuntimeDir = await mkdtemp(
  join(tmpdir(), 'runtime-import-gate-2702-')
);
const gateRuntimeBundle = join(gateRuntimeDir, 'runtime-verifier.bundle.mjs');
await buildGate2702Runtime({
  projectDir: PROJECT_DIR,
  outputFile: gateRuntimeBundle,
});

async function expectGate2702RuntimeBundleLoads() {
  const bundleUrl = pathToFileURL(gateRuntimeBundle).href;
  const missingStateRoot = join(gateRuntimeDir, 'missing-state');
  const probeSource = `
    const module = await import(${JSON.stringify(bundleUrl)});
    if (typeof module.loadCurrentEvaluation !== 'function') process.exit(3);
    try {
      await module.loadCurrentEvaluation({
        trial: '11111111-1111-5111-8111-111111111111',
        stateRoot: ${JSON.stringify(missingStateRoot)},
      });
      process.exit(4);
    } catch (error) {
      if (/verified seal marker is not valid JSON/.test(String(error?.message))) {
        process.exit(0);
      }
      console.error(error);
      process.exit(5);
    }
  `;
  const result = await new Promise((resolve) => {
    let probeStdout = '';
    let probeStderr = '';
    const probe = spawn(
      'node',
      ['--import', REGISTER, '--input-type=module', '--eval', probeSource],
      {
        cwd: PROJECT_DIR,
        env: {
          ...process.env,
          DASHBOARD_RUNTIME_IMPORT_GUARD: '1',
          NODE_ENV: 'production',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    probe.stdout.on('data', (chunk) => {
      probeStdout += String(chunk);
    });
    probe.stderr.on('data', (chunk) => {
      probeStderr += String(chunk);
    });
    probe.on('close', (code) => {
      resolve({ code, output: `${probeStdout}\n${probeStderr}`.trim() });
    });
  });

  check(
    'bundled #2702 verifier loads and executes with zero node_modules',
    result.code === 0,
    result.output.slice(-2000)
  );
}

await expectGate2702RuntimeBundleLoads();

const port = await freePort();
const claudeDir = await mkdtemp(join(tmpdir(), 'runtime-import-claude-'));
const distDir = await mkdtemp(join(tmpdir(), 'runtime-import-dist-'));
const cacheDir = await mkdtemp(join(tmpdir(), 'runtime-import-cache-'));
const ingestDir = await mkdtemp(join(tmpdir(), 'runtime-import-ingest-'));
const INGEST_TOKEN = 'runtime-import-ingest-token';
const WRITE_TOKEN = 'runtime-import-write-token';
const base = `http://127.0.0.1:${port}`;

await writeFile(join(distDir, 'index.html'), '<!doctype html><main>ok</main>');

let stdout = '';
let stderr = '';
const proc = spawn('node', ['--import', REGISTER, SERVER], {
  cwd: PROJECT_DIR,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    CLAUDE_DIR: claudeDir,
    DIST_DIR: distDir,
    CHD_DB_PATH: join(cacheDir, 'dashboard.db'),
    ADOPTION_RECEIPTS_PATH: join(cacheDir, 'adoption-receipts.jsonl'),
    ENTERPRISE_AUDIT_LOG_PATH: join(cacheDir, 'enterprise-audit.jsonl'),
    ADOPTION_SPOOL_PATH: join(cacheDir, 'adoption-spool.jsonl'),
    DASHBOARD_REVIEW_EVENTS_CACHE_PATH: join(cacheDir, 'review-events.json'),
    CHD_GATE_2702_RUNTIME_VERIFIER: gateRuntimeBundle,
    DASHBOARD_RUNTIME_IMPORT_GUARD: '1',
    DASHBOARD_AUTH_MODE: '',
    DASHBOARD_AUTH_TOKENS: '',
    DASHBOARD_ADMIN_TOKEN: '',
    // Opt-in surfaces whose handlers lazy-import() only when enabled (#1576):
    // set so the POST exercises below reach those import chains under the guard.
    PROBAITIO_INGEST_DIR: ingestDir,
    PROBAITIO_INGEST_TOKEN: INGEST_TOKEN,
    POLICY_WRITE_TOKEN: WRITE_TOKEN,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

proc.stdout.on('data', (chunk) => {
  stdout += String(chunk);
});
proc.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});

async function waitUp() {
  for (let i = 0; i < 80; i += 1) {
    if (proc.exitCode !== null) return false;
    try {
      const response = await fetch(`${base}/api/auth/session`);
      if (response.status === 200) return true;
    } catch {
      /* server not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

try {
  const up = await waitUp();
  check(
    'server boots with runtime import guard',
    up,
    [stdout, stderr].filter(Boolean).join('\n').slice(-2000)
  );

  if (up) {
    const response = await fetch(`${base}/api/auth/session`);
    const body = await response.json().catch(() => null);
    check(
      'auth session route responds',
      response.status === 200,
      `got ${response.status}`
    );
    check('local mode remains unauthenticated', body?.authRequired === false);

    // #1576: exercise the function-scoped lazy import() chains that only resolve
    // when these opt-in operator/ingest/dispatch routes are actually hit, so a
    // future npm-package leak in those graphs fails the guard HERE, not in prod.
    // Each handler import()s under DASHBOARD_RUNTIME_IMPORT_GUARD=1; the stderr
    // scan below is the backstop assertion that none pulled a bare package.
    //   GET  /api/sessions             -> ./lib/kube-client.mjs (imported before
    //                                     the isConfigured() gate, so no cluster)
    //   POST /api/sessions             -> ./lib/remotesession-dispatch.mjs
    //   POST /api/ingest/:id/artifacts -> ../src/lib/claude-tree-classification.ts
    const sessionsList = await fetch(`${base}/api/sessions`);
    // 200 = import resolved + no cluster configured (or the list succeeded); 502 =
    // import resolved but a CONFIGURED cluster (e.g. the in-cluster ARC CI runner,
    // which has a service-account kubeconfig) rejected the list. Both prove
    // kube-client.mjs imported under the guard — only a 500 'dispatch module
    // unavailable' (the import-catch) would mean the guard blocked a bare package.
    check(
      'GET /api/sessions resolves the kube-client import chain',
      sessionsList.status === 200 || sessionsList.status === 502,
      `got ${sessionsList.status}`
    );

    const sessionsCreate = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: base,
        'x-csrf-token': WRITE_TOKEN,
      },
      body: '{}',
    });
    // 400 proves write-auth PASSED and the dispatch module imported, then
    // validateDispatchInput rejected the empty body. A 401/403/415 would mean we
    // never reached the import; a 500 would mean the import itself was blocked.
    check(
      'POST /api/sessions resolves the remotesession-dispatch import',
      sessionsCreate.status === 400,
      `got ${sessionsCreate.status}`
    );

    const ingest = await fetch(`${base}/api/ingest/probe-source/artifacts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${INGEST_TOKEN}`,
      },
      body: JSON.stringify({ artifacts: [] }),
    });
    // < 500 proves the claude-tree-classification import resolved — a guard block
    // in that (un-try/caught) chain surfaces as a 500. Empty artifacts[] is
    // accepted (nothing written), so the handler runs past the import.
    check(
      'POST /api/ingest/:id/artifacts resolves the claude-tree-classification import',
      ingest.status < 500,
      `got ${ingest.status}`
    );
  }
} finally {
  proc.kill();
  await rm(claudeDir, { recursive: true, force: true });
  await rm(distDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
  await rm(ingestDir, { recursive: true, force: true });
  await rm(gateRuntimeDir, { recursive: true, force: true });
}

if (/Server runtime import guard blocked bare package/.test(stderr)) {
  console.error(stderr);
  failures += 1;
}

if (failures > 0) process.exit(1);
