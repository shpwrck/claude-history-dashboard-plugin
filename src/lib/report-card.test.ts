import { describe, it, expect } from 'vitest';
import { buildReportCard } from './report-card';
import type { SessionRegistryEntry } from './parse-session-registry';
import type { TelemetryEvent } from './parse-telemetry';
import type { DebugSessionMetrics } from './parse-debug';

const env = {
  node_version: 'v22.0.0',
  terminal: 'tmux',
  wsl_version: '2',
  linux_distro_id: 'ubuntu',
  arch: 'x64',
  build_time: '2026-06-01',
};

function sess(
  cwd: string,
  sessionId: string,
  entrypoint: string,
  kind = 'interactive'
): SessionRegistryEntry {
  return {
    pid: Math.abs(hash(sessionId)) % 100000,
    sessionId,
    cwd,
    startedAt: 1_700_000_000_000,
    procStart: '12345',
    version: '2.1.161',
    peerProtocol: 1,
    kind,
    entrypoint,
  };
}
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
function tele(sessionId: string, attempt: number, elapsed_ms: number): TelemetryEvent {
  return {
    event_name: 'tengu_api_slow_first_byte',
    client_timestamp: '2026-06-01T00:00:00Z',
    model: 'claude-opus-4-8',
    betas: '',
    session_id: sessionId,
    attempt,
    elapsed_ms,
    env,
  };
}
function dbg(sessionId: string, p90: number, fastModeLost = 0): DebugSessionMetrics {
  return {
    sessionId,
    ttfbP50: Math.round(p90 / 2),
    ttfbP90: p90,
    ttfbMax: p90,
    ttfbSampleCount: 5,
    maxRetryAttempt: 1,
    slowFirstByteCount: 0,
    fastModeLostCount: fastModeLost,
  };
}

describe('buildReportCard — blended verdict (#572)', () => {
  it('committed + OK → KEEP (one CLI, clean reliability)', () => {
    const reg = ['a', 'b', 'c', 'd'].map((id) => sess('/repo/keep', id, 'cli'));
    const card = buildReportCard(reg, [], []);
    const p = card.projects.find((x) => x.cwd === '/repo/keep')!;
    expect(p.attributionBucket).toBe('committed');
    expect(p.dragBucket).toBe('OK');
    expect(p.verdict).toBe('KEEP');
  });

  it('committed + HEAVY → MOVE (one CLI, but actively expensive)', () => {
    const ids = ['m1', 'm2', 'm3', 'm4'];
    const reg = ids.map((id) => sess('/repo/move', id, 'sdk-cli'));
    // retry storms (attempt >= 8) → +40; p90 TTFB >= 5s → +25; >60s wasted → +15
    const telem = ids.flatMap((id) => [tele(id, 9, 30000), tele(id, 2, 1000)]);
    const debug = ids.map((id) => dbg(id, 13000, 5));
    const card = buildReportCard(reg, telem, debug);
    const p = card.projects.find((x) => x.cwd === '/repo/move')!;
    expect(p.attributionBucket).toBe('committed');
    expect(p.dragBucket).toBe('HEAVY');
    expect(p.verdict).toBe('MOVE');
    expect(p.maxAttempt).toBeGreaterThanOrEqual(8);
  });

  it('split entrypoints → FLAG regardless of drag', () => {
    const reg = [
      sess('/repo/split', 's1', 'cli'),
      sess('/repo/split', 's2', 'cli'),
      sess('/repo/split', 's3', 'sdk-cli'),
      sess('/repo/split', 's4', 'sdk-cli'),
    ];
    const card = buildReportCard(reg, [], []);
    const p = card.projects.find((x) => x.cwd === '/repo/split')!;
    expect(p.attributionBucket).toBe('split');
    expect(p.verdict).toBe('FLAG');
  });

  it('low-signal (<=2 sessions) → MOVE', () => {
    const reg = [sess('/repo/tiny', 't1', 'cli'), sess('/repo/tiny', 't2', 'cli')];
    const card = buildReportCard(reg, [], []);
    const p = card.projects.find((x) => x.cwd === '/repo/tiny')!;
    expect(p.attributionBucket).toBe('low-signal');
    expect(p.verdict).toBe('MOVE');
  });

  it('committed + DRAG → FLAG (a reliability tax, not yet disqualifying)', () => {
    const ids = ['d1', 'd2', 'd3', 'd4'];
    const reg = ids.map((id) => sess('/repo/drag', id, 'cli'));
    // Only p90 TTFB >= 5s → +25 → DRAG bucket (20..44), attribution committed → FLAG
    const debug = ids.map((id) => dbg(id, 6000));
    const card = buildReportCard(reg, [], debug);
    const p = card.projects.find((x) => x.cwd === '/repo/drag')!;
    expect(p.attributionBucket).toBe('committed');
    expect(p.dragBucket).toBe('DRAG');
    expect(p.verdict).toBe('FLAG');
  });

  it('tally + fleet rollup reflect per-project verdicts', () => {
    const reg = [
      ...['a', 'b', 'c', 'd'].map((id) => sess('/repo/keep', id, 'cli')),
      sess('/repo/tiny', 't1', 'cli'),
      sess('/repo/tiny', 't2', 'cli'),
    ];
    const card = buildReportCard(reg, [], []);
    expect(card.tally.KEEP).toBe(1);
    expect(card.tally.MOVE).toBe(1);
    expect(card.totalProjects).toBe(2);
    expect(card.totalSessions).toBe(6);
  });

  it('empty inputs → empty card', () => {
    const card = buildReportCard([], [], []);
    expect(card.projects).toEqual([]);
    expect(card.tally).toEqual({ KEEP: 0, FLAG: 0, MOVE: 0 });
  });
});
