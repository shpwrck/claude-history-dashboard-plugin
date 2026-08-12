// The public-sample node:fs gate (#3628/#3735) must be ABLE to fail (#3478).
//
// Run: node --test scripts/check-sample-no-node-fs.test.mjs
//
// Drives the real gate as a subprocess against synthetic dists and asserts on
// EXIT CODES, because the exit code is the only thing CI consumes. The fixtures
// mirror shapes measured from real `npm run build:sample` output rather than
// invented ones — in particular the clean-build false positive that rules out
// the obvious `readFileSync`/`node:fs` marker, and the two distinct leak shapes
// (#3613 duplicated the graph into a new chunk; an import edge into the
// existing shared chunk moves no count at all).
//
// The pure evaluator is exercised directly too, so the ratchet and allowlist
// semantics are pinned without needing a dist on disk for every case.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runGate, PROJECT_DIR } from './lib/gate-harness.mjs';
import { evaluateFsLeak } from './check-sample-no-node-fs.mjs';

const GATE = join(PROJECT_DIR, 'scripts', 'check-sample-no-node-fs.mjs');

// The shape Vite emits for the bounded-fs chunk in the public sample: node:fs
// resolved to an empty stub, then dereferenced at module scope. Evaluating this
// throws "Cannot read properties of undefined (reading 'O_RDONLY')".
const FS_GRAPH_BODY =
  'var n=e(((e,t)=>{t.exports={}})),r=t(n(),1);' +
  'r.constants.O_RDONLY|(typeof r.constants.O_NOFOLLOW==`number`?r.constants.O_NOFOLLOW:0);';

/** Build a dist/assets tree from a {filename: source} map and run the gate on it. */
function withDist(assets, run) {
  const dist = mkdtempSync(join(tmpdir(), 'spa-node-fs-gate-'));
  try {
    mkdirSync(join(dist, 'assets'), { recursive: true });
    for (const [name, source] of Object.entries(assets)) {
      writeFileSync(join(dist, 'assets', name), source);
    }
    return run(dist);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
}

// A faithful miniature of the current public sample dist after #3639: the pure
// analytics live in fs-free leaves, so the former debt chunks hold NO edge
// into the fs graph and `bounded-fs` is not emitted at all. The fixture still
// ships a `bounded-fs` chunk (allowlisted container, zero reachers) so the
// subprocess leak cases below can add edges INTO it — an allowlisted container
// nothing imports must itself keep passing. A view chunk ships
// `node:fs`/`readFileSync` as recommendation COPY — which the real
// Recommendations chunk does. Mirroring the real baseline is what lets the
// subprocess cases run the gate under its SHIPPED policy (real allowlist,
// real — now empty — debt list) instead of a test-only one.
const CLEAN_ASSETS = {
  'bounded-fs-CH76ajUM.js': `import{L as e,z as t}from"./Spinner-DTC27OcH.js";${FS_GRAPH_BODY}export{n as t};`,
  'Spinner-DTC27OcH.js': 'export const L=1,z=2;',
  // The former debt chunks (#3639), each now edge-free into the fs graph:
  // their shared values come from the fs-free leaves.
  'parse-telemetry-Do29yvEo.js': 'import{L as b}from"./Spinner-DTC27OcH.js";export{b};',
  'AgentReportCardPf-B3LLViF9.js': 'import"./Spinner-DTC27OcH.js";export const A=1;',
  'PlanShapesPf-CIZJDjZp.js': 'import{L as b}from"./Spinner-DTC27OcH.js";export{b};',
  'ReviewQueuePf-DDu-zzYS.js': 'import{b}from"./parse-telemetry-Do29yvEo.js";export{b};',
  'Recommendations-DKfrBmLI.js':
    'import{L as a}from"./Spinner-DTC27OcH.js";' +
    "const fix=[`const fs = require('node:fs');`,`JSON.parse(fs.readFileSync(path, 'utf8'))`];export{fix,a};",
  'index-CuhiiY7w.js':
    'const deps=["assets/Recommendations-DKfrBmLI.js","assets/bounded-fs-CH76ajUM.js"];' +
    'export const load=()=>import("./Recommendations-DKfrBmLI.js");',
};

test('a clean public sample PASSES — fs graph confined to the allowlisted chunk (exit 0)', () => {
  withDist(CLEAN_ASSETS, (dist) => {
    const r = runGate(GATE, ['--dist', dist]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /PASSED/);
  });
});

test('recommendation COPY naming node:fs/readFileSync does not trip the gate', () => {
  withDist(CLEAN_ASSETS, (dist) => {
    const r = runGate(GATE, ['--dist', dist]);
    // The literals are present in the fixture, so a marker set keyed on them
    // would have failed here on an entirely clean build.
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /Recommendations-DKfrBmLI\.js/);
  });
});

