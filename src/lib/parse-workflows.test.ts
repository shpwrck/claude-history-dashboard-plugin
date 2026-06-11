import { describe, it, expect } from 'vitest';
import {
  parseWorkflows,
  parseWorkflowRun,
  agentsByPhase,
  phaseAggregates,
  runTimeline,
  type WorkflowsResponse,
  type WorkflowRun,
} from './parse-workflows';

// A run with timed + untimed agents across two phases, for the #437 helpers.
const RUN: WorkflowRun = {
  runId: 'wf_t',
  workflowName: 'w',
  status: 'completed',
  startTime: 1000,
  durationMs: 500,
  agentCount: 3,
  totalTokens: 300,
  totalToolCalls: 9,
  defaultModel: null,
  sessionId: 's',
  phases: [],
  agents: [
    { index: 1, label: 'a', phaseIndex: 1, phaseTitle: 'Research', model: null, state: 'done', agentType: null, startedAt: 1000, durationMs: 200, tokens: 100, toolCalls: 3, promptPreview: null, resultPreview: null },
    { index: 2, label: 'b', phaseIndex: 1, phaseTitle: 'Research', model: null, state: 'done', agentType: null, startedAt: 1100, durationMs: 300, tokens: 200, toolCalls: 6, promptPreview: null, resultPreview: null },
    { index: 3, label: 'c', phaseIndex: 2, phaseTitle: 'Verify', model: null, state: 'cached', agentType: null, startedAt: null, durationMs: null, tokens: null, toolCalls: null, promptPreview: null, resultPreview: null },
  ],
};

const resp: WorkflowsResponse = {
  runs: [
    {
      runId: 'wf_old',
      workflowName: 'older-run',
      status: 'completed',
      startTime: 1000,
      durationMs: 500,
      agentCount: 1,
      totalTokens: 10,
      totalToolCalls: 2,
      defaultModel: 'claude-sonnet-4-6',
      sessionId: 'sess-old',
      phases: [{ title: 'Research', detail: 'd' }],
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Research' },
        {
          type: 'workflow_agent',
          index: 1,
          label: 'a:research',
          phaseIndex: 1,
          phaseTitle: 'Research',
          model: 'claude-sonnet-4-6',
          state: 'done',
          startedAt: 1001,
          durationMs: 400,
          tokens: 10,
          toolCalls: 2,
          promptPreview: 'do research',
          resultPreview: 'found it',
        },
      ],
    },
    {
      runId: 'wf_new',
      workflowName: 'newer-run',
      status: 'completed',
      startTime: 2000,
      sessionId: 'sess-new',
      // A cached agent: tokens/toolCalls/durationMs OMITTED entirely.
      workflowProgress: [
        {
          type: 'workflow_agent',
          index: 2,
          label: 'b:second',
          phaseIndex: 2,
          phaseTitle: 'Verify',
          state: 'cached',
        },
        {
          type: 'workflow_agent',
          index: 1,
          label: 'a:first',
          phaseIndex: 1,
          phaseTitle: 'Research',
          state: 'done',
        },
      ],
    },
  ],
};

describe('parseWorkflows', () => {
  it('orders runs newest-first by startTime', () => {
    const runs = parseWorkflows(resp);
    expect(runs.map((r) => r.runId)).toEqual(['wf_new', 'wf_old']);
  });

  it('extracts run fields and the parent sessionId', () => {
    const run = parseWorkflows(resp).find((r) => r.runId === 'wf_old')!;
    expect(run.workflowName).toBe('older-run');
    expect(run.status).toBe('completed');
    expect(run.agentCount).toBe(1);
    expect(run.totalTokens).toBe(10);
    expect(run.sessionId).toBe('sess-old');
    expect(run.phases[0].title).toBe('Research');
  });

  it('filters out workflow_phase markers, keeps only agents, sorted by index', () => {
    const run = parseWorkflows(resp).find((r) => r.runId === 'wf_new')!;
    expect(run.agents).toHaveLength(2);
    expect(run.agents.map((a) => a.index)).toEqual([1, 2]); // sorted
  });

  it('coalesces omitted agent fields to null (no zero-fill)', () => {
    const run = parseWorkflows(resp).find((r) => r.runId === 'wf_new')!;
    const cached = run.agents.find((a) => a.label === 'b:second')!;
    expect(cached.tokens).toBeNull();
    expect(cached.toolCalls).toBeNull();
    expect(cached.durationMs).toBeNull();
    expect(cached.agentType).toBeNull();
  });

  it('drops a run with no runId', () => {
    expect(parseWorkflowRun({ workflowName: 'x' })).toBeNull();
  });

  it('returns [] for null/empty input', () => {
    expect(parseWorkflows(null)).toEqual([]);
    expect(parseWorkflows({ runs: [] })).toEqual([]);
  });
});

