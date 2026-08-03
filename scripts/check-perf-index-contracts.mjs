#!/usr/bin/env node
// Eager-index recurrence gate (#3481, epic #1930).
//
// A newly-added Map/Set/sorted-index precomputation in production code must make its
// consumption contract reviewable in the same diff:
//
//   // perf-index-contract: <id> non-querying
//     Requires a matching marker in an added test plus a literal zero-work
//     assertion. The test is the discriminating proof that the index stays
//     lazy on an input that never queries it.
//
//   // perf-index-contract: <id> always-consumed: <concrete reason>
//     For paths where every successful call necessarily queries the index.
//     The reason is required so this cannot collapse into a bare suppression.
//
// The gate is diff-scoped: existing Map/Set uses are grandfathered, while the
// next performance refactor cannot add one without choosing and proving its
// contract. CI runs this from the full-history `changes` checkout.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?)$/;
const TEST_PATH_RE = /(?:^|\/)(?:[^/]+\.)?(?:test|spec)\.[cm]?[jt]sx?$/;
const CONTRACT_RE =
  /^\s*\/\/\s*perf-index-contract:\s*([a-z0-9][a-z0-9-]*)\s+(non-querying|always-consumed)(?::\s*(.*))?/i;
const ZERO_ASSERTION_RE =
  /(?:\.to(?:Be|Equal)\(\s*0\s*\)|assert\.(?:equal|strictEqual)\([^,\n]+,\s*0\s*\))/;
const MIN_RATIONALE_LENGTH = 24;
const CONTRACT_LOOKBACK_LINES = 6;

function productionPath(path) {
  return SOURCE_EXT_RE.test(path) && !TEST_PATH_RE.test(path);
}

function addsPrecomputation(content) {
  const code = content.replace(/\/\/.*$/, '');
  return /\bnew\s+(?:Map|Set)\b/.test(code) || /\.(?:sort|toSorted)\s*\(/.test(code);
}

function parseAddedLines(unifiedDiff) {
  const files = [];
  let current = null;
  let newLine = 0;
  let hunk = 0;
  for (const raw of unifiedDiff.split(/\r?\n/)) {
    if (raw.startsWith('diff --git ')) {
      current = null;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const value = raw.slice(4).trim();
      const path = value === '/dev/null' ? null : value.replace(/^b\//, '');
      current = path ? { path, lines: [] } : null;
      if (current) files.push(current);
      continue;
    }
    const hunkMatch = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)/.exec(raw);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1]);
      hunk += 1;
      continue;
    }
    if (!current || raw.startsWith('--- ')) continue;
    if (raw.startsWith('+')) {
      current.lines.push({ content: raw.slice(1), added: true, line: newLine, hunk });
      newLine += 1;
      continue;
    }
    if (raw.startsWith(' ')) {
      current.lines.push({ content: raw.slice(1), added: false, line: newLine, hunk });
      newLine += 1;
      continue;
    }
    if (raw.startsWith('-')) continue;
    // "\\ No newline at end of file" and other metadata do not advance a line.
  }
  return files;
}

function nearestContract(lines, index) {
  const start = Math.max(0, index - CONTRACT_LOOKBACK_LINES);
  const hunk = lines[index].hunk;
  for (let i = index; i >= start; i -= 1) {
    if (lines[i].hunk !== hunk) break;
    const match = CONTRACT_RE.exec(lines[i].content);
    if (match) {
      return {
        id: match[1].toLowerCase(),
        kind: match[2].toLowerCase(),
        rationale: (match[3] ?? '').trim(),
      };
    }
  }
  return null;
}

function testProofs(files) {
  const proofs = Object.create(null);
  for (const file of files) {
    if (!TEST_PATH_RE.test(file.path)) continue;
    const added = file.lines.filter((line) => line.added);
    for (const line of added) {
      const match = CONTRACT_RE.exec(line.content);
      if (!match || match[2].toLowerCase() !== 'non-querying') continue;
      const id = match[1].toLowerCase();
      const hasZeroAssertion = added.some(
        (candidate) =>
          candidate.hunk === line.hunk && ZERO_ASSERTION_RE.test(candidate.content)
      );
      proofs[id] ??= [];
      proofs[id].push({ path: file.path, hasZeroAssertion });
    }
  }
  return proofs;
}

