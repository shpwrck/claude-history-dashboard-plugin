import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

function workflowFixture() {
  const root = join(tmpdir(), `chd-workflow-bounds-${randomUUID()}`);
  const workflows = join(root, 'projects', 'proj-a', 'sess-a', 'workflows');
  mkdirSync(workflows, { recursive: true });
  writeFileSync(
    join(workflows, 'wf_a.json'),
    JSON.stringify({
      runId: 'wf-a',
      workflowName: 'A',
      status: 'completed',
      startTime: 1767225600000,
    })
  );
  writeFileSync(
    join(workflows, 'wf_b.json'),
    JSON.stringify({
      runId: 'wf-b',
      workflowName: 'B',
      status: 'completed',
      startTime: 1767225600001,
    })
  );
  return { root, projectsRoot: join(root, 'projects') };
}

function sparseWorkflowFixture(sessionCount = 12) {
  const root = join(tmpdir(), `chd-workflow-discovery-${randomUUID()}`);
  const projectsRoot = join(root, 'projects');
  for (let index = 0; index < sessionCount; index += 1) {
    const workflows = join(
      projectsRoot,
      'proj-a',
      `sess-${String(index).padStart(3, '0')}`,
      'workflows'
    );
    mkdirSync(workflows, { recursive: true });
    writeFileSync(
      join(workflows, `wf_${index}.json`),
      JSON.stringify({
        runId: `wf-${index}`,
        workflowName: 'Sparse fixture',
        status: 'completed',
        startTime: 1767225600000 + index,
      })
    );
  }
  return { root, projectsRoot };
}