describe('agentsByPhase', () => {
  it('groups agents by phase title in first-seen order', () => {
    const run = parseWorkflows(resp).find((r) => r.runId === 'wf_new')!;
    const grouped = agentsByPhase(run);
    expect(grouped.map((g) => g.phase)).toEqual(['Research', 'Verify']);
    expect(grouped[0].agents[0].label).toBe('a:first');
  });
});

describe('phaseAggregates (#437)', () => {
  it('sums tokens and computes wall-clock span per phase', () => {
    const aggs = phaseAggregates(RUN);
    expect(aggs.map((a) => a.phase)).toEqual(['Research', 'Verify']);
    const research = aggs[0];
    expect(research.tokenSum).toBe(300); // 100 + 200
    expect(research.startMin).toBe(1000);
    expect(research.endMax).toBe(1400); // max(1000+200, 1100+300)
    expect(research.spanMs).toBe(400);
  });

  it('leaves span null for a phase whose agents have no timing', () => {
    const verify = phaseAggregates(RUN).find((a) => a.phase === 'Verify')!;
    expect(verify.tokenSum).toBe(0); // cached agent, null tokens — not zero-filled into a number
    expect(verify.startMin).toBeNull();
    expect(verify.spanMs).toBeNull();
  });

  it('does not zero-fill the span when start is known but duration is null', () => {
    // startedAt present, durationMs null → we have a start instant but no span,
    // so spanMs must be null (renders "—"), NOT 0 (which would render "0s").
    const run: WorkflowRun = {
      ...RUN,
      agents: [
        { ...RUN.agents[0], startedAt: 5000, durationMs: null, phaseTitle: 'Solo', phaseIndex: 9 },
      ],
    };
    const solo = phaseAggregates(run).find((a) => a.phase === 'Solo')!;
    expect(solo.startMin).toBe(5000);
    expect(solo.endMax).toBeNull();
    expect(solo.spanMs).toBeNull();
  });
});

describe('runTimeline (#437)', () => {
  it('offsets bars from the earliest agent start and scales by total span', () => {
    const tl = runTimeline(RUN);
    expect(tl.startRef).toBe(1000);
    expect(tl.totalSpanMs).toBe(400); // 1400 - 1000
    const a = tl.bars.find((b) => b.agent.label === 'a')!;
    const b = tl.bars.find((x) => x.agent.label === 'b')!;
    expect(a.offsetMs).toBe(0);
    expect(a.durationMs).toBe(200);
    expect(b.offsetMs).toBe(100); // 1100 - 1000
    expect(a.hasTiming).toBe(true);
  });

  it('marks untimed agents hasTiming:false without a zero bar', () => {
    const c = runTimeline(RUN).bars.find((b) => b.agent.label === 'c')!;
    expect(c.hasTiming).toBe(false);
    expect(c.offsetMs).toBe(0);
    expect(c.durationMs).toBe(0);
  });

  it('never divides by zero when no agent is timed', () => {
    const untimed: WorkflowRun = { ...RUN, startTime: null, agents: [{ ...RUN.agents[2] }] };
    expect(runTimeline(untimed).totalSpanMs).toBe(1);
  });
});
