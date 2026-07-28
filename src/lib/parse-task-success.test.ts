import { describe, expect, it } from 'vitest';
import {
  classifyAgentClosingClaim,
  classifyHumanTaskVerdict,
  computeTaskSuccess,
  parseTaskSuccess,
} from './parse-task-success';
import type { RuntimeEvents } from './parse-runtime-events';

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

function historyEntry(
  sessionId: string,
  display: string,
  timestamp: string
) {
  return {
    display,
    pastedContents: {},
    timestamp: Date.parse(timestamp),
    project: '/repo/app',
    sessionId,
  };
}

function runtime(sessionId: string, stopTimestamp: string): RuntimeEvents {
  return {
    sessionId,
    turns: [],
    stopHooks: [
      {
        sessionId,
        timestamp: stopTimestamp,
        hookCount: 1,
        totalDurationMs: 10,
        hadErrors: false,
        preventedContinuation: false,
      },
    ],
    awaySummaries: [],
    scheduledFires: [],
  };
}

function completedFileEvents(
  sessionId: string,
  filePath: string,
  baseTimestamp = '2026-01-01T00:00:01.000Z'
) {
  return [
    {
      sessionId,
      timestamp: baseTimestamp,
      kind: 'tool_use' as const,
      toolName: 'Edit',
      topicText: JSON.stringify({ file_path: filePath }),
      isMutating: true,
    },
    {
      sessionId,
      timestamp: '2026-01-01T00:00:02.000Z',
      kind: 'tool_result' as const,
      isError: false,
    },
    {
      sessionId,
      timestamp: '2026-01-01T00:00:02.500Z',
      kind: 'assistant_text' as const,
      text: `Done, fixed ${filePath}.`,
      topicText: `Done, fixed ${filePath}.`,
    },
  ];
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

  it('corroborates a neutral move-on plus completed claim when the topic never returns', () => {
    const transcript = [
      userLine('update the docs', '2026-01-01T00:00:00.000Z'),
      assistantLine(
        [editTool, { type: 'text', text: 'Updated the documentation and finished.' }],
        '2026-01-01T00:00:01.000Z'
      ),
      stopLine('2026-01-01T00:00:02.000Z'),
      userLine('now check the logs', '2026-01-01T00:00:03.000Z'),
      // #3155: history must extend past the 14-day recurrence window before
      // "the topic never returned" is evidence rather than a statement about
      // how briefly we looked. This fixture previously spanned three seconds.
      userLine('unrelated deployment question', '2026-01-20T00:00:00.000Z'),
    ].join('\n');

    const rows = parseTaskSuccess(transcript, 'neutral-session.jsonl', {
      fallbackProject: '/repo/app',
    });

    expect(rows[0].verdict).toBe('neutral');
    expect(rows[0].agentClaim).toBe('completed');
    expect(rows[0].confidence).toBe('high');
    expect(rows[0].successScore).toBeGreaterThanOrEqual(0.9);
    expect(rows[0].recurrence?.kind).toBe('corroborated');
  });

  it('demotes a neutral completed span when a later corrective turn returns to the same topic', () => {
    const rows = computeTaskSuccess({
      entries: [
        historyEntry(
          'done-session',
          'fix src/BillingWidget.tsx',
          '2026-01-01T00:00:00.000Z'
        ),
        historyEntry(
          'done-session',
          'now check the logs',
          '2026-01-01T00:03:00.000Z'
        ),
        historyEntry(
          'correct-session',
          'no, BillingWidget.tsx is still broken',
          '2026-01-02T00:00:00.000Z'
        ),
      ],
      runtimeEvents: [runtime('done-session', '2026-01-01T00:02:30.000Z')],
      transcriptEvents: completedFileEvents(
        'done-session',
        'src/BillingWidget.tsx'
      ),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      verdict: 'correct',
      confidence: 'high',
      successScore: 0,
      recurrence: {
        kind: 'demoted',
        topic: 'billingwidget.tsx',
        proof: {
          sessionId: 'correct-session',
          display: 'no, BillingWidget.tsx is still broken',
        },
      },
    });
  });

  it('corroborates a completed evidence-backed span whose topic never returns', () => {
    const rows = computeTaskSuccess({
      entries: [
        historyEntry(
          'quiet-session',
          'fix src/ReportsPanel.tsx',
          '2026-01-01T00:00:00.000Z'
        ),
        historyEntry(
          'quiet-session',
          'now check the logs',
          '2026-01-01T00:03:00.000Z'
        ),
        // #3155: observed history must cover the full 14-day recurrence
        // window after the span before its absence counts as corroboration.
        historyEntry(
          'other-session',
          'review src/OtherPanel.tsx',
          '2026-01-20T00:00:00.000Z'
        ),
      ],
      runtimeEvents: [runtime('quiet-session', '2026-01-01T00:02:30.000Z')],
      transcriptEvents: completedFileEvents('quiet-session', 'src/ReportsPanel.tsx'),
    });

    expect(rows[0]).toMatchObject({
      verdict: 'neutral',
      confidence: 'high',
      recurrence: {
        kind: 'corroborated',
        topic: 'reportspanel.tsx',
      },
    });
    expect(rows[0].successScore).toBeGreaterThanOrEqual(0.9);
  });

  it('never demotes an explicitly accepted span even when a later topic match is corrective', () => {
    const rows = computeTaskSuccess({
      entries: [
        historyEntry(
          'accepted-session',
          'fix src/AcceptedPanel.tsx',
          '2026-01-01T00:00:00.000Z'
        ),
        historyEntry(
          'accepted-session',
          'thanks, merge it',
          '2026-01-01T00:03:00.000Z'
        ),
        historyEntry(
          'later-session',
          'no, AcceptedPanel.tsx is still broken',
          '2026-01-02T00:00:00.000Z'
        ),
      ],
      runtimeEvents: [runtime('accepted-session', '2026-01-01T00:02:30.000Z')],
      transcriptEvents: completedFileEvents(
        'accepted-session',
        'src/AcceptedPanel.tsx'
      ),
    });

    expect(rows[0]).toMatchObject({
      verdict: 'accept',
      confidence: 'high',
      successScore: 1,
    });
    expect(rows[0].recurrence?.kind).not.toBe('demoted');
  });

  it('keeps classifier fixtures precise for synthetic and blocked/completed claims', () => {
    expect(classifyHumanTaskVerdict('thanks, merge it')).toBe('accept');
    expect(classifyHumanTaskVerdict("no, that's broken")).toBe('correct');
    expect(classifyHumanTaskVerdict('BillingWidget.tsx is still broken')).toBe(
      'correct'
    );
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

// ---------------------------------------------------------------------------
// Absence is only evidence once we have watched long enough (#3155)
// ---------------------------------------------------------------------------

describe('recurrence corroboration requires an observed window (#3155)', () => {
  const span = (): TaskSuccessProxy[] =>
    computeTaskSuccess({
      entries: [
        historyEntry('quiet-session', 'fix src/ReportsPanel.tsx', '2026-01-01T00:00:00.000Z'),
        historyEntry('quiet-session', 'now check the logs', '2026-01-01T00:03:00.000Z'),
      ],
      runtimeEvents: [runtime('quiet-session', '2026-01-01T00:02:30.000Z')],
      transcriptEvents: completedFileEvents('quiet-session', 'src/ReportsPanel.tsx'),
    });

  it('does not promote on absence when the window has not elapsed', () => {
    // History covers three minutes. "The user never came back" is a statement
    // about how briefly we looked, not about the task.
    const rows = span();
    expect(rows[0].confidence).not.toBe('high');
    expect(rows[0].recurrence?.kind).not.toBe('corroborated');
  });

  it('does not promote when there is no history at all', () => {
    // The starkest case: with an empty corpus nothing can return, so every span
    // used to be corroborated to high confidence — absent evidence read as
    // evidence of success.
    const rows = computeTaskSuccess({
      entries: [
        historyEntry('quiet-session', 'fix src/ReportsPanel.tsx', '2026-01-01T00:00:00.000Z'),
        historyEntry('quiet-session', 'now check the logs', '2026-01-01T00:03:00.000Z'),
      ],
      runtimeEvents: [runtime('quiet-session', '2026-01-01T00:02:30.000Z')],
      transcriptEvents: completedFileEvents('quiet-session', 'src/ReportsPanel.tsx'),
    });
    expect(rows.every((r) => r.recurrence?.kind !== 'corroborated')).toBe(true);
  });

  it('promotes once observed history covers the full window, and dates the claim', () => {
    const rows = computeTaskSuccess({
      entries: [
        historyEntry('quiet-session', 'fix src/ReportsPanel.tsx', '2026-01-01T00:00:00.000Z'),
        historyEntry('quiet-session', 'now check the logs', '2026-01-01T00:03:00.000Z'),
        // We kept watching for 19 days and the topic never returned.
        historyEntry('other-session', 'review src/OtherPanel.tsx', '2026-01-20T00:00:00.000Z'),
      ],
      runtimeEvents: [runtime('quiet-session', '2026-01-01T00:02:30.000Z')],
      transcriptEvents: completedFileEvents('quiet-session', 'src/ReportsPanel.tsx'),
    });
    expect(rows[0].confidence).toBe('high');
    expect(rows[0].recurrence?.kind).toBe('corroborated');
    // The claim is bounded by when we stopped looking, not open-ended.
    expect(rows[0].recurrence?.observedUntil).toBe('2026-01-20T00:00:00.000Z');
  });
});
