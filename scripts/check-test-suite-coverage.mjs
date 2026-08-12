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
// so there is no second suite-wiring list to keep in sync. #3742 adds only a
// bounded owner registry for explicit workflow roots and manual commands.

import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ALLOWED_TEST_SUITE_OWNERS,
  TEST_SUITE_OWNERS,
  WORKFLOW_TEST_OWNER_BY_JOB,
} from './lib/test-suite-owners.mjs';

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
const TEST_SCRIPT_INVOKE_RE = /\bnpm\s+run\s+(test:[^\s&|;()]+)/g;

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

// Block-scalar headers: `|`, `>`, with optional chomping/indentation indicators.
const BLOCK_SCALAR_RE = /^[|>][+-]?\d*$/;

/**
 * Executable shell from a workflow: the `jobs.*.steps[*].run` scalars, and
 * nothing else (#3075).
 *
 * The gate previously matched suite paths and `npm run` names anywhere in the
 * whole document, so a suite named in an inert field — `env:`, `name:`, a
 * `with:` input, arbitrary metadata — was accepted as PROOF that CI runs it.
 * Absence of an executable step is not evidence that a step exists: only a
 * `run:` command actually executes, so only a `run:` command counts.
 *
 * This is a deliberately small structural scan (no YAML dependency in a
 * zero-dependency gate): it tracks indentation to build the key path, and
 * accepts a `run` key only at `jobs.<job>.steps[*].run`. `defaults.run:` is a
 * MAPPING, not a command, and is skipped because its value is neither an inline
 * scalar nor a block-scalar header.
 */
export function extractRunCommands(yamlText) {
  const lines = yamlText.split('\n');
  const commands = [];
  const stack = []; // { indent, key }
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const lineIndent = raw.length - raw.trimStart().length;
    // A step is a sequence item: `- run: …` / `- name: …`. Each `- ` marker
    // shifts the effective key indent right by 2.
    let rest = raw.slice(lineIndent);
    let keyIndent = lineIndent;
    while (rest.startsWith('- ') || rest === '-') {
      const consumed = rest.startsWith('- ') ? 2 : 1;
      rest = rest.slice(consumed);
      keyIndent += consumed;
    }
    const m = /^([A-Za-z_][\w.-]*)\s*:(\s|$)/.exec(rest);
    if (!m) continue;
    const key = m[1];
    const value = rest.slice(m[0].length).trim();
    while (stack.length && stack[stack.length - 1].indent >= keyIndent) stack.pop();
    stack.push({ indent: keyIndent, key });
    const path = stack.map((e) => e.key);
    const isStepRun =
      key === 'run' && path.length === 4 && path[0] === 'jobs' && path[2] === 'steps';
    if (BLOCK_SCALAR_RE.test(value)) {
      // Block scalar: every following line indented deeper than the key. Consume
      // it here (whether or not it is a step `run`) so its contents are never
      // re-read as structure — a heredoc that happens to contain `run:` is data.
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const next = lines[j];
        if (!next.trim()) {
          body.push('');
          continue;
        }
        const nextIndent = next.length - next.trimStart().length;
        if (nextIndent <= keyIndent) break;
        body.push(next);
      }
      i = j - 1;
      if (isStepRun) commands.push(body.join('\n'));
      continue;
    }
    if (!isStepRun) continue;
    if (value) {
      // Inline scalar; drop a surrounding quote pair if present.
      commands.push(value.replace(/^(['"])([\s\S]*)\1$/, '$2'));
    }
  }
  return commands;
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
    // Only executable `jobs.*.steps[*].run` shell counts as wiring (#3075) —
    // suite paths sitting in `env:`/`name:`/metadata prove nothing runs.
    const runs = extractRunCommands(readFileSync(join(wfDir, entry.name), 'utf8'));
    for (const command of runs) {
      const text = stripComments(command);
      for (const ref of extractSuiteRefs(text)) {
        for (const f of expandRef(ref, universe)) wired.add(f);
      }
      for (const m of text.matchAll(NPM_INVOKE_RE)) {
        const name = m[1] ?? m[2];
        const files = scriptFiles.get(name);
        if (files) for (const f of files) wired.add(f);
      }
    }
  }
  return wired;
}

/** Executable run commands paired with their top-level workflow job id. */
export function extractJobRunCommands(yamlText) {
  const lines = yamlText.split('\n');
  const jobsIndex = lines.findIndex((line) => line === 'jobs:');
  if (jobsIndex < 0) return [];
  const commands = [];
  for (let i = jobsIndex + 1; i < lines.length; i += 1) {
    const jobMatch = /^  ([A-Za-z0-9_-]+):$/.exec(lines[i]);
    if (!jobMatch) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^  [A-Za-z0-9_-]+:$/.test(lines[j])) {
        end = j;
        break;
      }
    }
    const jobYaml = ['jobs:', ...lines.slice(i, end)].join('\n');
    for (const command of extractRunCommands(jobYaml)) {
      commands.push({ job: jobMatch[1], command });
    }
    i = end - 1;
  }
  return commands;
}

