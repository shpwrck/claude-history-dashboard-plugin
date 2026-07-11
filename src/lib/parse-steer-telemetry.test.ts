import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sanitizeSteerRecord,
  parseSteerTelemetryLines,
  aggregateSteerTelemetry,
  readSteerTelemetry,
} from './parse-steer-telemetry';

const dirs: string[] = [];
function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'steer-test-'));
  dirs.push(dir);
  const file = join(dir, '.pretooluse-steer.jsonl');
  writeFileSync(file, content);
  return file;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const delivered = (ruleId: string, ts: string, kind = 'steer') =>
  JSON.stringify({ event: 'delivered', ruleId, kind, accepted: null, declined: null, ts });
const outcome = (ruleId: string, event: 'accepted' | 'declined', ts: string) =>
  JSON.stringify({ event, ruleId, kind: 'steer', ts });

describe('sanitizeSteerRecord — fail-closed', () => {
  it('keeps a well-formed delivery line', () => {
    const r = sanitizeSteerRecord({ event: 'delivered', ruleId: 'read-streak', kind: 'steer', ts: '2026-06-10T00:00:00Z', tool: 'Read' });
    expect(r).toEqual({ ts: '2026-06-10T00:00:00.000Z', event: 'delivered', ruleId: 'read-streak', kind: 'steer' });
  });

  it('reads an optional misfireTag only when it is in the taxonomy', () => {
    expect(sanitizeSteerRecord({ event: 'declined', ruleId: 'r', ts: '2026-06-10T00:00:00Z', misfireTag: 'wrong-scale' })?.misfireTag).toBe('wrong-scale');
    expect(sanitizeSteerRecord({ event: 'declined', ruleId: 'r', ts: '2026-06-10T00:00:00Z', misfireTag: 'bogus' })?.misfireTag).toBeUndefined();
  });

  it('drops lines with an unknown event, missing ruleId, or bad ts', () => {
    expect(sanitizeSteerRecord({ event: 'weird', ruleId: 'r', ts: '2026-06-10T00:00:00Z' })).toBeNull();
    expect(sanitizeSteerRecord({ event: 'delivered', ts: '2026-06-10T00:00:00Z' })).toBeNull();
    expect(sanitizeSteerRecord({ event: 'delivered', ruleId: 'r', ts: 'not-a-date' })).toBeNull();
    expect(sanitizeSteerRecord(null)).toBeNull();
    expect(sanitizeSteerRecord([{ event: 'delivered', ruleId: 'r', ts: '2026-06-10T00:00:00Z' }])).toBeNull();
  });

  it('defaults a missing kind to steer', () => {
    expect(sanitizeSteerRecord({ event: 'delivered', ruleId: 'r', ts: '2026-06-10T00:00:00Z' })?.kind).toBe('steer');
  });
});

describe('parseSteerTelemetryLines — drops junk', () => {
  it('skips blank and unparseable lines, keeps valid ones', () => {
    const raw = [
      delivered('read-streak', '2026-06-10T00:00:00Z'),
      '',
      '{ not json',
      JSON.stringify({ event: 'nope', ruleId: 'x', ts: '2026-06-10T00:00:00Z' }),
      outcome('read-streak', 'accepted', '2026-06-10T00:01:00Z'),
    ].join('\n');
    const records = parseSteerTelemetryLines(raw);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.event)).toEqual(['delivered', 'accepted']);
  });
});

describe('aggregateSteerTelemetry — counts + tags + sort', () => {
  it('rolls up fire-count and accepted/declined per rule', () => {
    const records = parseSteerTelemetryLines(
      [
        delivered('read-streak', '2026-06-10T00:00:00Z'),
        delivered('read-streak', '2026-06-10T00:02:00Z'),
        outcome('read-streak', 'accepted', '2026-06-10T00:01:00Z'),
        outcome('read-streak', 'declined', '2026-06-10T00:03:00Z'),
        delivered('npm-global', '2026-06-10T00:04:00Z'),
      ].join('\n')
    );
    const agg = aggregateSteerTelemetry(records);
    const readStreak = agg.find((r) => r.ruleId === 'read-streak')!;
    expect(readStreak.fireCount).toBe(2);
    expect(readStreak.acceptedCount).toBe(1);
    expect(readStreak.declinedCount).toBe(1);
    expect(readStreak.lastTs).toBe('2026-06-10T00:03:00.000Z');
    // Busiest rule (most fires) leads.
    expect(agg[0].ruleId).toBe('read-streak');
  });

  it('collects distinct misfire tags per rule', () => {
    const records = parseSteerTelemetryLines(
      [
        JSON.stringify({ event: 'declined', ruleId: 'r', ts: '2026-06-10T00:00:00Z', misfireTag: 'wrong-scale' }),
        JSON.stringify({ event: 'declined', ruleId: 'r', ts: '2026-06-10T00:01:00Z', misfireTag: 'wrong-scale' }),
        JSON.stringify({ event: 'declined', ruleId: 'r', ts: '2026-06-10T00:02:00Z', misfireTag: 'gap' }),
      ].join('\n')
    );
    expect(aggregateSteerTelemetry(records)[0].misfireTags).toEqual(['gap', 'wrong-scale']);
  });

  it('returns an empty rollup for no records', () => {
    expect(aggregateSteerTelemetry([])).toEqual([]);
  });
});

