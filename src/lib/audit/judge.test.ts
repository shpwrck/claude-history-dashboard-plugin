/**
 * Tests for the tier-3 judge-audit harness (#605 / #738).
 *
 * The judge is injected, so these cover the full deterministic-seed ->
 * judge-interpret path WITHOUT touching the network, plus the graceful-degrade
 * branch the `/api/audit.json` route relies on (no injected judge -> `[]`).
 */
import { describe, it, expect } from 'vitest';
import {
  seedTokenToToolOutliers,
  runReferenceAudit,
  runAudits,
  parseVerdict,
  makeClaudeJudge,
  type AuditSession,
  type JudgeFn,
  type ClaudeJudgeChatRequest,
} from './judge';
import { callAnthropic } from '../anthropic-egress';

// One genuine outlier (huge tokens, ~no tools) amid normal, balanced sessions.
const FIXTURE: AuditSession[] = [
  { sessionId: 'normal-a', project: 'demo', totalTokens: 80_000, toolCalls: 40, messageCount: 60 },
  { sessionId: 'normal-b', project: 'demo', totalTokens: 120_000, toolCalls: 55, messageCount: 90 },
  // 300k tokens, 1 tool call -> 300k tokens/tool: well past the absolute floor.
  { sessionId: 'outlier', project: 'demo', totalTokens: 300_000, toolCalls: 1, messageCount: 120 },
  // Below the volume floor: ignored even though its ratio is huge.
  { sessionId: 'tiny', project: 'demo', totalTokens: 9_000, toolCalls: 0, messageCount: 4 },
];

const yesJudge: JudgeFn = async () => ({
  isFinding: true,
  rationale: 'Heavy deliberation with almost no execution.',
  confidence: 'high',
});

describe('seedTokenToToolOutliers', () => {
  it('flags only the high-ratio, high-volume session', () => {
    const out = seedTokenToToolOutliers(FIXTURE).map((s) => s.sessionId);
    expect(out).toEqual(['outlier']);
  });

  it('returns nothing when no session clears the volume floor', () => {
    expect(seedTokenToToolOutliers([FIXTURE[3]])).toEqual([]);
  });

  it('flags a lone session above the absolute floor (no population to compare)', () => {
    const solo: AuditSession = {
      sessionId: 'solo',
      project: 'demo',
      totalTokens: 150_000,
      toolCalls: 1,
      messageCount: 70,
    };
    // 150k tokens/tool > RATIO_ABSOLUTE_FLOOR; median*3 must NOT suppress it.
    expect(seedTokenToToolOutliers([solo]).map((s) => s.sessionId)).toEqual(['solo']);
  });

  it('leaves a lone below-absolute-floor session unflagged', () => {
    const solo: AuditSession = {
      sessionId: 'solo-low',
      project: 'demo',
      totalTokens: 60_000,
      toolCalls: 1,
      messageCount: 70,
    };
    expect(seedTokenToToolOutliers([solo])).toEqual([]);
  });
});

describe('runReferenceAudit', () => {
  it('emits a well-formed AuditFinding for a judge-confirmed outlier', async () => {
    const findings = await runReferenceAudit(FIXTURE, yesJudge);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.id).toBe('token-to-tool-ratio:outlier');
    expect(f.domain).toBe('workflow');
    expect(f.confidence).toBe('high');
    expect(f.judgeRationale).toMatch(/deliberation/i);
    expect(f.evidenceRefs).toContain('session:outlier');
    expect(f.summary).toContain('300,000');
  });

  it('drops candidates the judge rejects', async () => {
    const noJudge: JudgeFn = async () => ({
      isFinding: false,
      rationale: 'Legitimately analysis-heavy.',
      confidence: 'low',
    });
    expect(await runReferenceAudit(FIXTURE, noJudge)).toEqual([]);
  });
});

