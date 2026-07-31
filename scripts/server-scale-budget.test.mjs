// The server-scale budget gate's CONFIG path must be able to fail (#3478,
// epic #1930).
//
// Run: node --test scripts/server-scale-budget.test.mjs   (npm run test:server-scale-budget)
//
// The defect this pins: `intEnv` parseInt'd every DASHBOARD_SCALE_* override
// and silently fell back on anything unusable — `=abc`/`=0` became the default
// and `=12g` became 12 — across all 14 budgets, so an operator typo produced a
// green run that measured something other than what was asked. The parsing now
// routes through the canonical fail-closed envNumber helper (#3076) and dies
// loudly (exit 2) before any corpus is synthesized or server booted.
//
// Deliberately NOT covered here: the full budget-BREACH path (a slow run must
// exit 1). That requires a built server + the synthetic 1200-session corpus
// and lives in .github/workflows/server-scale.yml; it stays on the gate
// discrimination registry's legacy exception list (scripts/lib/gate-registry.mjs)
// until a bounded breach test exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runGate, PROJECT_DIR } from './lib/gate-harness.mjs';

const GATE = join(PROJECT_DIR, 'scripts', 'server-scale-budget.mjs');

// A tiny-but-valid budget file: even if a regression re-opened the silent
// fallback, the run it would start is bounded (2 sessions, generous ceilings)
// and would then FAIL the exit-code assertion by exiting 0.
const VALID_BUDGET = {
  sessions: 2,
  turnsPerSession: 1,
  projects: 1,
  users: 1,
  teams: 1,
  assembleSamples: 1,
  serverBootBudgetMs: 60_000,
  serverDatasetLoadBudgetMs: 60_000,
  coldIngestBudgetMs: 60_000,
  assembleBudgetMs: 60_000,
  serializeBudgetMs: 60_000,
  warmIngestBudgetMs: 60_000,
  datasetBytesBudget: 1_000_000_000,
  heapGrowthBudgetBytes: 4_000_000_000,
  rssGrowthBudgetBytes: 4_000_000_000,
};

function withBudgetFile(budget, run) {
  const dir = mkdtempSync(join(tmpdir(), 'server-scale-budget-'));
  try {
    const path = join(dir, 'budget.json');
    writeFileSync(path, JSON.stringify(budget, null, 2));
    return run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runScaleGate(budgetPath, env) {
  return runGate(GATE, ['--budget', budgetPath], { registerTs: true, env });
}

test('a set-but-unusable DASHBOARD_SCALE_* var is a loud death, not a silent fallback', () => {
  withBudgetFile(VALID_BUDGET, (budgetPath) => {
    const r = runScaleGate(budgetPath, { DASHBOARD_SCALE_SESSIONS: '12g' });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /DASHBOARD_SCALE_SESSIONS/);
    assert.match(r.out, /not a finite number|not an integer/);
    assert.doesNotMatch(r.out, /PASS server-mode scale budget/);
  });
});

test('zero is out of range (min 1), never quietly the default', () => {
  withBudgetFile(VALID_BUDGET, (budgetPath) => {
    const r = runScaleGate(budgetPath, { DASHBOARD_SCALE_TURNS: '0' });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /DASHBOARD_SCALE_TURNS/);
    assert.match(r.out, /out of range/);
  });
});

test('a non-integer budget override fails loudly too', () => {
  withBudgetFile(VALID_BUDGET, (budgetPath) => {
    const r = runScaleGate(budgetPath, {
      DASHBOARD_SCALE_ASSEMBLE_BUDGET_MS: '2.5s',
    });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /DASHBOARD_SCALE_ASSEMBLE_BUDGET_MS/);
  });
});

test('a budget file missing a required key is a hard config error (exit 2)', () => {
  const missingKey = { ...VALID_BUDGET };
  delete missingKey.datasetBytesBudget;
  withBudgetFile(missingKey, (budgetPath) => {
    const r = runScaleGate(budgetPath, {});
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /positive integer "datasetBytesBudget"/);
  });
});

test('assembleSamples is LIVE budget config now, so an invalid value fails (#3478)', () => {
  // It was documented in server-scale-budget.json but filtered out by
  // BUDGET_KEYS, leaving a hard-coded `?? 3` silently governing — dead config.
  const badSamples = { ...VALID_BUDGET, assembleSamples: 0 };
  withBudgetFile(badSamples, (budgetPath) => {
    const r = runScaleGate(budgetPath, {});
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /positive integer "assembleSamples"/);
  });
});
