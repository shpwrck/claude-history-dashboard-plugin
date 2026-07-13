import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendCheckpointAnswer,
  CHECKPOINT_ANSWER_FUTURE_CLOCK_SKEW_MS,
  CHECKPOINT_ANSWER_READ_MAX_BYTES,
  CHECKPOINT_ANSWER_MAX_DURATION_MS,
  CHECKPOINT_ANSWER_REVERSE_CLOCK_SKEW_MS,
  parseCheckpointAnswerLines,
  readCheckpointAnswerIndex,
  readCheckpointAnswerEfficacy,
  sanitizeCheckpointAnswer,
} from './checkpoint-answer-store';
import { buildCheckpointAnswerRecord, withLateCorrection } from './checkpoint-instrumentation';
import type { DocNeighborhood } from './doc-neighborhood';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function neighborhood(): DocNeighborhood {
  return {
    anchor: { kind: 'doc', slug: 'AGENTS' },
    seeds: ['AGENTS'],
    nodes: [{
      slug: 'AGENTS',
      path: 'AGENTS.md',
      category: 'root',
      distance: 0,
      relevance: 1,
      gitMtimeIso: null,
      hygiene: { danglingLinks: [], stale: false, contradictory: false },
    }],
    ambiguityTrigger: false,
    ambiguitySources: [],
  };
}

function record(id: string, elapsedMs: number, lateCorrection: boolean | null = null) {
  return buildCheckpointAnswerRecord({
    checkpointId: id,
    shownAt: 1_000,
    answeredAt: 1_000 + elapsedMs,
    answer: 'worktrees',
    neighborhood: neighborhood(),
    lateCorrection,
  })!;
}