export function evaluatePerfIndexContracts(unifiedDiff) {
  const files = parseAddedLines(unifiedDiff);
  const proofs = testProofs(files);
  const errors = [];
  const contracts = [];

  for (const file of files) {
    if (!productionPath(file.path)) continue;
    for (let i = 0; i < file.lines.length; i += 1) {
      const line = file.lines[i];
      if (!line.added || !addsPrecomputation(line.content)) continue;
      const contract = nearestContract(file.lines, i);
      if (!contract) {
        errors.push(
          `${file.path}:${line.line} adds an eager Map/Set/sorted-index precomputation but is missing a perf-index-contract declaration within ${CONTRACT_LOOKBACK_LINES} lines.`
        );
        continue;
      }
      contracts.push(contract.id);
      if (contract.kind === 'always-consumed') {
        const words = contract.rationale.split(/\s+/).filter(Boolean);
        if (
          contract.rationale.length < MIN_RATIONALE_LENGTH ||
          words.length < 4
        ) {
          errors.push(
            `${file.path}:${line.line} contract ${contract.id} needs a concrete always-consumed rationale (at least ${MIN_RATIONALE_LENGTH} characters and four words).`
          );
        }
        continue;
      }
      const matchingProof = (proofs[contract.id] ?? []).find(
        (proof) => proof.hasZeroAssertion
      );
      if (!matchingProof) {
        errors.push(
          `${file.path}:${line.line} contract ${contract.id} needs a matching added zero-work regression test marker and a literal assertion against 0.`
        );
      }
    }
  }

  const uniqueContracts = contracts
    .filter((id, index) => contracts.indexOf(id) === index)
    // perf-index-contract: contract-report-order always-consumed: every successful gate immediately reports the complete contract list deterministically
    .sort();
  return { ok: errors.length === 0, errors, contracts: uniqueContracts };
}

function gitDiff() {
  const explicit = process.env.PERF_INDEX_BASE_REF;
  const baseRef = process.env.GITHUB_BASE_REF;
  const baseSha = process.env.GITHUB_EVENT_PULL_REQUEST_BASE_SHA;
  const headSha = process.env.GITHUB_EVENT_PULL_REQUEST_HEAD_SHA;
  const attempts = [];
  if (baseSha && headSha) attempts.push([`${baseSha}...${headSha}`]);
  if (explicit) attempts.push([`${explicit}...HEAD`]);
  if (baseRef) attempts.push([`origin/${baseRef}...HEAD`]);
  // Local runs include tracked staged/unstaged edits so the gate is useful
  // before commit. CI uses the immutable PR base/head ranges above.
  if (!baseSha && !baseRef && !explicit) attempts.push(['origin/master']);

  const errors = [];
  for (const range of attempts) {
    try {
      return execFileSync('git', ['diff', '--unified=6', ...range], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      errors.push(`${range.join(' ')}: ${error.message}`);
    }
  }
  throw new Error(
    `could not resolve the PR/base diff for the perf-index gate. ${errors.join(' | ')}`
  );
}

function main() {
  let result;
  try {
    result = evaluatePerfIndexContracts(gitDiff());
  } catch (error) {
    console.error(`Perf-index contract gate could not run: ${error.message}`);
    process.exit(2);
  }
  if (!result.ok) {
    console.error(
      'Eager-index contract violations (#3481): added Map/Set/sorted-index precomputations must prove the non-querying path stays at zero work, or explain why every call consumes the index.'
    );
    for (const error of result.errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(
    `Perf-index contract gate passed (${result.contracts.length} declared contract(s) in this diff).`
  );
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) main();
