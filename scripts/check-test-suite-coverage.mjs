#!/usr/bin/env node
// Test-suite CI-coverage gate (#2954).
//
// Every scripts/**/*.test.mjs suite must be invoked by at least one root-level
// .github/workflows/*.yml workflow — either directly (`node --test
// scripts/x.test.mjs`) or transitively through an `npm run <script>` whose
// package.json command names it. A suite wired NOWHERE runs only when a human
// remembers to, so a security- or data-integrity-relevant contract can rot
// silently (the exact gap #2954 closed for 17 dark suites). This is the
// recurrence guard: add a new scripts/*.test.mjs and forget to wire it, and CI
// fails here.
//
// Run: node scripts/check-test-suite-coverage.mjs
//
// Modeled on scripts/check-enterprise-route-inventory.mjs (declared inventory vs
// live surface). The difference: the "reachable" set here is DERIVED, not
// hand-maintained — computed from package.json scripts + the workflow files —
// so there is no second list to keep in sync.

import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Suites intentionally NOT wired to any workflow. Keep this EMPTY where
// possible: every entry is a hole in the guarantee and needs a justifying
// comment naming why the suite runs nowhere in CI.
export const EXCLUDED_SUITES = [
  // (none — every scripts/**/*.test.mjs is wired into CI as of #2954)
];

// Matches a scripts/*.test.mjs reference (literal path or glob) inside a command
// or workflow string. An optional leading `./` is tolerated; register-ts.mjs and
// other non-`.test.mjs` scripts never match.
const SUITE_REF_RE = /(?:\.\/)?scripts\/[^\s'";|&()]*\.test\.mjs/g;

// npm script invocations: `npm run <name>` (captured) or bare `npm test`.
const NPM_INVOKE_RE = /\bnpm\s+(?:run\s+([^\s&|;()]+)|(test)(?![\w:-]))/g;

/** Recursively list every scripts test suite (a `.test.mjs` file), repo-relative with forward slashes. */
export function listSuiteFiles(repoRoot) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name.endsWith('.test.mjs')) {
        out.push(relative(repoRoot, full).split('\\').join('/'));
      }
    }
  };
  walk(join(repoRoot, 'scripts'));
  return out.sort();
}

/**
 * Strip comments from workflow YAML / shell text so a suite named in a COMMENT
 * (e.g. ci.yml's `# scripts/*.test.mjs …` notes) is not mistaken for a live
 * invocation. Drops full-line `#` comments and trailing ` #…` comments — the
 * `run:` commands we look for never carry a whitespace-preceded `#`.
 */
export function stripComments(text) {
  return text
    .split('\n')
    .map((line) => {
      if (line.trimStart().startsWith('#')) return '';
      const m = line.match(/\s#/);
      return m ? line.slice(0, m.index) : line;
    })
    .join('\n');
}

/** Extract scripts/*.test.mjs references (literal + glob) from a command string. */
export function extractSuiteRefs(command) {
  const refs = [];
  for (const m of command.matchAll(SUITE_REF_RE)) {
    refs.push(m[0].replace(/^\.\//, ''));
  }
  return refs;
}

/** Compile a filename glob (supporting `*` and `**`) to an anchored RegExp. */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 1;
      } else {
        re += '[^/]*';
      }
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Expand a ref (literal path or glob) to the matching universe files. */
function expandRef(ref, universe) {
  if (!ref.includes('*')) {
    return universe.includes(ref) ? [ref] : [];
  }
  const re = globToRegExp(ref);
  return universe.filter((f) => re.test(f));
}

/**
 * Map each package.json script name -> Set of universe files it (transitively,
 * through nested `npm run`/`npm test`) invokes.
 */
export function resolveScriptFiles(pkgScripts, universe) {
  const resolve = (name, seen) => {
    const files = new Set();
    if (seen.has(name)) return files; // cycle guard
    seen.add(name);
    const cmd = pkgScripts[name];
    if (typeof cmd !== 'string') return files;
    for (const ref of extractSuiteRefs(cmd)) {
      for (const f of expandRef(ref, universe)) files.add(f);
    }
    for (const m of cmd.matchAll(NPM_INVOKE_RE)) {
      const nested = m[1] ?? m[2];
      if (nested && pkgScripts[nested] !== undefined) {
        for (const f of resolve(nested, seen)) files.add(f);
      }
    }
    return files;
  };
  const result = new Map();
  for (const name of Object.keys(pkgScripts)) {
    result.set(name, resolve(name, new Set()));
  }
  return result;
}

/** The set of universe files reachable from any root workflow. */
export function collectWiredSuites(repoRoot, universe, pkgScripts) {
  const scriptFiles = resolveScriptFiles(pkgScripts, universe);
  const wired = new Set();
  const wfDir = join(repoRoot, '.github', 'workflows');
  for (const entry of readdirSync(wfDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const text = stripComments(readFileSync(join(wfDir, entry.name), 'utf8'));
    for (const ref of extractSuiteRefs(text)) {
      for (const f of expandRef(ref, universe)) wired.add(f);
    }
    for (const m of text.matchAll(NPM_INVOKE_RE)) {
      const name = m[1] ?? m[2];
      const files = scriptFiles.get(name);
      if (files) for (const f of files) wired.add(f);
    }
  }
  return wired;
}

/** Return the sorted list of scripts test suites wired into no workflow. */
export function findUnwiredSuites(repoRoot, { exclude = EXCLUDED_SUITES } = {}) {
  const universe = listSuiteFiles(repoRoot);
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const wired = collectWiredSuites(repoRoot, universe, pkg.scripts ?? {});
  const excluded = new Set(exclude);
  return universe.filter((f) => !wired.has(f) && !excluded.has(f)).sort();
}

function main() {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const unwired = findUnwiredSuites(repoRoot);
  if (unwired.length) {
    console.error(
      'Unwired test suites (#2954): the following scripts/**/*.test.mjs run in NO\n' +
        'workflow, so they gate nothing and can rot silently. Wire each into a\n' +
        'workflow (add an npm "test:*" script and a ci.yml/test.yml step that runs\n' +
        'it), or — if a suite is intentionally manual — add it to EXCLUDED_SUITES in\n' +
        'scripts/check-test-suite-coverage.mjs with a justifying comment.\n'
    );
    for (const f of unwired) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(
    `Test-suite coverage gate passed: every scripts/**/*.test.mjs (${listSuiteFiles(
      fileURLToPath(new URL('..', import.meta.url))
    ).length} suites) is invoked by a workflow.`
  );
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) main();
