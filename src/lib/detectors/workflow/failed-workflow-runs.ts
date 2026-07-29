/**
 * failed-workflow-runs — flags Workflow-tool runs that failed or aborted, or
 * that contain agents left in an error/failed state. A failed orchestration
 * usually means wasted fan-out cost and an incomplete result that produced no
 * recommendation anywhere else. (#635, part of #632)
 *
 * dataDeps: reads the optional `workflows` field on RecommendationInput
 * (parse-workflows output). Absent/empty ⇒ silent.
 */
import type { Detector } from '../types';
import type { WorkflowRun } from '../../parse-workflows';
import { newestEpochDate } from '../shared';

const FAIL_STATUS_RE = /\b(abort|error|fail)/i;
const FAIL_AGENT_STATE_RE = /\b(error|fail)/i;

function isFailedRun(run: WorkflowRun): boolean {
  if (FAIL_STATUS_RE.test(run.status)) return true;
  return run.agents.some((a) => a.state != null && FAIL_AGENT_STATE_RE.test(a.state));
}

export const detector: Detector = {
  id: 'workflow.failed-workflow-runs',
  category: 'workflow',
  dataDeps: ['workflows'],
  rule(input) {
    const runs = input.workflows ?? [];
    if (!runs.length) return null;

    const failed = runs.filter(isFailedRun);
    if (!failed.length) return null;

    const evidence = failed.slice(0, 5).map((r) => {
      const errAgents = r.agents.filter(
        (a) => a.state != null && FAIL_AGENT_STATE_RE.test(a.state)
      ).length;
      const why = errAgents > 0 ? `${errAgents} agent(s) errored` : `status ${r.status}`;
      return `${r.workflowName} (${r.runId}): ${why}`;
    });

    // Split the two independent reasons a run lands in `failed` so the citation
    // names which field carried the evidence rather than blurring them.
    const byStatus = failed.filter((r) => FAIL_STATUS_RE.test(r.status)).length;
    const erroredAgents = failed.reduce(
      (n, r) =>
        n + r.agents.filter((a) => a.state != null && FAIL_AGENT_STATE_RE.test(a.state)).length,
      0
    );
    // Anchored to the newest FAILED run's start — never to `now`, and never to
    // the successful runs. A later clean run contributes to the denominator but
    // to none of the reported failures or evidence rows, so dating the finding
    // from it would assert a freshness the failure signal does not have.
    // `WorkflowRun` records no end instant, so a run's start is the freshest
    // datum available; runs with a null start contribute nothing rather than a
    // fabricated date.
    const asOf = newestEpochDate(failed.map((r) => r.startTime));

    return {
      id: 'workflow.failed-workflow-runs',
      category: 'workflow',
      severity: 'warning',
      title: 'Workflow runs failed or aborted',
      detail: `${failed.length} of ${runs.length} Workflow-tool run(s) failed, aborted, or left an agent in an error state — wasted fan-out cost with no completed result.`,
      action:
        'Review the failed runs in the Workflows view; fix the failing stage or add a guard so the fan-out does not burn cost on a run that cannot complete.',
      affected: failed.length,
      view: 'workflows',
      evidence,
      provenance: {
        observations: [
          {
            claim: `${failed.length} of ${runs.length} parsed Workflow run(s) matched a failure signal`,
            source: 'parse-workflows (workflows[])',
            field: 'status / agents[].state',
            value: failed.length,
          },
          {
            claim: `${byStatus} run(s) carry a run-level status matching /abort|error|fail/i`,
            source: 'parse-workflows (workflows[])',
            field: 'status',
            value: byStatus,
          },
          {
            claim: `${erroredAgents} individual agent(s) inside those runs are in a state matching /error|fail/i`,
            source: 'parse-workflows (workflows[].agents)',
            field: 'agents[].state',
            value: erroredAgents,
          },
        ],
        // What is measured is a SUBSTRING MATCH on two recorded strings. A run
        // whose status text never says abort/error/fail — a silent hang, a
        // partial result the orchestrator called complete — is not counted, so
        // this is a floor, not a total. No cost is read here either: the
        // "wasted fan-out cost" in `detail` is the inference drawn from a run
        // failing, not a measured spend, and a failed run may still have
        // produced usable partial output.
        inference:
          'Run status and agent state strings are pattern-matched; no token spend or ' +
          'output usefulness is measured. A failed or aborted run is read as spend ' +
          'without a completed result, and runs that fail without saying so are not ' +
          'counted at all.',
        ...(asOf ? { asOf } : {}),
      },
    };
  },
};