describe('runAudits graceful degrade', () => {
  it('returns [] with no injected judge', async () => {
    expect(await runAudits({ sessions: FIXTURE })).toEqual([]);
  });

  it('runs the audit when a judge is injected', async () => {
    const findings = await runAudits({ sessions: FIXTURE, judge: yesJudge });
    expect(findings.map((f) => f.id)).toEqual(['token-to-tool-ratio:outlier']);
  });

  it('never throws when an audit errors mid-run', async () => {
    const throwingJudge: JudgeFn = async () => {
      throw new Error('judge exploded');
    };
    await expect(
      runAudits({ sessions: FIXTURE, judge: throwingJudge })
    ).resolves.toEqual([]);
  });

  it('keeps earlier findings when a later candidate throws', async () => {
    // Two outliers amid enough low-ratio normals to keep the median low so both
    // clear the threshold; the judge confirms the first and throws on the second.
    const twoOutliers: AuditSession[] = [
      { sessionId: 'norm-1', project: 'demo', totalTokens: 80_000, toolCalls: 55, messageCount: 70 },
      { sessionId: 'norm-2', project: 'demo', totalTokens: 90_000, toolCalls: 60, messageCount: 75 },
      { sessionId: 'norm-3', project: 'demo', totalTokens: 100_000, toolCalls: 50, messageCount: 80 },
      { sessionId: 'out-1', project: 'demo', totalTokens: 300_000, toolCalls: 1, messageCount: 100 },
      { sessionId: 'out-2', project: 'demo', totalTokens: 400_000, toolCalls: 1, messageCount: 100 },
    ];
    const seeded = seedTokenToToolOutliers(twoOutliers).map((s) => s.sessionId);
    expect(seeded).toEqual(['out-1', 'out-2']);

    const flakyJudge: JudgeFn = async ({ user }) => {
      if (user.includes('out-2')) throw new Error('transient');
      return { isFinding: true, rationale: 'waste', confidence: 'medium' };
    };
    const findings = await runAudits({ sessions: twoOutliers, judge: flakyJudge });
    expect(findings.map((f) => f.id)).toEqual(['token-to-tool-ratio:out-1']);
  });

  it('caps reference audit judge fanout with the shared judge budget', async () => {
    const manyOutliers: AuditSession[] = [
      ...Array.from({ length: 10 }, (_, i) => ({
        sessionId: `norm-${i}`,
        project: 'demo',
        totalTokens: 80_000 + i,
        toolCalls: 80,
        messageCount: 70,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        sessionId: `out-${i}`,
        project: 'demo',
        totalTokens: 300_000 + i,
        toolCalls: 1,
        messageCount: 100,
      })),
    ];
    let calls = 0;
    const countingJudge: JudgeFn = async () => {
      calls += 1;
      return { isFinding: true, rationale: 'waste', confidence: 'medium' };
    };

    const findings = await runAudits({
      sessions: manyOutliers,
      judge: countingJudge,
      maxJudgeCalls: 2,
    });

    expect(calls).toBe(2);
    expect(findings.map((f) => f.id)).toEqual([
      'token-to-tool-ratio:out-0',
      'token-to-tool-ratio:out-1',
    ]);
  });
});

describe('parseVerdict', () => {
  it('extracts a JSON verdict embedded in prose', () => {
    const v = parseVerdict(
      'Sure — {"isFinding": true, "rationale": "ok", "confidence": "medium"} done.'
    );
    expect(v).toEqual({ isFinding: true, rationale: 'ok', confidence: 'medium' });
  });

  it('defaults safely on unparseable or invalid replies', () => {
    expect(parseVerdict('no json here')).toEqual({
      isFinding: false,
      rationale: '',
      confidence: 'low',
    });
    expect(parseVerdict('{"isFinding": true, "confidence": "bogus"}')).toEqual({
      isFinding: true,
      rationale: '',
      confidence: 'low',
    });
  });
});

/**
 * #3111 — the judge's data classification must be an ENFORCED property of the
 * call, not a caller convention. `makeClaudeJudge` turns a `claude-derived`
 * prompt into `containsClaudeData: true`, which the LLM chokepoint refuses to
 * send under the subscription OAuth credential.
 */
describe('judge data classification (#3111)', () => {
  it('marks a claude-derived prompt as Claude data on the chat request', async () => {
    const seen: ClaudeJudgeChatRequest[] = [];
    const judge = makeClaudeJudge(async (req) => {
      seen.push(req);
      return { text: '{"isFinding":false,"rationale":"","confidence":"low"}' };
    });

    await judge({
      system: 'sys',
      user: 'transcript',
      classification: 'claude-derived',
    });

    expect(seen[0].containsClaudeData).toBe(true);
  });

  it('leaves an unclassified (metrics-only) prompt unmarked', async () => {
    const seen: ClaudeJudgeChatRequest[] = [];
    const judge = makeClaudeJudge(async (req) => {
      seen.push(req);
      return { text: '{"isFinding":false,"rationale":"","confidence":"low"}' };
    });

    await judge({ system: 'sys', user: '12 tokens per tool call' });

    expect(seen[0].containsClaudeData).toBe(false);
  });

  it('refuses a subscription-OAuth judge before any network dispatch', async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    // A judge whose chat implementation is backed by the subscription OAuth
    // credential instead of a Console key.
    const oauthJudge = makeClaudeJudge(async (req) => {
      await callAnthropic('server.usage-gauge', {
        credential: { kind: 'oauth', token: 'subscription-oauth-token' },
        path: '/messages',
        body: { messages: req.messages },
        containsClaudeData: req.containsClaudeData,
        fetchImpl,
      });
      return { text: '{"isFinding":false,"rationale":"","confidence":"low"}' };
    });

    await expect(
      oauthJudge({
        system: 'sys',
        user: 'CLAIM: ... ACTION: ...',
        classification: 'claude-derived',
      })
    ).rejects.toMatchObject({ code: 'ERR_DASHBOARD_LLM_OAUTH_CLAUDE_DATA' });

    expect(fetchCalls).toBe(0);
  });
});
