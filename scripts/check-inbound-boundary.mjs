#!/usr/bin/env node
// Inbound SPA/server boundary gate (#2081 — the inbound half of the #324 split).
//
// The `spa-boundary` CI job guards the OUTBOUND direction: it builds the SPA
// (which aliases @api-client to a no-op stub) and fails if any server-touching
// string survives in the emitted bundle. That is one-directional. This gate
// guards the INBOUND direction: it asserts that every dashboard-server call
// routes through the single `src/lib/api-client.ts` chokepoint, so a stray
// `fetch('/api/…')` or `new EventSource('/api/…')` added to a shared lib,
// detector, or component can't silently bypass the structured client.
//
// We forbid the browser network PRIMITIVES, not the `/api/` string — `/api/`
// appears pervasively in doc comments across the parsers (each names the route
// whose payload it parses), so a string scan would be all false positives. A
// server call REQUIRES a network primitive, so gating the primitives catches
// every bypass while the prose stays free.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// The ONLY modules permitted to make a raw browser network call. Everything
// else must go through the api-client chokepoint. Each entry is load-bearing:
export const NETWORK_OWNERS = [
  'lib/api-client.ts', // THE chokepoint — owns every /api/ server call
  'lib/api-client.spa.ts', // its no-op SPA-build alias (no server strings)
  'lib/dataset-worker.ts', // the worker api-client delegates the dataset fetch to (#162); the URL is a param, not a literal
  'lib/claude-api.ts', // BYO Ask-Claude -> the Anthropic API with the user's own key (governed by ADR 0008, not the chokepoint)
  'lib/sample-data.ts', // fetches the build-time static sample zip (SPA tier, no server involved)
];

// Tight primitives only: real call sites write `fetch(` (no space) / `new
// EventSource(`; prose writes "over-fetch (…)" / "the fetch (fetchUsage)" with a
// space, so this never trips on a comment. Comment lines are skipped anyway.
const PRIMITIVE =
  /\bfetch\(|\bnew\s+(?:EventSource|WebSocket|XMLHttpRequest)\b|\bnavigator\.sendBeacon\b/;

/**
 * Scan a src tree for raw network primitives outside the owner allowlist.
 * Returns `{ file, line, text }[]` (empty when clean). Skips `*.test.ts(x)` and
 * comment lines; strips a trailing `//` comment before matching.
 */
export function findInboundViolations(srcDir, owners = NETWORK_OWNERS) {
  const allow = new Set(owners);
  const violations = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) {
        continue;
      }
      const rel = relative(srcDir, full).split('\\').join('/');
      if (allow.has(rel)) continue;

      const lines = readFileSync(full, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        // Skip whole comment lines (line, block, JSDoc continuation).
        if (
          trimmed.startsWith('//') ||
          trimmed.startsWith('*') ||
          trimmed.startsWith('/*')
        ) {
          return;
        }
        const code = line.replace(/\/\/.*$/, ''); // drop a trailing line comment
        if (PRIMITIVE.test(code)) {
          violations.push({ file: rel, line: i + 1, text: line.trim() });
        }
      });
    }
  };

  walk(srcDir);
  return violations;
}

// CLI: scan ../src and exit non-zero on any violation.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const srcDir = join(fileURLToPath(new URL('..', import.meta.url)), 'src');
  const violations = findInboundViolations(srcDir);
  if (violations.length) {
    console.error(
      'Inbound SPA/server boundary violation (#2081): a raw network call lives outside the api-client chokepoint.\n'
    );
    for (const v of violations) {
      console.error(`  src/${v.file}:${v.line}: ${v.text}`);
    }
    console.error(
      '\nRoute the call through src/lib/api-client.ts so the single chokepoint owns it' +
        ' (the spa-boundary job guards the outbound half). If this module is a genuine' +
        ' network owner, add it to NETWORK_OWNERS in scripts/check-inbound-boundary.mjs' +
        ' with a justifying comment.'
    );
    process.exit(1);
  }
  console.log(
    `Inbound boundary clean: no raw network primitives outside the ${NETWORK_OWNERS.length} sanctioned owners.`
  );
}
