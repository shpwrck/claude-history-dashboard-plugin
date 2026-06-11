/**
 * Tests for the agentic-workflow-opportunity audit (#605 / #741).
 *
 * The judge is injected, so these cover the deterministic sequence-detection ->
 * judge-interpret path without the network, plus the per-candidate failure
 * isolation the no-500 route contract relies on.
 */
import { describe, it, expect } from 'vitest';
import {
  detectRecurringSequences,
  runAgenticOpportunityAudit,
  DEFAULT_DETECT_OPTIONS,
  type ToolSequenceSession,
} from './agentic-opportunities';
import type { JudgeFn } from './judge';

// A Read -> Edit -> Bash sequence recurs across two sessions; a third session is
// unrelated noise. Each session carries an estimated $ cost.
const FIXTURE: ToolSequenceSession[] = [
  {
    sessionId: 's1',
    project: 'demo',
    tools: ['Read', 'Edit', 'Bash', 'Read', 'Grep'],
    cost: 1.5,
  },
  {
    sessionId: 's2',
    project: 'demo',
    tools: ['Grep', 'Read', 'Edit', 'Bash'],
    cost: 2.5,
  },
  {
    sessionId: 's3',
    project: 'demo',
    tools: ['WebFetch', 'WebSearch', 'WebFetch'],
    cost: 0.4,
  },
];

const yesJudge: JudgeFn = async () => ({
  isFinding: true,
  rationale: 'Mechanical and recurring — worth a loop.',
  confidence: 'high',
});

describe('detectRecurringSequences', () => {
  it('finds the cross-session sequence and weights it by displaced cost', () => {
    const found = detectRecurringSequences(FIXTURE);
    const hit = found.find((c) => c.signature === 'Read -> Edit -> Bash');
    expect(hit).toBeDefined();
    expect(hit!.sessions).toEqual(['s1', 's2']);
    expect(hit!.displacedCost).toBeCloseTo(4.0); // 1.5 + 2.5
    expect(hit!.length).toBe(3);
  });

  it('ignores sequences confined to a single session', () => {
    // Only s1 has this 4-step run; minSessions=2 means it must not appear.
    const single: ToolSequenceSession[] = [
      { sessionId: 'only', project: 'demo', tools: ['A', 'B', 'C', 'D'], cost: 9 },
    ];
    expect(detectRecurringSequences(single)).toEqual([]);
  });

  it('skips single-tool retry-loop windows', () => {
    const retries: ToolSequenceSession[] = [
      { sessionId: 'r1', project: 'demo', tools: ['Bash', 'Bash', 'Bash'], cost: 1 },
      { sessionId: 'r2', project: 'demo', tools: ['Bash', 'Bash', 'Bash'], cost: 1 },
    ];
    expect(detectRecurringSequences(retries)).toEqual([]);
  });

  it('respects the topN cap', () => {
    const out = detectRecurringSequences(FIXTURE, {
      ...DEFAULT_DETECT_OPTIONS,
      topN: 1,
    });
    expect(out).toHaveLength(1);
  });
});

describe('runAgenticOpportunityAudit', () => {
  it('emits a finding per judge-confirmed candidate', async () => {
    const candidates = detectRecurringSequences(FIXTURE);
    const findings = await runAgenticOpportunityAudit(candidates, yesJudge);
    const f = findings.find((x) => x.id === 'agentic-opportunity:Read -> Edit -> Bash');
    expect(f).toBeDefined();
    expect(f!.domain).toBe('workflow');
    expect(f!.confidence).toBe('high');
    expect(f!.evidenceRefs).toContain('session:s1');
    expect(f!.summary).toContain('$4.00');
  });

  it('drops candidates the judge rejects', async () => {
    const noJudge: JudgeFn = async () => ({
      isFinding: false,
      rationale: 'Too varied to automate.',
      confidence: 'low',
    });
    expect(await runAgenticOpportunityAudit(detectRecurringSequences(FIXTURE), noJudge)).toEqual([]);
  });

  it('isolates a per-candidate judge failure', async () => {
    // Two distinct cross-session sequences so one can fail while the other lands.
    const twoSeq: ToolSequenceSession[] = [
      { sessionId: 'a1', project: 'demo', tools: ['Read', 'Edit', 'Bash'], cost: 1 },
      { sessionId: 'a2', project: 'demo', tools: ['Read', 'Edit', 'Bash'], cost: 1 },
      { sessionId: 'b1', project: 'demo', tools: ['Grep', 'Glob', 'Read'], cost: 1 },
      { sessionId: 'b2', project: 'demo', tools: ['Grep', 'Glob', 'Read'], cost: 1 },
    ];
    const candidates = detectRecurringSequences(twoSeq);
    expect(candidates.length).toBeGreaterThan(1);
    const flaky: JudgeFn = async ({ user }) => {
      if (user.includes(candidates[0].signature)) throw new Error('transient');
      return { isFinding: true, rationale: 'ok', confidence: 'medium' };
    };
    const findings = await runAgenticOpportunityAudit(candidates, flaky);
    // The first candidate threw and was skipped; later ones still produced findings.
    expect(findings.some((f) => f.id.includes(candidates[0].signature))).toBe(false);
    expect(findings.length).toBe(candidates.length - 1);
  });
});
