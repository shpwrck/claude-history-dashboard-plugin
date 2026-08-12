#!/usr/bin/env node
// Gate: a tracked source file must not contain a NUL byte (#3417).
//
// A NUL makes git classify the whole file as BINARY. Nothing about the
// program's behaviour changes — which is exactly why this survives every other
// gate — but the file stops being reviewable: `git diff` and GitHub both render
// "Bin 3175 -> 3180 bytes" instead of a diff, so any later change to it lands
// unseen.
//
// This has happened at least twice. `scripts/shell-quote-parity.test.mjs`
// merged in #3415 as a binary blob because an editing tool wrote a literal NUL
// into its fixture corpus; the suite passed, lint passed, and all 15 CI checks
// were green. It was caught only by the manual post-merge `git show --stat`
// inspection the repo requires (#124), and repaired in #3416. Three
// NUL-bearing files were then found already on master, one of them a 15 kB
// parser (#3417 fixed those in the same change as this gate).
//
// THE IDIOM IS NOT THE PROBLEM. All of those sites used NUL deliberately, as a
// separator when composing a Map key from two strings:
//
//     const key = `${a}\u0000${b}`;
//
// which is sound — NUL cannot occur in either component. The fix is to spell it
// as the ESCAPE `\u0000` rather than embedding a raw NUL byte: identical value
// at runtime, and the file stays text. The error message says so, because a
// gate that reads as "this technique is banned" gets worked around.
//
// SWEEPING FOR THIS FROM BASH DOES NOT WORK. `grep -q $'\x00'` cannot match:
// bash cannot hold a NUL in a string, so the pattern degrades to the empty
// string and matches EVERY file. A first attempt at this sweep reported all
// 1,026 files under src/ and scripts/ as binary. Use a byte scan in a language
// that can represent NUL (as here), `git diff --numstat` (binary shows as
// `-\t-`), or `git grep -I`.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Directories whose contents are scanned. Binary assets live outside these. */
export const SCANNED_ROOTS = Object.freeze(['src', 'scripts']);

/**
 * Extensions that must be text. Deliberately an allowlist rather than a
 * denylist of binary types: a genuine binary fixture added under `src/` with an
 * unlisted extension is simply not scanned, so the gate cannot fail on an asset
 * it was never meant to police.
 */
export const TEXT_EXTENSIONS = Object.freeze([
  '.ts',
  '.tsx',
  '.mjs',
  '.js',
  '.cjs',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.css',
  '.html',
]);

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'dist-sample',
  'coverage',
  'playwright-report',
  'test-results',
  '_plugin_payload',
]);

function listFiles(directory, accumulated = []) {
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
      listFiles(join(directory, entry.name), accumulated);
      continue;
    }
    // Symlinks are neither followed nor read — matching check-shell-quote.mjs.
    if (!entry.isFile()) continue;
    if (!TEXT_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
    accumulated.push(join(directory, entry.name));
  }
  return accumulated;
}

/** Number of NUL bytes in a buffer — the thing that makes git call a file binary. */
export function nulCount(buffer) {
  let count = 0;
  for (const byte of buffer) if (byte === 0) count += 1;
  return count;
}

/**
 * Every scanned file holding at least one NUL byte, with its count and first
 * offset. Throws when a CONFIGURED root does not exist (#3478): a renamed or
 * moved src/ used to be silently skipped, producing a green NUL-gate that had
 * scanned nothing — absence of the tree is a config failure, not cleanliness.
 */
export function scanForBinarySources(root = REPO_ROOT, roots = SCANNED_ROOTS) {
  const offenders = [];
  for (const scanned of roots) {
    const directory = join(root, scanned);
    let stat;
    try {
      stat = statSync(directory);
    } catch {
      throw new Error(
        `configured scan root "${scanned}" not found at ${directory} — the gate would ` +
          `verify NOTHING there. A renamed/moved source root must update SCANNED_ROOTS ` +
          `in scripts/check-no-binary-sources.mjs, not silently green the gate.`
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(
        `configured scan root "${scanned}" at ${directory} is not a directory — ` +
          `update SCANNED_ROOTS in scripts/check-no-binary-sources.mjs.`
      );
    }
    for (const absolute of listFiles(directory)) {
      const buffer = readFileSync(absolute);
      const count = nulCount(buffer);
      if (count === 0) continue;
      offenders.push({
        file: relative(root, absolute).split(sep).join('/'),
        nuls: count,
        firstByteOffset: buffer.indexOf(0),
      });
    }
  }
  return offenders;
}

function main() {
  // Optional root override (default: this repo) so the gate's own tests can
  // point the real CLI at a fixture tree and assert its exit codes (#3478).
  const rootArg = process.argv[2];
  let offenders;
  try {
    offenders = scanForBinarySources(rootArg ? resolve(rootArg) : REPO_ROOT);
  } catch (err) {
    // A missing/invalid configured root: the gate verified nothing. Exit 2 to
    // distinguish "misconfigured, inspected nothing" from "found NULs" (1).
    console.error(`::error::${err.message}`);
    process.exit(2);
  }
  for (const { file, nuls, firstByteOffset } of offenders) {
    console.error(
      `::error file=${file}::${file} contains ${nuls} NUL byte(s) (first at offset ` +
        `${firstByteOffset}), so git stores it as BINARY and it renders no diff — any ` +
        `later change to it lands unreviewed. If the NUL is deliberate (a separator in ` +
        `a composite key is a sound use), write it as the escape \\u0000 instead of a ` +
        `raw byte: identical at runtime, and the file stays reviewable.`
    );
  }
  if (offenders.length > 0) process.exit(1);
  console.log(
    `No NUL bytes in tracked ${SCANNED_ROOTS.join('/')} sources — every source file is diffable.`
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
