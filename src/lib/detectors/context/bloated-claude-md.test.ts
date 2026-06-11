import { describe, it, expect } from 'vitest';
import { detector } from './bloated-claude-md';
import type { RecommendationInput } from '../types';

function input(global: string): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: { claudeMd: { global } } as unknown as RecommendationInput['liveConfig'],
  };
}

describe('context.bloated-claude-md (#412)', () => {
  it('stays silent at or below the 200-line target', () => {
    expect(detector.rule(input('x\n'.repeat(150)), 0)).toBeNull();
    expect(detector.rule(input(''), 0)).toBeNull();
  });

  it('warns past 200 lines and escalates to critical past 400', () => {
    const warn = detector.rule(input('x\n'.repeat(250)), 0);
    expect(warn?.id).toBe('context.bloated-claude-md');
    expect(warn?.severity).toBe('warning');
    expect(warn?.fix?.target).toBe('CLAUDE.md');

    const crit = detector.rule(input('x\n'.repeat(450)), 0);
    expect(crit?.severity).toBe('critical');
  });
});
