// Coverage for the repo-map measurement gate's ability to FAIL (#3452, #3471,
// #3510 — epic #1930).
//
// Run under register-ts (the gate imports the TS repo-map barrel):
//   node --import ./scripts/register-ts.mjs --test scripts/repo-map-gate.test.mjs
//
// Three generations of the same defect class are pinned here — a control that
// reports success for a state it claims to reject:
//   - #3452: the persisted-payload check compared a value already clamped to the
//     budget against that same budget — a tautology that could never fail.
//   - #3471: the localization probe seeded from the head of the ranking under
//     test and counted seeds as their own hits (a REVERSED ranking scored
//     34.8%), and returned a perfect 100 when it measured nothing.
//   - #3510: the localization floor/slice were plain JSON numbers relaxed ten
//     times in a row with no machine check that a measured ranking change
//     justified any of them. The gate now anchors them to a RECORDED baseline
//     (value + ranking-surface sha), and these tests prove both directions:
//     an unjustified relaxation fails, a re-measured legitimate one passes.
//
// These tests drive the real script as a subprocess and assert on EXIT CODES,
// which is the only thing CI actually consumes. `--max-persisted-bytes` keeps
// them fast: it exercises the size-bounding path on a handful of files instead
// of requiring a 1 MiB corpus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runGate as runGateScript, PROJECT_DIR } from './lib/gate-harness.mjs';
import { localizationProbe } from './lib/repo-map-probe.mjs';

const GATE = join(PROJECT_DIR, 'scripts', 'repo-map-gate.mjs');

test('ranking surface includes the parser-output admission boundary', () => {
  const source = readFileSync(GATE, 'utf8');
  assert.match(source, /'src\/lib\/repo-map\/parser-output\.ts'/);
});

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

/** A root whose files import NOTHING intra-repo — the probe has no evidence. */
function makeImportlessRoot(fileCount = 4) {
  const root = mkdtempSync(join(tmpdir(), 'repo-map-gate-noimp-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    writeFileSync(
      join(root, 'src', `lone${i}.ts`),
      `export function lone${i}(value: number): number { return value + ${i}; }\n`
    );
  }
  return root;
}

function runGate(root, budgetPath, extra = [], env = {}) {
  // The shared gate-test harness (#3478) owns the spawn shape; this wrapper
  // fixes the gate script + its --root/--budget plumbing and neutralizes
  // ambient REPO_MAP_* vars (harness convention: '' means unset) so only the
  // overrides under test are set — e.g. a stray REPO_MAP_PRIOR_BUDGET_REF
  // would hard-error every non-git run. The gate's env parsing treats '' as
  // unset on both the envNumber and prior-budget-ref paths.
  const scrub = Object.fromEntries(
    Object.keys(process.env)
      .filter((k) => k.startsWith('REPO_MAP_'))
      .map((k) => [k, ''])
  );
  return runGateScript(GATE, ['--root', root, '--budget', budgetPath, ...extra], {
    env: { ...scrub, ...env },
    registerTs: true,
  });
}

