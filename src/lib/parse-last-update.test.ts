import { describe, it, expect } from 'vitest';
import { parseLastUpdate, analyzeUpdateHealth } from './parse-last-update';
import type { UpdateResult } from './parse-last-update';

// ---- inline fixtures (mirrors mock-snapshots.json from proto/539-last-update) ------

const ok = (
  ts: string,
  from: string,
  to: string,
  path = 'npm-global'
): UpdateResult => ({
  timestamp: ts,
  path,
  outcome: 'success',
  status: 'success',
  version_from: from,
  version_to: to,
  error_code: null,
});

const fail = (
  ts: string,
  from: string,
  to: string,
  code: string,
  outcomeVal: 'failure' | 'blocked' = 'failure'
): UpdateResult => ({
  timestamp: ts,
  path: 'npm-global',
  outcome: outcomeVal,
  status: outcomeVal,
  version_from: from,
  version_to: to,
  error_code: code,
});

// 10-record series matching the prototype output (grade C, 80% success, 2 failures)
const SERIES: UpdateResult[] = [
  ok('2026-05-19T08:12:03.001Z', '2.1.140', '2.1.142'),
  ok('2026-05-21T07:55:41.220Z', '2.1.142', '2.1.144'),
  fail('2026-05-23T09:03:12.880Z', '2.1.144', '2.1.145', 'EACCES', 'failure'),
  ok('2026-05-23T09:31:55.140Z', '2.1.144', '2.1.145'), // immediate retry
  ok('2026-05-26T08:40:09.700Z', '2.1.145', '2.1.149'),
  fail('2026-05-28T10:11:48.512Z', '2.1.149', '2.1.150', 'ENETUNREACH', 'blocked'),
  ok('2026-05-30T08:05:22.003Z', '2.1.149', '2.1.153'),
  ok('2026-06-01T07:48:30.900Z', '2.1.153', '2.1.158'),
  ok('2026-06-02T09:22:14.330Z', '2.1.158', '2.1.160'),
  ok('2026-06-03T19:37:43.706Z', '2.1.160', '2.1.161'),
];

// ---- parseLastUpdate -------------------------------------------------------

describe('parseLastUpdate', () => {
  it('parses a valid JSON object', () => {
    const raw = JSON.stringify(SERIES[0]);
    const result = parseLastUpdate(raw);
    expect(result).not.toBeNull();
    expect(result?.outcome).toBe('success');
    expect(result?.version_from).toBe('2.1.140');
  });

  it('parses a failure record', () => {
    const raw = JSON.stringify(SERIES[2]);
    const result = parseLastUpdate(raw);
    expect(result?.outcome).toBe('failure');
    expect(result?.error_code).toBe('EACCES');
  });

  it('returns null for empty string', () => {
    expect(parseLastUpdate('')).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    expect(parseLastUpdate('   \n')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseLastUpdate('{not json')).toBeNull();
  });

  it('returns null for a JSON array (not a single record)', () => {
    expect(parseLastUpdate(JSON.stringify([SERIES[0]]))).toBeNull();
  });

  it('accepts a record with only outcome (no status fallback needed)', () => {
    const r = parseLastUpdate(JSON.stringify({ outcome: 'success', version_from: '1.0.0', version_to: '1.0.1' }));
    expect(r?.outcome).toBe('success');
  });

  it('accepts a record with only status (older CLI format)', () => {
    const r = parseLastUpdate(JSON.stringify({ status: 'failure', error_code: 'EACCES' }));
    expect(r?.status).toBe('failure');
  });
});

// ---- analyzeUpdateHealth ---------------------------------------------------

