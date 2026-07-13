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
