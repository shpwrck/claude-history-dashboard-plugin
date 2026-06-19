import { describe, it, expect } from 'vitest';
import { detector } from './repeated-commands';
import type { RecommendationInput } from '../types';
import type { ToolUsageData, ToolCall } from '../../parse-tools';

// `npm run build` run 4× in one session — a repeated command the detector flags.
const bashCall = (i: number): ToolCall =>
  ({
    timestamp: `2026-01-01T00:00:0${i}Z`,
    toolName: 'Bash',
    input: { command: 'npm run build' },
    toolUseId: `u${i}`,
    isError: false,
    resultBytes: 100,
  }) as unknown as ToolCall;

const toolData: ToolUsageData[] = [
  { sessionId: 's1', calls: Array.from({ length: 4 }, (_, i) => bashCall(i)) },
] as unknown as ToolUsageData[];

const input = (
  overrides?: Partial<RecommendationInput>
): RecommendationInput => ({
  tokenData: [],
  toolData,
  sessions: [],
  projects: [],
  permissionRows: [],
  apiErrors: [],
  liveConfig: null,
  ...overrides,
});

describe('workflow.repeated-commands (#1803)', () => {
  it('fires for a command repeated 3+ times and deep-links to the Tools view', () => {
    const rec = detector.rule(input(), 0);
    expect(rec?.id).toBe('workflow.repeated-commands');
    expect(rec?.category).toBe('workflow');
    expect(rec?.view).toBe('tools');
    expect(rec?.evidence?.some((e) => e.includes('npm run build'))).toBe(true);
  });

  it('exposes a copyable CLAUDE.md wrapper snippet as the actionable next step', () => {
    const rec = detector.rule(input(), 0);
    expect(rec?.fix).toBeDefined();
    expect(rec?.fix?.target).toBe('CLAUDE.md');
    // The snippet names the repeated command so the user can wrap it.
    expect(rec?.fix?.snippet).toContain('npm run build');
    expect(rec?.fix?.snippet).toContain('## Common commands');
  });

  it('self-suppresses when CLAUDE.md already documents the wrapper', () => {
    const liveConfig = {
      claudeMd: {
        global:
          '## Common commands\n\nThese were run repeatedly — wrap them in a script (e.g. `scripts/dev.sh`) or a Makefile target and invoke that instead of re-typing the steps:\n\n- `npm run build`',
      },
    } as unknown as RecommendationInput['liveConfig'];
    expect(detector.rule(input({ liveConfig }), 0)).toBeNull();
  });

  it('says nothing when no command repeats', () => {
    const sparse: ToolUsageData[] = [
      {
        sessionId: 's2',
        calls: [bashCall(0)],
      },
    ] as unknown as ToolUsageData[];
    expect(detector.rule(input({ toolData: sparse }), 0)).toBeNull();
  });
});