// ---------------------------------------------------------------------------
// Canonical baseline for the synthetic corpus. The probe is purely structural
// (root-relative paths, deterministic ranking + tie-break), so every makeRoot()
// corpus of the same shape measures identically — one --measure-only run gives
// the honest recall + the REAL ranking-surface sha every budget below anchors
// to, exactly the bootstrap path a human uses on the real budget.
// ---------------------------------------------------------------------------
function measureCandidate(root, budgetOver = {}) {
  const budget = join(root, 'measure-budget.json');
  writeFileSync(budget, JSON.stringify(budgetOver));
  const r = runGate(root, budget, ['--measure-only']);
  assert.equal(r.code, 0, r.out);
  const line = r.out
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('{"recallPct"'));
  assert.ok(line, `no baseline candidate in:\n${r.out}`);
  return JSON.parse(line);
}
function measureBaselineCandidate() {
  const root = makeRoot();
  try {
    return measureCandidate(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const CANON = measureBaselineCandidate();

/** A budget object CONSISTENT with its recorded baseline (the passing shape).
 *  Override top-level keys via `over`, baseline fields via `baselineOver`. */
function budgetObject(over = {}, baselineOver = {}) {
  const baseline = { ...CANON, ...baselineOver };
  return {
    unboundedPayloadMaxBytes: 100_000_000,
    retainedFilesMin: 0,
    coldIngestMaxMs: 600_000,
    localizationRecallMinPct: Math.max(0, +(baseline.recallPct - 2).toFixed(1)),
    rereadTokensSavedMin: 0,
    localizationTopKPct: baseline.topKPct,
    localizationBaseline: baseline,
    bodySentinels: [],
    ...over,
  };
}
function writeBudget(root, over = {}, baselineOver = {}) {
  const path = join(root, 'budget.json');
  writeFileSync(path, JSON.stringify(budgetObject(over, baselineOver), null, 2));
  return path;
}

/** Commit `budgetObj` as <root>/budget.json in a fresh git repo, so the
 *  cross-commit checks have a PRIOR the working tree cannot rewrite. Tests then
 *  overwrite the working copy and run the gate with
 *  REPO_MAP_PRIOR_BUDGET_REF=HEAD. Global/system git config is masked so a
 *  host-level commit.gpgsign cannot break the throwaway commit. */
function gitCommitPriorBudget(root, budgetObj) {
  writeFileSync(join(root, 'budget.json'), JSON.stringify(budgetObj, null, 2));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const g = (...args) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  g('init', '-q');
  g('add', 'budget.json');
  g(
    '-c', 'user.email=gate-test@example.invalid',
    '-c', 'user.name=gate-test',
    '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', 'prior budget'
  );
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

test('gate measures the normalized repository fields in the production envelope', () => {
  const root = makeRoot(4);
  try {
    const committedBudget = budgetObject();
    gitCommitPriorBudget(root, committedBudget);
    const budget = join(root, 'budget.json');

    const withoutRemote = runGate(root, budget, ['--measure-only']);
    assert.equal(withoutRemote.code, 0, withoutRemote.out);
    const withoutBytes = Number(
      /payload \(unbounded\)\s+(\d+)\s*B/.exec(withoutRemote.out)?.[1]
    );

    const slug = 'owner/repository-identity-budget-fixture';
    execFileSync(
      'git',
      ['-C', root, 'remote', 'add', 'origin', 'corp:repository-identity-budget-fixture.git'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    execFileSync(
      'git',
      ['-C', root, 'config', 'url.git@github.com:Owner/.insteadOf', 'corp:'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const withRemote = runGate(root, budget, ['--measure-only']);
    assert.equal(withRemote.code, 0, withRemote.out);
    const withBytes = Number(
      /payload \(unbounded\)\s+(\d+)\s*B/.exec(withRemote.out)?.[1]
    );

    // The normalized slug is serialized once in map.repository and once in
    // cacheKey.repository, exactly as it is by the host producer.
    const expectedDelta =
      2 * (Buffer.byteLength(JSON.stringify(slug), 'utf8') - Buffer.byteLength('null'));
    assert.equal(withBytes - withoutBytes, expectedDelta);
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
    assert.match(r.out, /REPO_MAP_MAX_BYTES.*not a finite number/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unusable discovery-cap env override is an error too (#3477 convergence)', () => {
  const root = makeRoot(4);
  try {
    const files = runGate(root, writeBudget(root), [], { REPO_MAP_MAX_FILES: '12g' });
    assert.equal(files.code, 2, `expected a hard error, got:\n${files.out}`);
    assert.match(files.out, /REPO_MAP_MAX_FILES/);

    const zero = runGate(root, writeBudget(root), [], { REPO_MAP_TOKEN_BUDGET: '0' });
    assert.equal(zero.code, 2, `expected a hard error, got:\n${zero.out}`);
    assert.match(zero.out, /REPO_MAP_TOKEN_BUDGET.*out of range/);
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

// ---------------------------------------------------------------------------
// #3471: the rebuilt probe cannot report success without evidence.
// ---------------------------------------------------------------------------

test('obsolete pre-#3471 probe knobs are hard errors, not silently honored or ignored', () => {
  const root = makeRoot(4);
  try {
    const topK = runGate(root, writeBudget(root, { localizationTopK: 86 }));
    assert.equal(topK.code, 2, `expected a hard error, got:\n${topK.out}`);
    assert.match(topK.out, /localizationTopK.*obsolete/);

    const sample = runGate(root, writeBudget(root, { localizationSampleSize: 40 }));
    assert.equal(sample.code, 2, `expected a hard error, got:\n${sample.out}`);
    assert.match(sample.out, /localizationSampleSize.*obsolete/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a probe with no evidence is an ERROR in gating mode, never a perfect score', () => {
  // The old probe returned 100 for an empty measurement — a perfect mark that
  // clears any floor by construction (#3471 defect 3).
  const root = makeImportlessRoot();
  try {
    const gating = runGate(root, writeBudget(root));
    assert.equal(gating.code, 2, `expected a hard error, got:\n${gating.out}`);
    assert.match(gating.out, /not evaluable/);

    // --measure-only reports the non-result instead of inventing a number.
    const measure = runGate(root, writeBudget(root), ['--measure-only']);
    assert.equal(measure.code, 0, measure.out);
    assert.match(measure.out, /localization probe\s+not evaluable/);
    assert.doesNotMatch(measure.out, /localization recall/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #3510: relaxing a localization number without a measured ranking change
// fails; a legitimate re-measured change passes. Both directions.
// ---------------------------------------------------------------------------

test('a recall drop against the recorded baseline FAILS (regression, ranking unchanged)', () => {
  // Simulated by recording a baseline higher than what the corpus measures —
  // the exact state a ranking regression leaves behind: reality below record,
  // ranking-surface sha unchanged.
  const root = makeRoot();
  try {
    const budget = writeBudget(root, {}, { recallPct: +(CANON.recallPct + 10).toFixed(1) });
    const r = runGate(root, budget);
    assert.equal(r.code, 1, `expected a gate failure, got:\n${r.out}`);
    assert.match(r.out, /recall vs baseline.*fails budget/);
    assert.match(r.out, /#3510 contract/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a sandbagged/stale baseline FAILS when reality measures far above it', () => {
  // Lowering the recorded baseline (to buy future regression room) is caught
  // because the measured value must stay within the UP tolerance of the record.
  const root = makeRoot();
  try {
    const low = +(CANON.recallPct - 5).toFixed(1);
    const budget = writeBudget(root, {}, { recallPct: low });
    const r = runGate(root, budget);
    assert.equal(r.code, 1, `expected a gate failure, got:\n${r.out}`);
    assert.match(r.out, /baseline freshness.*fails budget/);
    assert.match(r.out, /ratchet localizationBaseline\.recallPct UP/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a ranking-surface change without a re-recorded baseline is a hard error', () => {
  const root = makeRoot(4);
  try {
    const budget = writeBudget(root, {}, { rankingCodeSha256: 'ab'.repeat(32) });
    const r = runGate(root, budget);
    assert.equal(r.code, 2, `expected a hard error, got:\n${r.out}`);
    assert.match(r.out, /ranking surface changed/);
    assert.match(r.out, /measure-only/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('widening localizationTopKPct without re-baselining is a hard error', () => {
  // Recall@K is monotonic in K, so the old absolute knob was an unbounded
  // escape hatch (widened 10x). The fraction can only move together with a
  // re-recorded measurement at the new K.
  const root = makeRoot(4);
  try {
    const budget = writeBudget(root, { localizationTopKPct: CANON.topKPct + 3 });
    const r = runGate(root, budget);
    assert.equal(r.code, 2, `expected a hard error, got:\n${r.out}`);
    assert.match(r.out, /does not match localizationBaseline\.topKPct/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a floor detached from the recorded baseline is a hard error', () => {
  const root = makeRoot(4);
  try {
    const budget = writeBudget(root, { localizationRecallMinPct: 0 });
    const r = runGate(root, budget);
    assert.equal(r.code, 2, `expected a hard error, got:\n${r.out}`);
    assert.match(r.out, /below the recorded baseline/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing localizationBaseline is a hard error in gating mode', () => {
  const root = makeRoot(4);
  try {
    const budget = writeBudget(root, { localizationBaseline: null });
    const r = runGate(root, budget);
    assert.equal(r.code, 2, `expected a hard error, got:\n${r.out}`);
    assert.match(r.out, /missing localizationBaseline/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a legitimate re-measured baseline PASSES (the relaxation path with evidence)', () => {
  // The passing direction of the #3510 acceptance: a budget whose baseline is
  // exactly what --measure-only reports — the state a genuine ranking change
  // leaves behind after re-recording — gates green, floor and all.
  const root = makeRoot();
  try {
    const r = runGate(root, writeBudget(root));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /recall vs baseline/);
    assert.match(r.out, /baseline freshness/);
    // The budget lives in a non-git temp dir here, so the cross-commit checks
    // must skip VISIBLY, never silently.
    assert.match(r.out, /cross-commit relaxation checks SKIPPED: budget file is not inside a git repository/);
    assert.match(r.out, /Repo-map gate PASSED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #3471 probe invariants (review r13-rev-perf, finding 3). The subprocess
// suite above anchors to a self-measured CANON, so a reintroduced probe defect
// would inflate CANON and every relative assertion would still pass. These
// tests import the probe module directly and pin its ABSOLUTE semantics
// against hand-computed graphs.
// ---------------------------------------------------------------------------

test('probe invariant: a reversed ranking scores 0, not a tautological floor', () => {
  // One hub imported by nine leaves. Ranked correctly (hub first), every edge
  // hits the head; reversed (hub last), the identical ground truth scores 0 —
  // the old probe scored a reversed ranking 34.8% on this repo because seeds
  // counted themselves.
  const hub = { path: 'src/hub.ts', imports: [] };
  const leaves = Array.from({ length: 9 }, (_, i) => ({
    path: `src/leaf${i}.ts`,
    imports: ['./hub'],
  }));
  const ranked = { files: [hub, ...leaves] };
  const reversed = { files: [...leaves].reverse().concat(hub) };

  const good = localizationProbe(ranked, 10); // K = ceil(10% of 10) = 1: the hub slot
  assert.equal(good.evaluable, true);
  assert.equal(good.denominator, 9);
  assert.equal(good.recallPct, 100);

  const bad = localizationProbe(reversed, 10);
  assert.equal(bad.denominator, 9); // identical ground truth...
  assert.equal(bad.recallPct, 0); // ...but the head no longer contains the hub
});

test('probe invariant: a seed never counts itself (#3471 defect 2 cannot return)', () => {
  // `a` imports itself and `b`. The self-edge must enter neither the
  // denominator nor the hits — under the old probe, a top-ranked seed was a
  // guaranteed hit for its own task.
  const files = [
    { path: 'src/a.ts', imports: ['./a', './b'] },
    { path: 'src/b.ts', imports: [] },
  ];
  const r = localizationProbe({ files }, 50); // K = 1: exactly `a`, the top-ranked seed
  assert.equal(r.denominator, 1); // only a -> b
  assert.equal(r.hits, 0); // a's presence in the head buys nothing
  assert.equal(r.recallPct, 0);
});

test('probe invariant: the denominator is invariant under ranking permutations', () => {
  // Ground truth must come from the import graph alone. Permuting the ranking
  // changes WHICH edges hit the head, never how many edges exist.
  const files = [
    { path: 'src/a.ts', imports: ['./b', './c'] },
    { path: 'src/b.ts', imports: ['./c'] },
    { path: 'src/c.ts', imports: [] },
    { path: 'src/d.ts', imports: ['./a'] },
  ];
  const HAND_COMPUTED_EDGES = 4; // a->b, a->c, b->c, d->a
  const permutations = [
    files,
    [...files].reverse(),
    [files[2], files[0], files[3], files[1]],
    [files[3], files[2], files[1], files[0]],
  ];
  for (const perm of permutations) {
    const r = localizationProbe({ files: perm }, 25);
    assert.equal(r.evaluable, true);
    assert.equal(r.denominator, HAND_COMPUTED_EDGES);
  }
});

test('the canonical synthetic corpus measures its hand-computed edge count', () => {
  // makeRoot(24): mod1..mod23 each import exactly one prior module — 23 edges.
  // If a probe refactor reintroduced self-hits (or dropped edges), CANON would
  // silently drift off this number and inflate every relative test above.
  assert.equal(CANON.denominator, 23);
  assert.equal(CANON.rankedFiles, 24);
  assert.equal(CANON.topKPct, 7);
});

// ---------------------------------------------------------------------------
// #3510 cross-commit checks (review r13-rev-perf, findings 1-2). The in-file
// checks are stateless within a commit, so both demonstrated bypasses were
// PAIRED JSON edits. These tests commit an honest prior budget in a throwaway
// git repo, apply the exact bypass to the working copy, and prove it now
// fails — plus the legitimate re-measured paths that must keep passing.
// ---------------------------------------------------------------------------

test('cross-commit: paired baseline+floor lowering vs the committed prior FAILS (finding 1 bypass)', () => {
  const root = makeRoot();
  try {
    gitCommitPriorBudget(root, budgetObject()); // honest prior
    // The reviewer's demonstrated bypass: recallPct -3 and the floor lowered to
    // match — satisfies every static check (floor inside the slack band, and
    // measured 66.9 <= 63.9+3 style freshness at exactly the ceiling).
    const lowered = +(CANON.recallPct - 3).toFixed(1);
    const budget = writeBudget(
      root,
      { localizationRecallMinPct: Math.max(0, +(lowered - 2).toFixed(1)) },
      { recallPct: lowered },
    );
    const r = runGate(root, budget, [], { REPO_MAP_PRIOR_BUDGET_REF: 'HEAD' });
    assert.equal(r.code, 2, `expected the cross-commit check to refuse, got:\n${r.out}`);
    assert.match(r.out, /localizationBaseline\.recallPct lowered/);
    assert.match(r.out, /without matching the freshly measured/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cross-commit: paired topKPct widening with a stale recorded value FAILS (finding 2 bypass)', () => {
  // Needs a corpus where widening moves measured recall by MORE than the down
  // tolerance but LESS than the up tolerance — the exact window where the
  // static freshness ceiling cannot see the stale record and only the
  // cross-commit check can. makeRoot(100) measures ~7.1% at K=7% and ~9.1% at
  // K=9%: a 2-point jump.
  const root = makeRoot(100);
  try {
    const m7 = measureCandidate(root, { localizationTopKPct: 7 });
    const m9 = measureCandidate(root, { localizationTopKPct: 9 });
    const jump = +(m9.recallPct - m7.recallPct).toFixed(1);
    assert.ok(
      jump > 1 && jump <= 3,
      `corpus must model the static-invisible widening (jump ${jump} must be in (1, 3])`,
    );

    gitCommitPriorBudget(root, budgetObject({}, m7)); // honest prior at 7%
    // The bypass: widen the fraction in BOTH places, leave recallPct stale —
    // under the old checks this passed and quietly bought regression slack.
    const budget = writeBudget(root, {}, { ...m7, topKPct: 9 });
    const r = runGate(root, budget, [], { REPO_MAP_PRIOR_BUDGET_REF: 'HEAD' });
    assert.equal(r.code, 2, `expected the cross-commit check to refuse, got:\n${r.out}`);
    assert.match(r.out, /localizationTopKPct moved 7 -> 9/);
    assert.match(r.out, /does not match the freshly measured/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cross-commit: a widening that RECORDS the fresh measurement at the new K passes', () => {
  const root = makeRoot(100);
  try {
    const m7 = measureCandidate(root, { localizationTopKPct: 7 });
    gitCommitPriorBudget(root, budgetObject({}, m7));
    // The legitimate path: re-measure at the wider K and record the (higher)
    // fresh number — the future regression bar rises with it.
    const m9 = measureCandidate(root, { localizationTopKPct: 9 });
    const budget = writeBudget(root, {}, m9);
    const r = runGate(root, budget, [], { REPO_MAP_PRIOR_BUDGET_REF: 'HEAD' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /accepted re-baseline vs HEAD/);
    assert.match(r.out, /Repo-map gate PASSED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cross-commit: a fresh downward re-baseline passes; the floor may follow by at most the same distance', () => {
  // The sanctioned composition-drift path (review finding 4b): prior recorded
  // 2 points above current reality; re-recording the fresh value passes, and
  // the floor may drop by up to those same 2 points — but no further.
  const root = makeRoot();
  try {
    const priorRecall = +(CANON.recallPct + 2).toFixed(1);
    gitCommitPriorBudget(root, budgetObject({}, { recallPct: priorRecall }));

    const followedFloor = Math.max(0, +(CANON.recallPct - 2).toFixed(1));
    const ok = writeBudget(root, { localizationRecallMinPct: followedFloor }, {});
    const r1 = runGate(root, ok, [], { REPO_MAP_PRIOR_BUDGET_REF: 'HEAD' });
    assert.equal(r1.code, 0, r1.out);
    assert.match(r1.out, /accepted re-baseline vs HEAD/);

    const overDropped = Math.max(0, +(CANON.recallPct - 3.5).toFixed(1));
    const over = writeBudget(root, { localizationRecallMinPct: overDropped }, {});
    const r2 = runGate(root, over, [], { REPO_MAP_PRIOR_BUDGET_REF: 'HEAD' });
    assert.equal(r2.code, 2, `expected the floor over-drop to be refused, got:\n${r2.out}`);
    assert.match(r2.out, /more than the recorded baseline moved/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cross-commit: a prior budget predating the baseline contract skips with a visible note', () => {
  // The introduction commit's own situation: the committed prior still has the
  // pre-#3471 shape, so there is nothing to ratchet against yet.
  const root = makeRoot();
  try {
    gitCommitPriorBudget(root, {
      unboundedPayloadMaxBytes: 100_000_000,
      retainedFilesMin: 0,
      coldIngestMaxMs: 600_000,
      localizationRecallMinPct: 77,
      rereadTokensSavedMin: 0,
      localizationTopK: 86,
      localizationSampleSize: 40,
      bodySentinels: [],
    });
    const budget = writeBudget(root); // the new, consistent shape
    const r = runGate(root, budget, [], { REPO_MAP_PRIOR_BUDGET_REF: 'HEAD' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /predates the baseline contract/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cross-commit: an explicit REPO_MAP_PRIOR_BUDGET_REF that cannot resolve is an ERROR', () => {
  // Fail-closed on explicit configuration (#3477 rule): a stated anchor that
  // does not exist must never silently degrade into "no checks".
  const root = makeRoot(4);
  try {
    const budget = writeBudget(root);
    const r = runGate(root, budget, [], { REPO_MAP_PRIOR_BUDGET_REF: 'HEAD' });
    assert.equal(r.code, 2, `expected a hard error, got:\n${r.out}`);
    assert.match(r.out, /REPO_MAP_PRIOR_BUDGET_REF=HEAD/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
