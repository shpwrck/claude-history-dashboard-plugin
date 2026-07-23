// Unit tests for the pure decision core of the usage-aware, harness-neutral audit
// orchestrator (corrections 2 & 3). The live dispatch (nested claude -p / codex exec)
// runs on demand; these cover the logic that must never over-spend: budget verdicts
// (stale/absent -> ZERO), ledger resume parsing, batch selection, and harness routing.
//   node --test scripts/audits/orchestrate.test.mjs
//
// See docs/audits/v060-review-phase-audit.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideBudget,
  parseLedger,
  pendingBatches,
  sizeBatch,
  planNext,
  buildDispatchArgv,
  buildPrompt,
  parseArgs,
  resolveSectionSpec,
  filterFiles,
  shq,
} from './orchestrate.mjs';

const LEDGER = `
| Section | Files | security → #1932 | data-integrity → #2133 | performance → #1930 |
|---|---|---|---|---|
| root | 33 | DONE (#1) | — | WIP |
| scripts/ | 158 | — | — | — |
| docs/ | 140 | DONE (clean) | DONE (clean) | DONE (clean) |
`;

test('decideBudget: valid headers -> ok, leftPct is the binding (min) window', () => {
  const v = decideBudget({ '5h-utilization': '0.32', '7d-utilization': '0.86', '5h-status': 'ok', '7d-status': 'ok' });
  assert.equal(v.ok, true);
  assert.equal(Math.round(v.w5), 68);
  assert.equal(Math.round(v.w7), 14);
  assert.equal(Math.round(v.leftPct), 14);
});

test('decideBudget: absent / unparseable / rejected / stale all -> ZERO budget', () => {
  assert.deepEqual(decideBudget(null).ok, false);
  assert.equal(decideBudget({ '5h-utilization': 'x', '7d-utilization': '0.1' }).ok, false);
  assert.equal(decideBudget({ '5h-utilization': '0.1', '7d-utilization': '0.1' }).leftPct > 0, true);
  const rej = decideBudget({ '5h-utilization': '0.1', '7d-utilization': '0.1', '7d-status': 'rejected' });
  assert.equal(rej.ok, false);
  const stale = decideBudget({ '5h-utilization': '0.1', '7d-utilization': '0.1', 'stale': true });
  assert.equal(stale.ok, false);
  // a source with no numbers at all is zero, never "fresh"
  assert.equal(decideBudget({}).leftPct, 0);
  // out-of-range utilization (unit change / corruption) fails closed, not inflated
  const oob = decideBudget({ '5h-utilization': '-0.5', '7d-utilization': '0.1' });
  assert.equal(oob.ok, false);
  assert.equal(oob.w5, 0);
  assert.match(oob.reason, /\[0,1\]/);
});

test('shq escapes embedded single quotes so a filename cannot break out', () => {
  assert.equal(shq('scripts/'), "'scripts/'");
  assert.equal(shq("x'; rm -rf ."), "'x'\\''; rm -rf .'");
});

test('resolveSectionSpec: maps clean sections + include/exclude, null for unmappable', () => {
  assert.deepEqual(resolveSectionSpec('scripts/'), { include: ['scripts/'] });
  assert.deepEqual(resolveSectionSpec('src/lib (non-detectors)'), { include: ['src/lib/'], exclude: ['src/lib/detectors/'] });
  assert.equal(resolveSectionSpec('root'), null); // top-level-files only -> needs --files
  assert.equal(resolveSectionSpec('data/, tools/, bin/, commands/, .claude*'), null);
});

test('filterFiles: drops files under an excluded prefix (JS, since ls-tree has no exclude magic)', () => {
  const files = ['src/lib/a.ts', 'src/lib/detectors/d.ts', 'src/lib/b.ts'];
  assert.deepEqual(filterFiles(files, ['src/lib/detectors/']), ['src/lib/a.ts', 'src/lib/b.ts']);
  assert.deepEqual(filterFiles(files, []), files);
});

test('parseLedger: reads sections, files, and per-gate done/pending', () => {
  const s = parseLedger(LEDGER);
  assert.equal(s.length, 3);
  const root = s.find((x) => x.section === 'root');
  assert.equal(root.files, 33);
  assert.equal(root.gates.security, 'done');
  assert.equal(root.gates['data-integrity'], 'pending');
  assert.equal(root.gates.performance, 'pending'); // WIP is not done
  const docs = s.find((x) => x.section === 'docs/');
  assert.equal(docs.gates.security, 'done');
  assert.equal(docs.gates.performance, 'done');
});

test('pendingBatches: only sections with an active gate not done', () => {
  const s = parseLedger(LEDGER);
  const pend = pendingBatches(s, ['security', 'data-integrity', 'performance']);
  // docs/ fully done -> excluded; root has 2 pending; scripts/ has 3
  assert.deepEqual(pend.map((p) => p.section).sort(), ['root', 'scripts/']);
  const root = pend.find((p) => p.section === 'root');
  assert.deepEqual(root.gates.sort(), ['data-integrity', 'performance']);
});

