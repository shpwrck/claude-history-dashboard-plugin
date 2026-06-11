#!/usr/bin/env node
// Enterprise readiness gate: produce a concise local receipt for CTO-demo and
// paid-pilot review. This is intentionally a composition of the narrower gates
// that already carry the detailed contracts.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const FORBIDDEN_SPA_PATTERN = /\/api\/|csrf-token|policy\/write|EventSource/;
const TEXT_DIST_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.svg']);

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
    name: 'Upload-only SPA build',
    command: 'npm',
    args: ['run', 'build:spa'],
  },
  {
    name: 'SPA emitted bundle contains no server-touching strings',
    run: assertSpaBoundary,
  },
  {
    name: 'SPA bundle-size budget',
    command: 'node',
    args: ['scripts/check-bundle-size.mjs', '--flavor', 'spa'],
  },
];

export function findSpaBoundaryOffenders(root) {
  const targets = [
    join(root, 'dist', 'index.html'),
    join(root, 'dist', 'assets'),
  ];
  const offenders = [];

  for (const target of targets) {
    if (!existsSync(target)) continue;
    for (const file of textFiles(target)) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (FORBIDDEN_SPA_PATTERN.test(lines[index])) {
          offenders.push(`${relative(root, file)}:${index + 1}`);
        }
      }
    }
  }

  return offenders;
}

function assertSpaBoundary(root) {
  const offenders = findSpaBoundaryOffenders(root);
  if (offenders.length > 0) {
    throw new Error(
      [
        'SPA bundle contains server-touching strings:',
        ...offenders.map((offender) => `- ${offender}`),
      ].join('\n')
    );
  }
}

function* textFiles(path) {
  const stat = statSync(path);
  if (stat.isFile()) {
    if (isTextDistFile(path)) yield path;
    return;
  }
  if (!stat.isDirectory()) return;

  const entries = readdirSync(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      yield* textFiles(child);
    } else if (entry.isFile() && isTextDistFile(child)) {
      yield child;
    }
  }
}

function isTextDistFile(path) {
  return TEXT_DIST_EXTENSIONS.has(path.slice(path.lastIndexOf('.')));
}

function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function runCommand(check, root, verbose) {
  const started = Date.now();

  if (check.run) {
    try {
      check.run(root);
      return elapsed(started);
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

  return duration;
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
    'Usage: node scripts/enterprise-readiness-gate.mjs [--list] [--verbose]',
    '',
    '--list     Print the checks without running them.',
    '--verbose  Stream each sub-check output instead of printing only failures.',
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
  console.log('');
  console.log('Running checks...');

  for (const check of ENTERPRISE_READINESS_CHECKS) {
    try {
      const duration = runCommand(check, root, verbose);
      console.log(`✓ ${check.name} (${duration}s)`);
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
  console.log('PASS enterprise readiness gate');
  console.log(
    'Attach this receipt to the security release-gate issue or CTO-demo handoff.'
  );
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) main();