describe('analyzeUpdateHealth', () => {
  describe('empty input', () => {
    it('returns a zero/null report without throwing', () => {
      const report = analyzeUpdateHealth([]);
      expect(report.total).toBe(0);
      expect(report.cadenceDays).toBeNull();
      expect(report.versionDrift).toBeNull();
      expect(report.grade).toBe('A');
    });
  });

  describe('single-record series (today\'s common case)', () => {
    it('reports the outcome of that one record', () => {
      const report = analyzeUpdateHealth([SERIES[0]]);
      expect(report.total).toBe(1);
      expect(report.successRate).toBe(1);
      expect(report.successCount).toBe(1);
      expect(report.failedCount).toBe(0);
      expect(report.cadenceDays).toBeNull(); // only one record — no interval
      expect(report.grade).toBe('A');
    });

    it('handles a single failure record', () => {
      const report = analyzeUpdateHealth([SERIES[2]]); // EACCES failure
      expect(report.total).toBe(1);
      expect(report.successRate).toBe(0);
      expect(report.failedCount).toBe(1);
      expect(report.errorCodes).toContain('EACCES');
      expect(report.grade).toBe('D');
    });
  });

  describe('10-record prototype series (grade C, 80% success)', () => {
    const report = analyzeUpdateHealth(SERIES);

    it('computes the correct success rate (8/10 = 80%)', () => {
      expect(report.total).toBe(10);
      expect(report.successCount).toBe(8);
      expect(report.failedCount).toBe(2);
      expect(report.successRate).toBeCloseTo(0.8, 5);
    });

    it('assigns grade C for 80% success', () => {
      expect(report.grade).toBe('C');
    });

    it('detects 1 immediate retry (EACCES + same-day success within <1h)', () => {
      expect(report.immediateRetries).toBe(1);
    });

    it('captures both error codes', () => {
      expect(report.errorCodes).toContain('EACCES');
      expect(report.errorCodes).toContain('ENETUNREACH');
    });

    it('reports version drift from first to last', () => {
      expect(report.versionDrift).toMatch(/2\.1\.140/);
      expect(report.versionDrift).toMatch(/2\.1\.161/);
    });

    it('cadence is roughly 1.7 days (15d / 9 gaps)', () => {
      expect(report.cadenceDays).not.toBeNull();
      expect(report.cadenceDays!).toBeGreaterThan(1.5);
      expect(report.cadenceDays!).toBeLessThan(2.0);
    });
  });

  describe('grade thresholds', () => {
    const makeResults = (successes: number, total: number): UpdateResult[] =>
      Array.from({ length: total }, (_, i) =>
        i < successes
          ? ok(`2026-06-0${(i % 9) + 1}T10:00:00Z`, '1.0.0', '1.0.1')
          : fail(`2026-06-0${(i % 9) + 1}T11:00:00Z`, '1.0.0', '1.0.1', 'EACCES')
      );

    it('A: >= 95% success', () => {
      expect(analyzeUpdateHealth(makeResults(19, 20)).grade).toBe('A');
    });
    it('B: >= 85% and < 95%', () => {
      expect(analyzeUpdateHealth(makeResults(17, 20)).grade).toBe('B');
    });
    it('C: >= 70% and < 85%', () => {
      expect(analyzeUpdateHealth(makeResults(14, 20)).grade).toBe('C');
    });
    it('D: < 70%', () => {
      expect(analyzeUpdateHealth(makeResults(13, 20)).grade).toBe('D');
    });
  });

  describe('immediateRetries semantics (#3143)', () => {
    it('counts ONLY a failure→success pair with a finite, sub-hour gap', () => {
      const results = [
        fail('2026-06-01T10:00:00.000Z', '1.0.0', '1.0.1', 'EACCES'),
        ok('2026-06-01T10:30:00.000Z', '1.0.0', '1.0.1'), // 30 min later
      ];
      expect(analyzeUpdateHealth(results).immediateRetries).toBe(1);
    });

    it('does not count two successes 30 minutes apart', () => {
      const results = [
        ok('2026-06-01T10:00:00.000Z', '1.0.0', '1.0.1'),
        ok('2026-06-01T10:30:00.000Z', '1.0.1', '1.0.2'),
      ];
      expect(analyzeUpdateHealth(results).immediateRetries).toBe(0);
    });

    it('does not count a failure followed by another failure', () => {
      const results = [
        fail('2026-06-01T10:00:00.000Z', '1.0.0', '1.0.1', 'EACCES'),
        fail('2026-06-01T10:20:00.000Z', '1.0.0', '1.0.1', 'EACCES'),
      ];
      expect(analyzeUpdateHealth(results).immediateRetries).toBe(0);
    });

    it('does not count a success followed by a failure', () => {
      const results = [
        ok('2026-06-01T10:00:00.000Z', '1.0.0', '1.0.1'),
        fail('2026-06-01T10:20:00.000Z', '1.0.1', '1.0.2', 'EACCES'),
      ];
      expect(analyzeUpdateHealth(results).immediateRetries).toBe(0);
    });

    it('does not count a failure→success pair an hour or more apart', () => {
      const results = [
        fail('2026-06-01T10:00:00.000Z', '1.0.0', '1.0.1', 'EACCES'),
        ok('2026-06-01T11:05:00.000Z', '1.0.0', '1.0.1'), // 65 min
      ];
      expect(analyzeUpdateHealth(results).immediateRetries).toBe(0);
    });

    it('ignores pairs with an unparseable timestamp', () => {
      const results = [
        fail('bogus', '1.0.0', '1.0.1', 'EACCES'),
        ok('2026-06-01T10:10:00.000Z', '1.0.0', '1.0.1'),
      ];
      expect(analyzeUpdateHealth(results).immediateRetries).toBe(0);
    });

    it('is order-independent — a failure→success pair given out of order still counts once', () => {
      const results = [
        ok('2026-06-01T10:30:00.000Z', '1.0.0', '1.0.1'),
        fail('2026-06-01T10:00:00.000Z', '1.0.0', '1.0.1', 'EACCES'),
      ];
      expect(analyzeUpdateHealth(results).immediateRetries).toBe(1);
    });
  });
});
