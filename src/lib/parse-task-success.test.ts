import { describe, expect, it } from 'vitest';
import {
  classifyAgentClosingClaim,
  classifyHumanTaskVerdict,
  parseTaskSuccess,
} from './parse-task-success';

const line = (value: Record<string, unknown>) => JSON.stringify(value);

function userLine(
  content: unknown,
  timestamp: string,
  extra: Record<string, unknown> = {}
): string {
  return line({
    type: 'user',
    timestamp,
    cwd: '/repo/app',
    message: { role: 'user', content },
    ...extra,
  });
}

function assistantLine(content: unknown[], timestamp: string): string {
  return line({
    type: 'assistant',
    timestamp,
    message: { role: 'assistant', content },
  });
}

function stopLine(timestamp: string): string {
  return line({
    type: 'system',
    subtype: 'stop_hook_summary',
    timestamp,
    hookCount: 1,
    hookInfos: [{ command: 'notify', durationMs: 10 }],
    hookErrors: [],
    preventedContinuation: false,
  });
}

const editTool = {
  type: 'tool_use',
  id: 'toolu_edit',
  name: 'Edit',
  input: { file_path: 'src/App.tsx', old_string: 'a', new_string: 'b' },
};

const successResult = {
  type: 'tool_result',
  tool_use_id: 'toolu_edit',
  content: 'edited',
  is_error: false,
};

describe('parse-task-success', () => {
  it('scores an accepted span high-confidence and does not include cost as an input', () => {
    const transcript = [
      userLine('build the feature', '2026-01-01T00:00:00.000Z'),
      assistantLine(
        [editTool, { type: 'text', text: 'Implemented the feature and tests pass.' }],
        '2026-01-01T00:00:01.000Z'
      ),
      userLine([successResult], '2026-01-01T00:00:02.000Z'),
      stopLine('2026-01-01T00:00:03.000Z'),
      userLine('thanks, merge it', '2026-01-01T00:00:04.000Z'),
    ].join('\n');

    const rows = parseTaskSuccess(transcript, 'success-session.jsonl', {
      fallbackProject: '/repo/app',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: 'success-session',
      project: '/repo/app',
      taskIndex: 0,
      verdict: 'accept',
      agentClaim: 'completed',
      confidence: 'high',
      successScore: 1,
      backedByMutation: true,
      mutatingToolCount: 1,
      toolCallCount: 1,
      toolResultCount: 1,
      toolErrorCount: 0,
    });
    expect('costUsd' in rows[0]).toBe(false);
  });

  it('scores a corrective next-turn verdict low with high confidence', () => {
    const transcript = [
      userLine('fix the bug', '2026-01-01T00:00:00.000Z'),
      assistantLine(
        [editTool, { type: 'text', text: 'Done, the bug is fixed.' }],
        '2026-01-01T00:00:01.000Z'
      ),
      stopLine('2026-01-01T00:00:02.000Z'),
      userLine("no, that's broken", '2026-01-01T00:00:03.000Z'),
    ].join('\n');

    const rows = parseTaskSuccess(transcript, 'correct-session.jsonl', {
      fallbackProject: '/repo/app',
    });

    expect(rows[0]).toMatchObject({
      verdict: 'correct',
      confidence: 'high',
      successScore: 0,
      verdictScore: 0,
    });
  });

  it('scores a neutral move-on plus completed claim as medium-confidence middle', () => {
    const transcript = [
      userLine('update the docs', '2026-01-01T00:00:00.000Z'),
      assistantLine(
        [editTool, { type: 'text', text: 'Updated the documentation and finished.' }],
        '2026-01-01T00:00:01.000Z'
      ),
      stopLine('2026-01-01T00:00:02.000Z'),
      userLine('now check the logs', '2026-01-01T00:00:03.000Z'),
    ].join('\n');

    const rows = parseTaskSuccess(transcript, 'neutral-session.jsonl', {
      fallbackProject: '/repo/app',
    });

    expect(rows[0].verdict).toBe('neutral');
    expect(rows[0].agentClaim).toBe('completed');
    expect(rows[0].confidence).toBe('med');
    expect(rows[0].successScore).toBeGreaterThan(0.5);
    expect(rows[0].successScore).toBeLessThan(1);
  });

  it('keeps classifier fixtures precise for synthetic and blocked/completed claims', () => {
    expect(classifyHumanTaskVerdict('thanks, merge it')).toBe('accept');
    expect(classifyHumanTaskVerdict("no, that's broken")).toBe('correct');
    expect(classifyHumanTaskVerdict('now check the logs')).toBe('neutral');
    expect(
      classifyHumanTaskVerdict(
        '<system-reminder>no, that is synthetic</system-reminder>'
      )
    ).toBe('none');
    expect(classifyAgentClosingClaim('Implemented it and all checks pass.')).toBe(
      'completed'
    );
    expect(classifyAgentClosingClaim('I am blocked waiting for approval.')).toBe(
      'blocked'
    );
    expect(classifyAgentClosingClaim('This is not complete yet.')).toBe('none');
  });
});
