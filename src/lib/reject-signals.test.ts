import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * Short-read harness (#3167). `FileHandle.read` may legally return fewer bytes
 * than requested before EOF. This mock caps every read at `shortReadLimit` so
 * that behaviour is reproducible; it is INERT (a straight pass-through) unless a
 * test sets the limit, so every other test in this file exercises the real
 * `node:fs/promises`.
 */
const readCap: { bytes: number | null } = { bytes: null };
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const realRead = handle.read.bind(handle);
      handle.read = (async (
        buf: Buffer,
        offset: number,
        len: number,
        pos: number
      ) =>
        realRead(
          buf,
          offset,
          readCap.bytes === null ? len : Math.min(len, readCap.bytes),
          pos
        )) as typeof handle.read;
      return handle;
    },
  };
});
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sanitizeRejectSignal,
  appendRejectSignal,
  parseRejectSignalLines,
  readRejectSignals,
  REJECT_REASONS,
  REJECT_SIGNAL_MAX_RECORDS,
  REJECT_SIGNAL_READ_MAX_BYTES,
  REJECT_SIGNAL_LINE_MAX_BYTES,
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

/**
 * Read-budget contract (#3167).
 *
 * The log is append-only and never compacted, so its size tracks how long the
 * dashboard has been in use. Before the budget, a read decoded the whole file
 * and retained every record: measured on a 24.7 MiB / 200,000-record log, the
 * old path decoded 25,888,890 bytes, materialized 200,000 line strings at once,
 * and returned 200,000 records. The bounded path decodes at most 1 MiB, holds
 * one line at a time, and returns the newest 5,000.
 */
