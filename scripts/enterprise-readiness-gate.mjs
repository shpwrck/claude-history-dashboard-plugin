#!/usr/bin/env node
// Enterprise readiness gate: produce a concise local receipt for CTO-demo and
// paid-pilot review. This is intentionally a composition of the narrower gates
// that already carry the detailed contracts.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ENTERPRISE_READINESS_CHECKS = [
  {
    name: 'Enterprise auth, authorization, posture, audit, and rate-limit contracts',
    command: 'npm',
    args: ['run', 'test:enterprise-auth'],
  },
  {
    name: 'LLM egress gate unit checks',
    command: 'npm',
    args: ['run', 'test:llm-egress-gate'],
  },
  {
    name: 'LLM egress registry, call-site, generated-doc, and public-exposure gate',
    command: 'npm',
    args: ['run', 'gate:llm-egress'],
  },
  {
    name: 'LLM public-exposure gate in multi-tenant mode',
    command: 'npm',
    args: ['run', 'gate:llm-egress'],
    env: {
      DASHBOARD_LLM_PUBLIC_EXPOSURE_MODE: 'multi-tenant',
    },
  },
  {
    name: 'Enterprise data route inventory gate',
    command: 'npm',
    args: ['run', 'gate:enterprise-routes'],
  },
  {
    name: 'Enterprise CTO-demo security posture gate',
    command: 'npm',
    args: ['run', 'gate:enterprise-posture'],
  },
  {
    name: 'Server build and typecheck',
    command: 'npm',
    args: ['run', 'build'],
  },
  {
    name: 'Server bundle-size budget',
    command: 'node',
    args: ['scripts/check-bundle-size.mjs', '--flavor', 'server'],
  },
  {
    name: 'Server runtime no-node_modules import guard',
    command: 'npm',
    args: ['run', 'test:server-runtime-imports'],
  },
  {
    name: 'Server production healthcheck contract',
    command: 'npm',
    args: ['run', 'test:server-healthcheck'],
  },
  {
    name: 'Container runtime least-privilege contract',
    command: 'npm',
    args: ['run', 'test:compose-runtime-hardening'],
  },
  {
    name: 'Server HTTP listener timeout contract',
    command: 'npm',
    args: ['run', 'test:server-http-timeouts'],
  },
  {
    name: 'Server-mode large-history scale budget',
    command: 'npm',
    args: ['run', 'gate:server-scale'],
  },
  {
    name: 'Repo-map scale and localization budget',
    command: 'npm',
    args: ['run', 'gate:repo-map'],
  },
  {
    name: 'Public sample build',
    command: 'npm',
    args: ['run', 'build:sample'],
  },
  {
    name: 'Public sample browser-only boundary',
    command: 'npm',
    args: ['run', 'gate:sample-boundary'],
  },
];

function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function runCommand(check, root, verbose, opts = {}) {
  const started = Date.now();

  if (check.run) {
    try {
      const outcome = check.run(root, opts);
      return {
        duration: elapsed(started),
        status: outcome && outcome.status === 'skipped' ? 'skipped' : 'passed',
        reason: outcome && outcome.reason,
      };
    } catch (err) {
      throw new CheckFailure(check, elapsed(started), '', err.message);
    }
  }

  const result = spawnSync(check.command, check.args, {
    cwd: root,
    env: { ...process.env, ...(check.env ?? {}) },
    encoding: 'utf8',
    stdio: verbose ? 'inherit' : 'pipe',
  });

  const duration = elapsed(started);
  if (result.status !== 0) {
    throw new CheckFailure(
      check,
      duration,
      result.stdout ?? '',
      result.stderr ?? '',
      result.status ?? 1
    );
  }

  return { duration, status: 'passed' };
}

class CheckFailure extends Error {
  constructor(check, duration, stdout, stderr, status = 1) {
    super(`${check.name} failed`);
    this.check = check;
    this.duration = duration;
    this.stdout = stdout;
    this.stderr = stderr;
    this.status = status;
  }
}

function elapsed(started) {
  return ((Date.now() - started) / 1000).toFixed(1);
}

function commandText(check) {
  if (check.run) return '<internal>';
  const env = Object.entries(check.env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  const command = [check.command, ...check.args].join(' ');
  return [env, command].filter(Boolean).join(' ');
}

export function renderCheckList(checks = ENTERPRISE_READINESS_CHECKS) {
  return checks
    .map((check, index) => `${index + 1}. ${check.name} - ${commandText(check)}`)
    .join('\n');
}

function usage() {
  return [
    'Usage: node scripts/enterprise-readiness-gate.mjs [--list] [--verbose] [--require-emitted-bundle]',
    '',
    '--list                    Print the checks without running them.',
    '--verbose                 Stream each sub-check output instead of printing only failures.',
    '--require-emitted-bundle  Hard-fail any sub-check that would otherwise be',
    '                          SKIPPED because the emitted dist/ bundle is absent',
    '                          (default: skips are reported loudly but do not fail).',
  ].join('\n');
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    console.log(usage());
    return;
  }

  console.log('Enterprise readiness gate');
  console.log('');
  console.log(renderCheckList());

  if (args.has('--list')) return;

  const root = repoRoot();
  const verbose = args.has('--verbose');
  const opts = { requireEmittedBundle: args.has('--require-emitted-bundle') };
  console.log('');
  console.log('Running checks...');

  let passed = 0;
  const skipped = [];
  for (const check of ENTERPRISE_READINESS_CHECKS) {
    try {
      const outcome = runCommand(check, root, verbose, opts);
      if (outcome.status === 'skipped') {
        // #3478: a skip must be LOUD and visibly distinct from a pass — this
        // sub-check inspected nothing, so it proved nothing.
        skipped.push({ name: check.name, reason: outcome.reason });
        console.log(`! ${check.name} SKIPPED (${outcome.duration}s) — ${outcome.reason}`);
      } else {
        passed += 1;
        console.log(`✓ ${check.name} (${outcome.duration}s)`);
      }
    } catch (err) {
      if (err instanceof CheckFailure) {
        console.error(`✗ ${err.check.name} (${err.duration}s)`);
        console.error(`Command: ${commandText(err.check)}`);
        if (err.stdout.trim()) {
          console.error('\nstdout:\n' + err.stdout.trim());
        }
        if (err.stderr.trim()) {
          console.error('\nstderr:\n' + err.stderr.trim());
        }
        process.exit(err.status || 1);
      }
      throw err;
    }
  }

  console.log('');
  if (skipped.length === 0) {
    console.log(`PASS enterprise readiness gate — all ${passed} sub-checks passed`);
    console.log(
      'Attach this receipt to the security release-gate issue or CTO-demo handoff.'
    );
  } else {
    // "Passed" and "not inspected" are different claims; a receipt with skips
    // is NOT a full receipt and says so.
    console.log(
      `PASS enterprise readiness gate — ${passed} passed, ${skipped.length} SKIPPED (not inspected):`
    );
    for (const s of skipped) {
      console.log(`  ! ${s.name}: ${s.reason}`);
    }
    console.log(
      'A skipped sub-check verified nothing. This is NOT a full receipt — re-run ' +
        'with --require-emitted-bundle to make missing inputs a hard failure.'
    );
  }
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) main();