test('pendingBatches: narrowing active gates changes what is pending', () => {
  const s = parseLedger(LEDGER);
  const pend = pendingBatches(s, ['security']); // root & docs security done; scripts/ not
  assert.deepEqual(pend.map((p) => p.section), ['scripts/']);
});

test('sizeBatch: half the 5h window, floored, min 1', () => {
  assert.equal(sizeBatch(68, 40), 13); // floor(40 * .68 * .5)
  assert.equal(sizeBatch(14, 40), 2);
  assert.equal(sizeBatch(1, 40), 1); // never zero
});

test('planNext: routes to the harness with the most budget above the floor', () => {
  const sections = parseLedger(LEDGER);
  const usage = { claude: { ok: true, leftPct: 40, w5: 68 }, codex: { ok: true, leftPct: 90, w5: 90 } };
  const p = planNext({ sections, activeGates: ['security', 'data-integrity', 'performance'], usage, floorPct: 12 });
  assert.equal(p.stop, false);
  assert.equal(p.harness, 'codex'); // higher leftPct
  assert.equal(p.section, 'root'); // first pending
  assert.ok(p.maxFiles >= 1);
});

test('planNext: a stale/unusable Codex source is skipped, routing to Claude', () => {
  const sections = parseLedger(LEDGER);
  const usage = { claude: { ok: true, leftPct: 30, w5: 60 }, codex: { ok: false, leftPct: 0, w5: 0, reason: 'stale' } };
  const p = planNext({ sections, activeGates: ['security', 'data-integrity', 'performance'], usage, floorPct: 12 });
  assert.equal(p.harness, 'claude');
});

test('planNext: no harness above floor -> usage-aware STOP (never over-spend)', () => {
  const sections = parseLedger(LEDGER);
  const usage = { claude: { ok: true, leftPct: 8, w5: 20 }, codex: { ok: false, leftPct: 0 } };
  const p = planNext({ sections, activeGates: ['security'], usage, floorPct: 12 });
  assert.equal(p.stop, true);
  assert.match(p.reason, /floor/);
});

test('planNext: nothing pending -> STOP done, even with full budget', () => {
  const sections = parseLedger(LEDGER);
  const usage = { claude: { ok: true, leftPct: 99, w5: 99 }, codex: { ok: true, leftPct: 99, w5: 99 } };
  const p = planNext({ sections, activeGates: ['security'], usage, floorPct: 12 }); // only docs+root security done... root done, docs done, scripts pending
  // security: root done, docs done, scripts pending -> not all done
  assert.equal(p.stop, false);
  const p2 = planNext({ sections: sections.filter((x) => x.section !== 'scripts/'), activeGates: ['security'], usage, floorPct: 12 });
  assert.equal(p2.stop, true);
  assert.match(p2.reason, /all sections/);
});

test('buildDispatchArgv: per-harness command; unknown throws', () => {
  assert.deepEqual(buildDispatchArgv({ harness: 'claude', promptPath: '/tmp/p' }), { file: 'claude', args: ['-p', '@/tmp/p'] });
  assert.deepEqual(buildDispatchArgv({ harness: 'codex', promptPath: '/tmp/p' }), { file: 'codex', args: ['exec', '@/tmp/p'] });
  assert.throws(() => buildDispatchArgv({ harness: 'nope', promptPath: '/tmp/p' }), /unknown harness/);
});

test('buildPrompt: names only the active gates, pins the baseline, lists the explicit files (no ls-tree)', () => {
  const prompt = buildPrompt({ section: 'scripts/', gates: ['security'], baseline: 'abc123', repoDir: '/repo', findingsPath: 'f.json', auditDate: '2026-07-23', files: ['scripts/a.mjs', 'scripts/b.mjs'] });
  assert.match(prompt, /origin\/master abc123/);
  assert.match(prompt, /- security:/);
  assert.doesNotMatch(prompt, /- performance:/);
  assert.match(prompt, /f\.json/);
  assert.match(prompt, /scripts\/a\.mjs/); // explicit file listed
  assert.doesNotMatch(prompt, /ls-tree/); // orchestrator enumerated; the worker just reads the given files
  assert.doesNotMatch(prompt, /<section-path>/);
});

test('parseArgs: requires --baseline, defaults to --plan', () => {
  const a = parseArgs(['--baseline', 'abc', '--gates', 'security,performance', '--floor', '15']);
  assert.equal(a.baseline, 'abc');
  assert.equal(a.mode, 'plan');
  assert.equal(a.gates, 'security,performance');
  assert.equal(a.floor, 15);
  assert.equal(parseArgs(['--baseline', 'abc', '--run']).mode, 'run');
  assert.throws(() => parseArgs(['--run']), /--baseline/);
  assert.throws(() => parseArgs(['--baseline', 'a', '--bogus']), /unknown arg/);
});
