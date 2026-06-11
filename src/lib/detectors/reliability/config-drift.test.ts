/**
 * Tests for reliability.config-drift detector.
 *
 * The detector reads `configBackups` (a new optional field on RecommendationInput).
 * Tests use inline DriftEvent[] fixtures — no filesystem, no real backups.
 */

import { describe, it, expect } from 'vitest';
import { detector } from './config-drift';
import type { RecommendationInput } from '../types';
import type { DriftEvent } from '../../parse-backups';

// ── Fixture helpers ──────────────────────────────────────────────────────────

const NOW = 1_717_200_000_000; // fixed clock epoch-ms
const H = 3_600_000;
const DAY = 24 * H;

const PROJECT = '/home/tariq/work/payments-monorepo';
const OTHER = '/home/tariq/work/other-repo';

function baseInput(configBackups?: DriftEvent[]): RecommendationInput & { configBackups?: DriftEvent[] } {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    configBackups,
  };
}

function event(
  kind: DriftEvent['kind'],
  opts: Partial<DriftEvent> = {}
): DriftEvent {
  return {
    kind,
    project: PROJECT,
    server: undefined,
    from: undefined,
    to: undefined,
    timestamp: NOW - H, // 1 hour ago — recent
    severity: 'info',
    ...opts,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('reliability.config-drift', () => {
  it('emits null when configBackups is absent', () => {
    expect(detector.rule(baseInput(), NOW)).toBeNull();
  });

  it('emits null when configBackups is empty', () => {
    expect(detector.rule(baseInput([]), NOW)).toBeNull();
  });

  it('emits null when all events are outside the 7-day recency window', () => {
    const old = event('server-disabled', {
      timestamp: NOW - 8 * DAY, // 8 days ago — outside window
      severity: 'warning',
      server: 'postgres',
    });
    expect(detector.rule(baseInput([old]), NOW)).toBeNull();
  });

  it('emits null for global-churn-only events (not project-scoped)', () => {
    const churn = event('global-churn', { project: undefined });
    expect(detector.rule(baseInput([churn]), NOW)).toBeNull();
  });

  describe('server-disabled', () => {
    it('fires a warning when a server is recently disabled', () => {
      const ev = event('server-disabled', {
        severity: 'warning',
        server: 'postgres',
        from: 'enabled',
        to: 'disabled',
      });
      const rec = detector.rule(baseInput([ev]), NOW);
      expect(rec).not.toBeNull();
      expect(rec!.id).toBe('reliability.config-drift');
      expect(rec!.category).toBe('reliability');
      expect(rec!.severity).toBe('warning');
      expect(rec!.title).toMatch(/disabled/i);
      expect(rec!.evidence).toEqual(
        expect.arrayContaining([expect.stringContaining('postgres')])
      );
    });

    it('names the disabled server in the title', () => {
      const ev = event('server-disabled', {
        severity: 'warning',
        server: 'mydb',
        from: 'enabled',
        to: 'disabled',
      });
      const rec = detector.rule(baseInput([ev]), NOW);
      expect(rec!.detail).toContain('mydb');
    });
  });

  describe('trust-flip', () => {
    it('fires a warning on trust true -> false', () => {
      const ev = event('trust-flip', {
        severity: 'warning',
        from: true,
        to: false,
      });
      const rec = detector.rule(baseInput([ev]), NOW);
      expect(rec).not.toBeNull();
      expect(rec!.severity).toBe('warning');
    });
  });

  describe('enable-all-flip', () => {
    it('fires when enableAll is turned on', () => {
      const ev = event('enable-all-flip', {
        severity: 'warning',
        from: false,
        to: true,
      });
      const rec = detector.rule(baseInput([ev]), NOW);
      expect(rec).not.toBeNull();
      expect(rec!.severity).toBe('warning');
    });
  });

  describe('repo-server-appeared / vanished', () => {
    it('fires info (not warning) for appeared/vanished alone', () => {
      const appeared = event('repo-server-appeared', {
        severity: 'info',
        server: 'sentry',
        from: undefined,
        to: 'sentry',
      });
      const rec = detector.rule(baseInput([appeared]), NOW);
      expect(rec).not.toBeNull();
      // No disabled events, so severity should be downgraded to info
      expect(rec!.severity).toBe('info');
    });
  });

  describe('multi-event / multi-project', () => {
    it('counts affected correctly across multiple events', () => {
      const events: DriftEvent[] = [
        event('server-disabled', { severity: 'warning', server: 'postgres' }),
        event('trust-flip', { severity: 'warning', from: true, to: false }),
        event('enable-all-flip', { severity: 'warning', from: false, to: true, timestamp: NOW - 2 * H }),
        event('repo-server-appeared', { severity: 'info', server: 'sentry' }),
      ];
      const rec = detector.rule(baseInput(events), NOW);
      expect(rec!.affected).toBe(4);
      expect(rec!.severity).toBe('warning'); // has server-disabled
    });

    it('reports multiple distinct projects', () => {
      const events: DriftEvent[] = [
        event('server-disabled', { severity: 'warning', server: 'postgres', project: PROJECT }),
        event('trust-flip',      { severity: 'warning', from: true, to: false, project: OTHER }),
      ];
      const rec = detector.rule(baseInput(events), NOW);
      expect(rec!.projects).toContain(PROJECT);
      expect(rec!.projects).toContain(OTHER);
    });
  });

  describe('evidence list', () => {
    it('caps evidence at 5 entries', () => {
      const events: DriftEvent[] = Array.from({ length: 8 }, (_, i) =>
        event('server-disabled', {
          severity: 'warning',
          server: `srv${i}`,
          timestamp: NOW - i * H,
        })
      );
      const rec = detector.rule(baseInput(events), NOW);
      expect(rec!.evidence!.length).toBeLessThanOrEqual(5);
    });

    it('includes timestamp and server in evidence strings', () => {
      const ev = event('server-disabled', {
        severity: 'warning',
        server: 'postgres',
        timestamp: NOW - H,
      });
      const rec = detector.rule(baseInput([ev]), NOW);
      expect(rec!.evidence![0]).toMatch(/postgres/);
      // ISO timestamp prefix
      expect(rec!.evidence![0]).toMatch(/\d{4}-\d{2}-\d{2}/);
    });
  });
});
