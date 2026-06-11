/**
 * Tests for parse-session-registry.ts
 *
 * Fixtures are shaped exactly like ~/.claude/sessions/<pid>.json:
 *   { pid, sessionId, cwd, startedAt, procStart, version, peerProtocol, kind, entrypoint }
 *
 * Key invariants under test:
 *   1. "committed"  attribution when one entrypoint >= 70% and sessionCount > 2
 *   2. "split"      attribution when no entrypoint >= 70% and sessionCount > 2
 *   3. "low-signal" attribution when sessionCount <= 2
 *   4. kind!=entrypoint anomaly count (sdk-cli + kind:interactive is the real-world case)
 *   5. parseSessionRegistryDir tolerates missing dirs and malformed JSON
 */

import { describe, it, expect } from 'vitest';
import { analyzeAttribution, parseSessionRegistryDir } from './parse-session-registry';
import type { SessionRegistryEntry } from './parse-session-registry';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let _pid = 1000;
const entry = (overrides: Partial<SessionRegistryEntry> & { cwd: string }): SessionRegistryEntry => ({
  pid: _pid++,
  sessionId: `sess-${_pid}`,
  cwd: overrides.cwd,
  startedAt: overrides.startedAt ?? 1_700_000_000_000 + _pid * 1000,
  procStart: String(_pid),
  version: overrides.version ?? '2.1.0',
  peerProtocol: overrides.peerProtocol ?? 1,
  kind: overrides.kind ?? 'interactive',
  entrypoint: overrides.entrypoint ?? 'cli',
  ...overrides,
});

// ---------------------------------------------------------------------------
// analyzeAttribution — attribution bucket tests
// ---------------------------------------------------------------------------

