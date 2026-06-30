import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sanitizeRejectSignal,
  appendRejectSignal,
  parseRejectSignalLines,
  readRejectSignals,
  REJECT_REASONS,
} from './reject-signals';

const FIXED = () => new Date('2026-06-10T00:00:00.000Z');
const dirs: string[] = [];
function tmpFile(name = 'reject-signals.jsonl'): string {
  const dir = mkdtempSync(join(tmpdir(), 'reject-test-'));
  dirs.push(dir);
  return join(dir, name);
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('sanitizeRejectSignal — fail-closed allowlist', () => {
  it('normalizes a valid signal and stamps schemaVersion/kind/ts', () => {
    const rec = sanitizeRejectSignal({ findingId: 'cost.cache-1h-waste', reason: 'wrong' }, FIXED);
    expect(rec).toEqual({
      schemaVersion: '1',
      kind: 'REJECT',
      ts: '2026-06-10T00:00:00.000Z',
      findingId: 'cost.cache-1h-waste',
      reason: 'wrong',
    });
  });

  it('accepts every reason in the enum', () => {
    for (const reason of REJECT_REASONS) {
      expect(sanitizeRejectSignal({ findingId: 'x', reason }, FIXED)?.reason).toBe(reason);
    }
  });

  it('rejects an unknown reason', () => {
    expect(sanitizeRejectSignal({ findingId: 'x', reason: 'because' }, FIXED)).toBeNull();
    expect(sanitizeRejectSignal({ findingId: 'x', reason: '' }, FIXED)).toBeNull();
  });

  it('rejects a missing / empty / oversized findingId', () => {
    expect(sanitizeRejectSignal({ reason: 'dismiss' }, FIXED)).toBeNull();
    expect(sanitizeRejectSignal({ findingId: '  ', reason: 'dismiss' }, FIXED)).toBeNull();
    expect(sanitizeRejectSignal({ findingId: 'a'.repeat(161), reason: 'dismiss' }, FIXED)).toBeNull();
  });

  it('rejects non-object / array / null bodies', () => {
    expect(sanitizeRejectSignal(null, FIXED)).toBeNull();
    expect(sanitizeRejectSignal('x', FIXED)).toBeNull();
    expect(sanitizeRejectSignal([{ findingId: 'x', reason: 'dismiss' }], FIXED)).toBeNull();
  });

  it('drops non-allowlisted fields (kind/schemaVersion are server-stamped, not trusted from input)', () => {
    const rec = sanitizeRejectSignal(
      { findingId: 'x', reason: 'dismiss', kind: 'EVIL', extra: 1, ts: 'nonsense' },
      FIXED
    );
    expect(rec).toEqual({
      schemaVersion: '1',
      kind: 'REJECT',
      ts: '2026-06-10T00:00:00.000Z', // bad ts falls back to now()
      findingId: 'x',
      reason: 'dismiss',
    });
  });

  it('preserves a valid client-supplied ts', () => {
    const rec = sanitizeRejectSignal(
      { findingId: 'x', reason: 'dismiss', ts: '2026-01-02T03:04:05.000Z' },
      FIXED
    );
    expect(rec?.ts).toBe('2026-01-02T03:04:05.000Z');
  });
});

describe('appendRejectSignal — write path', () => {
  it('appends a sanitized record as one JSON line and creates the dir', async () => {
    const file = tmpFile();
    const result = await appendRejectSignal(file, { findingId: 'a.b', reason: 'not-relevant' }, { now: FIXED });
    expect(result.ok).toBe(true);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ kind: 'REJECT', findingId: 'a.b', reason: 'not-relevant' });
  });

  it('appends successive signals without clobbering', async () => {
    const file = tmpFile();
    await appendRejectSignal(file, { findingId: 'a', reason: 'dismiss' }, { now: FIXED });
    await appendRejectSignal(file, { findingId: 'b', reason: 'wrong' }, { now: FIXED });
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('returns a 400 and writes nothing for an invalid body', async () => {
    const file = tmpFile();
    const result = await appendRejectSignal(file, { findingId: 'a', reason: 'nope' }, { now: FIXED });
    expect(result).toMatchObject({ ok: false, status: 400 });
    let threw = false;
    try {
      readFileSync(file, 'utf8');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true); // file never created
  });
});

describe('read path — sanitize again, drop junk', () => {
  it('parses good lines and drops blank/unparseable/non-allowlisted ones', () => {
    const raw = [
      JSON.stringify({ findingId: 'a', reason: 'dismiss' }),
      '',
      '{ not json',
      JSON.stringify({ findingId: 'b', reason: 'unknown' }), // bad reason → dropped
      JSON.stringify({ findingId: 'c', reason: 'wrong' }),
    ].join('\n');
    const signals = parseRejectSignalLines(raw, FIXED);
    expect(signals.map((s) => s.findingId)).toEqual(['a', 'c']);
  });

  it('reads from a file and returns [] for a missing file', async () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({ findingId: 'z', reason: 'dismiss' }) + '\n');
    expect((await readRejectSignals(file, FIXED)).map((s) => s.findingId)).toEqual(['z']);
    expect(await readRejectSignals(join(tmpdir(), 'does-not-exist-reject.jsonl'), FIXED)).toEqual([]);
  });
});
