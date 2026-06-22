import { describe, it, expect } from 'vitest';
import { detector } from './output-verbosity';
import type { RecommendationInput } from '../types';
import type { SessionTokenData, AssistantFeatures, LiveConfig } from '../../../types';
import { runReclaimCascade } from '../../reclaim';

const af = (sessionId: string, textLength: number): AssistantFeatures =>
  ({
    sessionId,
    assistantTurnCount: 30,
    textLength,
    codeBlockCount: 0,
    toolCallCount: 5,
    refusalCount: 0,
    hedgingCount: 0,
    endsWithQuestionCount: 0,
    thinkingByteLen: 0,
  }) as AssistantFeatures;

const session = (sessionId: string, outputTokens: number, turns = 20): SessionTokenData =>
  ({
    sessionId,
    entries: Array.from({ length: turns }, () => ({
      timestamp: 't',
      model: 'claude-opus-4-7',
      inputTokens: 0,
      outputTokens: Math.round(outputTokens / turns),
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 50_000,
      webSearchRequests: 0,
      webFetchRequests: 0,
    })),
  }) as unknown as SessionTokenData;

// Verbose, prose-dominant session: ~100k prose tokens (400k chars) of 120k output.
const proseDominant = (): Partial<RecommendationInput> => ({
  assistantFeatures: [af('s1', 400_000)],
  tokenData: [session('s1', 120_000)],
});

const input = (overrides?: Partial<RecommendationInput>): RecommendationInput =>
  ({
    tokenData: [],
    toolData: [],
    assistantFeatures: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    ...overrides,
  }) as RecommendationInput;

describe('cost.output-verbosity (#1923)', () => {
  it('fires on prose-dominant output with a conservative output-pool reclaim', () => {
    const rec = detector.rule(input(proseDominant()), 0);
    expect(rec?.id).toBe('cost.output-verbosity');
    expect(rec?.category).toBe('cost');
    expect(rec?.estSavingsUsd).toBeGreaterThan(0);
    expect(rec?.reclaim?.ownedPools).toEqual(['output']);
    expect(rec?.reclaim?.counterfactual.kind).toBe('scaleTokens');
    expect(rec?.savingsAttribution?.tier).toBe('tier-0-estimate');
    expect(rec?.savingsAttribution?.confidence).toBe('low'); // unproven lever
    expect(rec?.detail).toMatch(/[Pp]rose only/);
  });

  it('books a positive output marginal through the cascade and preserves the identity', () => {
    const rec = detector.rule(input(proseDominant()), 0);
    const result = runReclaimCascade([rec!.reclaim!], input(proseDominant()).tokenData);
    expect(result.total).toBeGreaterThan(0);
    expect(result.byCategory.cost).toBeCloseTo(result.total, 9);
    expect(result.billOriginal - result.billFinal).toBeCloseTo(result.total, 9);
  });

  it('does not credit tool/JSON-heavy output (prose-only, honest-null)', () => {
    // Lots of output but tiny prose (textLength small) → prose share below floor.
    const rec = detector.rule(
      input({ assistantFeatures: [af('s1', 4_000)], tokenData: [session('s1', 200_000)] }),
      0
    );
    expect(rec).toBeNull();
  });

  it('self-suppresses once CLAUDE.md documents output brevity', () => {
    const liveConfig = {
      claudeMd: {
        global:
          '## Output brevity\n\n- Keep assistant output terse, especially in headless runs.',
        perProject: {},
      },
    } as unknown as LiveConfig;
    const rec = detector.rule(input({ ...proseDominant(), liveConfig }), 0);
    expect(rec).toBeNull();
  });

  it('stays silent with no assistant features', () => {
    expect(detector.rule(input({ assistantFeatures: [], tokenData: [session('s1', 120_000)] }), 0)).toBeNull();
  });

  it('ships the validated CLAUDE.md brevity fix with self-suppression markers', () => {
    const rec = detector.rule(input(proseDominant()), 0);
    expect(rec?.fix?.target).toBe('CLAUDE.md');
    expect(rec?.fix?.snippet).toContain('keep assistant output terse'.replace(/^k/, 'K'));
    expect(rec?.fix?.appliedMarkers).toBeDefined();
  });
});
