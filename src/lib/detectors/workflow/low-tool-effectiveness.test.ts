import { describe, it, expect } from 'vitest';
import { detector } from './low-tool-effectiveness';
import type { RecommendationInput } from '../types';
import type { ToolUsageData, ToolCall } from '../../parse-tools';

// 11 identical Bash calls → each retries the prior, no forward motion → low score.
const calls: ToolCall[] = Array.from({ length: 11 }, (_, i) => ({
  timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
  toolName: 'Bash', input: { command: 'npm test' }, toolUseId: `u${i}`, isError: null, resultBytes: 0,
}));
const toolData: ToolUsageData[] = [{ sessionId: 's1', calls }];

const input = (postHook = false): RecommendationInput => ({
  tokenData: [], toolData, sessions: [], projects: [], permissionRows: [], apiErrors: [], timelines: [],
  liveConfig: postHook ? ({ settings: { hooks: { PostToolUse: [{ matcher: 'Edit|Write' }] } } } as unknown as RecommendationInput['liveConfig']) : null,
});

describe('workflow.low-tool-effectiveness (#423)', () => {
  it('fires for a tool with effectiveness < 0.4 over >=10 invocations', () => {
    const rec = detector.rule(input(), 0);
    expect(rec?.id).toBe('workflow.low-tool-effectiveness');
    expect(rec?.detail).toContain('Bash');
  });
  it('self-suppresses when a post-edit validation hook exists', () => {
    expect(detector.rule(input(true), 0)).toBeNull();
  });
});
