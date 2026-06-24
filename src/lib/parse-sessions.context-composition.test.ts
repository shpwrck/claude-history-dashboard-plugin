import { describe, it, expect } from 'vitest';
import { parseSessionJsonl } from './parse-sessions';

// #1926: per-turn input-context snapshots (contextHistoryTokens /
// contextToolResultTokens) accumulated in transcript order.
const userText = (text: string, timestamp: string) =>
  JSON.stringify({
    type: 'user',
    timestamp,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });

const userToolResult = (content: string, timestamp: string) =>
  JSON.stringify({
    type: 'user',
    timestamp,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content }],
    },
  });

const assistantWithText = (
  id: string,
  text: string,
  usage: Record<string, unknown>,
  timestamp: string
) =>
  JSON.stringify({
    type: 'assistant',
    timestamp,
    message: {
      id,
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text }],
      usage,
    },
  });

describe('parseSessionJsonl context-composition sums (#1926)', () => {
  it('sums per-turn cumulative history/tool-result snapshots, excluding each turn own output', () => {
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1 };
    const text = [
      userText('a'.repeat(26), '2026-01-01T00:00:00.000Z'), // history += ceil(26/2.6)=10
      assistantWithText('m1', 'b'.repeat(26), usage, '2026-01-01T00:00:01.000Z'), // snapshot h=10,t=0; then +10 visible
      userToolResult('c'.repeat(35), '2026-01-01T00:00:02.000Z'), // toolResult += ceil(35/3.5)=10
      assistantWithText('m2', 'd'.repeat(52), usage, '2026-01-01T00:00:03.000Z'), // snapshot h=20,t=10
    ].join('\n');

    const out = parseSessionJsonl(text, 'sess.jsonl')!;
    expect(out.entries).toHaveLength(2);

    // Snapshot sums: history 10 (turn1) + 20 (turn2) = 30; toolResult 0 + 10 = 10.
    expect(out.contextHistoryTokensSum).toBe(30);
    expect(out.contextToolResultTokensSum).toBe(10);
  });

  it('omits the sum fields when the session has no preceding context to attribute', () => {
    const text = assistantWithText(
      'm1',
      'hello',
      { input_tokens: 5, output_tokens: 3 },
      '2026-01-01T00:00:00.000Z'
    );
    const out = parseSessionJsonl(text, 'sess.jsonl')!;
    expect(out.contextHistoryTokensSum).toBeUndefined();
    expect(out.contextToolResultTokensSum).toBeUndefined();
  });
});