test('the fs graph DUPLICATED into a second chunk FAILS the gate (exit 1)', () => {
  // The #3613 shape: a new import edge dragged the graph into another bundle,
  // so a second chunk carries it outright.
  withDist(
    {
      ...CLEAN_ASSETS,
      'upload-pipeline-worker-DuRemhRo.js': `${FS_GRAPH_BODY}export{};`,
    },
    (dist) => {
      const r = runGate(GATE, ['--dist', dist]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /CONTAINS the node:fs graph/);
      assert.match(r.out, /upload-pipeline-worker-DuRemhRo\.js/);
    }
  );
});

test('a NEW static import edge into the existing fs chunk FAILS the gate (exit 1)', () => {
  // The shape a bare `grep -c O_RDONLY | wc -l` baseline cannot see: the count
  // stays at 1 because no new chunk carries the graph — only a new edge to it.
  withDist(
    {
      ...CLEAN_ASSETS,
      'SessionList-DYEaTiZ1.js': 'import{t as b}from"./bounded-fs-CH76ajUM.js";export{b};',
    },
    (dist) => {
      const r = runGate(GATE, ['--dist', dist]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /statically imports the node:fs graph/);
      assert.match(r.out, /SessionList-DYEaTiZ1\.js/);
    }
  );
});

test('a TRANSITIVE static import edge FAILS the gate (exit 1)', () => {
  withDist(
    {
      ...CLEAN_ASSETS,
      'parse-backups-Qb1a7Kz9.js': 'import{t as b}from"./bounded-fs-CH76ajUM.js";export{b};',
      'BackupsView-Zq2b8Lm3.js': 'import{b}from"./parse-backups-Qb1a7Kz9.js";export{b};',
    },
    (dist) => {
      const r = runGate(GATE, ['--dist', dist]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /BackupsView-Zq2b8Lm3\.js/);
    }
  );
});

test('a chunk reaching the fs graph ONLY via bare export-star FAILS the gate (#3649)', () => {
  // The discriminating case for the star-with-no-`as` clause: before #3649 the
  // edge regex required braces, an identifier, or `* as`, so this exact shape
  // was silently dropped and the gate passed.
  withDist(
    {
      ...CLEAN_ASSETS,
      'BarrelView-Ab1c2Dd3.js': 'export*from"./bounded-fs-CH76ajUM.js";',
    },
    (dist) => {
      const r = runGate(GATE, ['--dist', dist]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /statically imports the node:fs graph/);
      assert.match(r.out, /BarrelView-Ab1c2Dd3\.js/);
    }
  );
});

test('a wrong-flavor (server) dist is a usage error (exit 2), not a leak or a pass (#3650)', () => {
  // Pointing the gate at a plain `npm run build` dist used to evaluate it:
  // chunk names differ there, so the shrink-only ratchet fired a misleading
  // "you fixed it, delete the entry". A server-only marker proves the flavor.
  withDist(
    {
      'index-CuhiiY7w.js': 'export const load=()=>fetch("/api/recommendations.json");',
      'Spinner-DTC27OcH.js': 'export const L=1,z=2;',
    },
    (dist) => {
      const r = runGate(GATE, ['--dist', dist]);
      assert.equal(r.code, 2, r.out);
      assert.match(r.out, /wrong-flavor dist/);
      assert.match(r.out, /build:sample/);
      assert.doesNotMatch(r.out, /BLOCKED/);
    }
  );
});

