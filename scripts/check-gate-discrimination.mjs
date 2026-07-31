#!/usr/bin/env node
// Gate discrimination check (#3478, epic #1930): every gate must be ABLE to fail.
//
// A verification surface whose tests only exercise the passing path is
// indistinguishable from `exit 0` — the class this repo keeps re-shipping
// (the repo-map tautology #3452, the bundle-size shell fail-open, the
// engine-absent empty-dist pass, ...). This check makes the class
// non-recurring by construction:
//
//   1. Every gate surface — a package.json `gate:*` script or a
//      scripts/check-*.mjs file — must be registered in
//      scripts/lib/gate-registry.mjs. A new gate that does not register fails
//      CI here on arrival.
//   2. A registry entry's `discriminatingTest` must point at a test file that
//      exists (scripts/ or src/), so a deleted/renamed suite cannot leave a
//      gate claiming coverage it no longer has.
//   3. `discriminatingTest: null` is allowed ONLY for the names seeded in
//      LEGACY_NULL_GATES — and that list only SHRINKS. Landing a gate's
//      must-fail test means removing its name from the list; adding a name
//      (or a new null entry) fails.
//
// Run: node scripts/check-gate-discrimination.mjs   (npm run gate:discrimination)

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { GATE_REGISTRY, LEGACY_NULL_GATES } from './lib/gate-registry.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// A scripts/*.mjs path inside a package script command. Commands may carry a
// loader before the gate (`node --import ./scripts/register-ts.mjs
// scripts/x.mjs`), so the LAST match is the gate script itself.
const SCRIPT_PATH_RE = /(?:\.\/)?scripts\/[^\s'"]+\.mjs/g;

/**
 * Derive the enforced gate surfaces from the repo itself:
 * package.json `gate:*` scripts (resolved to the script file they run) and
 * every scripts/check-*.mjs file (excluding *.test.mjs suites).
 * Returns Map<scriptPath, Set<sourceDescription>>.
 */
export function collectGateSurfaces(repoRoot = REPO_ROOT) {
  const surfaces = new Map();
  const add = (script, source) => {
    if (!surfaces.has(script)) surfaces.set(script, new Set());
    surfaces.get(script).add(source);
  };

  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    if (!name.startsWith('gate:')) continue;
    const matches = [...String(command).matchAll(SCRIPT_PATH_RE)].map((m) =>
      m[0].replace(/^\.\//, '')
    );
    add(matches.length > 0 ? matches[matches.length - 1] : `<unresolved:${name}>`, `package.json "${name}"`);
  }

  for (const entry of readdirSync(join(repoRoot, 'scripts'), { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith('check-') || !entry.name.endsWith('.mjs')) continue;
    if (entry.name.endsWith('.test.mjs')) continue;
    add(`scripts/${entry.name}`, `scripts/${entry.name}`);
  }

  return surfaces;
}

/**
 * Pure audit, injectable for the must-reject tests. Returns the list of
 * failure messages (empty = the registry is sound).
 */
export function auditGateDiscrimination({
  surfaces,
  registry = GATE_REGISTRY,
  legacyNulls = LEGACY_NULL_GATES,
  testExists = (path) => existsSync(join(REPO_ROOT, path)),
}) {
  const failures = [];

  const byScript = new Map();
  const byName = new Map();
  for (const entry of registry) {
    if (byName.has(entry.name)) {
      failures.push(`duplicate registry entry name "${entry.name}"`);
    }
    byName.set(entry.name, entry);
    if (byScript.has(entry.script)) {
      failures.push(`duplicate registry entry script "${entry.script}"`);
    }
    byScript.set(entry.script, entry);
  }

  // (1) every derived gate surface is registered.
  for (const [script, sources] of surfaces) {
    if (byScript.has(script)) continue;
    failures.push(
      `unregistered gate surface: ${script} (via ${[...sources].join(', ')}) — every gate ` +
        `must be listed in scripts/lib/gate-registry.mjs with a discriminating (must-fail) ` +
        `test. A null entry is not an option for new gates: the legacy exception list only shrinks.`
    );
  }

  // (2) named tests exist, in the allowed trees.
  for (const entry of registry) {
    const test = entry.discriminatingTest;
    if (test === null) continue;
    if (typeof test !== 'string' || !(test.startsWith('scripts/') || test.startsWith('src/'))) {
      failures.push(
        `registry entry "${entry.name}" has an invalid discriminatingTest ${JSON.stringify(test)} — ` +
          `must be a scripts/ or src/ test path, or null only for seeded legacy exceptions`
      );
      continue;
    }
    if (!testExists(test)) {
      failures.push(
        `dangling discriminating test for "${entry.name}": ${test} does not exist — ` +
          `a renamed/deleted suite must update the registry, not leave the gate claiming coverage`
      );
    }
  }

  // (3) the null ratchet.
  const legacySet = new Set(legacyNulls);
  for (const entry of registry) {
    if (entry.discriminatingTest !== null) continue;
    if (!legacySet.has(entry.name)) {
      failures.push(
        `new null registry entry "${entry.name}": every NEW gate ships a discriminating test ` +
          `with the gate — the seeded legacy exception list (LEGACY_NULL_GATES) can only shrink (#3478)`
      );
    }
  }
  for (const name of legacySet) {
    const entry = byName.get(name);
    if (!entry) {
      failures.push(
        `stale legacy exception "${name}": no registry entry carries this name — remove it from LEGACY_NULL_GATES`
      );
    } else if (entry.discriminatingTest !== null) {
      failures.push(
        `stale legacy exception "${name}": its entry now names a discriminating test — ` +
          `remove the name from LEGACY_NULL_GATES (that removal IS the ratchet)`
      );
    }
  }

  return failures;
}

function main() {
  const surfaces = collectGateSurfaces();
  const failures = auditGateDiscrimination({ surfaces });

  // Registry hygiene beyond the audited invariants: a script path that no
  // longer exists means the registry itself rotted.
  for (const entry of GATE_REGISTRY) {
    if (!existsSync(join(REPO_ROOT, entry.script))) {
      failures.push(`registry entry "${entry.name}" points at a missing script: ${entry.script}`);
    }
  }

  if (failures.length > 0) {
    console.error('Gate discrimination check FAILED (#3478):\n');
    for (const f of failures) console.error(`  - ${f}`);
    console.error(
      '\nEvery gate surface needs a registered discriminating test — a test that drives ' +
        'the real gate and asserts it FAILS (non-zero exit) on bad input. See ' +
        'scripts/lib/gate-registry.mjs.'
    );
    process.exit(1);
  }

  const registered = GATE_REGISTRY.filter((e) => e.discriminatingTest !== null).length;
  console.log(
    `Gate discrimination check passed: ${GATE_REGISTRY.length} gate surfaces registered, ` +
      `${registered} with discriminating tests, ${LEGACY_NULL_GATES.length} seeded legacy ` +
      `exceptions remaining (shrink-only).`
  );
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) main();
