import { describe, it, expect } from 'vitest';
import { detector } from './self-update-health';
import type { RecommendationInput } from '../types';
import type { UpdateResult } from '../../parse-last-update';

// Helpers
const baseInput = (): RecommendationInput => ({
  tokenData: [],
  toolData: [],
  sessions: [],
  projects: [],
  permissionRows: [],
  apiErrors: [],
  liveConfig: null,
});

const withResults = (results?: UpdateResult[]): RecommendationInput =>
  ({ ...baseInput(), updateResults: results } as RecommendationInput & {
    updateResults?: UpdateResult[];
  });

const ok = (ts: string, from: string, to: string): UpdateResult => ({
  timestamp: ts,
  path: 'npm-global',
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

// 10-record series from the prototype (grade C, 80% success, 2 failures)
const PROTO_SERIES: UpdateResult[] = [
  ok('2026-05-19T08:12:03.001Z', '2.1.140', '2.1.142'),
  ok('2026-05-21T07:55:41.220Z', '2.1.142', '2.1.144'),
  fail('2026-05-23T09:03:12.880Z', '2.1.144', '2.1.145', 'EACCES', 'failure'),
  ok('2026-05-23T09:31:55.140Z', '2.1.144', '2.1.145'),
  ok('2026-05-26T08:40:09.700Z', '2.1.145', '2.1.149'),
  fail('2026-05-28T10:11:48.512Z', '2.1.149', '2.1.150', 'ENETUNREACH', 'blocked'),
  ok('2026-05-30T08:05:22.003Z', '2.1.149', '2.1.153'),
  ok('2026-06-01T07:48:30.900Z', '2.1.153', '2.1.158'),
  ok('2026-06-02T09:22:14.330Z', '2.1.158', '2.1.160'),
  ok('2026-06-03T19:37:43.706Z', '2.1.160', '2.1.161'),
];

describe('reliability.self-update-health (#566)', () => {
  describe('silent paths', () => {
    it('emits nothing when updateResults is absent', () => {
      expect(detector.rule(baseInput(), 0)).toBeNull();
    });

    it('emits nothing for an empty array', () => {
      expect(detector.rule(withResults([]), 0)).toBeNull();
    });

    it('emits nothing when all attempts succeeded (grade A)', () => {
      const allOk: UpdateResult[] = [
        ok('2026-06-01T10:00:00Z', '2.1.140', '2.1.141'),
        ok('2026-06-02T10:00:00Z', '2.1.141', '2.1.142'),
        ok('2026-06-03T10:00:00Z', '2.1.142', '2.1.143'),
      ];
      expect(detector.rule(withResults(allOk), 0)).toBeNull();
    });
  });

  describe('prototype series — grade C, 80% success', () => {
    const rec = detector.rule(withResults(PROTO_SERIES), 0);

    it('fires with the correct id', () => {
      expect(rec?.id).toBe('reliability.self-update-health');
    });

    it('uses info severity for 80% success (>= 70%)', () => {
      expect(rec?.severity).toBe('info');
    });

    it('sets affected to the failed count (2)', () => {
      expect(rec?.affected).toBe(2);
    });

    it('mentions both error codes in the detail', () => {
      expect(rec?.detail).toMatch(/EACCES/);
      expect(rec?.detail).toMatch(/ENETUNREACH/);
    });

    it('detail references the total and success count', () => {
      expect(rec?.detail).toMatch(/10/);
      expect(rec?.detail).toMatch(/8/);
    });
  });

  describe('low success rate — grade D (< 70%) escalates to warning', () => {
    // 5 failures out of 8 = 37.5% — well below 70%
    const lowSeries: UpdateResult[] = [
      ok('2026-06-01T10:00:00Z', '2.1.0', '2.1.1'),
      ok('2026-06-02T10:00:00Z', '2.1.1', '2.1.2'),
      ok('2026-06-03T10:00:00Z', '2.1.2', '2.1.3'),
      fail('2026-06-04T10:00:00Z', '2.1.3', '2.1.4', 'EACCES'),
      fail('2026-06-05T10:00:00Z', '2.1.4', '2.1.5', 'EACCES'),
      fail('2026-06-06T10:00:00Z', '2.1.5', '2.1.6', 'ENETUNREACH', 'blocked'),
      fail('2026-06-07T10:00:00Z', '2.1.6', '2.1.7', 'EACCES'),
      fail('2026-06-08T10:00:00Z', '2.1.7', '2.1.8', 'EACCES'),
    ];
    const rec = detector.rule(withResults(lowSeries), 0);

    it('escalates to warning severity', () => {
      expect(rec?.severity).toBe('warning');
    });

    it('sets affected to the failed count (5)', () => {
      expect(rec?.affected).toBe(5);
    });

    it('action recommends pinning a version', () => {
      expect(rec?.action).toMatch(/[Pp]in/);
    });
  });

  describe('single-record series (today\'s typical ingest)', () => {
    it('fires for a single failed record', () => {
      const single = [fail('2026-06-04T09:00:00Z', '2.1.160', '2.1.161', 'EACCES')];
      const rec = detector.rule(withResults(single), 0);
      expect(rec).not.toBeNull();
      expect(rec?.affected).toBe(1);
      expect(rec?.severity).toBe('warning'); // 0% success = grade D
    });

    it('stays silent for a single successful record', () => {
      const single = [ok('2026-06-04T09:00:00Z', '2.1.160', '2.1.161')];
      expect(detector.rule(withResults(single), 0)).toBeNull();
    });
  });

  describe('detector metadata', () => {
    it('has the correct category', () => {
      expect(detector.category).toBe('reliability');
    });

    it('has the correct id', () => {
      expect(detector.id).toBe('reliability.self-update-health');
    });
  });
});
