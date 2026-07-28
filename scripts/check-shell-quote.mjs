#!/usr/bin/env node
// Gate: the POSIX shell-quoting escape is written in ONE place (#3379).
//
// Several v0.6 audit High findings were the same defect — untrusted artifact
// text interpolated into a copyable snippet without quoting (#3212, #3213,
// #3230, #3231, PR #3372). It recurred because there was nothing central to
// reach for: five call sites had each re-typed the escape, and they had already
// drifted. Extracting the primitive only helps if the next author cannot
// quietly re-type it, so this gate makes that fail CI instead of review.
//
// WHAT THIS GATE CLAIMS, EXACTLY: it fails when a file outside the canonical
// modules spells the escape idiom the way every copy in this repo has spelled
// it — the literal `'\''` sequence as it appears in JS/TS source, or a
// `.replace`/`.replaceAll` of a single-quote pattern. It is a recurrence guard
// for a known idiom, NOT a proof that no other quoting scheme exists; a helper
// that quotes some entirely different way is a different bug and will not trip
// this. Overclaiming here would itself be an audit finding.
//
// Test files are exempt: asserting on `'\''` in expected output is exactly what
// a good test for this looks like, and tests ship in no bundle.
//
// SCOPE, stated so the pass is not read as broader than it is: it walks .ts,
// .tsx, .mjs, .js and .cjs under the repo root, skipping vendored/build output
// and every dot-directory (.git, .github, .claude worktrees), and it does not
// follow symlinks — a symlinked file or directory is skipped, not traversed.

import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The only two files allowed to spell the escape. See scripts/shell-quote-parity.test.mjs. */
export const CANONICAL = Object.freeze([
  'src/lib/shell-quote.ts',
  'scripts/lib/shell-quote.mjs',
]);

/**
 * The gate cannot police itself: to search for the idiom it must contain the
 * idiom, both in `ESCAPE_IDIOM`/`QUOTE_REPLACE_RE` and in the error text that
 * shows an author what tripped. Skipped explicitly rather than silently.
 */
const SELF = 'scripts/check-shell-quote.mjs';

/**
 * Files that still hold their own copy and structurally cannot import either
 * canonical module. Frozen and shrink-only: the gate fails if an entry stops
 * tripping (remove it) or stops existing (remove it), so this can never rot
 * into a standing bypass. Adding an entry is a deliberate, reviewable edit.
 */
export const KNOWN_EXCEPTIONS = Object.freeze({
  // Workflow-tool scripts execute in a sandbox with no module resolution — they
  // are handed to the Workflow runtime as a self-contained source string, so an
  // `import` is not available to them at any path. Tracked by #3379.
  'scripts/audits/v060-audit-batch.workflow.mjs':
    'Workflow-tool script: runs with no module resolution, so it cannot import a shared leaf',
});

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js', '.cjs'];
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'dist-spa',
  'dist-sample',
  '.git',
  'coverage',
  'playwright-report',
  'test-results',
  '_plugin_payload',
]);

/**
 * The escape as it appears in JS/TS source: an apostrophe, an escaped
 * backslash, then two apostrophes — `'\\''` in a template or string literal.
 */
const ESCAPE_IDIOM = "'\\\\''";

/** A `.replace(/'/g, …)` / `.replaceAll("'", …)` — the escape regardless of how the replacement is spelled. */
const QUOTE_REPLACE_RE = /\.replace(?:All)?\(\s*(?:\/'\/g|"'"|'\\''|`'`)/;

function isTestFile(relativePath) {
  const base = relativePath.split('/').pop() ?? '';
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) || relativePath.startsWith('src/test/');
}

function listSourceFiles(directory, accumulated = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
      listSourceFiles(join(directory, entry.name), accumulated);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
    accumulated.push(join(directory, entry.name));
  }
  return accumulated;
}

/** Why `file` trips the gate, or null when it does not. */
export function violationIn(source) {
  if (source.includes(ESCAPE_IDIOM)) {
    return `spells the \`'\\''\` escape idiom directly`;
  }
  if (QUOTE_REPLACE_RE.test(source)) {
    return 'replaces a single-quote pattern, which is how this escape is built';
  }
  return null;
}

export function scanRepository(
  root = REPO_ROOT,
  { canonical = CANONICAL, exceptions = KNOWN_EXCEPTIONS, self = SELF } = {}
) {
  const offenders = [];
  const exceptionsSeen = new Set();
  for (const absolute of listSourceFiles(root)) {
    const relativePath = relative(root, absolute).split(sep).join('/');
    if (canonical.includes(relativePath) || relativePath === self) continue;
    if (isTestFile(relativePath)) continue;
    const reason = violationIn(readFileSync(absolute, 'utf8'));
    if (!reason) continue;
    if (relativePath in exceptions) {
      exceptionsSeen.add(relativePath);
      continue;
    }
    offenders.push({ file: relativePath, reason });
  }
  const staleExceptions = Object.keys(exceptions).filter((file) => {
    if (exceptionsSeen.has(file)) return false;
    try {
      statSync(join(root, file));
    } catch {
      return true; // gone entirely
    }
    return true; // present but no longer tripping
  });
  return { offenders, staleExceptions };
}

function main() {
  const { offenders, staleExceptions } = scanRepository();
  let failed = false;

  for (const { file, reason } of offenders) {
    failed = true;
    console.error(
      `::error file=${file}::${file} ${reason}. Import the shared primitive instead: ` +
        `\`shellQuote\` / \`shellQuoteMinimal\` from src/lib/shell-quote.ts (TypeScript) or ` +
        `scripts/lib/shell-quote.mjs (plain node scripts). Five hand-typed copies of this ` +
        `escape drifted apart and caused a run of High audit findings (#3379); there is ` +
        `deliberately one implementation now.`
    );
  }

  for (const file of staleExceptions) {
    failed = true;
    console.error(
      `::error file=scripts/check-shell-quote.mjs::${file} is listed in KNOWN_EXCEPTIONS but no ` +
        `longer holds its own copy of the escape (or no longer exists). Delete the entry — the ` +
        `exception list is shrink-only so it cannot become a standing bypass.`
    );
  }

  if (failed) process.exit(1);
  const exceptionCount = Object.keys(KNOWN_EXCEPTIONS).length;
  console.log(
    `Shell-quoting escape is confined to ${CANONICAL.join(' + ')}` +
      (exceptionCount ? `, plus ${exceptionCount} tracked exception(s).` : '.')
  );
}

// Resolve through symlinks before comparing (the house pattern, see
// check-enterprise-route-inventory.mjs). A raw string compare can miss under a
// symlinked checkout, and a gate whose main() silently fails to fire exits 0
// and reports nothing — green CI proving nothing, which is the failure mode
// this gate exists to prevent.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
