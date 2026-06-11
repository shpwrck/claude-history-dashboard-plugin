import { describe, it, expect } from 'vitest';
import { detector } from './tool-undo-rate';
import type { RecommendationInput } from '../types';
import type { ToolUsageData, ToolCall } from '../../parse-tools';

const edit = (i: number, file: string): ToolCall =>
  ({ timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`, toolName: 'Edit', input: { file_path: file }, toolUseId: `e${i}`, isError: null, resultBytes: 0 });
const restore = (i: number): ToolCall =>
  ({ timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`, toolName: 'Bash', input: { command: 'git restore .' }, toolUseId: `b${i}`, isError: null, resultBytes: 0 });

// 10 edits on distinct files; the first two are immediately followed by a git restore.
const calls: ToolCall[] = [];
let t = 0;
calls.push(edit(t++, 'f0'), restore(t++));
calls.push(edit(t++, 'f1'), restore(t++));
for (let i = 2; i < 10; i++) calls.push(edit(t++, `f${i}`));
const toolData: ToolUsageData[] = [{ sessionId: 's1', calls }];

const input = (pre = false): RecommendationInput => ({
  tokenData: [], toolData, sessions: [], projects: [], permissionRows: [], apiErrors: [], timelines: [],
  liveConfig: pre ? ({ settings: { hooks: { PreToolUse: [{ matcher: 'Edit|Write' }] } } } as unknown as RecommendationInput['liveConfig']) : null,
});

describe('workflow.tool-undo-rate (#422)', () => {
  it('fires when edit rollback rate >= 10% over >=10 invocations', () => {
    const rec = detector.rule(input(), 0);
    expect(rec?.id).toBe('workflow.tool-undo-rate');
    expect(rec?.fix?.snippet).toContain('PreToolUse');
  });
  it('self-suppresses when a PreToolUse Edit hook exists', () => {
    expect(detector.rule(input(true), 0)).toBeNull();
  });
});
