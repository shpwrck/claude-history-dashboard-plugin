import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detector, BURST_MIN_FAILURES } from './workflow-ratelimit-burst';
import { validateRecommendationProvenance } from '../provenance';
import { filterRecommendationsByProject } from '../../recommendations';
import { parseWorkflows, type WorkflowsResponse } from '../../parse-workflows';
import { readWorkflowsSync } from '../../../../scripts/read-workflows.mjs';
import type { RecommendationInput } from '../types';
import type { WorkflowAgent, WorkflowRun } from '../../parse-workflows';

// ── Fixture builders (parse-workflows shapes, null-coalesced like the parser) ──

function agent(over: Partial<WorkflowAgent> = {}): WorkflowAgent {
  return {
    index: 0,
    label: null,
    phaseIndex: null,
    phaseTitle: null,
    model: null,
    state: 'completed',
    agentType: null,
    startedAt: null,
    durationMs: null,
    tokens: null,
    toolCalls: null,
    promptPreview: null,
    resultPreview: null,
    error: null,
    ...over,
  };
}

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  const agents = over.agents ?? [];
  return {
    runId: 'wf_run',
    workflowName: 'adversarial-review',
    status: 'failed',
    startTime: 1_780_000_000_000,
    durationMs: 60_000,
    agentCount: agents.length,
    totalTokens: null,
    totalToolCalls: null,
    defaultModel: null,
    sessionId: 'f8f7788b',
    phases: [],
    ...over,
    agents,
  };
}

/** An agent killed by plan-limit exhaustion (the observed failure shape). */
const rateLimited = (i: number, over: Partial<WorkflowAgent> = {}): WorkflowAgent =>
  agent({
    index: i,
    state: 'error',
    resultPreview: "You've hit your session limit. Your limit will reset later.",
    ...over,
  });

/** A healthy completed agent. */
const ok = (i: number): WorkflowAgent =>
  agent({ index: i, state: 'completed', resultPreview: 'done', tokens: 40_000 });

function input(workflows?: WorkflowRun[]): RecommendationInput {
  return { workflows } as unknown as RecommendationInput;
}

// ── No burst ───────────────────────────────────────────────────────────────

describe('reliability.workflow-ratelimit-burst — no burst', () => {
  it('emits nothing when workflows are absent or empty', () => {
    expect(detector.rule(input(), 0)).toBeNull();
    expect(detector.rule(input([]), 0)).toBeNull();
  });

  it('emits nothing on healthy runs', () => {
    expect(
      detector.rule(input([run({ status: 'completed', agents: [ok(0), ok(1), ok(2)] })]), 0)
    ).toBeNull();
  });

  it('stays silent below the burst floor (fewer than 3 rate-limit failures in a run)', () => {
    const r = run({ agents: [rateLimited(0), rateLimited(1), ok(2), ok(3)] });
    expect(BURST_MIN_FAILURES).toBe(3);
    expect(detector.rule(input([r]), 0)).toBeNull();
  });

  it('does NOT pool sub-floor failures across separate runs into one burst', () => {
    // 2 + 2 rate-limit failures in two different runs: neither run is a burst.
    const a = run({ runId: 'wf_a', agents: [rateLimited(0), rateLimited(1), ok(2)] });
    const b = run({ runId: 'wf_b', agents: [rateLimited(0), rateLimited(1), ok(2)] });
    expect(detector.rule(input([a, b]), 0)).toBeNull();
  });
});

// ── Non-rate-limit failures ────────────────────────────────────────────────

describe('reliability.workflow-ratelimit-burst — non-rate-limit failures stay silent', () => {
  it('ignores a burst of generic (non-rate-limit) agent errors', () => {
    const generic = (i: number): WorkflowAgent =>
      agent({ index: i, state: 'error', resultPreview: 'TypeError: cannot read properties of null' });
    const r = run({ agents: [generic(0), generic(1), generic(2), generic(3), ok(4)] });
    expect(detector.rule(input([r]), 0)).toBeNull();
  });

  it('ignores COMPLETED agents even when their result has a canonical limit message', () => {
    const mention = (i: number): WorkflowAgent =>
      agent({
        index: i,
        state: 'completed',
        resultPreview: "You've hit your session limit. Your limit will reset later.",
      });
    const r = run({ status: 'completed', agents: [mention(0), mention(1), mention(2), mention(3)] });
    expect(detector.rule(input([r]), 0)).toBeNull();
  });

  it('ignores failed tasks whose domain text merely mentions a rate limiter', () => {
    const taskFailure = (i: number, resultPreview: string): WorkflowAgent =>
      agent({ index: i, state: 'failed', resultPreview });
    const r = run({
      agents: [
        taskFailure(0, 'rate limiter test failed: expected the burst to be throttled'),
        taskFailure(1, 'rate limit middleware test failed to compile'),
        taskFailure(2, 'failed to update the rate limiter documentation'),
        ok(3),
      ],
    });
    expect(detector.rule(input([r]), 0)).toBeNull();
  });
});

// ── Small burst → warning ──────────────────────────────────────────────────