describe('checkpoint answer store (#2519)', () => {
  it('sanitizes allowlisted fields and recomputes elapsed time', () => {
    const sanitized = sanitizeCheckpointAnswer({
      ...record(' cp-1 ', 5_000),
      elapsedMs: 999_999,
      secret: 'drop me',
      provenance: { ...record('x', 1).provenance, extra: 'drop me' },
    });
    expect(sanitized).toEqual(record('cp-1', 5_000));
    expect(sanitized).not.toHaveProperty('secret');
    expect(sanitized?.provenance).not.toHaveProperty('extra');
  });

  it('fails closed on malformed records and provenance', () => {
    expect(sanitizeCheckpointAnswer({})).toBeNull();
    expect(sanitizeCheckpointAnswer({ ...record('cp', 1), answeredAtIso: 'bad' })).toBeNull();
    expect(sanitizeCheckpointAnswer({
      ...record('cp', 1),
      provenance: {
        ...record('cp', 1).provenance,
        demotedSlugs: ['not-shown'],
      },
    })).toBeNull();
  });

  it('accepts canonical historical timestamps and exact clock/duration boundaries', () => {
    const nowMs = Date.parse('2026-07-13T12:00:00.000Z');
    const base = record('cp', 1_000);
    const cases = [
      {
        label: 'historical',
        shownMs: Date.parse('1900-01-01T00:00:00.000Z'),
        answeredMs: Date.parse('1900-01-01T00:00:05.000Z'),
        elapsedMs: 5_000,
      },
      {
        label: 'historical leap day',
        shownMs: Date.parse('2024-02-29T23:59:58.000Z'),
        answeredMs: Date.parse('2024-02-29T23:59:59.000Z'),
        elapsedMs: 1_000,
      },
      {
        label: 'future allowance boundary',
        shownMs: nowMs + CHECKPOINT_ANSWER_FUTURE_CLOCK_SKEW_MS,
        answeredMs: nowMs + CHECKPOINT_ANSWER_FUTURE_CLOCK_SKEW_MS,
        elapsedMs: 0,
      },
      {
        label: 'reverse allowance boundary',
        shownMs: Date.parse('2026-07-12T00:00:00.000Z'),
        answeredMs:
          Date.parse('2026-07-12T00:00:00.000Z')
          - CHECKPOINT_ANSWER_REVERSE_CLOCK_SKEW_MS,
        elapsedMs: 0,
      },
      {
        label: 'maximum duration boundary',
        shownMs: Date.parse('2026-07-10T00:00:00.000Z'),
        answeredMs:
          Date.parse('2026-07-10T00:00:00.000Z')
          + CHECKPOINT_ANSWER_MAX_DURATION_MS,
        elapsedMs: CHECKPOINT_ANSWER_MAX_DURATION_MS,
      },
    ];

    for (const item of cases) {
      const sanitized = sanitizeCheckpointAnswer({
        ...base,
        checkpointId: item.label,
        shownAtIso: new Date(item.shownMs).toISOString(),
        answeredAtIso: new Date(item.answeredMs).toISOString(),
        elapsedMs: 999_999,
      }, nowMs);
      expect(sanitized, item.label).not.toBeNull();
      expect(sanitized?.elapsedMs, item.label).toBe(item.elapsedMs);
    }
  });

  it('accepts canonical UTC rows produced from valid offset builder input', () => {
    const built = buildCheckpointAnswerRecord({
      checkpointId: 'offset-input',
      shownAt: '2024-02-29T23:59:55+01:00',
      answeredAt: '2024-02-29T23:59:59.123+01:00',
      answer: 'worktrees',
      neighborhood: neighborhood(),
    });
    expect(built).not.toBeNull();
    expect(sanitizeCheckpointAnswer(
      built,
      Date.parse('2026-07-13T12:00:00.000Z')
    )).toEqual(built);
  });

  it('rejects non-canonical, impossible, future, reversed, and overlong timestamps', () => {
    const nowMs = Date.parse('2026-07-13T12:00:00.000Z');
    const base = record('cp', 1_000);
    const shownMs = Date.parse('2026-07-10T00:00:00.000Z');
    const cases = [
      {
        label: 'locale',
        shownAtIso: '07/13/2026 12:00:00',
        answeredAtIso: '07/13/2026 12:00:05',
      },
      {
        label: 'normalized impossible date',
        shownAtIso: '2026-02-30T00:00:00.000Z',
        answeredAtIso: '2026-03-02T00:00:05.000Z',
      },
      {
        label: 'non-leap Feb 29',
        shownAtIso: '2026-02-29T00:00:00.000Z',
        answeredAtIso: '2026-03-01T00:00:05.000Z',
      },
      {
        label: 'extended year',
        shownAtIso: '+002026-07-13T12:00:00.000Z',
        answeredAtIso: '+002026-07-13T12:00:05.000Z',
      },
      {
        label: 'offset instead of exact builder UTC form',
        shownAtIso: '2026-07-13T08:00:00.000-04:00',
        answeredAtIso: '2026-07-13T08:00:05.000-04:00',
      },
      {
        label: 'date only',
        shownAtIso: '2026-07-13',
        answeredAtIso: '2026-07-13',
      },
      {
        label: 'missing zone',
        shownAtIso: '2026-07-13T12:00:00.000',
        answeredAtIso: '2026-07-13T12:00:05.000',
      },
      {
        label: 'surrounding whitespace',
        shownAtIso: ' 2026-07-13T12:00:00.000Z ',
        answeredAtIso: ' 2026-07-13T12:00:05.000Z ',
      },
      {
        label: 'normalized 24 hour',
        shownAtIso: '2026-07-13T24:00:00.000Z',
        answeredAtIso: '2026-07-14T00:00:05.000Z',
      },
      {
        label: 'leap second',
        shownAtIso: '2026-07-13T23:59:60.000Z',
        answeredAtIso: '2026-07-14T00:00:05.000Z',
      },
      {
        label: 'sub-millisecond precision',
        shownAtIso: '2026-07-13T12:00:00.0000Z',
        answeredAtIso: '2026-07-13T12:00:05.0000Z',
      },
      {
        label: 'future beyond allowance',
        shownAtIso: new Date(
          nowMs + CHECKPOINT_ANSWER_FUTURE_CLOCK_SKEW_MS + 1
        ).toISOString(),
        answeredAtIso: new Date(
          nowMs + CHECKPOINT_ANSWER_FUTURE_CLOCK_SKEW_MS + 1
        ).toISOString(),
      },
      {
        label: 'reverse beyond allowance',
        shownAtIso: new Date(shownMs).toISOString(),
        answeredAtIso: new Date(
          shownMs - CHECKPOINT_ANSWER_REVERSE_CLOCK_SKEW_MS - 1
        ).toISOString(),
      },
      {
        label: 'duration beyond allowance',
        shownAtIso: new Date(shownMs).toISOString(),
        answeredAtIso: new Date(
          shownMs + CHECKPOINT_ANSWER_MAX_DURATION_MS + 1
        ).toISOString(),
      },
    ];

    for (const item of cases) {
      expect(sanitizeCheckpointAnswer({
        ...base,
        checkpointId: item.label,
        shownAtIso: item.shownAtIso,
        answeredAtIso: item.answeredAtIso,
      }, nowMs), item.label).toBeNull();
    }
  });

  it('appends sanitized JSONL and rejects invalid input without writing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkpoint-store-'));
    dirs.push(dir);
    const file = join(dir, 'nested', 'answers.jsonl');
    expect(await appendCheckpointAnswer(file, { nope: true })).toMatchObject({
      ok: false,
      status: 400,
    });
    const result = await appendCheckpointAnswer(file, { ...record('cp', 4_000), extra: 'drop' });
    expect(result).toMatchObject({ ok: true, written: true });
    const parsed = parseCheckpointAnswerLines(await readFile(file, 'utf8'));
    expect(parsed.skipped).toBe(0);
    expect(parsed.records).toEqual([record('cp', 4_000)]);
  });

  it('deduplicates correction updates and aggregates median + resolved rate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkpoint-index-'));
    dirs.push(dir);
    const file = join(dir, 'answers.jsonl');
    const first = record('cp-1', 1_000);
    const corrected = withLateCorrection(first, true);
    const noCorrection = record('cp-2', 3_000, false);
    const unresolved = record('cp-3', 9_000);
    await writeFile(file, [
      JSON.stringify(first),
      JSON.stringify(corrected),
      '{bad json',
      JSON.stringify(noCorrection),
      JSON.stringify(unresolved),
      '',
    ].join('\n'));

    const index = await readCheckpointAnswerIndex(file);
    expect(index.recordCount).toBe(4);
    expect(index.skipped).toBe(1);
    expect(index.records).toHaveLength(3);
    expect(index.records.find((item) => item.checkpointId === 'cp-1')?.lateCorrection).toBe(true);
    expect(index.summary).toEqual({
      answerCount: 3,
      medianElapsedMs: 3_000,
      resolvedLateCorrectionRate: 0.5,
      observedLateCorrectionRateLowerBound: 1 / 3,
      correctedCount: 1,
      resolvedCorrectionCount: 2,
      unresolvedCorrectionCount: 1,
    });
    expect(index.records[0].provenance.source).toBe('doc-neighborhood');
  });

  it('preserves the first immutable payload while folding correction state monotonically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkpoint-immutable-'));
    dirs.push(dir);
    const file = join(dir, 'answers.jsonl');
    const first = record('cp', 1_000);
    const rewrite = {
      ...first,
      answeredAtIso: new Date(9_000).toISOString(),
      elapsedMs: 8_000,
      answer: 'rewritten answer',
      lateCorrection: true,
      provenance: {
        source: 'doc-neighborhood' as const,
        anchor: { kind: 'file' as const, path: 'OTHER.md' },
        shownSlugs: ['OTHER'],
        ambiguityTrigger: true,
        demotedSlugs: ['OTHER'],
      },
    };
    await writeFile(file, `${JSON.stringify(first)}\n${JSON.stringify(rewrite)}\n`);

    const index = await readCheckpointAnswerIndex(file);
    expect(index.records).toEqual([{ ...first, lateCorrection: true }]);
    expect(index.summary.medianElapsedMs).toBe(1_000);

    const efficacy = await readCheckpointAnswerEfficacy(file);
    expect(efficacy.cohorts.ambiguityClear.answerCount).toBe(1);
    expect(efficacy.cohorts.ambiguityTriggered.answerCount).toBe(0);
    expect(efficacy.window.endedAtIso).toBe(first.answeredAtIso);
    expect(efficacy.provenance.samples[0].provenance).toEqual(first.provenance);
  });

  it('skips timestamp poison without moving aggregate median or window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkpoint-timestamp-poison-'));
    dirs.push(dir);
    const file = join(dir, 'answers.jsonl');
    const nowMs = Date.parse('2026-07-13T12:00:00.000Z');
    const base = record('base', 1_000);
    const valid = {
      ...base,
      checkpointId: 'valid-historical',
      shownAtIso: '1900-01-01T00:00:00.000Z',
      answeredAtIso: '1900-01-01T00:00:05.000Z',
      elapsedMs: 5_000,
    };
    const poison = [
      {
        ...base,
        checkpointId: 'feb-30',
        shownAtIso: '2026-02-30T00:00:00.000Z',
        answeredAtIso: '2026-03-02T00:00:05.000Z',
      },
      {
        ...base,
        checkpointId: 'locale',
        shownAtIso: '07/13/2026 12:00:00',
        answeredAtIso: '07/13/2026 12:00:05',
      },
      {
        ...base,
        checkpointId: 'future-2099',
        shownAtIso: '2099-01-01T00:00:00.000Z',
        answeredAtIso: '2099-01-01T00:00:05.000Z',
      },
      {
        ...base,
        checkpointId: 'huge-reverse',
        shownAtIso: '2026-07-10T00:00:00.000Z',
        answeredAtIso: '2000-07-10T00:00:00.000Z',
      },
      {
        ...base,
        checkpointId: 'huge-duration',
        shownAtIso: '1900-01-01T00:00:00.000Z',
        answeredAtIso: '2026-07-10T00:00:00.000Z',
      },
    ];
    await writeFile(file, `${[valid, ...poison].map(JSON.stringify).join('\n')}\n`);

    const efficacy = await readCheckpointAnswerEfficacy(file, { nowMs });
    expect(efficacy.summary.answerCount).toBe(1);
    expect(efficacy.summary.medianElapsedMs).toBe(5_000);
    expect(efficacy.window).toEqual({
      startedAtIso: valid.shownAtIso,
      endedAtIso: valid.answeredAtIso,
    });
    expect(efficacy.provenance).toMatchObject({
      recordsRead: 1,
      recordsSkipped: poison.length,
      logicalAnswers: 1,
    });
    expect(efficacy.provenance.samples.map((sample) => sample.checkpointId)).toEqual([
      'valid-historical',
    ]);
  });

  it('returns an empty aggregate for a missing log', async () => {
    const index = await readCheckpointAnswerIndex('/definitely/missing/checkpoint-answers.jsonl');
    expect(index.records).toEqual([]);
    expect(index.summary.medianElapsedMs).toBeNull();
    expect(index.summary.resolvedLateCorrectionRate).toBeNull();
    expect(index.summary.observedLateCorrectionRateLowerBound).toBeNull();
  });

  it('propagates non-ENOENT metadata errors instead of returning an empty index', async () => {
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    await expect(readCheckpointAnswerIndex('/not-readable/checkpoint-answers.jsonl', {
      openSnapshot: async () => { throw denied; },
    })).rejects.toBe(denied);
  });

  it('propagates an injected midstream read failure instead of erasing partial evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkpoint-midstream-'));
    dirs.push(dir);
    const file = join(dir, 'answers.jsonl');
    const row = `${JSON.stringify(record('cp', 1_000))}\n`;
    await writeFile(file, row);
    const failure = Object.assign(new Error('device failed during read'), { code: 'EIO' });
    async function* failingStream() {
      yield row;
      throw failure;
    }

    await expect(readCheckpointAnswerIndex(file, {
      openSnapshot: async () => ({
        size: Buffer.byteLength(row),
        createStream: () => failingStream(),
        close: async () => undefined,
      }),
    })).rejects.toBe(failure);
  });

  it('rejects a short snapshot read instead of returning partial evidence', async () => {
    const row = `${JSON.stringify(record('cp', 1_000))}\n`;
    async function* shortStream() {
      yield row;
    }

    await expect(readCheckpointAnswerIndex('/injected/short-snapshot.jsonl', {
      openSnapshot: async () => ({
        size: Buffer.byteLength(row) + 1,
        createStream: () => shortStream(),
        close: async () => undefined,
      }),
    })).rejects.toMatchObject({
      code: 'CHECKPOINT_ANSWER_SNAPSHOT_INCOMPLETE',
      expectedBytes: Buffer.byteLength(row) + 1,
      bytesRead: Buffer.byteLength(row),
    });
  });

  it('fails closed before reading a realistic log beyond the production byte budget', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkpoint-byte-bound-'));
    dirs.push(dir);
    const file = join(dir, 'answers.jsonl');
    await writeFile(file, '');
    await truncate(file, CHECKPOINT_ANSWER_READ_MAX_BYTES + 1);

    await expect(readCheckpointAnswerIndex(file)).rejects.toMatchObject({
      code: 'CHECKPOINT_ANSWER_READ_BUDGET_EXCEEDED',
      provenance: {
        complete: false,
        truncated: true,
        reason: 'max-bytes',
        limit: CHECKPOINT_ANSWER_READ_MAX_BYTES,
        observed: CHECKPOINT_ANSWER_READ_MAX_BYTES + 1,
      },
    });
  });

  it('bounds physical rows even when duplicates keep the logical map small', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkpoint-row-bound-'));
    dirs.push(dir);
    const file = join(dir, 'answers.jsonl');
    const row = JSON.stringify(record('cp', 1_000));
    await writeFile(file, `${row}\n${row}\n${row}\n`);

    await expect(readCheckpointAnswerIndex(file, {
      limits: { maxRows: 2 },
    })).rejects.toMatchObject({
      code: 'CHECKPOINT_ANSWER_READ_BUDGET_EXCEEDED',
      provenance: {
        reason: 'max-rows',
        limit: 2,
        observed: 3,
        logicalAnswers: 1,
      },
    });
  });

  it('bounds unique logical answers before the aggregate map can grow without limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkpoint-logical-bound-'));
    dirs.push(dir);
    const file = join(dir, 'answers.jsonl');
    await writeFile(file, [
      JSON.stringify(record('cp-1', 1_000)),
      JSON.stringify(record('cp-2', 2_000)),
      JSON.stringify(record('cp-3', 3_000)),
      '',
    ].join('\n'));

    await expect(readCheckpointAnswerIndex(file, {
      limits: { maxLogicalAnswers: 2 },
    })).rejects.toMatchObject({
      code: 'CHECKPOINT_ANSWER_READ_BUDGET_EXCEEDED',
      provenance: {
        reason: 'max-logical-answers',
        limit: 2,
        observed: 3,
        logicalAnswers: 2,
      },
    });
  });

  it('separates ambiguity cohorts and bounds retained provenance samples', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkpoint-efficacy-'));
    dirs.push(dir);
    const file = join(dir, 'answers.jsonl');
    const rows = Array.from({ length: 25 }, (_, index) => {
      const base = record(`cp-${index}`, index + 1, index % 3 === 0 ? true : false);
      return JSON.stringify({
        ...base,
        provenance: {
          ...base.provenance,
          ambiguityTrigger: index % 2 === 0,
        },
      });
    });
    await writeFile(file, `${rows.join('\n')}\n`);

    const efficacy = await readCheckpointAnswerEfficacy(file);
    expect(efficacy.kind).toBe('CHECKPOINT_ANSWER_EFFICACY');
    expect(efficacy.summary.answerCount).toBe(25);
    expect(efficacy.cohorts.ambiguityTriggered.answerCount).toBe(13);
    expect(efficacy.cohorts.ambiguityClear.answerCount).toBe(12);
    expect(efficacy.provenance).toMatchObject({
      source: 'checkpoint-answer-log',
      complete: true,
      truncated: false,
      recordsRead: 25,
      recordsSkipped: 0,
      logicalAnswers: 25,
    });
    expect(efficacy.provenance.samples).toHaveLength(20);
    expect(efficacy.provenance.samples[0].provenance.source).toBe('doc-neighborhood');
    expect(efficacy.window.startedAtIso).toBe(new Date(1_000).toISOString());
  });

  it('never lets a stale initial retry erase a recorded correction', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkpoint-monotonic-'));
    dirs.push(dir);
    const file = join(dir, 'answers.jsonl');
    const initial = record('cp', 1_000);
    await writeFile(file, [
      JSON.stringify(initial),
      JSON.stringify(withLateCorrection(initial, true)),
      JSON.stringify(initial),
      '',
    ].join('\n'));
    const index = await readCheckpointAnswerIndex(file);
    expect(index.records).toHaveLength(1);
    expect(index.records[0].lateCorrection).toBe(true);
    expect(index.summary.resolvedLateCorrectionRate).toBe(1);
    expect(index.summary.observedLateCorrectionRateLowerBound).toBe(1);
  });
});
