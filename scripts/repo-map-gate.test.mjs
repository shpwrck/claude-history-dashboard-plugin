// Coverage for the repo-map measurement gate's ability to FAIL (#3452, epic #1930).
//
// Run under register-ts (the gate imports the TS repo-map barrel):
//   node --import ./scripts/register-ts.mjs --test scripts/repo-map-gate.test.mjs
//
// The defect this pins: `enforceSizeLimit` binary-searches the largest prefix of
// the ranked file list that fits the persisted ceiling and DROPS the rest, so the
// persisted size is clamped to that ceiling by construction. The gate then
// compared that clamped value against `datasetPayloadMaxBytes`, which was the
// SAME number — a tautology that could never fail, whatever the repo grew to.
// Growth was absorbed by silently shedding ranked files instead of failing CI.
//
// These tests drive the real script as a subprocess and assert on EXIT CODES,
// which is the only thing CI actually consumes. `--max-persisted-bytes` keeps
// them fast: it exercises the size-bounding path on a handful of files instead of
// requiring a 1 MiB corpus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runGate as runGateScript, PROJECT_DIR } from './lib/gate-harness.mjs';

const GATE = join(PROJECT_DIR, 'scripts', 'repo-map-gate.mjs');

/** A throwaway source root big enough to serialize past a small ceiling. */
function makeRoot(fileCount = 24) {
  const root = mkdtempSync(join(tmpdir(), 'repo-map-gate-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    // Real parseable TS with several exported symbols, so each file contributes
    // meaningful structure (names + signatures + imports) to the artifact.
    const imports = i > 0 ? `import { helper${i - 1} } from './mod${i - 1}';\n` : '';
    const body = Array.from(
      { length: 8 },
      (_, k) =>
        `export function helper${i}_${k}(argumentNumber${k}: string, second${k}: number): string {\n` +
        `  return argumentNumber${k} + String(second${k});\n}`
    ).join('\n');
    writeFileSync(
      join(root, 'src', `mod${i}.ts`),
      `${imports}export function helper${i}(): number { return ${i}; }\n${body}\n`
    );
  }
  return root;
}

function writeBudget(root, over = {}) {
  const budget = {
    unboundedPayloadMaxBytes: 100_000_000,
    retainedFilesMin: 0,
    coldIngestMaxMs: 600_000,
    localizationRecallMinPct: 0,
    rereadTokensSavedMin: 0,
    localizationTopK: 25,
    localizationSampleSize: 40,
    bodySentinels: [],
    ...over,
  };
  const path = join(root, 'budget.json');
  writeFileSync(path, JSON.stringify(budget, null, 2));
  return path;
}

function runGate(root, budgetPath, extra = [], env = {}) {
  // The shared gate-test harness (#3478) owns the spawn shape; this wrapper
  // only fixes the gate script + its --root/--budget plumbing.
  return runGateScript(GATE, ['--root', root, '--budget', budgetPath, ...extra], {
    env,
    registerTs: true,
  });
}

test('gate FAILS when the natural serialization exceeds its payload budget', () => {
  const root = makeRoot();
  try {
    // Establish the natural (unbounded) size for this corpus.
    const measure = runGate(root, writeBudget(root), ['--measure-only']);
    assert.equal(measure.code, 0, measure.out);
    const natural = Number(/payload \(unbounded\)\s+(\d+)\s*B/.exec(measure.out)?.[1]);
    assert.ok(Number.isInteger(natural) && natural > 0, `no unbounded size in:\n${measure.out}`);

    // Budget BELOW the natural size, and a persisted ceiling equally low so the
    // artifact is clamped hard. This is exactly the shape that used to pass: the
    // persisted value gets trimmed to the ceiling and compared against a budget
    // it can no longer exceed.
    const ceiling = Math.floor(natural / 2);
    const budget = writeBudget(root, { unboundedPayloadMaxBytes: ceiling });
    const gated = runGate(root, budget, ['--max-persisted-bytes', String(ceiling)]);

    assert.equal(gated.code, 1, `expected a gate failure, got:\n${gated.out}`);
    assert.match(gated.out, /Repo-map gate BLOCKED/);
    assert.match(gated.out, /payload \(unbounded\)/);

    // And the proof that the clamp really did engage — i.e. this is the case the
    // old gate silently passed, not merely an over-budget corpus.
    assert.match(gated.out, /size-bounded: dropped [1-9]\d*/);
    assert.match(gated.out, /not gated — clamped value/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate PASSES the same corpus when the payload budget is above its natural size', () => {
  const root = makeRoot();
  try {
    const budget = writeBudget(root, { unboundedPayloadMaxBytes: 100_000_000 });
    const r = runGate(root, budget, ['--max-persisted-bytes', '20000']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Repo-map gate PASSED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate FAILS when the clamp sheds more ranked files than the floor allows', () => {
  const root = makeRoot();
  try {
    // A tiny persisted ceiling drops nearly everything; the retained-count floor
    // is what makes that shedding a failure rather than a silent degradation.
    const budget = writeBudget(root, { retainedFilesMin: 20 });
    const r = runGate(root, budget, ['--max-persisted-bytes', '3000']);
    assert.equal(r.code, 1, `expected a gate failure, got:\n${r.out}`);
    assert.match(r.out, /files retained/);
    assert.match(r.out, /Repo-map gate BLOCKED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing required budget key is an ERROR, never a silent pass', () => {
  const root = makeRoot(4);
  try {
    // The third instance of this same class, in the file being repaired: the
    // check loop used `bound == null ? true`, so a typo'd or absent key printed
    // "(no budget)" and passed.
    const budget = writeBudget(root);
    const parsed = JSON.parse(readFileSync(budget, 'utf8'));
    delete parsed.unboundedPayloadMaxBytes;
    writeFileSync(budget, JSON.stringify(parsed, null, 2));

    const r = runGate(root, budget, ['--max-persisted-bytes', '20000']);
    assert.equal(r.code, 2, `expected a hard error, got:\n${r.out}`);
    assert.match(r.out, /missing a numeric bound for: payload \(unbounded\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('honors the producer ceiling REPO_MAP_MAX_BYTES, so it measures what ships', () => {
  // scripts/repo-map-generate.mjs clamps with REPO_MAP_MAX_BYTES. A gate that
  // ignored it would evaluate a 1 MiB artifact while a 512 KiB deployment
  // shipped far fewer files — passing the retention check on an artifact nobody
  // has. Reported by Codex review on PR #3476.
  const root = makeRoot();
  try {
    const budget = writeBudget(root, { retainedFilesMin: 20 });
    // Same corpus, same budget, ONLY the producer env differs.
    const wide = runGate(root, budget, [], { REPO_MAP_MAX_BYTES: '100000000' });
    assert.equal(wide.code, 0, wide.out);

    const narrow = runGate(root, budget, [], { REPO_MAP_MAX_BYTES: '3000' });
    assert.equal(narrow.code, 1, `expected the narrow ceiling to trip: ${narrow.out}`);
    assert.match(narrow.out, /files retained/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unusable REPO_MAP_MAX_BYTES is an error, not a silent fallback', () => {
  const root = makeRoot(4);
  try {
    const r = runGate(root, writeBudget(root), [], { REPO_MAP_MAX_BYTES: '12g' });
    assert.equal(r.code, 2, `expected a hard error, got:\n${r.out}`);
    assert.match(r.out, /REPO_MAP_MAX_BYTES must be a positive integer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--max-persisted-bytes takes precedence over REPO_MAP_MAX_BYTES', () => {
  const root = makeRoot();
  try {
    const budget = writeBudget(root, { retainedFilesMin: 20 });
    // Env would trip the floor; the explicit flag overrides it and passes.
    const r = runGate(root, budget, ['--max-persisted-bytes', '100000000'], {
      REPO_MAP_MAX_BYTES: '3000',
    });
    assert.equal(r.code, 0, r.out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--max-persisted-bytes rejects non-numeric input instead of falling back', () => {
  const root = makeRoot(4);
  try {
    const r = runGate(root, writeBudget(root), ['--max-persisted-bytes', '12g']);
    assert.equal(r.code, 2, `expected a parse failure, got:\n${r.out}`);
    assert.match(r.out, /must be a positive integer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
