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
    };
  },
};