describe('reliability.workflow-ratelimit-burst — small burst (warning)', () => {
  const smallBurst = run({
    runId: 'wf_small',
    agents: [rateLimited(0), rateLimited(1), rateLimited(2), ok(3), ok(4), ok(5), ok(6), ok(7)],
  });

  it('fires at warning with run/session ref, failure count, and total agents', () => {
    const rec = detector.rule(input([smallBurst]), 0);
    expect(rec).not.toBeNull();
    expect(rec!.id).toBe('reliability.workflow-ratelimit-burst');
    expect(rec!.category).toBe('reliability');
    expect(rec!.severity).toBe('warning'); // 3/8 is a burst but not catastrophic
    expect(rec!.affected).toBe(1); // one burst run
    expect(rec!.view).toBe('workflows');
    expect(rec!.evidence![0]).toContain('wf_small');
    expect(rec!.evidence![0]).toContain('session f8f7788b');
    expect(rec!.evidence![0]).toContain(
      '3/8 agents failed on explicit usage-limit exhaustion'
    );
  });

  it('leads evidence with short(sessionId) so project filtering retains the detector', () => {
    const sessionId = 'aaaaaaaa-1111-2222-3333-444444444444';
    const rec = detector.rule(input([run({ sessionId, agents: smallBurst.agents })]), 0)!;
    const sessions = [
      { sessionId, project: '/repo/alpha' },
      { sessionId: 'bbbbbbbb-1111-2222-3333-444444444444', project: '/repo/beta' },
    ];

    expect(rec.evidence![0]).toMatch(/^aaaaaaaa[,\s]/);
    expect(filterRecommendationsByProject([rec], '/repo/alpha', sessions)).toHaveLength(1);
    expect(filterRecommendationsByProject([rec], '/repo/beta', sessions)).toEqual([]);
  });

  it('gives conditional guard guidance and points salvage at completed agent transcripts', () => {
    const rec = detector.rule(input([smallBurst]), 0);
    expect(rec!.action).toContain('session-usage');
    expect(rec!.action).toContain('workflow-window-guard');
    expect(rec!.action).toContain('If your environment has');
    expect(rec!.action).not.toContain('enforce this');
    expect(rec!.action).toContain('half the remaining window');
    expect(rec!.action).toContain('weekly/plan headroom');
    expect(rec!.action).toContain('defer until reset or reduce scope');
    expect(rec!.action).toContain('~10 agents');
    expect(rec!.action).toContain('one verifier per finding');
    expect(rec!.action).toContain('subagents/workflows/wf_small/agent-*.jsonl');
    expect(rec!.action).not.toContain('journal.jsonl');
  });

  it('sums estimated wasted tokens from the rate-limited agents when derivable', () => {
    const costed = run({
      runId: 'wf_costed',
      agents: [
        rateLimited(0, { tokens: 50_000 }),
        rateLimited(1, { tokens: 30_000 }),
        rateLimited(2, { tokens: 20_000 }),
        ok(3),
      ],
    });
    const rec = detector.rule(input([costed]), 0);
    expect(rec!.evidence![0]).toContain('~100k tokens spent by failed agents');
    expect(rec!.detail).toContain('~100k failed-agent tokens');
    // The token sum is a separate cited observation.
    const tokenObs = rec!.provenance!.observations.find((o) =>
      o.field?.includes('agents[].tokens')
    );
    expect(tokenObs?.value).toBe(100_000);
  });

  it('omits the wasted-token claim when no failed agent carries tokens', () => {
    const rec = detector.rule(input([smallBurst]), 0);
    expect(rec!.detail).not.toContain('failed-agent tokens');
    expect(
      rec!.provenance!.observations.some((observation) =>
        observation.field?.includes('agents[].tokens')
      )
    ).toBe(false);
  });

  it('labels partial failed-agent token sums as a known lower bound', () => {
    const partial = run({
      runId: 'wf_partial_tokens',
      agents: [
        rateLimited(0, { tokens: 50_000 }),
        rateLimited(1),
        rateLimited(2),
        ok(3),
      ],
    });
    const rec = detector.rule(input([partial]), 0)!;
    expect(rec.evidence![0]).toContain('at least ~50k known tokens spent');
    expect(rec.evidence![0]).toContain('2 failed agent token count(s) unknown');
    expect(rec.detail).toContain('at least ~50k known failed-agent tokens');
    const tokenObs = rec.provenance!.observations.find((o) =>
      o.field?.includes('agents[].tokens')
    );
    expect(tokenObs?.value).toBe(50_000);
    expect(tokenObs?.claim).toContain('at least ~50k known tokens');
    expect(tokenObs?.claim).toContain(
      '2 failed agent token count(s) were unavailable or invalid'
    );
  });

  it('rejects a negative failed-agent token count as unavailable/invalid, never summed (#3218)', () => {
    // The baseline parser admits finite negatives; a −20k row must not subtract
    // from the known total nor let the accounting be reported as complete.
    const negative = run({
      runId: 'wf_negative_tokens',
      agents: [
        rateLimited(0, { tokens: 50_000 }),
        rateLimited(1, { tokens: -20_000 }),
        rateLimited(2, { tokens: 20_000 }),
        ok(3),
      ],
    });
    const rec = detector.rule(input([negative]), 0)!;

    // 50k + 20k = 70k known (the −20k row is excluded, not subtracted).
    expect(rec.evidence![0]).toContain('at least ~70k known tokens spent');
    expect(rec.evidence![0]).toContain('1 failed agent token count(s) unknown');
    expect(rec.detail).toContain('at least ~70k known failed-agent tokens');

    const tokenObs = rec.provenance!.observations.find((o) =>
      o.field?.includes('agents[].tokens')
    );
    expect(tokenObs?.value).toBe(70_000);
    expect(tokenObs?.claim).toContain('at least ~70k known tokens');
    expect(tokenObs?.claim).toContain(
      '1 failed agent token count(s) were unavailable or invalid'
    );
    // Never described as a complete count.
    expect(tokenObs?.claim).not.toContain('complete failed-agent token counts');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'treats a non-finite failed-agent token count (%s) as unavailable/invalid (#3218)',
    (bad) => {
      const r = run({
        runId: 'wf_nonfinite_tokens',
        agents: [
          rateLimited(0, { tokens: 30_000 }),
          rateLimited(1, { tokens: bad }),
          rateLimited(2, { tokens: 30_000 }),
          ok(3),
        ],
      });
      const rec = detector.rule(input([r]), 0)!;
      expect(rec.evidence![0]).toContain('at least ~60k known tokens spent');
      expect(rec.evidence![0]).toContain('1 failed agent token count(s) unknown');
      const tokenObs = rec.provenance!.observations.find((o) =>
        o.field?.includes('agents[].tokens')
      );
      expect(tokenObs?.value).toBe(60_000);
    }
  );
});

// ── Catastrophic burst → critical ──────────────────────────────────────────

describe('reliability.workflow-ratelimit-burst — catastrophic burst (critical)', () => {
  /** The observed 2026-07-03 incident: 68-agent review, 24 verifiers dead. */
  function observedIncident(): WorkflowRun {
    const agents: WorkflowAgent[] = [];
    for (let i = 0; i < 44; i++) agents.push(ok(i));
    for (let i = 44; i < 68; i++) agents.push(rateLimited(i, { tokens: 41_000 }));
    return run({ runId: 'wf_68', workflowName: 'adversarial-review', agents });
  }

  it('escalates to critical when a large fraction of a big fan-out died', () => {
    const rec = detector.rule(input([observedIncident()]), 0);
    expect(rec).not.toBeNull();
    expect(rec!.severity).toBe('critical'); // 24/68 = 35% of a 68-agent fan-out
    expect(rec!.evidence![0]).toContain(
      '24/68 agents failed on explicit usage-limit exhaustion'
    );
    expect(rec!.detail).toContain('lost 24 of 68 agents');
  });

  it('stays warning when the burst is large in count but a small fraction of the fan-out', () => {
    // 10 failures out of 200 agents (5%): real burst, not a catastrophic sizing miss.
    const agents: WorkflowAgent[] = [];
    for (let i = 0; i < 190; i++) agents.push(ok(i));
    for (let i = 190; i < 200; i++) agents.push(rateLimited(i));
    const rec = detector.rule(input([run({ runId: 'wf_wide', agents })]), 0);
    expect(rec!.severity).toBe('warning');
  });

  it('stays warning when the fraction is high but the fan-out is small', () => {
    // 4 of 8 died: half the run, but not a big fan-out — warning, not critical.
    const r = run({
      runId: 'wf_half',
      agents: [rateLimited(0), rateLimited(1), rateLimited(2), rateLimited(3), ok(4), ok(5), ok(6), ok(7)],
    });
    expect(detector.rule(input([r]), 0)!.severity).toBe('warning');
  });

  it('one catastrophic run among small bursts makes the card critical, ranked worst-first', () => {
    const small = run({
      runId: 'wf_small',
      agents: [rateLimited(0), rateLimited(1), rateLimited(2), ok(3)],
    });
    const rec = detector.rule(input([small, observedIncident()]), 0);
    expect(rec!.severity).toBe('critical');
    expect(rec!.affected).toBe(2);
    expect(rec!.evidence![0]).toContain('wf_68'); // worst burst leads the evidence
  });

  it('keeps the fraction-critical run visible and uses it as the salvage target', () => {
    const warningRuns = Array.from({ length: 5 }, (_, runIndex) => {
      const agents: WorkflowAgent[] = [];
      for (let i = 0; i < 188; i++) agents.push(ok(i));
      for (let i = 188; i < 200; i++) agents.push(rateLimited(i));
      return run({ runId: `wf_warning_${runIndex}`, agents });
    });
    const criticalAgents: WorkflowAgent[] = [];
    for (let i = 0; i < 10; i++) criticalAgents.push(ok(i));
    for (let i = 10; i < 20; i++) criticalAgents.push(rateLimited(i));
    const fractionCritical = run({ runId: 'wf_fraction_critical', agents: criticalAgents });

    const rec = detector.rule(input([...warningRuns, fractionCritical]), 0)!;
    expect(rec.severity).toBe('critical');
    expect(rec.evidence).toHaveLength(5);
    expect(rec.evidence![0]).toContain('wf_fraction_critical');
    expect(rec.detail).toContain('severity-leading run wf_fraction_critical lost 10 of 20');
    expect(rec.action).toContain(
      'subagents/workflows/wf_fraction_critical/agent-*.jsonl'
    );
  });
});

// ── Failure-shape tolerance (parser null-coalescing) ───────────────────────

describe('reliability.workflow-ratelimit-burst — outcome text shapes', () => {
  it('detects the current CLI error-only manifest shape end to end', () => {
    const root = mkdtempSync(join(tmpdir(), 'chd-workflow-ratelimit-'));
    const projectsRoot = join(root, 'projects');
    const workflowDir = join(
      projectsRoot,
      'repo-project',
      'a1b2c3d4-1111-2222-3333-444444444444',
      'workflows'
    );
    const cliError = "You've hit your session limit · resets 1:10pm (America/New_York)";
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(workflowDir, 'wf_error.json'), JSON.stringify({
      runId: 'wf_error',
      workflowName: 'error-only-run',
      status: 'failed',
      startTime: 1_780_000_000_000,
      agentCount: 3,
      workflowProgress: Array.from({ length: 3 }, (_, index) => ({
        type: 'workflow_agent',
        index,
        state: 'error',
        error: cliError,
      })),
    }));

    try {
      const projected = readWorkflowsSync(projectsRoot);
      expect(projected.runs[0].workflowProgress[0].error).toBe(cliError);
      const parsed = parseWorkflows(projected as WorkflowsResponse);
      expect(parsed[0].agents[0].error).toBe(cliError);
      const rec = detector.rule(input(parsed), 1_780_000_001_000);
      expect(rec).not.toBeNull();
      expect(rec!.provenance!.observations[0].field).toContain(
        'workflows[].agents[].error'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not count unknown-state agents from legacy/cached manifests', () => {
    const unknown = (i: number): WorkflowAgent =>
      agent({
        index: i,
        state: null,
        resultPreview: "You've hit your session limit. Your limit will reset later.",
      });
    const r = run({ agents: [unknown(0), unknown(1), unknown(2), ok(3)] });
    expect(detector.rule(input([r]), 0)).toBeNull();
  });

  it('does NOT count an agent with neither state nor result text', () => {
    const blank = (i: number): WorkflowAgent => agent({ index: i, state: null, resultPreview: null });
    const r = run({ agents: [blank(0), blank(1), blank(2), blank(3)] });
    expect(detector.rule(input([r]), 0)).toBeNull();
  });

  it.each([
    'error',
    'errored',
    'failed',
    'aborted',
    'cancelled',
    'canceled',
    'terminated',
    'stopped',
    'killed',
  ])('counts the bounded terminal failure state %s', (state) => {
    const agents = Array.from({ length: 3 }, (_, index) =>
      agent({
        index,
        state,
        error: "You've hit your session limit · resets 3pm",
      })
    );
    expect(detector.rule(input([run({ agents })]), 0)).not.toBeNull();
  });

  it.each([
    'not failed',
    'error-retrying',
    'cancel-requested',
    'stopping',
    'killer',
    'stopwatch',
    'kill-switch-active',
  ])('rejects a non-terminal state that contains failure-like text: %s', (state) => {
    const agents = Array.from({ length: 3 }, (_, index) =>
      agent({
        index,
        state,
        error: "You've hit your session limit · resets 3pm",
      })
    );
    expect(detector.rule(input([run({ agents })]), 0)).toBeNull();
  });

  it('matches positively attributable Claude capacity-exhaustion shapes', () => {
    const shapes = [
      'Usage limit reached — resets 3pm',
      'Weekly limit reached',
      'Weekly limit reached · resets 3pm',
      "You've hit your weekly limit · resets 3pm",
      'Claude quota exhausted for this account',
      'Claude Code usage quota was exhausted',
      'The weekly plan limit was exceeded',
      "You've hit your session limit. Your limit will reset later.",
      'You have hit your session limit',
      "You've hit your usage limit",
      "You've hit your usage limit · contact your admin to increase it",
      "You've hit your usage limit · resets 3pm (America/New_York)",
      "You've hit your usage limit · resets 3:00pm (America/New_York)",
      "You've hit your usage limit · resets 3:00 pm (America/New_York)",
      "You've hit your Opus limit",
      'You have hit your Opus limit · resets 3pm',
      "You've hit your Opus limit · resets Jul 15, 3pm (America/New_York)",
      "You've hit your Opus limit · resets Feb 29, 3pm (America/New_York)",
      "You've hit your Opus limit · resets Feb 29, 2024, 3pm (America/New_York)",
      "You've hit your Sonnet limit",
      'You have hit your Sonnet limit · resets 3pm',
      "You've hit your Sonnet limit · resets Jul 15, 2027, 3:05pm (America/Argentina/Buenos_Aires)",
      "You've hit your Opus limit · resets 3pm (GMT)",
      "You've hit your Opus limit · resets 3pm (Etc/GMT+5)",
      "You've exhausted your Claude Code weekly plan limit",
      "Your Claude account's five-hour session limit was exceeded",
      "Claude's weekly plan usage limit has been reached",
      'The session window was exhausted',
    ];
    const agents = shapes.map((text, i) => agent({ index: i, state: 'failed', resultPreview: text }));
    const rec = detector.rule(input([run({ agents: [...agents, ok(shapes.length)] })]), 0);
    expect(rec).not.toBeNull();
    expect(rec!.evidence![0]).toContain(`${shapes.length}/${shapes.length + 1}`);
  });

  it.each([
    "You've hit your Fable 5 limit",
    "You've hit your Fable 5 limit · resets 3pm",
  ])('counts the current CLI Fable 5 capacity label: %s', (text) => {
    const agents = Array.from({ length: BURST_MIN_FAILURES }, (_, index) =>
      agent({ index, state: 'error', error: text })
    );

    expect(detector.rule(input([run({ agents })]), 0)).not.toBeNull();
  });

  it.each([
    "You've reached your Fable 5 limit.",
    "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.",
    "You've reached your Fable 5 limit. /model to switch models.",
  ])('counts the installed CLI Fable 5 API-error form: %s', (text) => {
    const agents = Array.from({ length: BURST_MIN_FAILURES }, (_, index) =>
      agent({ index, state: 'error', error: text })
    );

    expect(detector.rule(input([run({ agents })]), 0)).not.toBeNull();
  });

  it.each([
    "The fixture says You've hit your Fable 5 limit",
    "OpenAI: You've hit your Fable 5 limit",
    "You've hit your Fable 6 limit",
    "You've hit your Fable 5 API limit",
    "You've hit your Fable 5 limit according to the docs",
    "You've hit your Fable 5 limit · resets sometime",
  ])('rejects framed, provider-owned, or non-canonical Fable limit prose: %s', (text) => {
    const agents = Array.from({ length: BURST_MIN_FAILURES }, (_, index) =>
      agent({ index, state: 'error', error: text })
    );

    expect(detector.rule(input([run({ agents })]), 0)).toBeNull();
  });

  it.each([
    "The fixture says You've reached your Fable 5 limit.",
    "\"You've reached your Fable 5 limit.\"",
    "OpenAI: You've reached your Fable 5 limit.",
    "You've reached your Fable 5 API limit.",
    "You've reached your Fable 5 limit according to the docs.",
    "You've reached your Fable 5 limit. Run /usage-credits to continue.",
    "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model according to the docs.",
    "You've reached your Fable 5 limit. /model to switch model.",
  ])('rejects framed, provider-owned, or malformed Fable API-error prose: %s', (text) => {
    const agents = Array.from({ length: BURST_MIN_FAILURES }, (_, index) =>
      agent({ index, state: 'error', error: text })
    );

    expect(detector.rule(input([run({ agents })]), 0)).toBeNull();
  });

  it.each([
    'quota exhausted for this account',
    'hit your quota',
    'out of quota',
    'quota was exceeded',
  ])('does not count unqualified quota exhaustion: %s', (text) => {
    const agents = Array.from({ length: 3 }, (_, index) =>
      agent({ index, state: 'failed', resultPreview: text })
    );
    expect(detector.rule(input([run({ agents })]), 0)).toBeNull();
  });

  it.each([
    'Out of Claude usage quota',
    'Used all of your Claude Code usage quota',
  ])('counts an anchored Claude-owned depleted-quota assertion: %s', (text) => {
    const agents = Array.from({ length: 3 }, (_, index) =>
      agent({ index, state: 'failed', resultPreview: text })
    );
    expect(detector.rule(input([run({ agents })]), 0)).not.toBeNull();
  });

  it.each([
    'GitHub API quota exhausted',
    'OpenAI usage quota exceeded',
    'AWS plan quota reached',
    'storage usage quota was exhausted',
    'database quota exceeded for this tenant',
    'Twilio usage quota exceeded',
    'Kubernetes plan quota exhausted',
    'GitHub usage limit reached',
    'OpenAI plan limit exceeded',
    'Acme Cloud usage limit reached',
    'internal payments service plan quota reached',
    'Nebula Compute session limit reached',
    'OrchidDB weekly limit reached',
    'private registry weekly plan limit exceeded',
    'cluster scheduler session window exhausted',
  ])('does not infer Claude exhaustion from an arbitrary provider limit: %s', (text) => {
    const agents = Array.from({ length: 3 }, (_, index) =>
      agent({ index, state: 'failed', resultPreview: text })
    );
    expect(detector.rule(input([run({ agents })]), 0)).toBeNull();
  });

  it.each([
    'The usage quota was exhausted',
    'The plan limit has been reached for this account',
    'Used all of your usage for this period',
    'Usage limit reached',
    'Claude Code task failed because GitHub usage limit reached',
    'OpenAI plan limit exceeded while comparing Claude',
    'Claude Code was running. Twilio usage quota exceeded',
    'Claude usage limit was not reached',
    "If Claude Code's weekly limit is reached, reduce fan-out",
    'Checking whether Claude Code usage limit was exceeded',
    'Claude session limit resets at 3pm',
    'Maybe out of Claude usage quota',
    'If out of Claude usage quota, retry later',
    'The fixture says out of Claude usage quota',
    '"Out of Claude usage quota"',
    'We may have used all of your Claude Code usage quota',
    'We did not use all of your Claude Code usage quota',
    'Used all of your Claude Code usage quota in the sample',
    'Did we use all of your Claude Code usage quota?',
  ])('does not treat ambiguous or non-affirmative task prose as Claude exhaustion: %s', (text) => {
    const agents = Array.from({ length: 3 }, (_, index) =>
      agent({ index, state: 'failed', resultPreview: text })
    );
    expect(detector.rule(input([run({ agents })]), 0)).toBeNull();
  });

  it.each([
    'No Claude usage limit was reached',
    'Never was Claude usage limit reached',
    'When Claude usage limit is reached, retry later',
    'Whenever Claude usage limit is reached, retry later',
    'Suppose Claude usage limit was reached',
    'Assume Claude Code usage quota was exhausted',
    'Assuming Claude usage limit was exceeded, reduce fan-out',
    'In case Claude usage limit is reached, defer the workflow',
    'Were Claude usage limit reached, retry later',
    'For example, Claude usage limit was reached',
    'e.g. Claude usage limit was reached',
    'Example: Claude usage limit was reached',
    'Let us say Claude usage limit was reached',
    'We cannot confirm Claude usage limit was reached',
    'Claude usage limit was reached only when capacity was unavailable',
    'Claude usage limit was reached — no, it was not',
    'Was Claude usage limit reached? Check the policy before retrying',
    'Was Claude usage limit reached? Investigate logs.',
    'Did we hit Claude usage limit? If so, retry later.',
    'Maybe Claude usage limit was reached',
    'Possibly Claude usage limit was reached',
    'Perhaps Claude usage limit was reached',
    "We can't confirm Claude usage limit was reached",
    'The sentence "Claude usage limit was reached" is false',
  ])('does not treat explicit negation or hypothetical policy prose as an incident: %s', (text) => {
    const agents = Array.from({ length: 3 }, (_, index) =>
      agent({ index, state: 'failed', resultPreview: text })
    );
    expect(detector.rule(input([run({ agents })]), 0)).toBeNull();
  });

  it.each([
    'Claude usage limit was reached. Do not retry until reset.',
    'Claude Code usage quota was exhausted; when it resets, retry later.',
    'Your Claude weekly plan limit was exceeded. Never retry the whole fan-out blindly.',
    "You've hit your session limit. When the limit resets, retry later.",
    "You've hit your session limit. Your limit will reset at 3pm.",
    'Usage limit reached. Resets at 3pm.',
    'Claude usage limit was reached because no capacity remained.',
    'Was Claude usage limit reached? Claude usage limit was reached.',
    '"Was Claude usage limit reached?" Claude usage limit was reached.',
    'Agent failed. Claude usage limit was reached.',
    'The run stopped;\nClaude Code usage quota was exhausted.',
    "ERROR: You've hit your session limit.",
  ])('keeps a first or positively sequenced affirmative Claude capacity failure: %s', (text) => {
    const agents = Array.from({ length: 3 }, (_, index) =>
      agent({ index, state: 'failed', resultPreview: text })
    );
    expect(detector.rule(input([run({ agents })]), 0)).not.toBeNull();
  });

  it.each([
    'Agent failed when Claude usage limit was reached.',
    'The run stopped when Claude Code usage quota was exhausted.',
    'All agents errored when we hit your Claude Code usage limit.',
    'Agent could not continue because Claude usage limit was exhausted.',
    'No agent completed because Claude usage limit was reached.',
    'Agent could not finish: Claude Code usage quota was exhausted.',
    'Failed to update documentation because Claude usage limit was reached.',
    'When Claude usage limit was reached, the run stopped.',
    'Once Claude usage limit was reached, the run stopped.',
  ])('keeps an affirmative past capacity incident when earlier prose describes its consequence: %s', (text) => {
    const agents = Array.from({ length: 3 }, (_, index) =>
      agent({ index, state: 'failed', resultPreview: text })
    );
    expect(detector.rule(input([run({ agents })]), 0)).not.toBeNull();
  });

  it.each([
    ['stopped', 'Workflow stopped: Claude usage limit was reached.'],
    ['error', 'Task errored: Claude usage limit was reached.'],
    ['killed', 'The run was killed: Claude usage limit was reached.'],
  ])('counts concrete %s states with bounded terminal-colon outcomes', (state, resultPreview) => {
    const agents = Array.from({ length: 3 }, (_, index) =>
      agent({ index, state, resultPreview })
    );
    expect(detector.rule(input([run({ agents })]), 0)).not.toBeNull();
  });

  it.each(['stopping', 'killer', 'stopwatch', 'kill-switch-active'])(
    'does not treat a non-terminal %s state as a concrete failure',
    (state) => {
      const agents = Array.from({ length: 3 }, (_, index) =>
        agent({ index, state, resultPreview: "You've hit your usage limit" })
      );
      expect(detector.rule(input([run({ agents })]), 0)).toBeNull();
    }
  );

  it.each([
    'The sample says workflow stopped: Claude usage limit was reached.',
    '"Workflow stopped: Claude usage limit was reached."',
    'Task was not killed: Claude usage limit was reached.',
  ])('rejects framed or negated terminal-colon prose: %s', (resultPreview) => {
    const agents = Array.from({ length: 3 }, (_, index) =>
      agent({ index, state: 'stopped', resultPreview })
    );
    expect(detector.rule(input([run({ agents })]), 0)).toBeNull();
  });

  it.each([
    'Agent checked if retry was safe, then failed because Claude usage limit was reached.',
    'Agent probably retried twice, then definitely failed because Claude usage limit was reached.',
    'Claude usage limit was reached, not a task error.',
    'Agent failed because Claude usage limit was reached, not because the task errored.',
    'The agent was killed because Claude usage limit was reached.',
    'The run was killed after Claude Code usage quota was exhausted.',
    'Agent was unable to continue because Claude usage limit was reached.',
    'All agents were unable to finish when Claude usage limit was exhausted.',
    'No agent completed after Claude usage limit was reached.',
    'Agent was unable to finish: Claude Code usage quota was exhausted.',
    'All agents errored after we hit your Claude Code usage limit.',
    'Agent checked if retry was safe, but was killed because Claude usage limit was reached.',
    'Agent retried once, but was unable to continue after Claude usage limit was reached.',
  ])('keeps an anchored past incident or explicit then/but event boundary: %s', (text) => {
    const agents = Array.from({ length: 3 }, (_, index) =>
      agent({ index, state: 'failed', resultPreview: text })
    );
    expect(detector.rule(input([run({ agents })]), 0)).not.toBeNull();
  });

  it.each([
    'For instance, Claude usage limit was reached.',
    'Once Claude usage limit is reached, retry later.',
    'Probably Claude usage limit was reached.',
    'Probably the run stopped because Claude usage limit was reached.',
    'It seems Claude usage limit was reached.',
    'We suspect Claude usage limit was reached.',
    'Agent failed because it seems Claude usage limit was reached.',
    'Agent stopped because we suspect Claude usage limit was reached.',
    'No agent completed because we think Claude usage limit was reached.',
    'Agent failed because for example Claude usage limit was reached.',
    'Agent failed because hypothetically Claude usage limit was reached.',
    'Imagine Claude usage limit was reached.',
    'The documentation says Claude usage limit was reached.',
    'The test fixture says Claude usage limit was reached.',
    'Agent failed because the docs say Claude usage limit was reached.',
    'Agent stopped because an assertion states Claude usage limit was reached.',
    'Agent did not fail because Claude usage limit was reached.',
    'The run did not stop because Claude Code usage quota was exhausted.',
    'The docs mention Claude usage limit was reached.',
    'Documentation example: Claude usage limit was reached.',
    'Claude usage limit was reached once capacity ran out.',
    'We believe Claude usage limit was reached.',
    'Apparently Claude usage limit was reached.',
    'We denied Claude usage limit was reached.',
    'Evidence disproved that Claude usage limit was reached.',
    'We could ultimately have reached Claude usage limit.',
    'After Claude usage limit is reached, retry later.',
    'Before Claude usage limit is reached, stop launching agents.',
    'As soon as Claude usage limit is reached, retry later.',
    'In the event Claude usage limit is reached, retry later.',
    'Wait until Claude usage limit is reached before retrying.',
    'It may be that Claude usage limit was reached.',
    'It might be that Claude usage limit was reached.',
    'It could be that Claude usage limit was reached.',
    'Presumably Claude usage limit was reached.',
    'Allegedly Claude usage limit was reached.',
    'Potentially Claude usage limit was reached.',
    'As an example, Claude usage limit was reached.',
    'A sample failure reads: Claude usage limit was reached.',
    'Illustrative message: Claude usage limit was reached.',
    'Agent checked if retry was safe and failed because Claude usage limit was reached.',
    'Agent probably retried before definitely failing because Claude usage limit was reached.',
    'For example, a sample says this, then agent failed because Claude usage limit was reached.',
    'The documentation quotes a sample, but the agent failed because Claude usage limit was reached.',
    'Agent was killed before Claude usage limit is reached.',
    'Agent may be unable to continue after Claude usage limit is reached.',
    'Agent failed because Claude usage limit may have been reached.',
    'Agent might have failed because Claude usage limit was reached.',
    'Agent failed because Claude usage limit was reached according to the docs.',
    'When Claude usage limit was reached, the run may have stopped.',
    'Agent hypothetically retried, then failed because Claude usage limit was reached.',
    'Agent retried once, but possibly failed because Claude usage limit was reached.',
    '"Agent failed because Claude usage limit was reached."',
    'Did the agent fail because Claude usage limit was reached?',
    'Claude usage limit is reached.',
    'Weekly limit is reached.',
    'The session window is exhausted.',
    'Usage limit is reached — resets 3pm.',
    'Claude usage limit was reached, allegedly.',
    'Maybe Claude usage limit was reached. Claude usage limit was reached.',
    'e.g. Claude usage limit was reached. Claude usage limit was reached.',
    'Example: Claude usage limit was reached. Claude usage limit was reached.',
    'A sample failure follows. Claude usage limit was reached.',
    'The documentation shows the message below. Claude usage limit was reached.',
    'For example. Agent failed because Claude usage limit was reached.',
    'A sample failure follows; Claude usage limit was reached.',
    'A sample failure follows:\nClaude usage limit was reached.',
    'Claude usage limit was reached. Correction: it was not.',
    'Claude usage limit was reached. Your limit will reset at 3pm and that diagnosis was false.',
    "You've hit your session limit. Your limit will reset at 3pm, but that diagnosis was false.",
    "You've hit your session limit. Your limit will reset at some point.",
    "You've hit your session limit. Your limit will reset at 3pm in the example.",
    'Agent failed. Claude usage limit was reached. That diagnosis was false.',
    "Was Claude usage limit reached? Claude usage limit was reached. No, it wasn't.",
    "You've hit your session limit — reset later, but that diagnosis was false.",
    'Usage limit reached — resets 3pm, according to the docs.',
    'Task failed to assert the following: Claude usage limit was reached.',
    'Agent failed to quote the expected message: Claude usage limit was reached.',
    'Workflow failed to parse this fixture. Claude usage limit was reached.',
    'Failed to parse the fixture saying the agent failed because Claude usage limit was reached.',
    'Task failed to quote the sentence agent failed because Claude usage limit was reached.',
    'Workflow failed to analyze the claim that the agent stopped because Claude usage limit was reached.',
    'Agent failed to document the example where the run stopped because Claude usage limit was reached.',
    'Failed to determine whether the agent stopped because Claude usage limit was reached.',
    'Failed to read documentation claiming the workflow failed because Claude usage limit was reached.',
    'Failed to refute the false claim that the agent failed because Claude usage limit was reached.',
    'Failed to write a hypothetical where the workflow stopped because Claude usage limit was reached.',
    'Failed to parse an example in which the agent errored because Claude usage limit was reached.',
    'Agent asked whether it would fail because Claude usage limit was reached.',
    'Agent asked whether to continue before possibly failing because Claude usage limit was reached.',
    'Agent did not ask whether to continue before failing because Claude usage limit was reached.',
    'A sample says the agent asked whether to continue before failing because Claude usage limit was reached.',
    'We suspect cache stale, but the docs say the agent failed because Claude usage limit was reached.',
    'We suspect the cache was stale, but the agent might have failed because Claude usage limit was reached.',
    'We suspect the cache was stale, but the agent did not fail because Claude usage limit was reached.',
    'The documentation mentioned retries, and the sample says the agent failed because Claude usage limit was reached.',
    'The documentation mentioned retries, and the agent may fail because Claude usage limit was reached.',
    'The documentation mentioned retries, and the agent did not fail because Claude usage limit was reached.',
    'Claude usage limit was reached, not according to the logs.',
    'Claude usage limit was reached, not the GitHub limit according to the docs.',
    'Claude usage limit was reached once in a sample.',
    'Claude usage limit was reached once tomorrow.',
    'Workflow will be aborted because Claude usage limit was reached.',
    'Workflow was not aborted because Claude usage limit was reached.',
    'Workflow might have aborted because Claude usage limit was reached.',
    'Run could be cancelled because Claude usage limit was reached.',
    'Task was allegedly terminated because Claude usage limit was reached.',
    'Task terminated if Claude usage limit was reached.',
    'The sample says agent failed: Claude usage limit was reached.',
    'Agent did not fail: Claude usage limit was reached.',
    'The agent did not fail: Claude usage limit was reached.',
    'The documentation says the agent failed: Claude usage limit was reached.',
    'Agent failed: maybe Claude usage limit was reached.',
    "ERROR: Maybe you've hit your session limit.",
    "Fixture ERROR: You've hit your session limit.",
    "The fixture says ERROR: You've hit your session limit.",
    "ERROR: You've hit your session limit in the fixture.",
    'ERROR: If Claude usage limit was reached, retry later.',
    'ERROR: GitHub usage limit reached.',
    'Workflow was not canceled because Claude usage limit was reached.',
    'Workflow may be canceled because Claude usage limit was reached.',
    'Workflow will be canceled because Claude usage limit was reached.',
    'Usage limit reached. Maybe resets at 3pm.',
    'Usage limit reached. Resets at 3pm according to the docs.',
    'Usage limit reached. Reset fixture failed.',
  ])('does not treat a framed example, policy, or uncertain assertion as an incident: %s', (text) => {
    const agents = Array.from({ length: 3 }, (_, index) =>
      agent({ index, state: 'failed', resultPreview: text })
    );
    expect(detector.rule(input([run({ agents })]), 0)).toBeNull();
  });

  it.each([
    'Agent asked whether to continue before failing because Claude usage limit was reached.',
    'We suspect the cache was stale, but the agent failed because Claude usage limit was reached.',
    'The documentation mentioned retries, and the agent failed because Claude usage limit was reached.',
    'Claude usage limit was reached, not the GitHub limit.',
    'Claude usage limit was reached once yesterday.',
    'Workflow aborted because Claude usage limit was reached.',
    'Task terminated after Claude usage limit was reached.',
    'Run cancelled when Claude usage limit was reached.',
    'Workflow was aborted because Claude usage limit was reached.',
    'All agents were terminated after Claude usage limit was reached.',
    'The run was cancelled when Claude usage limit was reached.',
    'The agent failed: Claude usage limit was reached.',
    'Workflow was canceled because Claude usage limit was reached.',
    'Agent failed: Claude usage limit was reached.',
  ])('keeps a bounded affirmative incident without promoting nested meta prose: %s', (text) => {
    const agents = Array.from({ length: 3 }, (_, index) =>
      agent({ index, state: 'failed', resultPreview: text })
    );
    expect(detector.rule(input([run({ agents })]), 0)).not.toBeNull();
  });

  it('does not bridge Claude context in state to generic limit prose in resultPreview', () => {
    const agents = Array.from({ length: 3 }, (_, index) =>
      agent({
        index,
        state: 'failed Claude Code',
        resultPreview: 'usage limit reached',
      })
    );
    expect(detector.rule(input([run({ agents })]), 0)).toBeNull();
  });

  it.each([
    'API error 429: too many requests',
    'rate_limit_error: request rate exceeded',
    'HTTP status 529: overloaded_error',
    'API was rate limited by the provider',
    'request rate limit exceeded',
    'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
  ])('does not infer Claude plan exhaustion from generic API throttle: %s', (text) => {
    const agents = Array.from({ length: 3 }, (_, index) =>
      agent({ index, state: 'failed', resultPreview: text })
    );
    expect(detector.rule(input([run({ agents })]), 0)).toBeNull();
  });

  it.each([
    '"You\'ve hit your usage limit"',
    'The fixture says You\'ve hit your Opus limit',
    "You've hit your GitHub usage limit",
    "You've hit your usage limit · resets sometime",
    "You've hit your Sonnet limit · resets Jul 45, 99pm (America/New_York)",
    "You've hit your usage limit · contact your team admin",
    'OpenAI: You have hit your usage limit',
    'You have hit your OpenAI usage limit',
    'Fixture ERROR: You have hit your usage limit',
    'You have hit your usage limit according to the docs',
    'You have hit your Opus limit · contact your admin to increase it',
    'You have hit your usage limit · contact your admin to increase it according to the docs',
    'You have hit your Opus limit · resets 13pm (America/New_York)',
    'You have hit your Opus limit · resets 3:60pm (America/New_York)',
    'You have hit your Opus limit · resets Jul 32, 3pm (America/New_York)',
    'You have hit your Opus limit · resets Feb 31, 3pm (America/New_York)',
    'You have hit your Opus limit · resets Feb 29, 2025, 3pm (America/New_York)',
    'You have hit your Opus limit · resets Feb 29, 2026, 3pm (America/New_York)',
    'You have hit your Opus limit · resets 3pm (local time)',
    'You have hit your Opus limit · resets 3pm (A/B)',
    'You have hit your Opus limit · resets 3pm (America/Fake)',
    'You have hit your Opus limit · resets 3pm (UTC/GMT)',
    'You have hit your Opus limit · resets 3pm (America/New_York) according to docs',
    'You have hit your usage limit. That diagnosis was false.',
  ])('rejects framed, third-party, malformed, or retracted CLI-limit prose: %s', (text) => {
    const agents = Array.from({ length: 3 }, (_, index) =>
      agent({ index, state: 'failed', resultPreview: text })
    );
    expect(detector.rule(input([run({ agents })]), 0)).toBeNull();
  });

  it('does not count failed fixture/test prose that quotes exhaustion messages', () => {
    const mentions = [
      'usage limit reached fixture failed',
      'expected the session limit to be exceeded, but the assertion failed',
      'mocked quota exhausted response did not match documentation',
    ].map((resultPreview, index) =>
      agent({ index, state: 'failed', resultPreview })
    );
    expect(detector.rule(input([run({ agents: mentions })]), 0)).toBeNull();
  });

  it('falls back to agents.length when the manifest carries no agentCount', () => {
    const r = run({
      agentCount: null,
      agents: [rateLimited(0), rateLimited(1), rateLimited(2)],
    });
    const rec = detector.rule(input([r]), 0);
    expect(rec!.evidence![0]).toContain('3/3');
  });

  it.each([0, -2, 3.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'falls back to observed agent rows when agentCount is not a positive safe integer: %s',
    (agentCount) => {
      const r = run({
        agentCount,
        agents: [rateLimited(0), rateLimited(1), rateLimited(2)],
      });
      const rec = detector.rule(input([r]), 0)!;
      expect(rec.evidence![0]).toContain('3/3 agents failed');
      expect(rec.detail).toContain('lost 3 of 3 agents');
      expect(rec.provenance!.observations[0].claim).toContain('3 of 3 agents');
    }
  );

  it('never lets a declared agentCount underreport observed rows or distort severity', () => {
    const agents = [
      ...Array.from({ length: 10 }, (_, index) => ok(index)),
      ...Array.from({ length: 10 }, (_, index) => rateLimited(index + 10)),
    ];
    const rec = detector.rule(input([run({ agentCount: 10, agents })]), 0)!;
    expect(rec.evidence![0]).toContain('10/20 agents failed');
    expect(rec.detail).toContain('lost 10 of 20 agents');
    expect(rec.severity).toBe('critical');
  });

  it('preserves a valid declared total when it exceeds the observed rows', () => {
    const r = run({
      agentCount: 8,
      agents: [rateLimited(0), rateLimited(1), rateLimited(2)],
    });
    const rec = detector.rule(input([r]), 0)!;
    expect(rec.evidence![0]).toContain('3/8 agents failed');
    expect(rec.severity).toBe('warning');
  });
});

// ── Historical freshness ──────────────────────────────────────────────────

describe('reliability.workflow-ratelimit-burst — freshness honesty', () => {
  const startTime = Date.parse('2026-07-01T12:00:00Z');
  const burst = run({
    runId: 'wf_dated',
    startTime,
    agents: [rateLimited(0), rateLimited(1), rateLimited(2), ok(3)],
  });

  it('cites a fresh run date without historical stale wording', () => {
    const now = startTime + 24 * 60 * 60 * 1000;
    const rec = detector.rule(input([burst]), now)!;
    expect(rec.title).toBe('Workflow fan-out hit a usage-limit burst');
    expect(rec.detail).toContain(
      'The severity-leading workflow burst began on 2026-07-01; workflow history contained'
    );
    expect(rec.action).not.toContain('historical pattern');
    expect(rec.provenance?.asOf).toBe('2026-07-01');
    expect(rec.provenance?.stale).toBe(false);
  });

  it('demotes an old run to dated historical wording and guidance', () => {
    const now = startTime + 31 * 24 * 60 * 60 * 1000;
    const rec = detector.rule(input([burst]), now)!;
    expect(rec.title).toBe(
      'Severity-leading workflow usage-limit burst was recorded as of 2026-07-01'
    );
    expect(rec.detail).toContain(
      'The severity-leading workflow burst was recorded as of 2026-07-01; workflow history contained'
    );
    expect(rec.action).toMatch(/^Review whether this historical pattern still applies\./);
    expect(rec.provenance?.asOf).toBe('2026-07-01');
    expect(rec.provenance?.stale).toBe(true);
    expect(
      rec.provenance?.observations.some(
        (observation) => observation.field === 'workflows[].startTime'
      )
    ).toBe(true);
    expect(validateRecommendationProvenance(rec)).toEqual([]);
  });

  it('labels missing run timestamps as undated instead of inventing freshness', () => {
    const rec = detector.rule(input([{ ...burst, startTime: null }]), startTime)!;
    expect(rec.detail).toContain(
      'The severity-leading workflow burst is undated; workflow history contained'
    );
    expect(rec.provenance?.asOf).toBeUndefined();
    expect(rec.provenance?.stale).toBeUndefined();
  });

  it('treats a materially future run timestamp as undated', () => {
    const now = Date.parse('2026-07-10T12:00:00Z');
    const future = run({
      ...burst,
      runId: 'wf_future',
      startTime: Date.parse('2099-01-01T00:00:00Z'),
    });
    const rec = detector.rule(input([future]), now)!;
    expect(rec.detail).toContain(
      'The severity-leading workflow burst is undated; workflow history contained'
    );
    expect(rec.provenance?.asOf).toBeUndefined();
    expect(rec.provenance?.stale).toBeUndefined();
    expect(
      rec.provenance?.observations.some(
        (observation) => observation.field === 'workflows[].startTime'
      )
    ).toBe(false);
  });

  it('does not let a materially future timestamp win recency, provenance, or salvage ties', () => {
    const now = Date.parse('2026-07-10T12:00:00Z');
    const current = run({
      ...burst,
      runId: 'wf_current',
      startTime: Date.parse('2026-07-09T12:00:00Z'),
    });
    const future = run({
      ...burst,
      runId: 'wf_future',
      startTime: Date.parse('2099-01-01T00:00:00Z'),
    });
    const rec = detector.rule(input([future, current]), now)!;
    expect(rec.evidence![0]).toContain('wf_current');
    expect(rec.provenance?.asOf).toBe('2026-07-09');
    expect(rec.action).toContain('subagents/workflows/wf_current/agent-*.jsonl');
  });

  it('accepts a small positive clock skew as a dated run', () => {
    const now = Date.parse('2026-07-10T12:00:00Z');
    const withinSkew = run({
      ...burst,
      startTime: now + 4 * 60 * 1000,
    });
    const rec = detector.rule(input([withinSkew]), now)!;
    expect(rec.provenance?.asOf).toBe('2026-07-10');
    expect(rec.provenance?.stale).toBe(false);
  });

  it('treats a run beyond the five-minute clock-skew allowance as undated', () => {
    const now = Date.parse('2026-07-10T12:00:00Z');
    const beyondSkew = run({
      ...burst,
      startTime: now + 6 * 60 * 1000,
    });
    const rec = detector.rule(input([beyondSkew]), now)!;
    expect(rec.detail).toContain('severity-leading workflow burst is undated');
    expect(rec.provenance?.asOf).toBeUndefined();
    expect(rec.provenance?.stale).toBeUndefined();
  });

  it.each([
    ['outside the Date range', 1e100],
    ['an extended ISO year', Date.UTC(10_000, 0, 1)],
  ])('treats a finite corrupt startTime with %s as undated without throwing', (_label, corrupt) => {
    expect(() =>
      detector.rule(input([{ ...burst, startTime: corrupt }]), startTime)
    ).not.toThrow();
    const rec = detector.rule(input([{ ...burst, startTime: corrupt }]), startTime)!;
    expect(rec.detail).toContain(
      'The severity-leading workflow burst is undated; workflow history contained'
    );
    expect(rec.provenance?.asOf).toBeUndefined();
    expect(rec.provenance?.stale).toBeUndefined();
    expect(
      rec.provenance?.observations.some(
        (observation) => observation.field === 'workflows[].startTime'
      )
    ).toBe(false);
  });

  it('derives stale wording and provenance from the stale critical focus, not a newer warning', () => {
    const staleCriticalStart = Date.parse('2026-05-01T12:00:00Z');
    const freshWarningStart = Date.parse('2026-07-01T12:00:00Z');
    const criticalAgents = [
      ...Array.from({ length: 10 }, (_, index) => ok(index)),
      ...Array.from({ length: 10 }, (_, index) => rateLimited(index + 10)),
    ];
    const staleCritical = run({
      runId: 'wf_stale_critical',
      startTime: staleCriticalStart,
      agents: criticalAgents,
    });
    const freshWarning = run({
      runId: 'wf_fresh_warning',
      startTime: freshWarningStart,
      agents: [rateLimited(0), rateLimited(1), rateLimited(2), ok(3)],
    });

    const rec = detector.rule(
      input([freshWarning, staleCritical]),
      Date.parse('2026-07-10T12:00:00Z')
    )!;
    expect(rec.severity).toBe('critical');
    expect(rec.evidence![0]).toContain('wf_stale_critical');
    expect(rec.action).toContain(
      'subagents/workflows/wf_stale_critical/agent-*.jsonl'
    );
    expect(rec.provenance?.asOf).toBe('2026-05-01');
    expect(rec.provenance?.stale).toBe(true);
    expect(rec.title).toContain('as of 2026-05-01');
  });

  it('keeps an undated critical focus undated even when a warning burst is dated', () => {
    const criticalAgents = [
      ...Array.from({ length: 10 }, (_, index) => ok(index)),
      ...Array.from({ length: 10 }, (_, index) => rateLimited(index + 10)),
    ];
    const undatedCritical = run({
      runId: 'wf_undated_critical',
      startTime: null,
      agents: criticalAgents,
    });
    const datedWarning = run({
      runId: 'wf_dated_warning',
      startTime,
      agents: [rateLimited(0), rateLimited(1), rateLimited(2), ok(3)],
    });

    const rec = detector.rule(input([datedWarning, undatedCritical]), startTime)!;
    expect(rec.evidence![0]).toContain('wf_undated_critical');
    expect(rec.action).toContain(
      'subagents/workflows/wf_undated_critical/agent-*.jsonl'
    );
    expect(rec.detail).toContain('severity-leading workflow burst is undated');
    expect(rec.provenance?.asOf).toBeUndefined();
    expect(rec.provenance?.stale).toBeUndefined();
  });

  it('uses a dated critical focus even when another warning burst is undated', () => {
    const criticalAgents = [
      ...Array.from({ length: 10 }, (_, index) => ok(index)),
      ...Array.from({ length: 10 }, (_, index) => rateLimited(index + 10)),
    ];
    const datedCritical = run({
      runId: 'wf_dated_critical',
      startTime,
      agents: criticalAgents,
    });
    const undatedWarning = run({
      runId: 'wf_undated_warning',
      startTime: null,
      agents: [rateLimited(0), rateLimited(1), rateLimited(2), ok(3)],
    });

    const rec = detector.rule(
      input([undatedWarning, datedCritical]),
      startTime + 24 * 60 * 60 * 1000
    )!;
    expect(rec.evidence![0]).toContain('wf_dated_critical');
    expect(rec.provenance?.asOf).toBe('2026-07-01');
    expect(rec.provenance?.stale).toBe(false);
  });
});

// ── Auditability contract ──────────────────────────────────────────────────

describe('reliability.workflow-ratelimit-burst — auditability contract', () => {
  it('carries provenance citing the parse-workflows fields and passes the contract', () => {
    const r = run({
      agents: [rateLimited(0), rateLimited(1), rateLimited(2), ok(3)],
    });
    const rec = detector.rule(input([r]), 0);
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
    expect(rec!.provenance!.observations[0].source).toBe('parse-workflows');
    expect(rec!.provenance!.observations[0].field).toContain('workflows[].agents[]');
    expect(rec!.claimClass).toBe('accounting');
    expect(rec!.proofTier).toBe('accounting');
  });

  it('is recommend-only — never ships an auto-apply fix', () => {
    const r = run({ agents: [rateLimited(0), rateLimited(1), rateLimited(2)] });
    expect(detector.rule(input([r]), 0)!.fix).toBeUndefined();
  });
});
