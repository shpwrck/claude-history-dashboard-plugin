import { describe, expect, it } from 'vitest';
import { parseChurnGeometry } from './parse-churn-geometry';

const line = (entry: unknown) => JSON.stringify(entry);
const ts = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min, 0)).toISOString();

function assistantTool(timestamp: string, id: string, name: string, input: object): string {
  return line({
    type: 'assistant',
    timestamp,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input }],
    },
  });
}

function userResult(timestamp: string, toolUseId: string, toolUseResult: object): string {
  return line({
    type: 'user',
    timestamp,
    toolUseResult: { toolUseId, ...toolUseResult },
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }],
    },
  });
}

describe('parseChurnGeometry (#597)', () => {
  it('parses structuredPatch into line-geometry summaries with stop-boundary re-edits', () => {
    const text = [
      assistantTool(ts(1), 'edit-1', 'Edit', { file_path: 'src/payment.ts' }),
      userResult(ts(2), 'edit-1', {
        filePath: 'src/payment.ts',
        structuredPatch: { oldStart: 12, oldLines: 10, newStart: 12, newLines: 11, lines: 11 },
      }),
      line({ type: 'system', subtype: 'stop_hook_summary', timestamp: ts(3), hookCount: 1 }),
      assistantTool(ts(4), 'edit-2', 'Edit', { file_path: 'src/payment.ts' }),
      userResult(ts(5), 'edit-2', {
        filePath: 'src/payment.ts',
        originalFile: 'src/payment.ts',
        userModified: true,
        structuredPatch: [{ oldStart: 12, oldLines: 11, newStart: 12, newLines: 10, lines: 11 }],
      }),
    ].join('\n');

    const parsed = parseChurnGeometry(text, 'session-1.jsonl');
    expect(parsed?.sessionId).toBe('session-1');
    expect(parsed?.edits).toHaveLength(2);

    const file = parsed?.files[0];
    expect(file).toMatchObject({
      filePath: 'src/payment.ts',
      tasks: 2,
      edits: 2,
      userModifiedEdits: 1,
      grossLines: 22,
      netLines: 0,
      reeditRanges: 1,
      postStopReeditRanges: 1,
      reworkDistance: 22,
    });
  });

  it('records empty-patch Write results without inventing line geometry', () => {
    const text = [
      assistantTool(ts(1), 'write-1', 'Write', { file_path: 'src/new.ts' }),
      userResult(ts(2), 'write-1', {
        filePath: 'src/new.ts',
        structuredPatch: [],
      }),
    ].join('\n');

    const parsed = parseChurnGeometry(text, 'session-2.jsonl');
    expect(parsed?.edits[0]).toMatchObject({
      toolName: 'Write',
      filePath: 'src/new.ts',
      grossLines: 0,
      netLines: 0,
      emptyPatch: true,
    });
    expect(parsed?.files[0].emptyPatchWrites).toBe(1);
  });

  it('stays dark when no mutating tool result carries structured geometry', () => {
    const text = [
      assistantTool(ts(1), 'read-1', 'Read', { file_path: 'src/a.ts' }),
      userResult(ts(2), 'read-1', {
        filePath: 'src/a.ts',
        structuredPatch: { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 },
      }),
    ].join('\n');

    expect(parseChurnGeometry(text, 'session-3.jsonl')).toBeNull();
  });
});