test('a DYNAMIC import of the fs chunk is not a static edge — it does not fail', () => {
  // Lazy route loading defers evaluation; only static edges force the throw
  // before the importing module's own body runs.
  withDist(
    {
      ...CLEAN_ASSETS,
      'LazyThing-Zz1.js': 'export const load=()=>import("./bounded-fs-CH76ajUM.js");',
    },
    (dist) => {
      const r = runGate(GATE, ['--dist', dist]);
      assert.equal(r.code, 0, r.out);
    }
  );
});

test('an EMPTY dist is "verified nothing" — exit 2, never a green pass', () => {
  withDist({}, (dist) => {
    const r = runGate(GATE, ['--dist', dist]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /verified NOTHING/);
  });
});

test('a MISSING dist fails closed rather than passing (exit 2)', () => {
  const r = runGate(GATE, ['--dist', join(tmpdir(), 'spa-node-fs-gate-does-not-exist')]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /build:sample/);
});

// Exit 1 is reserved for "a leak was found". A usage error that reaches exit 1
// is worse than useless — it reports a mistyped flag as a node:fs leak. These
// pin the codes apart.
test('--dist with no value is a usage error (exit 2), not a phantom leak', () => {
  const r = runGate(GATE, ['--dist']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /--dist requires a directory path/);
  assert.doesNotMatch(r.out, /BLOCKED/);
});

test('an unknown flag is a usage error (exit 2), not a phantom leak', () => {
  const r = runGate(GATE, ['--nope']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /unknown argument/);
  assert.doesNotMatch(r.out, /BLOCKED/);
});

// ── pure-evaluator semantics ────────────────────────────────────────────────

const fixture = (assets) => ({
  files: Object.keys(assets),
  contentOf: (f) => assets[f],
});

// Minimal two-chunk baseline: the allowlisted container plus one chunk that
// imports it. Keeps the policy cases independent of the master-shaped fixture.
const MINIMAL = {
  'bounded-fs-CH76ajUM.js': FS_GRAPH_BODY,
  'PlanShapesPf-CIZJDjZp.js': 'import{t as b}from"./bounded-fs-CH76ajUM.js";export{b};',
};

test('a known-debt chunk is exempted, not silently ignored elsewhere', () => {
  const { files, contentOf } = fixture(MINIMAL);
  const result = evaluateFsLeak(files, contentOf, {
    allowedContainers: ['bounded-fs'],
    knownReachers: ['PlanShapesPf'],
  });
  assert.equal(result.ok, true, result.failures.join('\n'));
  // Still reported as reaching the graph — exempt from failing, not hidden.
  assert.ok(result.reachers.includes('PlanShapesPf-CIZJDjZp.js'));
});

test('an UNLISTED chunk reaching the graph fails even when others are exempt', () => {
  const { files, contentOf } = fixture({
    ...MINIMAL,
    'SessionList-DYEaTiZ1.js': 'import{t as b}from"./bounded-fs-CH76ajUM.js";export{b};',
  });
  const result = evaluateFsLeak(files, contentOf, {
    allowedContainers: ['bounded-fs'],
    knownReachers: ['PlanShapesPf'],
  });
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /SessionList-DYEaTiZ1\.js/);
});

test('the debt list is a RATCHET: a fixed entry must be removed, not left stale', () => {
  const { files, contentOf } = fixture({ 'bounded-fs-CH76ajUM.js': FS_GRAPH_BODY });
  const result = evaluateFsLeak(files, contentOf, {
    allowedContainers: ['bounded-fs'],
    knownReachers: ['PlanShapesPf'],
  });
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /no such chunk reaches the node:fs graph anymore/);
});

test('an absent fs-graph chunk is the ideal end state, not a gate failure', () => {
  // Once every import edge is cut the chunk stops being emitted; requiring it
  // to exist would red-flag the very fix this gate is meant to drive toward.
  const assets = {
    'Spinner-DTC27OcH.js': 'export const L=1,z=2;',
    'index-CuhiiY7w.js': 'import{L}from"./Spinner-DTC27OcH.js";export{L};',
  };
  const { files, contentOf } = fixture(assets);
  const result = evaluateFsLeak(files, contentOf, {
    allowedContainers: ['bounded-fs'],
    knownReachers: [],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.fsGraphChunks, []);
});