describe('read budget (#3167)', () => {
  function writeLog(records: number, findingId = (i: number) => `f-${i}`): string {
    const file = tmpFile();
    const lines: string[] = [];
    for (let i = 0; i < records; i++) {
      lines.push(
        JSON.stringify({
          schemaVersion: '1',
          kind: 'REJECT',
          ts: '2026-06-10T00:00:00.000Z',
          findingId: findingId(i),
          reason: 'dismiss',
        })
      );
    }
    writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    return file;
  }

  it('bounds retained records and returns the NEWEST window', async () => {
    const file = writeLog(REJECT_SIGNAL_MAX_RECORDS + 250);
    const signals = await readRejectSignals(file, FIXED);
    expect(signals.length).toBe(REJECT_SIGNAL_MAX_RECORDS);
    // Tail, not head: an append-only log's newest records are the useful ones,
    // so a budget that kept the OLDEST would return exactly the wrong window.
    expect(signals[signals.length - 1].findingId).toBe(
      `f-${REJECT_SIGNAL_MAX_RECORDS + 249}`
    );
    expect(signals[0].findingId).toBe('f-250');
  });

  it('bounds bytes pulled off disk, not just records', async () => {
    const file = writeLog(400);
    // A byte budget far below the file size must window the read itself.
    const windowed = await readRejectSignals(file, FIXED, { maxBytes: 600 });
    expect(windowed.length).toBeGreaterThan(0);
    expect(windowed.length).toBeLessThan(400);
    // Still the tail.
    expect(windowed[windowed.length - 1].findingId).toBe('f-399');
    // And the partial record at the window seam is dropped, never half-parsed.
    for (const s of windowed) expect(s.findingId).toMatch(/^f-\d+$/);
  });

  it('still rejects an individually oversized line inside the window', async () => {
    const file = tmpFile();
    const huge = 'x'.repeat(REJECT_SIGNAL_LINE_MAX_BYTES + 10);
    writeFileSync(
      file,
      [
        JSON.stringify({ findingId: 'ok-1', reason: 'dismiss' }),
        JSON.stringify({ findingId: huge, reason: 'dismiss' }),
        JSON.stringify({ findingId: 'ok-2', reason: 'wrong' }),
      ].join('\n') + '\n',
      'utf8'
    );
    const signals = await readRejectSignals(file, FIXED);
    expect(signals.map((s) => s.findingId)).toEqual(['ok-1', 'ok-2']);
  });

  it('is unchanged for a log inside the budget', async () => {
    const file = writeLog(50);
    const signals = await readRejectSignals(file, FIXED);
    expect(signals.length).toBe(50);
    expect(signals[0].findingId).toBe('f-0');
    expect(signals[49].findingId).toBe('f-49');
  });

  it('parseRejectSignalLines retains only the newest maxRecords', () => {
    const raw = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({ findingId: `p-${i}`, reason: 'dismiss' })
    ).join('\n');
    const bounded = parseRejectSignalLines(raw, FIXED, 5);
    expect(bounded.map((s) => s.findingId)).toEqual([
      'p-15',
      'p-16',
      'p-17',
      'p-18',
      'p-19',
    ]);
  });

  it('a malformed budget restores the default — it never reads unbounded', async () => {
    // `size > NaN` is false, so a NaN budget would read the WHOLE file while
    // still looking enforced. Same fail-open class as #3076/#3452.
    const file = writeLog(REJECT_SIGNAL_MAX_RECORDS + 250);
    for (const bad of [NaN, -1, Infinity]) {
      const signals = await readRejectSignals(file, FIXED, { maxRecords: bad });
      expect(signals.length).toBe(REJECT_SIGNAL_MAX_RECORDS);
    }
    for (const bad of [NaN, -1, Infinity]) {
      const signals = await readRejectSignals(file, FIXED, { maxBytes: bad });
      expect(signals.length).toBeLessThanOrEqual(REJECT_SIGNAL_MAX_RECORDS);
    }
  });

  it('reports when a budget windowed the result', async () => {
    // A windowed read returns a short list that is indistinguishable from a
    // genuinely short log, so a consumer would believe it had every reject.
    const file = writeLog(REJECT_SIGNAL_MAX_RECORDS + 250);
    let info: {
      totalBytes: number;
      bytesRead: number;
      recordsReturned: number;
      recordCapped: boolean;
    } | null = null;
    const signals = await readRejectSignals(file, FIXED, {
      onTruncated: (i) => {
        info = i;
      },
    });
    expect(signals.length).toBe(REJECT_SIGNAL_MAX_RECORDS);
    expect(info).not.toBeNull();
    expect(info!.recordCapped).toBe(true);
    expect(info!.recordsReturned).toBe(REJECT_SIGNAL_MAX_RECORDS);
    expect(info!.totalBytes).toBeGreaterThan(info!.bytesRead - 1);
  });

  it('does NOT report truncation for a log inside the budget', async () => {
    const file = writeLog(25);
    let called = false;
    const signals = await readRejectSignals(file, FIXED, {
      onTruncated: () => {
        called = true;
      },
    });
    expect(signals.length).toBe(25);
    expect(called).toBe(false);
  });

  it('fills the window across SHORT reads without dropping newest records', async () => {
    // Trusting a single `read` parses only the OLDER prefix of the window and
    // silently drops the NEWEST signals — the exact opposite of the tail
    // semantics this function promises. For an under-budget file `start` is 0,
    // so nothing would report the loss and a short result would be
    // indistinguishable from a complete one.
    const file = writeLog(40);
    readCap.bytes = 64;
    try {
      const signals = await readRejectSignals(file, FIXED);
      expect(signals.length).toBe(40);
      expect(signals[0].findingId).toBe('f-0');
      expect(signals[39].findingId).toBe('f-39');
    } finally {
      readCap.bytes = null;
    }
  });

  it('reports an early EOF before the stat-sized window is filled', async () => {
    const file = writeLog(40);
    let info: {
      totalBytes: number;
      bytesRead: number;
      recordsReturned: number;
      recordCapped: boolean;
    } | null = null;
    // A zero-byte read simulates EOF after stat (for example, concurrent
    // truncation). The incomplete result must not look like an empty log.
    readCap.bytes = 0;
    try {
      const signals = await readRejectSignals(file, FIXED, {
        onTruncated: (value) => {
          info = value;
        },
      });
      expect(signals).toEqual([]);
      expect(info).not.toBeNull();
      expect(info!.totalBytes).toBeGreaterThan(0);
      expect(info!.bytesRead).toBe(0);
      expect(info!.recordsReturned).toBe(0);
      expect(info!.recordCapped).toBe(false);
    } finally {
      readCap.bytes = null;
    }
  });

  it('reports a zero-byte window on a non-empty log as truncated', async () => {
    const file = writeLog(1);
    let called = false;
    const signals = await readRejectSignals(file, FIXED, {
      maxBytes: 0,
      onTruncated: ({ totalBytes, bytesRead, recordsReturned }) => {
        called = true;
        expect(totalBytes).toBeGreaterThan(0);
        expect(bytesRead).toBe(0);
        expect(recordsReturned).toBe(0);
      },
    });
    expect(signals).toEqual([]);
    expect(called).toBe(true);
  });

  it('keeps the TAIL window intact across short reads', async () => {
    const file = writeLog(REJECT_SIGNAL_MAX_RECORDS + 100);
    readCap.bytes = 128;
    try {
      const signals = await readRejectSignals(file, FIXED);
      expect(signals.length).toBe(REJECT_SIGNAL_MAX_RECORDS);
      // Newest must survive: a short read that stopped early would end here on
      // an older record instead.
      expect(signals[signals.length - 1].findingId).toBe(
        `f-${REJECT_SIGNAL_MAX_RECORDS + 99}`
      );
    } finally {
      readCap.bytes = null;
    }
  });

  it('declares finite default budgets', () => {
    expect(Number.isFinite(REJECT_SIGNAL_READ_MAX_BYTES)).toBe(true);
    expect(Number.isFinite(REJECT_SIGNAL_MAX_RECORDS)).toBe(true);
    expect(REJECT_SIGNAL_READ_MAX_BYTES).toBeGreaterThan(0);
    expect(REJECT_SIGNAL_MAX_RECORDS).toBeGreaterThan(0);
  });
});
