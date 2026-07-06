import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRejectSignal, type RejectSignal } from './reject-signals';
import {
  GOLD_VERDICTS,
  rejectReasonToGoldVerdict,
  goldVerdictToExpectedIsFinding,
  toJudgeGoldEntry,
  buildJudgeGoldSet,
  serializeJudgeGoldSet,
  exportJudgeGoldSet,
  exportJudgeGoldSetJsonl,
} from './judge-gold-set';

const FIXED = () => new Date('2026-06-10T00:00:00.000Z');
const dirs: string[] = [];
function tmpFile(name = 'reject-signals.jsonl'): string {
  const dir = mkdtempSync(join(tmpdir(), 'gold-set-test-'));
  dirs.push(dir);
  return join(dir, name);
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Build a RejectSignal without going through the writer. */
function sig(findingId: string, reason: RejectSignal['reason'], ts: string): RejectSignal {
  return { schemaVersion: '1', kind: 'REJECT', ts, findingId, reason };
}

describe('rejectReasonToGoldVerdict — validity vs deferral', () => {
  it('maps wrong/not-relevant to reject and dismiss to defer', () => {
    expect(rejectReasonToGoldVerdict('wrong')).toBe('reject');
    expect(rejectReasonToGoldVerdict('not-relevant')).toBe('reject');
    expect(rejectReasonToGoldVerdict('dismiss')).toBe('defer');
  });

  it('only ever emits a verdict in the GOLD_VERDICTS enum', () => {
    for (const reason of ['dismiss', 'wrong', 'not-relevant'] as const) {
      expect(GOLD_VERDICTS).toContain(rejectReasonToGoldVerdict(reason));
    }
  });
});

describe('goldVerdictToExpectedIsFinding — judge-validation mapping', () => {
  it('reject expects isFinding:false; defer is not a validity signal (null)', () => {
    expect(goldVerdictToExpectedIsFinding('reject')).toBe(false);
    expect(goldVerdictToExpectedIsFinding('defer')).toBeNull();
  });
});

describe('toJudgeGoldEntry — {findingId, verdict, reason} shape', () => {
  it('projects a signal into the defined entry shape, reason preserved verbatim', () => {
    expect(toJudgeGoldEntry(sig('cost.cache-1h-waste', 'wrong', '2026-06-01T00:00:00.000Z'))).toEqual({
      findingId: 'cost.cache-1h-waste',
      verdict: 'reject',
      reason: 'wrong',
    });
    expect(toJudgeGoldEntry(sig('a.b', 'dismiss', '2026-06-01T00:00:00.000Z'))).toEqual({
      findingId: 'a.b',
      verdict: 'defer',
      reason: 'dismiss',
    });
  });
});

describe('buildJudgeGoldSet — dedup latest-wins + deterministic order', () => {
  it('returns [] for an empty store (empty in ⇒ empty out)', () => {
    expect(buildJudgeGoldSet([])).toEqual([]);
  });

  it('keeps one entry per findingId, latest validity rejection wins', () => {
    const gold = buildJudgeGoldSet([
      sig('x', 'dismiss', '2026-06-01T00:00:00.000Z'),
      sig('x', 'wrong', '2026-06-05T00:00:00.000Z'), // latest validity rejection → wins
      sig('x', 'not-relevant', '2026-06-03T00:00:00.000Z'),
    ]);
    expect(gold).toEqual([{ findingId: 'x', verdict: 'reject', reason: 'wrong' }]);
  });

  it('a later dismiss does NOT erase an earlier hard validity rejection', () => {
    // A `dismiss` ("not now") is orthogonal to `wrong`/`not-relevant` ("the claim
    // is false"); it must not overwrite the hard ground truth the gold set holds.
    const gold = buildJudgeGoldSet([
      sig('x', 'wrong', '2026-06-01T00:00:00.000Z'), // hard validity rejection
      sig('x', 'dismiss', '2026-06-09T00:00:00.000Z'), // later deferral — must not win
    ]);
    expect(gold).toEqual([{ findingId: 'x', verdict: 'reject', reason: 'wrong' }]);
  });

  it('falls back to the latest dismiss only when every signal is a deferral', () => {
    const gold = buildJudgeGoldSet([
      sig('x', 'dismiss', '2026-06-01T00:00:00.000Z'),
      sig('x', 'dismiss', '2026-06-05T00:00:00.000Z'), // later dismiss → wins within defer class
    ]);
    expect(gold).toEqual([{ findingId: 'x', verdict: 'defer', reason: 'dismiss' }]);
  });

  it('on an equal-timestamp tie within a class, the last signal in input order wins', () => {
    // ISO timestamps can collide (two rejections in the same millisecond); for an
    // append-only log the deterministic tie-break is last-in-file. Pin it so a
    // future >= → > refactor cannot silently reverse the invariant.
    const gold = buildJudgeGoldSet([
      sig('x', 'wrong', '2026-06-01T00:00:00.000Z'),
      sig('x', 'not-relevant', '2026-06-01T00:00:00.000Z'), // same ts, later in input → wins
    ]);
    expect(gold).toEqual([{ findingId: 'x', verdict: 'reject', reason: 'not-relevant' }]);
  });

  it('sorts entries by findingId regardless of input order', () => {
    const gold = buildJudgeGoldSet([
      sig('c.z', 'wrong', '2026-06-01T00:00:00.000Z'),
      sig('a.a', 'dismiss', '2026-06-01T00:00:00.000Z'),
      sig('b.m', 'not-relevant', '2026-06-01T00:00:00.000Z'),
    ]);
    expect(gold.map((e) => e.findingId)).toEqual(['a.a', 'b.m', 'c.z']);
  });
});

describe('serializeJudgeGoldSet — JSONL text', () => {
  it('emits one JSON object per line with a trailing newline', () => {
    const text = serializeJudgeGoldSet([
      { findingId: 'a', verdict: 'reject', reason: 'wrong' },
      { findingId: 'b', verdict: 'defer', reason: 'dismiss' },
    ]);
    expect(text).toBe(
      '{"findingId":"a","verdict":"reject","reason":"wrong"}\n' +
        '{"findingId":"b","verdict":"defer","reason":"dismiss"}\n'
    );
    // Every non-blank line parses back to an entry with the three defined keys.
    for (const line of text.trim().split('\n')) {
      expect(Object.keys(JSON.parse(line)).sort()).toEqual(['findingId', 'reason', 'verdict']);
    }
  });

  it('serializes an empty set to the empty string, not a bare newline', () => {
    expect(serializeJudgeGoldSet([])).toBe('');
  });
});

describe('export from the reject-signal log', () => {
  it('reads the log, dedups, and serializes JSONL', async () => {
    const file = tmpFile();
    await appendRejectSignal(file, { findingId: 'z.late', reason: 'dismiss' }, { now: FIXED });
    await appendRejectSignal(file, { findingId: 'a.wrong', reason: 'wrong' }, { now: FIXED });

    expect(await exportJudgeGoldSet(file)).toEqual([
      { findingId: 'a.wrong', verdict: 'reject', reason: 'wrong' },
      { findingId: 'z.late', verdict: 'defer', reason: 'dismiss' },
    ]);
    expect(await exportJudgeGoldSetJsonl(file)).toBe(
      '{"findingId":"a.wrong","verdict":"reject","reason":"wrong"}\n' +
        '{"findingId":"z.late","verdict":"defer","reason":"dismiss"}\n'
    );
  });

  it('empty-store handling: a missing log exports [] and an empty JSONL string', async () => {
    const missing = join(tmpdir(), 'no-such-reject-log-2207.jsonl');
    expect(await exportJudgeGoldSet(missing)).toEqual([]);
    expect(await exportJudgeGoldSetJsonl(missing)).toBe('');
  });
});