/** Explicit workflow roots plus the conceptual owner of each run location. */
export function collectWorkflowTestRootOwners(
  repoRoot,
  { workflowOwners = WORKFLOW_TEST_OWNER_BY_JOB } = {}
) {
  // perf-index-contract: workflow-test-root-index always-consumed: every collection call returns the complete root index to the ownership validation scan
  const roots = new Map();
  const unowned = [];
  const wfDir = join(repoRoot, '.github', 'workflows');
  for (const entry of readdirSync(wfDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const runs = extractJobRunCommands(
      readFileSync(join(wfDir, entry.name), 'utf8')
    );
    for (const { job, command } of runs) {
      const location = `${entry.name}#${job}`;
      const owner = workflowOwners[location];
      for (const match of stripComments(command).matchAll(TEST_SCRIPT_INVOKE_RE)) {
        const script = match[1];
        // perf-index-contract: workflow-test-root-membership always-consumed: every matched root immediately records and later validates each run location and conceptual owner
        const record = roots.get(script) ?? {
          locations: new Set(),
          owners: new Set(),
        };
        record.locations.add(location);
        if (owner) record.owners.add(owner);
        else unowned.push({ script, location });
        roots.set(script, record);
      }
    }
  }
  return { roots, unowned };
}

function isUnitUmbrellaAlias(command, testCommand) {
  const hasDefaultUmbrella = testCommand
    .split(/\s*(?:&&|\|\||;)\s*/)
    .some((segment) => segment.trim() === 'vitest run');
  if (!hasDefaultUmbrella) return false;
  const match = /^\s*vitest\s+run(?:\s+(.+?))?\s*$/.exec(command);
  if (!match) return false;
  const args = match[1]?.trim().split(/\s+/) ?? [];
  // Positional file/name filters select a subset of the default umbrella.
  // Options can change config, environment, or project membership, so they
  // need an explicit root/manual owner instead of an inferred coverage claim.
  return args.every((arg) => !arg.startsWith('-') && !/[&|;]/.test(arg));
}

/**
 * Reconcile every package `test:*` command as exactly one of:
 *
 * - an explicitly registered workflow root;
 * - a convenience alias whose suite is already reached elsewhere (including
 *   Vitest aliases covered by the `npm test` umbrella); or
 * - an explicitly registered manual/watch/update command.
 */
export function findTestScriptOwnershipErrors(
  repoRoot,
  {
    owners = TEST_SUITE_OWNERS,
    workflowOwners = WORKFLOW_TEST_OWNER_BY_JOB,
  } = {}
) {
  const errors = [];
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const pkgScripts = pkg.scripts ?? {};
  // perf-index-contract: test-script-validation-order always-consumed: every validation call iterates the complete deterministic package-script order during reconciliation
  const testScripts = Object.keys(pkgScripts)
    .filter((name) => name.startsWith('test:'))
    .sort();
  // perf-index-contract: test-script-validation-memberships always-consumed: every validation call queries all membership sets while reconciling roots, owners, and aliases
  const testScriptSet = new Set(testScripts);
  const allowedOwners = new Set(ALLOWED_TEST_SUITE_OWNERS);
  const workflowOwnership = collectWorkflowTestRootOwners(repoRoot, {
    workflowOwners,
  });
  const workflowRoots = new Set(workflowOwnership.roots.keys());

  for (const { script, location } of workflowOwnership.unowned) {
    errors.push(`${script} runs from ${location}, whose workflow job has no owner`);
  }

  // perf-index-contract: test-script-owner-order always-consumed: every validation call scans the complete deterministic owner registry to report all topology errors
  for (const [script, owner] of Object.entries(owners).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (!allowedOwners.has(owner)) {
      errors.push(
        `${script} uses ${owner}, which is not an allowed owner (${ALLOWED_TEST_SUITE_OWNERS.join(
          ', '
        )})`
      );
    }
    if (!testScriptSet.has(script)) {
      errors.push(`${script} is registered to ${owner} but is absent from package.json`);
      continue;
    }
    if (owner === 'manual' && workflowRoots.has(script)) {
      errors.push(`${script} is registered manual but is an executable workflow root`);
    } else if (owner !== 'manual' && !workflowRoots.has(script)) {
      errors.push(`${script} is registered to ${owner} but is not a workflow root`);
    } else if (owner !== 'manual') {
      const actualOwners = workflowOwnership.roots.get(script).owners;
      for (const actualOwner of actualOwners) {
        if (actualOwner !== owner) {
          errors.push(
            `${script} is registered to ${owner} but runs under ${actualOwner}`
          );
        }
      }
    }
  }

  // perf-index-contract: workflow-test-root-order always-consumed: every validation call scans the complete deterministic root order for missing registrations
  for (const script of [...workflowRoots].sort()) {
    if (!Object.hasOwn(owners, script)) {
      errors.push(`${script} is an executable workflow root but is not registered`);
    }
  }

  const universe = listSuiteFiles(repoRoot);
  const scriptFiles = resolveScriptFiles(pkgScripts, universe);
  const wiredSuites = collectWiredSuites(repoRoot, universe, pkgScripts);
  const unitUmbrella = pkgScripts.test ?? '';
  for (const script of testScripts) {
    if (Object.hasOwn(owners, script) || workflowRoots.has(script)) continue;
    const command = pkgScripts[script];
    const referencedSuites = scriptFiles.get(script);
    const isCoveredSuiteAlias =
      referencedSuites.size > 0 &&
      [...referencedSuites].every((suite) => wiredSuites.has(suite));
    if (!isCoveredSuiteAlias && !isUnitUmbrellaAlias(command, unitUmbrella)) {
      errors.push(
        `${script} is neither a workflow root, a covered suite alias, nor registered manual`
      );
    }
  }

  return errors;
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
  const ownershipErrors = findTestScriptOwnershipErrors(repoRoot);
  if (unwired.length) {
    console.error(
      'Unwired test suites (#2954): the following scripts/**/*.test.mjs run in NO\n' +
        'workflow, so they gate nothing and can rot silently. Wire each into a\n' +
        'workflow (add an npm "test:*" script and a ci.yml/test.yml step that runs\n' +
        'it), or — if a suite is intentionally manual — add it to EXCLUDED_SUITES in\n' +
        'scripts/check-test-suite-coverage.mjs with a justifying comment.\n'
    );
    for (const f of unwired) console.error(`  ${f}`);
  }
  if (ownershipErrors.length) {
    console.error(
      'Test-script ownership errors (#3742): every executable workflow root must\n' +
        'have one bounded owner, aliases must already be covered, and manual\n' +
        'commands must be declared explicitly.\n'
    );
    for (const error of ownershipErrors) console.error(`  ${error}`);
  }
  if (unwired.length || ownershipErrors.length) {
    process.exit(1);
  }
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const testScriptCount = Object.keys(pkg.scripts ?? {}).filter((name) =>
    name.startsWith('test:')
  ).length;
  console.log(
    `Test-suite coverage gate passed: every scripts/**/*.test.mjs (${listSuiteFiles(
      fileURLToPath(new URL('..', import.meta.url))
    ).length} suites) is invoked by a workflow; all ${testScriptCount} test:* commands have a workflow, covered-alias, or manual owner.`
  );
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) main();
