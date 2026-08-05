// Gate discrimination registry (#3478, epic #1930).
//
// Every gate surface in this repo — a `gate:*` package script, a
// scripts/check-*.mjs, or another CI-consumed verifier — is listed here with
// the test file that proves the gate CAN FAIL (a "discriminating" test: it
// drives the real surface and asserts a non-zero exit / must-reject verdict).
// A gate whose only tests exercise the passing path is indistinguishable from
// `exit 0`; this registry is what makes that class of gate non-recurring.
//
// `discriminatingTest` is a repo-relative scripts/ or src/ test path, or null
// ONLY for the seeded legacy exceptions in LEGACY_NULL_GATES below.
// scripts/check-gate-discrimination.mjs enforces:
//   1. every gate surface is registered (new gates must register),
//   2. every named test file exists,
//   3. a null entry's name must be in the seeded legacy list — and that list
//      only SHRINKS: when a gate's discriminating test lands, remove its name
//      here and set the entry's test path. Adding a name fails the check.

export const GATE_REGISTRY = [
  // ── registered with a discriminating test ────────────────────────────────
  {
    name: 'repo-map-gate',
    script: 'scripts/repo-map-gate.mjs',
    discriminatingTest: 'scripts/repo-map-gate.test.mjs',
  },
  {
    name: 'cold-ingest-bench',
    script: 'scripts/cold-ingest-bench.mjs',
    discriminatingTest: 'scripts/cold-ingest-bench.test.mjs',
  },
  {
    name: 'measure-isolated-views',
    script: 'scripts/measure-isolated-views.mjs',
    discriminatingTest: 'scripts/measure-isolated-views.test.mjs',
  },
  {
    name: 'perf-probe',
    script: 'scripts/perf-probe.mjs',
    discriminatingTest: 'scripts/perf-probe.test.mjs',
  },
  {
    name: 'proof-batch',
    script: 'scripts/proof-batch.mjs',
    discriminatingTest: 'scripts/proof-batch.test.mjs',
  },
  {
    name: 'check-engine-absent',
    script: 'scripts/check-engine-absent.mjs',
    discriminatingTest: 'scripts/check-engine-absent.test.mjs',
  },
  {
    name: 'check-no-binary-sources',
    script: 'scripts/check-no-binary-sources.mjs',
    discriminatingTest: 'scripts/check-no-binary-sources.test.mjs',
  },
  {
    name: 'check-personal-paths',
    script: 'scripts/check-personal-paths.mjs',
    discriminatingTest: 'scripts/check-personal-paths.test.mjs',
  },
  {
    // The pure evaluator's must-fail cases live in the vitest suite; the CLI
    // is a thin filesystem wrapper around it.
    name: 'check-bundle-size',
    script: 'scripts/check-bundle-size.mjs',
    discriminatingTest: 'src/lib/check-bundle-size.test.ts',
  },
  {
    // Drives the real gate over synthetic dists: both leak shapes fail (exit 1)
    // and an empty/absent dist is "verified nothing" (exit 2), never a pass.
    name: 'check-spa-no-node-fs',
    script: 'scripts/check-spa-no-node-fs.mjs',
    discriminatingTest: 'scripts/check-spa-no-node-fs.test.mjs',
  },
  {
    // Inspected for #3478: its runCli spawn tests assert status 1 for missing
    // gates / open work / unaudited deferrals — already discriminating.
    name: 'check-release-gate',
    script: 'scripts/check-release-gate.mjs',
    discriminatingTest: 'scripts/check-release-gate.test.mjs',
  },
  {
    // Pins: empty diff is NOT docs-only; no diff strategy is a nonzero exit.
    name: 'ci-docs-only',
    script: 'scripts/ci-docs-only.mjs',
    discriminatingTest: 'scripts/ci-docs-only.test.mjs',
  },
  {
    // Composition gate: its own suite asserts the must-fail seams it owns
    // (boundary offenders throw; --require-emitted-bundle hard-fails a missing
    // bundle); each composed sub-gate carries its own registry entry.
    name: 'enterprise-readiness-gate',
    script: 'scripts/enterprise-readiness-gate.mjs',
    discriminatingTest: 'scripts/enterprise-readiness-gate.test.mjs',
  },
  {
    // The ratchet checks itself.
    name: 'check-gate-discrimination',
    script: 'scripts/check-gate-discrimination.mjs',
    discriminatingTest: 'scripts/check-gate-discrimination.test.mjs',
  },
  {
    name: 'check-perf-index-contracts',
    script: 'scripts/check-perf-index-contracts.mjs',
    discriminatingTest: 'scripts/check-perf-index-contracts.test.mjs',
  },
  {
    name: 'check-pr-workflow-trust',
    script: 'scripts/check-pr-workflow-trust.mjs',
    discriminatingTest: 'scripts/check-pr-workflow-trust.test.mjs',
  },
  {
    name: 'check-arc-dind-sandbox',
    script: 'scripts/check-arc-dind-sandbox.mjs',
    discriminatingTest: 'scripts/check-arc-dind-sandbox.test.mjs',
  },

  // ── seeded legacy exceptions (null = no discriminating test YET) ─────────
  { name: 'check-action-pins', script: 'scripts/check-action-pins.mjs', discriminatingTest: null },
  { name: 'check-shell-quote', script: 'scripts/check-shell-quote.mjs', discriminatingTest: null },
  { name: 'check-inbound-boundary', script: 'scripts/check-inbound-boundary.mjs', discriminatingTest: null },
  { name: 'check-llm-egress', script: 'scripts/check-llm-egress.mjs', discriminatingTest: null },
  { name: 'check-openapi-freshness', script: 'scripts/check-openapi-freshness.mjs', discriminatingTest: null },
  { name: 'check-test-suite-coverage', script: 'scripts/check-test-suite-coverage.mjs', discriminatingTest: null },
  { name: 'ensure-pr-milestone', script: 'scripts/ensure-pr-milestone.mjs', discriminatingTest: null },
  { name: 'seed-release-gates', script: 'scripts/seed-release-gates.mjs', discriminatingTest: null },
  { name: 'enterprise-posture-gate', script: 'scripts/enterprise-posture-gate.mjs', discriminatingTest: null },
  { name: 'check-enterprise-route-inventory', script: 'scripts/check-enterprise-route-inventory.mjs', discriminatingTest: null },
  {
    // The CONFIG path is discriminating-tested (scripts/server-scale-budget.test.mjs,
    // #3478) but the budget-BREACH path (a slow run must exit 1) needs a built
    // server + synthetic corpus and remains unproven — this stays null until a
    // bounded breach test lands.
    name: 'server-scale-budget',
    script: 'scripts/server-scale-budget.mjs',
    discriminatingTest: null,
  },
  { name: 'cold-load-measure', script: 'scripts/cold-load-measure.mjs', discriminatingTest: null },
  { name: 'measure-sessions-scale', script: 'scripts/measure-sessions-scale.mjs', discriminatingTest: null },
  { name: 'ingest-bench', script: 'scripts/ingest-bench.mjs', discriminatingTest: null },
  {
    // The grep/step gates written inline in ci.yml (entry-chunk recharts,
    // SPA-boundary grep, and friends): fail-closed shapes as of #3478 but not
    // separately testable until they move into scripts.
    name: 'ci-yaml-inline-gates',
    script: '.github/workflows/ci.yml',
    discriminatingTest: null,
  },
];

// The shrink-only exception list. Remove a name when its entry gains a real
// discriminatingTest; never add one (the check fails a new null instead).
export const LEGACY_NULL_GATES = [
  'check-action-pins',
  'check-shell-quote',
  'check-inbound-boundary',
  'check-llm-egress',
  'check-openapi-freshness',
  'check-test-suite-coverage',
  'ensure-pr-milestone',
  'seed-release-gates',
  'enterprise-posture-gate',
  'check-enterprise-route-inventory',
  'server-scale-budget',
  'cold-load-measure',
  'measure-sessions-scale',
  'ingest-bench',
  'ci-yaml-inline-gates',
];