describe('aggregateSteerTelemetry — misfire analytics (#2490)', () => {
  const tagged = (ruleId: string, tag: string, ts: string) =>
    JSON.stringify({ event: 'declined', ruleId, ts, misfireTag: tag });

  it('counts per-tag misfires ordered by count desc then tag asc', () => {
    const records = parseSteerTelemetryLines(
      [
        tagged('r', 'wrong-scale', '2026-06-10T00:00:00Z'),
        tagged('r', 'wrong-scale', '2026-06-10T00:01:00Z'),
        tagged('r', 'wrong-scale', '2026-06-10T00:02:00Z'),
        tagged('r', 'gap', '2026-06-10T00:03:00Z'),
        tagged('r', 'wrong-prescription', '2026-06-10T00:04:00Z'),
      ].join('\n')
    );
    const rule = aggregateSteerTelemetry(records)[0];
    expect(rule.misfireTagCounts).toEqual([
      { tag: 'wrong-scale', count: 3 },
      // ties (count 1) break by tag asc.
      { tag: 'gap', count: 1 },
      { tag: 'wrong-prescription', count: 1 },
    ]);
    // distinct list stays available + sorted for compatibility.
    expect(rule.misfireTags).toEqual(['gap', 'wrong-prescription', 'wrong-scale']);
    expect(rule.misfireCount).toBe(5);
  });

  it('computes misfire rate as misfire-tagged events / fire count', () => {
    const records = parseSteerTelemetryLines(
      [
        delivered('r', '2026-06-10T00:00:00Z'),
        delivered('r', '2026-06-10T00:01:00Z'),
        delivered('r', '2026-06-10T00:02:00Z'),
        delivered('r', '2026-06-10T00:03:00Z'),
        tagged('r', 'wrong-scale', '2026-06-10T00:04:00Z'),
      ].join('\n')
    );
    const rule = aggregateSteerTelemetry(records)[0];
    expect(rule.fireCount).toBe(4);
    expect(rule.misfireCount).toBe(1);
    expect(rule.misfireRate).toBe(0.25);
  });

  it('yields no rate (null, never NaN) when there are zero fires', () => {
    // Tags arrived on declined outcomes but the rule never delivered.
    const records = parseSteerTelemetryLines(
      [
        tagged('r', 'gap', '2026-06-10T00:00:00Z'),
        tagged('r', 'gap', '2026-06-10T00:01:00Z'),
      ].join('\n')
    );
    const rule = aggregateSteerTelemetry(records)[0];
    expect(rule.fireCount).toBe(0);
    expect(rule.misfireCount).toBe(2);
    expect(rule.misfireRate).toBeNull();
  });

  it('yields no rate and empty tag analytics when a fired rule has zero tags', () => {
    const records = parseSteerTelemetryLines(
      [
        delivered('r', '2026-06-10T00:00:00Z'),
        outcome('r', 'accepted', '2026-06-10T00:01:00Z'),
      ].join('\n')
    );
    const rule = aggregateSteerTelemetry(records)[0];
    expect(rule.fireCount).toBe(1);
    expect(rule.misfireTagCounts).toEqual([]);
    expect(rule.misfireCount).toBe(0);
    // Zero tags on a fired rule is an honest 0/N rate, not a null-denominator.
    expect(rule.misfireRate).toBe(0);
  });

  it('drops unknown tags fail-closed, so they never enter the analytics', () => {
    const records = parseSteerTelemetryLines(
      [
        delivered('r', '2026-06-10T00:00:00Z'),
        tagged('r', 'bogus-not-in-taxonomy', '2026-06-10T00:01:00Z'),
        tagged('r', 'wrong-scale', '2026-06-10T00:02:00Z'),
      ].join('\n')
    );
    const rule = aggregateSteerTelemetry(records)[0];
    expect(rule.misfireTagCounts).toEqual([{ tag: 'wrong-scale', count: 1 }]);
    expect(rule.misfireCount).toBe(1);
    expect(rule.misfireRate).toBe(1);
  });
});

describe('readSteerTelemetry — file IO', () => {
  it('reads + aggregates a real log file', async () => {
    const file = tmpFile([delivered('read-streak', '2026-06-10T00:00:00Z'), outcome('read-streak', 'accepted', '2026-06-10T00:01:00Z')].join('\n'));
    const agg = await readSteerTelemetry(file);
    expect(agg).toHaveLength(1);
    expect(agg[0]).toMatchObject({ ruleId: 'read-streak', fireCount: 1, acceptedCount: 1 });
  });

  it('returns [] for an absent log (no crash) — the "no data" state', async () => {
    expect(await readSteerTelemetry(join(tmpdir(), 'definitely-missing-steer.jsonl'))).toEqual([]);
  });

  it('returns [] for an empty log', async () => {
    expect(await readSteerTelemetry(tmpFile(''))).toEqual([]);
  });
});
