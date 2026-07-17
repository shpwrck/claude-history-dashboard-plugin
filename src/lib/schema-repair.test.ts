import { describe, expect, it } from 'vitest';

import {
  checkShape,
  defaultRepairMessage,
  parseJsonObject,
  runRepairLoop,
  type RepairMessage,
  type ValidationResult,
} from './schema-repair';

// A tiny domain validator: the completion must be the literal `ok`.
const wantOk = (raw: string): ValidationResult<string> =>
  raw.trim() === 'ok'
    ? { ok: true, value: 'ok' }
    : { ok: false, errors: [`response "${raw}" is not the word ok`] };

// A scripted chat: hands back each queued reply in turn, recording the messages.
const scripted = (replies: string[]) => {
  const calls: RepairMessage[][] = [];
  const chat = async (messages: RepairMessage[]) => {
    calls.push(messages);
    return replies[Math.min(calls.length - 1, replies.length - 1)];
  };
  return { chat, calls };
};

const seed: RepairMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'go' },
];

describe('runRepairLoop', () => {
  it('returns the first valid completion with repairRounds 0', async () => {
    const { chat, calls } = scripted(['ok']);
    const res = await runRepairLoop({ chat, messages: seed, validate: wantOk });
    expect(res).toEqual({ value: 'ok', schemaValid: true, repairRounds: 0, errors: [] });
    expect(calls).toHaveLength(1);
    // The seed messages are not mutated by the loop.
    expect(seed).toHaveLength(2);
  });

  it('repairs invalid -> valid and appends the model reply + a domain-phrased repair turn', async () => {
    const { chat, calls } = scripted(['bad', 'ok']);
    const res = await runRepairLoop({ chat, messages: seed, validate: wantOk });
    expect(res.schemaValid).toBe(true);
    expect(res.repairRounds).toBe(1);
    // Second call = seed + assistant('bad') + user(repair carrying the error).
    expect(calls[1]).toHaveLength(4);
    expect(calls[1][2]).toEqual({ role: 'assistant', content: 'bad' });
    expect(calls[1][3].role).toBe('user');
    expect(calls[1][3].content).toContain('is not the word ok');
  });

  it('honors the round bound and reports the last errors on exhaustion', async () => {
    const { chat, calls } = scripted(['bad']); // always invalid
    const res = await runRepairLoop({ chat, messages: seed, validate: wantOk, maxRounds: 3 });
    expect(res.schemaValid).toBe(false);
    expect(res.value).toBeNull();
    expect(res.repairRounds).toBe(3);
    expect(res.errors).toEqual(['response "bad" is not the word ok']);
    // 1 initial + 3 repairs = 4 attempts, no more.
    expect(calls).toHaveLength(4);
  });

  it('defaults to two repair rounds (three attempts)', async () => {
    const { chat, calls } = scripted(['bad']);
    const res = await runRepairLoop({ chat, messages: seed, validate: wantOk });
    expect(res.repairRounds).toBe(2);
    expect(calls).toHaveLength(3);
  });

  it('lets the caller override the repair message', async () => {
    const { chat, calls } = scripted(['bad', 'ok']);
    await runRepairLoop({
      chat,
      messages: seed,
      validate: wantOk,
      buildRepairMessage: (errors) => `RETRY: ${errors.join('; ')}`,
    });
    expect(calls[1][3].content).toBe('RETRY: response "bad" is not the word ok');
  });
});

describe('parseJsonObject', () => {
  it('parses a bare object', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('strips ```json fences and surrounding prose', () => {
    expect(parseJsonObject('Sure:\n```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonObject('answer -> {"a":1} <- done')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('rejects arrays, scalars, and junk with a domain-phrased error', () => {
    expect(parseJsonObject('[1,2]').ok).toBe(false);
    expect(parseJsonObject('42').ok).toBe(false);
    const junk = parseJsonObject('definitely not json');
    expect(junk.ok).toBe(false);
    if (junk.ok) throw new Error('unreachable');
    expect(junk.error).not.toMatch(/SyntaxError|Unexpected token/i);
  });
});

describe('checkShape', () => {
  it('returns [] when the object matches the spec', () => {
    expect(
      checkShape({ summary: 'x', ids: ['a', 'b'] }, { summary: 'string', ids: 'string[]' })
    ).toEqual([]);
  });

  it('returns one domain-phrased error per bad field', () => {
    const errors = checkShape(
      { summary: 3, ids: ['a', 4] },
      { summary: 'string', ids: 'string[]' }
    );
    expect(errors).toEqual(['"summary" must be a string.', '"ids" must be an array of strings.']);
  });
});

describe('defaultRepairMessage', () => {
  it('bullets the domain-phrased errors and asks for corrected JSON only', () => {
    const msg = defaultRepairMessage(['"x" is bad.', '"y" is bad.']);
    expect(msg).toContain('- "x" is bad.');
    expect(msg).toContain('- "y" is bad.');
    expect(msg).toMatch(/ONLY the corrected JSON object/);
  });
});
