import { describe, expect, it } from 'vitest';
import { parseValueFlow } from './parse-value-flow';

function assistant(timestamp: string, content: unknown[]) {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: { role: 'assistant', content },
  });
}

function user(timestamp: string, content: unknown[]) {
  return JSON.stringify({
    type: 'user',
    timestamp,
    message: { role: 'user', content },
  });
}

describe('parseValueFlow', () => {
  it('emits a high-confidence edge when a distinctive tool result value appears in a later tool input', () => {
    const text = [
      assistant('2026-01-01T00:00:00.000Z', [
        {
          type: 'tool_use',
          id: 'tool-read',
          name: 'Read',
          input: { file_path: 'deploy-output.txt' },
        },
      ]),
      user('2026-01-01T00:00:01.000Z', [
        {
          type: 'tool_result',
          tool_use_id: 'tool-read',
          content: 'created target deploy-target-9f83a1c7 for the next step',
        },
      ]),
      assistant('2026-01-01T00:00:02.000Z', [
        {
          type: 'tool_use',
          id: 'tool-bash',
          name: 'Bash',
          input: { command: 'deploy --target deploy-target-9f83a1c7' },
        },
      ]),
    ].join('\n');

    const parsed = parseValueFlow(text, 'session-a.jsonl');

    expect(parsed?.sessionId).toBe('session-a');
    expect(parsed?.hypotheses).toEqual([]);
    expect(parsed?.edges).toHaveLength(1);
    // Slim edge (#2108): only the consumer-read fields. sessionId/source/target/
    // confidence/reason were dropped as redundant or constant.
    expect(parsed?.edges[0]).toEqual({
      value: 'deploy-target-9f83a1c7',
      sourceToolUseId: 'tool-read',
      targetToolUseId: 'tool-bash',
    });
  });

  it('keeps temporal-only pairs separate from proven edges', () => {
    const text = [
      assistant('2026-01-01T00:00:00.000Z', [
        {
          type: 'tool_use',
          id: 'tool-read',
          name: 'Read',
          input: { file_path: 'deploy-output.txt' },
        },
      ]),
      user('2026-01-01T00:00:01.000Z', [
        {
          type: 'tool_result',
          tool_use_id: 'tool-read',
          content: 'created target deploy-target-9f83a1c7 for the next step',
        },
      ]),
      assistant('2026-01-01T00:00:02.000Z', [
        {
          type: 'tool_use',
          id: 'tool-bash',
          name: 'Bash',
          input: { command: 'deploy --target unrelated-target-0000ffff' },
        },
      ]),
    ].join('\n');

    const parsed = parseValueFlow(text, 'session-b.jsonl');

    expect(parsed?.edges).toEqual([]);
    expect(parsed?.hypotheses).toHaveLength(1);
    expect(parsed?.hypotheses[0]).toMatchObject({
      reason: 'temporal-sequence',
      source: { sessionId: 'session-b', entryIndex: 1, toolUseId: 'tool-read' },
      target: { sessionId: 'session-b', entryIndex: 2, toolUseId: 'tool-bash' },
    });
  });

  it('omits temporal-only hypotheses when compact dataset mode is requested', () => {
    const text = [
      assistant('2026-01-01T00:00:00.000Z', [
        {
          type: 'tool_use',
          id: 'tool-read',
          name: 'Read',
          input: { file_path: 'deploy-output.txt' },
        },
      ]),
      user('2026-01-01T00:00:01.000Z', [
        {
          type: 'tool_result',
          tool_use_id: 'tool-read',
          content: 'created target deploy-target-9f83a1c7 for the next step',
        },
      ]),
      assistant('2026-01-01T00:00:02.000Z', [
        {
          type: 'tool_use',
          id: 'tool-bash',
          name: 'Bash',
          input: { command: 'deploy --target unrelated-target-0000ffff' },
        },
      ]),
    ].join('\n');

    expect(
      parseValueFlow(text, 'session-b.jsonl', { includeHypotheses: false })
    ).toBeNull();
  });

  it('requires an exact token match, not a substring of a larger token', () => {
    const text = [
      assistant('2026-01-01T00:00:00.000Z', [
        {
          type: 'tool_use',
          id: 'tool-read',
          name: 'Read',
          input: { file_path: 'deploy-output.txt' },
        },
      ]),
      user('2026-01-01T00:00:01.000Z', [
        {
          type: 'tool_result',
          tool_use_id: 'tool-read',
          content: 'created target deploy-target-9f83a1c7 for the next step',
        },
      ]),
      assistant('2026-01-01T00:00:02.000Z', [
        {
          type: 'tool_use',
          id: 'tool-bash',
          name: 'Bash',
          // Contains the prior value only as a prefix of a longer token —
          // a different identifier, so no proven edge.
          input: { command: 'deploy --target deploy-target-9f83a1c7ff' },
        },
      ]),
    ].join('\n');

    const parsed = parseValueFlow(text, 'session-d.jsonl');

    expect(parsed?.edges).toEqual([]);
    expect(parsed?.hypotheses).toHaveLength(1);
  });

  it('scrubs secret-shaped values before they land on an edge', () => {
    const token = 'ghp_abcDEF123abcDEF123abcDEF123abcDEF123';
    const text = [
      assistant('2026-01-01T00:00:00.000Z', [
        {
          type: 'tool_use',
          id: 'tool-bash-1',
          name: 'Bash',
          input: { command: 'cat .credentials' },
        },
      ]),
      user('2026-01-01T00:00:01.000Z', [
        {
          type: 'tool_result',
          tool_use_id: 'tool-bash-1',
          content: `token: ${token}`,
        },
      ]),
      assistant('2026-01-01T00:00:02.000Z', [
        {
          type: 'tool_use',
          id: 'tool-bash-2',
          name: 'Bash',
          input: { command: `curl -H "Auth: ${token}" https://x.test` },
        },
      ]),
    ].join('\n');

    const parsed = parseValueFlow(text, 'session-e.jsonl');

    expect(parsed?.edges).toHaveLength(1);
    expect(parsed?.edges[0].value).toBe('[REDACTED:github-token]');
    expect(parsed?.edges[0].value).not.toContain(token);
  });

  it('uses timeline order rather than raw line order', () => {
    const text = [
      user('2026-01-01T00:00:01.000Z', [
        {
          type: 'tool_result',
          tool_use_id: 'tool-read',
          content: 'created target deploy-target-9f83a1c7 for the next step',
        },
      ]),
      assistant('2026-01-01T00:00:00.000Z', [
        {
          type: 'tool_use',
          id: 'tool-bash',
          name: 'Bash',
          input: { command: 'deploy --target deploy-target-9f83a1c7' },
        },
      ]),
    ].join('\n');

    expect(parseValueFlow(text, 'session-c.jsonl')).toBeNull();
  });
});