describe('analyzeAttribution', () => {
  describe('committed bucket (one entrypoint >= 70%, sessionCount > 2)', () => {
    it('classifies as committed when 4/5 sessions share one entrypoint', () => {
      const cwd = '/repo/alpha';
      const entries: SessionRegistryEntry[] = [
        entry({ cwd, entrypoint: 'cli', kind: 'interactive' }),
        entry({ cwd, entrypoint: 'cli', kind: 'interactive' }),
        entry({ cwd, entrypoint: 'cli', kind: 'interactive' }),
        entry({ cwd, entrypoint: 'cli', kind: 'interactive' }),
        entry({ cwd, entrypoint: 'sdk-cli', kind: 'interactive' }),
      ];
      const result = analyzeAttribution(entries);
      const proj = result.projects[0];
      expect(proj.attributionBucket).toBe('committed');
      expect(proj.dominantEntrypoint).toBe('cli');
      expect(proj.dominantShare).toBe(80);
    });

    it('classifies as committed at exactly 70% (3/3 cli out of... wait — 70% of 10)', () => {
      // 7 out of 10 sessions = exactly 70%
      const cwd = '/repo/beta';
      const entries: SessionRegistryEntry[] = [
        ...Array.from({ length: 7 }, () => entry({ cwd, entrypoint: 'sdk-cli', kind: 'interactive' })),
        ...Array.from({ length: 3 }, () => entry({ cwd, entrypoint: 'cli', kind: 'interactive' })),
      ];
      const result = analyzeAttribution(entries);
      const proj = result.projects[0];
      expect(proj.attributionBucket).toBe('committed');
      expect(proj.dominantEntrypoint).toBe('sdk-cli');
      expect(proj.dominantShare).toBe(70);
    });

    it('classifies as committed for sdk-cli dominant projects with anomalies', () => {
      const cwd = '/repo/sdk-dominant';
      // All 5 sessions are sdk-cli but kind is interactive (real-world pattern)
      const entries: SessionRegistryEntry[] = Array.from({ length: 5 }, () =>
        entry({ cwd, entrypoint: 'sdk-cli', kind: 'interactive' })
      );
      const result = analyzeAttribution(entries);
      const proj = result.projects[0];
      expect(proj.attributionBucket).toBe('committed');
      expect(proj.dominantEntrypoint).toBe('sdk-cli');
      // All 5 are anomalies (sdk-cli + kind:interactive)
      expect(proj.kindEntrypointAnomalyCount).toBe(5);
    });
  });

  describe('split bucket (no entrypoint >= 70%, sessionCount > 2)', () => {
    it('classifies as split when entrypoints are 50/50', () => {
      const cwd = '/repo/mixed';
      const entries: SessionRegistryEntry[] = [
        entry({ cwd, entrypoint: 'cli', kind: 'interactive' }),
        entry({ cwd, entrypoint: 'cli', kind: 'interactive' }),
        entry({ cwd, entrypoint: 'sdk-cli', kind: 'interactive' }),
        entry({ cwd, entrypoint: 'sdk-cli', kind: 'interactive' }),
      ];
      const result = analyzeAttribution(entries);
      const proj = result.projects[0];
      expect(proj.attributionBucket).toBe('split');
      expect(proj.dominantShare).toBe(50);
      expect(proj.entrypointMatrix).toHaveLength(2);
    });

    it('classifies as split when dominant share is 69% (just under threshold)', () => {
      const cwd = '/repo/just-under';
      // 9 out of 13 = 69.2% -> rounds to 69%
      const entries: SessionRegistryEntry[] = [
        ...Array.from({ length: 9 }, () => entry({ cwd, entrypoint: 'cli', kind: 'interactive' })),
        ...Array.from({ length: 4 }, () => entry({ cwd, entrypoint: 'sdk-cli', kind: 'interactive' })),
      ];
      const result = analyzeAttribution(entries);
      const proj = result.projects[0];
      // 9/13 = 69.2, rounds to 69 < 70
      expect(proj.dominantShare).toBe(69);
      expect(proj.attributionBucket).toBe('split');
    });

    it('builds an entrypoint matrix sorted descending by count', () => {
      const cwd = '/repo/three-ways';
      const entries: SessionRegistryEntry[] = [
        ...Array.from({ length: 3 }, () => entry({ cwd, entrypoint: 'cli' })),
        ...Array.from({ length: 5 }, () => entry({ cwd, entrypoint: 'sdk-cli' })),
        ...Array.from({ length: 2 }, () => entry({ cwd, entrypoint: 'sdk-py' })),
      ];
      const result = analyzeAttribution(entries);
      const proj = result.projects[0];
      expect(proj.entrypointMatrix[0].entrypoint).toBe('sdk-cli');
      expect(proj.entrypointMatrix[0].count).toBe(5);
      expect(proj.entrypointMatrix[1].entrypoint).toBe('cli');
      expect(proj.entrypointMatrix[2].entrypoint).toBe('sdk-py');
    });
  });

  describe('low-signal bucket (sessionCount <= 2)', () => {
    it('classifies a single session as low-signal even if it has a clear entrypoint', () => {
      const entries: SessionRegistryEntry[] = [
        entry({ cwd: '/repo/singleton', entrypoint: 'cli', kind: 'interactive' }),
      ];
      const result = analyzeAttribution(entries);
      expect(result.projects[0].attributionBucket).toBe('low-signal');
    });

    it('classifies exactly 2 sessions as low-signal', () => {
      const cwd = '/repo/pair';
      const entries: SessionRegistryEntry[] = [
        entry({ cwd, entrypoint: 'cli' }),
        entry({ cwd, entrypoint: 'cli' }),
      ];
      const result = analyzeAttribution(entries);
      expect(result.projects[0].attributionBucket).toBe('low-signal');
      expect(result.projects[0].sessionCount).toBe(2);
    });

    it('transitions to committed at 3 sessions with 100% one entrypoint', () => {
      const cwd = '/repo/threshold';
      const entries: SessionRegistryEntry[] = [
        entry({ cwd, entrypoint: 'cli' }),
        entry({ cwd, entrypoint: 'cli' }),
        entry({ cwd, entrypoint: 'cli' }),
      ];
      const result = analyzeAttribution(entries);
      expect(result.projects[0].attributionBucket).toBe('committed');
    });
  });

  describe('kind!=entrypoint anomaly count', () => {
    it('counts sessions where entrypoint=sdk-cli but kind=interactive', () => {
      const cwd = '/repo/anomalous';
      const entries: SessionRegistryEntry[] = [
        // True interactive: kind and entrypoint both "cli" — no anomaly
        entry({ cwd, entrypoint: 'cli', kind: 'interactive' }),
        entry({ cwd, entrypoint: 'cli', kind: 'interactive' }),
        // Automated via sdk-cli but kind mis-tags as "interactive" — anomaly
        entry({ cwd, entrypoint: 'sdk-cli', kind: 'interactive' }),
        entry({ cwd, entrypoint: 'sdk-cli', kind: 'interactive' }),
        // sdk-cli with correct kind (hypothetical future fix) — no anomaly
        entry({ cwd, entrypoint: 'sdk-cli', kind: 'sdk-cli' }),
      ];
      const result = analyzeAttribution(entries);
      const proj = result.projects[0];
      // 2 anomalies: the two (sdk-cli + interactive) sessions
      expect(proj.kindEntrypointAnomalyCount).toBe(2);
    });

    it('sums anomaly counts across all projects in totalKindAnomalies', () => {
      const entries: SessionRegistryEntry[] = [
        entry({ cwd: '/repo/a', entrypoint: 'sdk-cli', kind: 'interactive' }),
        entry({ cwd: '/repo/a', entrypoint: 'sdk-cli', kind: 'interactive' }),
        entry({ cwd: '/repo/a', entrypoint: 'sdk-cli', kind: 'interactive' }),
        entry({ cwd: '/repo/b', entrypoint: 'sdk-cli', kind: 'interactive' }),
        entry({ cwd: '/repo/b', entrypoint: 'sdk-cli', kind: 'interactive' }),
        entry({ cwd: '/repo/b', entrypoint: 'sdk-cli', kind: 'interactive' }),
        entry({ cwd: '/repo/b', entrypoint: 'cli', kind: 'interactive' }),
      ];
      const result = analyzeAttribution(entries);
      // 3 from /repo/a + 3 from /repo/b (the cli one is not an anomaly)
      expect(result.totalKindAnomalies).toBe(6);
    });

    it('has zero anomalies when all sessions correctly match kind and entrypoint', () => {
      const entries: SessionRegistryEntry[] = [
        entry({ cwd: '/repo/c', entrypoint: 'cli', kind: 'interactive' }),
        entry({ cwd: '/repo/c', entrypoint: 'cli', kind: 'interactive' }),
        entry({ cwd: '/repo/c', entrypoint: 'cli', kind: 'interactive' }),
      ];
      const result = analyzeAttribution(entries);
      expect(result.totalKindAnomalies).toBe(0);
      expect(result.projects[0].kindEntrypointAnomalyCount).toBe(0);
    });
  });

  describe('version timeline', () => {
    it('builds a version timeline sorted by first-seen ascending', () => {
      const cwd = '/repo/versioned';
      const entries: SessionRegistryEntry[] = [
        entry({ cwd, version: '2.1.160', startedAt: 1_700_100_000_000, entrypoint: 'cli' }),
        entry({ cwd, version: '2.1.161', startedAt: 1_700_200_000_000, entrypoint: 'cli' }),
        entry({ cwd, version: '2.1.159', startedAt: 1_700_000_000_000, entrypoint: 'cli' }),
        entry({ cwd, version: '2.1.161', startedAt: 1_700_300_000_000, entrypoint: 'cli' }),
      ];
      const result = analyzeAttribution(entries);
      const timeline = result.projects[0].versionTimeline;
      expect(timeline[0].version).toBe('2.1.159');
      expect(timeline[1].version).toBe('2.1.160');
      expect(timeline[2].version).toBe('2.1.161');
      expect(timeline[2].count).toBe(2);
    });

    it('collects all versions across projects into allVersions', () => {
      const entries: SessionRegistryEntry[] = [
        entry({ cwd: '/repo/x', version: '2.1.1', entrypoint: 'cli' }),
        entry({ cwd: '/repo/x', version: '2.1.2', entrypoint: 'cli' }),
        entry({ cwd: '/repo/x', version: '2.1.2', entrypoint: 'cli' }),
        entry({ cwd: '/repo/y', version: '2.1.3', entrypoint: 'cli' }),
        entry({ cwd: '/repo/y', version: '2.1.3', entrypoint: 'cli' }),
        entry({ cwd: '/repo/y', version: '2.1.3', entrypoint: 'cli' }),
      ];
      const result = analyzeAttribution(entries);
      expect(result.allVersions).toEqual(['2.1.1', '2.1.2', '2.1.3']);
    });
  });

  describe('rawEntries for report card joins', () => {
    it('retains raw per-session entries so the report card can join on sessionId', () => {
      const cwd = '/repo/joinable';
      const e1 = entry({ cwd, sessionId: 'aaa-111', entrypoint: 'cli' });
      const e2 = entry({ cwd, sessionId: 'bbb-222', entrypoint: 'sdk-cli' });
      const e3 = entry({ cwd, sessionId: 'ccc-333', entrypoint: 'cli' });
      const result = analyzeAttribution([e1, e2, e3]);
      const proj = result.projects[0];
      const ids = proj.rawEntries.map((e) => e.sessionId).sort();
      expect(ids).toEqual(['aaa-111', 'bbb-222', 'ccc-333'].sort());
    });
  });

  describe('multi-project aggregation', () => {
    it('handles multiple projects and sorts by sessionCount descending', () => {
      const entries: SessionRegistryEntry[] = [
        // /repo/small — 1 session
        entry({ cwd: '/repo/small', entrypoint: 'cli' }),
        // /repo/large — 5 sessions
        ...Array.from({ length: 5 }, () => entry({ cwd: '/repo/large', entrypoint: 'cli' })),
        // /repo/medium — 3 sessions
        ...Array.from({ length: 3 }, () => entry({ cwd: '/repo/medium', entrypoint: 'sdk-cli' })),
      ];
      const result = analyzeAttribution(entries);
      expect(result.totalProjects).toBe(3);
      expect(result.totalSessions).toBe(9);
      expect(result.projects[0].cwd).toBe('/repo/large');
      expect(result.projects[1].cwd).toBe('/repo/medium');
      expect(result.projects[2].cwd).toBe('/repo/small');
    });

    it('returns empty analysis for empty input', () => {
      const result = analyzeAttribution([]);
      expect(result.totalSessions).toBe(0);
      expect(result.totalProjects).toBe(0);
      expect(result.projects).toHaveLength(0);
      expect(result.allVersions).toHaveLength(0);
      expect(result.totalKindAnomalies).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// parseSessionRegistryDir — filesystem tests
// ---------------------------------------------------------------------------

describe('parseSessionRegistryDir', () => {
  it('reads valid session JSON files from a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-registry-test-'));
    const e1: SessionRegistryEntry = {
      pid: 1001,
      sessionId: 'test-session-1',
      cwd: '/repo/test',
      startedAt: 1_700_000_000_000,
      procStart: '1001',
      version: '2.1.0',
      peerProtocol: 1,
      kind: 'interactive',
      entrypoint: 'cli',
    };
    const e2: SessionRegistryEntry = {
      pid: 1002,
      sessionId: 'test-session-2',
      cwd: '/repo/test',
      startedAt: 1_700_000_001_000,
      procStart: '1002',
      version: '2.1.0',
      peerProtocol: 1,
      kind: 'interactive',
      entrypoint: 'sdk-cli',
    };
    writeFileSync(join(dir, '1001.json'), JSON.stringify(e1));
    writeFileSync(join(dir, '1002.json'), JSON.stringify(e2));

    const result = parseSessionRegistryDir(dir);
    expect(result).toHaveLength(2);
    const sessionIds = result.map((r) => r.sessionId).sort();
    expect(sessionIds).toEqual(['test-session-1', 'test-session-2']);
  });

  it('skips non-.json files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-registry-test-'));
    const e: SessionRegistryEntry = {
      pid: 2001,
      sessionId: 'test-session-x',
      cwd: '/repo/x',
      startedAt: 1_700_000_000_000,
      procStart: '2001',
      version: '2.1.0',
      peerProtocol: 1,
      kind: 'interactive',
      entrypoint: 'cli',
    };
    writeFileSync(join(dir, '2001.json'), JSON.stringify(e));
    writeFileSync(join(dir, 'README.txt'), 'not a session');
    writeFileSync(join(dir, 'lock'), 'lock file');

    const result = parseSessionRegistryDir(dir);
    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(2001);
  });

  it('tolerates malformed JSON files (partial writes during live sessions)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-registry-test-'));
    const good: SessionRegistryEntry = {
      pid: 3001,
      sessionId: 'good-session',
      cwd: '/repo/good',
      startedAt: 1_700_000_000_000,
      procStart: '3001',
      version: '2.1.0',
      peerProtocol: 1,
      kind: 'interactive',
      entrypoint: 'cli',
    };
    writeFileSync(join(dir, '3001.json'), JSON.stringify(good));
    writeFileSync(join(dir, '3002.json'), '{"pid": 3002, "sessionId": "incomplete"'); // truncated
    writeFileSync(join(dir, '3003.json'), 'not json at all');
    writeFileSync(join(dir, '3004.json'), '{}'); // missing required fields

    const result = parseSessionRegistryDir(dir);
    // Only the valid entry should be returned
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('good-session');
  });

  it('skips session registry files above the configured byte cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-registry-test-'));
    const small: SessionRegistryEntry = {
      pid: 3101,
      sessionId: 'small-session',
      cwd: '/repo/small',
      startedAt: 1_700_000_000_000,
      procStart: '3101',
      version: '2.1.0',
      peerProtocol: 1,
      kind: 'interactive',
      entrypoint: 'cli',
    };
    const large: SessionRegistryEntry = {
      ...small,
      pid: 3102,
      sessionId: 'large-session',
      cwd: `/repo/${'x'.repeat(2_048)}`,
    };
    writeFileSync(join(dir, '3101.json'), JSON.stringify(small));
    writeFileSync(join(dir, '3102.json'), JSON.stringify(large));

    const result = parseSessionRegistryDir(dir, { maxFileBytes: 512 });

    expect(result.map((item) => item.sessionId)).toEqual(['small-session']);
  });

  it('returns empty array for a non-existent directory', () => {
    const result = parseSessionRegistryDir('/tmp/this-path-does-not-exist-xyz-abc');
    expect(result).toEqual([]);
  });

  it('returns empty array for a missing required field (entrypoint)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-registry-test-'));
    const badEntry = { pid: 4001, sessionId: 'bad', cwd: '/repo', startedAt: 1_700_000_000_000, kind: 'interactive' };
    // missing entrypoint
    writeFileSync(join(dir, '4001.json'), JSON.stringify(badEntry));

    const result = parseSessionRegistryDir(dir);
    expect(result).toHaveLength(0);
  });
});