test('readWorkflows readers share one injected discovery budget across sparse nested directories (#3100)', async () => {
  const fx = sparseWorkflowFixture();
  try {
    const workflows = await import(`./read-workflows.mjs?fixture=${randomUUID()}`);
    const options = { discoveryMaxEntries: 3 };

    for (const [label, result] of [
      ['async', await workflows.readWorkflows(fx.projectsRoot, options)],
      ['sync', workflows.readWorkflowsSync(fx.projectsRoot, options)],
    ]) {
      assert.equal(result.runs.length, 0, `${label}: must stop before workflow dirs`);
      assert.equal(result.truncated, true, `${label}: exhausted discovery is truncated`);
      assert.equal(result.limits.maxDiscoveryEntries, 3);
      assert.deepEqual(
        result.discovery,
        { entriesExamined: 3, directoriesOpened: 2 },
        `${label}: work, not only retained runs, stays within the injected budget`
      );
    }
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

function projectedWorkflowFixture() {
  const root = join(tmpdir(), `chd-workflow-projection-${randomUUID()}`);
  const workflows = join(root, 'projects', 'proj-a', 'sess-a', 'workflows');
  const longText = 'x'.repeat(64);
  mkdirSync(workflows, { recursive: true });
  writeFileSync(
    join(workflows, 'wf_projection.json'),
    JSON.stringify({
      runId: longText,
      workflowName: longText,
      status: 'completed',
      startTime: 1767225600000,
      phases: [
        { title: longText, detail: longText },
        { title: 'second', detail: 'second detail' },
      ],
      workflowProgress: [
        {
          type: 'workflow_phase',
          index: 0,
          title: longText,
        },
        {
          type: 'workflow_agent',
          index: 1,
          label: longText,
          phaseTitle: longText,
          model: longText,
          state: 'completed',
          agentType: longText,
          tokens: { nested: longText },
          toolCalls: 3,
          promptPreview: longText,
          resultPreview: longText,
        },
      ],
    })
  );
  return { root, projectsRoot: join(root, 'projects') };
}

function projectedWorkflowErrorFixture() {
  const root = join(tmpdir(), `chd-workflow-error-projection-${randomUUID()}`);
  const workflows = join(root, 'projects', 'proj-a', 'sess-a', 'workflows');
  const longText = 'x'.repeat(400);
  mkdirSync(workflows, { recursive: true });
  writeFileSync(
    join(workflows, 'wf_error.json'),
    JSON.stringify({
      runId: 'wf-error',
      workflowName: 'error-run',
      status: 'failed',
      startTime: 1767225600000,
      workflowProgress: [
        {
          type: 'workflow_agent',
          index: 1,
          state: 'error',
          promptPreview: longText,
          resultPreview: longText,
          error: longText,
        },
        { type: 'workflow_agent', index: 2, state: 'error', error: { nested: longText } },
      ],
    })
  );
  return { root, projectsRoot: join(root, 'projects') };
}

test('readWorkflows and readWorkflowsSync honor the workflow run cap', async () => {
  const fx = workflowFixture();
  const origCap = process.env.DASHBOARD_WORKFLOW_RUN_MAX_ENTRIES;
  try {
    process.env.DASHBOARD_WORKFLOW_RUN_MAX_ENTRIES = '1';
    const workflows = await import(`./read-workflows.mjs?fixture=${randomUUID()}`);

    const asyncResult = await workflows.readWorkflows(fx.projectsRoot);
    assert.equal(asyncResult.limits.maxRuns, 1);
    assert.equal(asyncResult.runs.length, 1);
    assert.equal(asyncResult.truncated, true);

    const syncResult = workflows.readWorkflowsSync(fx.projectsRoot);
    assert.equal(syncResult.limits.maxRuns, 1);
    assert.equal(syncResult.runs.length, 1);
    assert.equal(syncResult.truncated, true);
  } finally {
    if (origCap === undefined) delete process.env.DASHBOARD_WORKFLOW_RUN_MAX_ENTRIES;
    else process.env.DASHBOARD_WORKFLOW_RUN_MAX_ENTRIES = origCap;
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('readWorkflows and readWorkflowsSync bound projected workflow payloads', async () => {
  const fx = projectedWorkflowFixture();
  const origPhaseCap = process.env.DASHBOARD_WORKFLOW_PHASE_MAX_ENTRIES;
  const origProgressCap = process.env.DASHBOARD_WORKFLOW_PROGRESS_MAX_ENTRIES;
  const origFieldCap = process.env.DASHBOARD_WORKFLOW_FIELD_MAX_CHARS;
  try {
    process.env.DASHBOARD_WORKFLOW_PHASE_MAX_ENTRIES = '1';
    process.env.DASHBOARD_WORKFLOW_PROGRESS_MAX_ENTRIES = '1';
    process.env.DASHBOARD_WORKFLOW_FIELD_MAX_CHARS = '8';
    const workflows = await import(`./read-workflows.mjs?fixture=${randomUUID()}`);

    for (const result of [
      await workflows.readWorkflows(fx.projectsRoot),
      workflows.readWorkflowsSync(fx.projectsRoot),
    ]) {
      assert.equal(result.limits.maxPhasesPerRun, 1);
      assert.equal(result.limits.maxProgressEntriesPerRun, 1);
      assert.equal(result.limits.fieldMaxChars, 8);
      assert.equal(result.runs.length, 1);
      assert.equal(result.runs[0].runId.length, 8);
      assert.equal(result.runs[0].workflowName.length, 8);
      assert.equal(result.runs[0].phases.length, 1);
      assert.equal(result.runs[0].phases[0].title.length, 8);
      assert.equal(result.runs[0].phases[0].detail.length, 8);
      assert.equal(result.runs[0].workflowProgress.length, 1);
      assert.equal(result.runs[0].workflowProgress[0].title.length, 8);
    }
  } finally {
    if (origPhaseCap === undefined) delete process.env.DASHBOARD_WORKFLOW_PHASE_MAX_ENTRIES;
    else process.env.DASHBOARD_WORKFLOW_PHASE_MAX_ENTRIES = origPhaseCap;
    if (origProgressCap === undefined) delete process.env.DASHBOARD_WORKFLOW_PROGRESS_MAX_ENTRIES;
    else process.env.DASHBOARD_WORKFLOW_PROGRESS_MAX_ENTRIES = origProgressCap;
    if (origFieldCap === undefined) delete process.env.DASHBOARD_WORKFLOW_FIELD_MAX_CHARS;
    else process.env.DASHBOARD_WORKFLOW_FIELD_MAX_CHARS = origFieldCap;
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('readWorkflows and readWorkflowsSync preserve bounded workflow-agent errors', async () => {
  const fx = projectedWorkflowErrorFixture();
  try {
    const workflows = await import(`./read-workflows.mjs?fixture=${randomUUID()}`);

    for (const result of [
      await workflows.readWorkflows(fx.projectsRoot),
      workflows.readWorkflowsSync(fx.projectsRoot),
    ]) {
      const progress = result.runs[0].workflowProgress[0];
      assert.equal(progress.promptPreview.length, 280);
      assert.equal(progress.resultPreview.length, 280);
      assert.equal(progress.error.length, 280);
      assert.equal(result.runs[0].workflowProgress[1].error, null);
    }
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #3099: newest-first ordering must survive string timestamps.
//
// `boundedScalar` preserved arbitrary strings, and the comparator subtracted
// them — an ISO timestamp minus another is NaN, which Array.prototype.sort
// reads as "no ordering", so the documented newest-first result silently
// degraded to directory iteration order. The manifests below are written in
// REVERSE chronological order, so an inert comparator leaves them that way.
// ---------------------------------------------------------------------------
function mixedTimestampFixture() {
  const root = join(tmpdir(), `chd-workflow-order-${randomUUID()}`);
  const workflows = join(root, 'projects', 'proj-a', 'sess-a', 'workflows');
  mkdirSync(workflows, { recursive: true });
  // Written oldest -> newest so filesystem/discovery order is the REVERSE of
  // the required result; `wf_d` has an unusable timestamp.
  const manifests = [
    ['wf_a.json', { runId: 'oldest-number', startTime: 1767225600000 }],
    ['wf_b.json', { runId: 'middle-iso-string', startTime: '2026-01-01T00:00:10.000Z' }],
    ['wf_c.json', { runId: 'newest-numeric-string', startTime: '1767225620000' }],
    ['wf_d.json', { runId: 'unusable', startTime: 'sometime last tuesday' }],
  ];
  for (const [name, extra] of manifests) {
    writeFileSync(
      join(workflows, name),
      JSON.stringify({ workflowName: 'W', status: 'completed', ...extra })
    );
  }
  return { root, projectsRoot: join(root, 'projects') };
}

test('normalizeStartTime: numbers, numeric strings and ISO strings become epoch ms; anything else is null', async () => {
  const { normalizeStartTime } = await import('./read-workflows.mjs');
  assert.equal(normalizeStartTime(1767225600000), 1767225600000);
  assert.equal(normalizeStartTime('1767225600000'), 1767225600000);
  assert.equal(normalizeStartTime('2026-01-01T00:00:00.000Z'), 1767225600000);
  assert.equal(normalizeStartTime('sometime last tuesday'), null);
  assert.equal(normalizeStartTime(''), null);
  assert.equal(normalizeStartTime(null), null);
  assert.equal(normalizeStartTime(Number.NaN), null);
  assert.equal(normalizeStartTime(true), null);
  assert.equal(normalizeStartTime({}), null);
});

test('readWorkflows and readWorkflowsSync order runs newest-first across timestamp shapes', async () => {
  const fx = mixedTimestampFixture();
  try {
    const workflows = await import(`./read-workflows.mjs?fixture=${randomUUID()}`);
    const expected = [
      'newest-numeric-string',
      'middle-iso-string',
      'oldest-number',
      'unusable', // no usable timestamp -> last, never interleaved
    ];
    for (const [label, result] of [
      ['async', await workflows.readWorkflows(fx.projectsRoot)],
      ['sync', workflows.readWorkflowsSync(fx.projectsRoot)],
    ]) {
      assert.deepEqual(
        result.runs.map((r) => r.runId),
        expected,
        `${label} reader must return runs newest-first`
      );
      // Every projected startTime is a number or null — never a raw string.
      for (const run of result.runs) {
        assert.ok(
          run.startTime === null || typeof run.startTime === 'number',
          `${label}: startTime must be normalized, got ${JSON.stringify(run.startTime)}`
        );
      }
      assert.equal(result.runs.at(-1).startTime, null);
    }
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
