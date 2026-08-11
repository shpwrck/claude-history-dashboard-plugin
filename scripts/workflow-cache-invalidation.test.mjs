// Regression coverage for workflow-derived cache freshness (#2706).
//
// Workflow manifests live below the shallow project stat gate. These tests prove
// the healthy watcher path, the bounded missed-event backstop, exact projection
// binding across contentHash/assembly, warm-path cost, and cap-based cache fencing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mkdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';

function manifestPath(projectsRoot, name = 'one') {
  return join(
    projectsRoot,
    'project-a',
    'session-a',
    'workflows',
    `wf_${name}.json`
  );
}

function writeManifest(path, runId, status, startTime = 1) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      runId,
      workflowName: 'Cache freshness fixture',
      status,
      startTime,
      phases: [],
      workflowProgress: [],
    })
  );
}

async function waitFor(predicate, message, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail(message);
}

test('watch events invalidate the gate and one projection binds hash to assembly (#2706)', async () => {
  const originalHome = process.env.HOME;
  const originalDb = process.env.CHD_DB_PATH;
  const home = join(tmpdir(), `chd-2706-home-${randomUUID()}`);
  const projectsRoot = join(home, '.claude', 'projects');
  const firstPath = manifestPath(projectsRoot);
  writeManifest(firstPath, 'one', 'running');
  process.env.HOME = home;
  process.env.CHD_DB_PATH = join(tmpdir(), `chd-2706-db-${randomUUID()}.db`);
  let ingest;

  try {
    ingest = await import(`./ingest.mjs?workflow-cache=${randomUUID()}`);
    const source1 = ingest.sourceSignature();
    const coldState = ingest.workflowFreshnessStateForTests();
    assert.equal(coldState.syncScans, 1, 'cold start performs one exact identity scan');
    assert.ok(coldState.watcherCount > 0, 'the healthy local root installs a watcher');

    for (let index = 0; index < 25; index += 1) ingest.sourceSignature();
    const warmState = ingest.workflowFreshnessStateForTests();
    assert.equal(warmState.syncScans, 1, 'warm signatures never re-walk sessions');
    assert.equal(warmState.asyncScans, 0, 'warm signatures do not run reconciliation inline');

    const build1 = ingest.ingest(source1);
    const dataset1 = ingest.assembleRecommendationDataset();
    assert.equal(dataset1.workflows.length, 1);
    assert.equal(dataset1.workflows[0].status, 'running');

    // Restore mtime after an in-place rewrite: ctime/watcher evidence must still
    // invalidate, and contentHash + assembled workflows must agree on the edit.
    const before = statSync(firstPath);
    writeManifest(firstPath, 'one', 'failed');
    utimesSync(firstPath, before.atime, before.mtime);
    await waitFor(
      () => ingest.sourceSignature() !== source1,
      'an in-place manifest edit must move the watcher token within one second'
    );
    const source2 = ingest.sourceSignature();
    const build2 = ingest.ingest(source2);
    const dataset2 = ingest.assembleRecommendationDataset();
    assert.notEqual(build2.contentHash, build1.contentHash);
    assert.equal(dataset2.workflows[0].status, 'failed');

    const secondPath = manifestPath(projectsRoot, 'two');
    writeManifest(secondPath, 'two', 'completed', 2);
    await waitFor(
      () => ingest.sourceSignature() !== source2,
      'adding a manifest must move the watcher token within one second'
    );
    const source3 = ingest.sourceSignature();
    const build3 = ingest.ingest(source3);
    assert.notEqual(build3.contentHash, build2.contentHash);
    assert.deepEqual(
      ingest.assembleRecommendationDataset().workflows.map((run) => run.runId),
      ['two', 'one']
    );

    rmSync(secondPath);
    await waitFor(
      () => ingest.sourceSignature() !== source3,
      'removing a manifest must move the watcher token within one second'
    );
    const build4 = ingest.ingest(ingest.sourceSignature());
    assert.notEqual(build4.contentHash, build3.contentHash);
    assert.deepEqual(
      ingest.assembleRecommendationDataset().workflows.map((run) => run.runId),
      ['one']
    );
  } finally {
    ingest?.disposeWorkflowFreshnessForTests();
    rmSync(home, { recursive: true, force: true });
    rmSync(process.env.CHD_DB_PATH, { force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = originalDb;
  }
});

test('periodic reconciliation bounds missed events and root lifecycle changes (#2706)', async () => {
  const root = join(tmpdir(), `chd-2706-reconcile-${randomUUID()}`);
  const workflows = await import(`./read-workflows.mjs?reconcile=${randomUUID()}`);
  const tracker = workflows.createWorkflowFreshnessTracker(root, {
    watch: false,
    reconcileIntervalMs: 25,
  });

  try {
    const empty = tracker.signature();
    writeManifest(manifestPath(root), 'late', 'completed');
    assert.equal(
      tracker.signature(),
      empty,
      'a deliberately missed event stays stale only until the backstop runs'
    );
    await waitFor(
      () => tracker.signature() !== empty,
      'the backstop must discover a newly-created root and manifest'
    );
    const populated = tracker.signature();

    rmSync(root, { recursive: true, force: true });
    await waitFor(
      () => tracker.signature() !== populated,
      'the backstop must discover root removal/replacement'
    );
    assert.ok(tracker.debugState().asyncScans > 0);

    tracker.dispose();
    assert.equal(tracker.debugState().active, false);
    writeManifest(manifestPath(root), 'returned', 'completed');
    const restarted = tracker.signature();
    assert.equal(tracker.debugState().active, true);
    assert.equal(
      tracker.debugState().syncScans,
      2,
      'an evicted scoped tracker restarts with a new exact cold baseline'
    );
    assert.equal(typeof restarted, 'string');
  } finally {
    tracker.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('every workflow projection cap participates in the persisted cache salt (#2706)', async () => {
  const envNames = [
    'DASHBOARD_WORKFLOW_MANIFEST_MAX_BYTES',
    'DASHBOARD_WORKFLOW_RUN_MAX_ENTRIES',
    'DASHBOARD_WORKFLOW_DISCOVERY_MAX_ENTRIES',
    'DASHBOARD_WORKFLOW_PHASE_MAX_ENTRIES',
    'DASHBOARD_WORKFLOW_PROGRESS_MAX_ENTRIES',
    'DASHBOARD_WORKFLOW_FIELD_MAX_CHARS',
  ];
  const originals = new Map(envNames.map((name) => [name, process.env[name]]));

  try {
    for (const name of envNames) delete process.env[name];
    const baselineModule = await import(`./read-workflows.mjs?caps=${randomUUID()}`);
    const baseline = baselineModule.workflowLimitsSignature();
    for (const name of envNames) {
      process.env[name] = '12345';
      const changedModule = await import(`./read-workflows.mjs?caps=${randomUUID()}`);
      assert.notEqual(
        changedModule.workflowLimitsSignature(),
        baseline,
        `${name} must change the schema salt`
      );
      delete process.env[name];
    }
  } finally {
    for (const [name, value] of originals) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
