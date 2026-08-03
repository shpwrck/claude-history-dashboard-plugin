import { describe, it, expect } from 'vitest';
import { detector } from './tool-undo-rate';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { ToolUsageData, ToolCall } from '../../parse-tools';

const edit = (i: number, file: string): ToolCall =>
  ({ timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`, toolName: 'Edit', input: { file_path: file }, toolUseId: `e${i}`, isError: null, resultBytes: 0 });
const restore = (i: number, file: string): ToolCall =>
  ({ timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`, toolName: 'Bash', input: { command: `git restore -- ${file}` }, toolUseId: `b${i}`, isError: null, resultBytes: 0, commandUndoFilePaths: [file] });
const failedRestore = (i: number, file: string): ToolCall =>
  ({ ...restore(i, file), isError: true });

// 10 edits on distinct files; the first two are immediately followed by a git restore.
const calls: ToolCall[] = [];
let t = 0;
calls.push(edit(t++, 'f0'), restore(t++, 'f0'));
calls.push(edit(t++, 'f1'), restore(t++, 'f1'));
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

  it('does not fire from a corpus whose only matching restore commands failed', () => {
    const failedCalls: ToolCall[] = [];
    let timestamp = 0;
    failedCalls.push(edit(timestamp++, 'f0'), failedRestore(timestamp++, 'f0'));
    failedCalls.push(edit(timestamp++, 'f1'), failedRestore(timestamp++, 'f1'));
    for (let i = 2; i < 10; i++) failedCalls.push(edit(timestamp++, `f${i}`));

    expect(
      detector.rule(
        {
          ...input(),
          toolData: [{ sessionId: 'failed-only', calls: failedCalls }],
        },
        Date.parse('2026-01-02T00:00:00Z')
      )
    ).toBeNull();
  });

  it('cites both rollback-rate operands and their division', () => {
    const rec = detector.rule(
      input(),
      Date.parse('2026-01-02T00:00:00Z')
    )!;

    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.affected).toBe(2);
    expect(rec.detail).toContain('20%');
    expect(rec.provenance?.asOf).toBe('2026-01-01');
    expect(rec.provenance?.stale).toBe(false);
    expect(rec.provenance?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'computeToolEffectiveness().tool',
          value: 'Edit',
        }),
        expect.objectContaining({
          field: 'computeToolEffectiveness().invocations',
          value: 10,
        }),
        expect.objectContaining({
          field: 'computeToolEffectiveness().immediatelyFollowedByUndo',
          value: 2,
        }),
      ])
    );
    expect(rec.provenance?.derivations).toContainEqual({
      id: 'undo-rate-percent',
      formula: 'round((immediatelyFollowedByUndo / invocations) * 100)',
      operands: { immediatelyFollowedByUndo: 2, invocations: 10 },
      value: 20,
    });
  });

  it('demotes a stale rollback window to dated historical wording', () => {
    const rec = detector.rule(
      input(),
      Date.parse('2026-06-10T00:00:00Z')
    )!;

    expect(rec.provenance?.asOf).toBe('2026-01-01');
    expect(rec.provenance?.stale).toBe(true);
    expect(rec.detail).toMatch(/^As of 2026-01-01,/);
    expect(rec.action).toMatch(/^Treat this as historical evidence/);
    expect(rec.action).toContain('remeasure');
  });
});
