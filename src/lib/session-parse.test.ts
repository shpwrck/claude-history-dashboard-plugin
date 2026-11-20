import { describe, expect, it } from 'vitest';
import { runSessionParse, type SessionParseEmit, type SessionParseFile } from './session-parse';

// #3805: pins the renamed parse-only session primitive. Every pass emits once,
// in a stable order, and `yielding` (main thread) matches the tight worker map.
const transcript = [
  {
    type: 'user',
    sessionId: 's-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd: '/work/demo',
    message: { role: 'user', content: 'hello' },
  },
  {
    type: 'assistant',
    sessionId: 's-1',
    timestamp: '2026-01-01T00:00:05.000Z',
    cwd: '/work/demo',
    message: {
      role: 'assistant',
      model: 'claude-test',
      content: [
        { type: 'text', text: 'reading' },
        { type: 'tool_use', id: 't-1', name: 'Read', input: { file_path: '/work/demo/a.ts' } },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  },
]
  .map((line) => JSON.stringify(line))
  .join('\n');

const files: SessionParseFile[] = [{ name: 's-1.jsonl', text: transcript, project: 'demo' }];

async function collect(yielding: boolean): Promise<SessionParseEmit[]> {
  const out: SessionParseEmit[] = [];
  await runSessionParse(files, (msg) => out.push(msg), { yielding });
  return out;
}

describe('runSessionParse', () => {
  it('emits each parse pass exactly once, in order', async () => {
    const types = (await collect(false)).map((m) => m.type);
    expect(types).toEqual([
      'tokens',
      'tools',
      'inventories',
      'timelines',
      'apiErrors',
      'permissions',
      'agentSettings',
      'attribution',
      'runtime',
      'churnGeometry',
      'valueFlow',
    ]);
  });

  it('produces identical messages with and without yielding', async () => {
    expect(await collect(true)).toEqual(await collect(false));
  });

  it('parses the transcript into session token data', async () => {
    const tokens = (await collect(false)).find((m) => m.type === 'tokens');
    expect(tokens?.data.length).toBe(1);
  });
});
