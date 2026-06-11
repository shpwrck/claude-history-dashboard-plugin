/**
 * Tests for reliability.agent-report-card wording (#1103).
 *
 * The MOVE verdict is overloaded: a project is MOVE either because it is
 * committed-with-HEAVY-drag, OR because it is low-signal (<=2 sessions, drag
 * OK). The audited bug was the detail calling ALL MOVE projects "heavy
 * reliability drag" — false for low-signal rows. These tests pin the
 * disambiguated wording.
 */
import { describe, it, expect } from 'vitest';
import { detector } from './agent-report-card';
import type { RecommendationInput } from '../types';
import type { SessionRegistryEntry } from '../../parse-session-registry';
import type { TelemetryEvent } from '../../parse-telemetry';
import type { DebugSessionMetrics } from '../../parse-debug';

const env = {
  node_version: 'v22.0.0', terminal: 'tmux', wsl_version: '2',
  linux_distro_id: 'ubuntu', arch: 'x64', build_time: '2026-06-01',
};
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
const sess = (cwd: string, sessionId: string, entrypoint: string): SessionRegistryEntry => ({
  pid: Math.abs(hash(sessionId)) % 100000, sessionId, cwd,
  startedAt: 1_700_000_000_000, procStart: '12345', version: '2.1.161',
  peerProtocol: 1, kind: 'interactive', entrypoint,
});
const tele = (sessionId: string, attempt: number, elapsed_ms: number): TelemetryEvent => ({
  event_name: 'tengu_api_slow_first_byte', client_timestamp: '2026-06-01T00:00:00Z',
  model: 'claude-opus-4-8', betas: '', session_id: sessionId, attempt, elapsed_ms, env,
});
const dbg = (sessionId: string, p90: number, fastModeLost = 0): DebugSessionMetrics => ({
  sessionId, ttfbP50: Math.round(p90 / 2), ttfbP90: p90, ttfbMax: p90,
  ttfbSampleCount: 5, maxRetryAttempt: 1, slowFirstByteCount: 0, fastModeLostCount: fastModeLost,
});

const input = (
  sessionRegistry: SessionRegistryEntry[],
  telemetry: TelemetryEvent[] = [],
  debugLogs: DebugSessionMetrics[] = []
): RecommendationInput => ({
  tokenData: [], toolData: [], sessions: [], projects: [], permissionRows: [], apiErrors: [],
  liveConfig: null, sessionRegistry, telemetry, debugLogs,
});

// A committed project with HEAVY drag (retry storms + slow TTFB + waste) → MOVE.
const heavyIds = ['m1', 'm2', 'm3', 'm4'];
const heavyReg = heavyIds.map((id) => sess('/repo/heavy', id, 'cli'));
const heavyTele = heavyIds.flatMap((id) => [tele(id, 9, 30000), tele(id, 2, 1000)]);
const heavyDebug = heavyIds.map((id) => dbg(id, 13000, 5));
// A low-signal project (<=2 sessions, no telemetry) → MOVE with drag OK.
const tinyReg = [sess('/repo/tiny', 't1', 'cli'), sess('/repo/tiny', 't2', 'cli')];

describe('reliability.agent-report-card MOVE wording (#1103)', () => {
  it('describes a committed-HEAVY MOVE as heavy reliability drag', () => {
    const rec = detector.rule(input(heavyReg, heavyTele, heavyDebug), 0)!;
    expect(rec.severity).toBe('warning');
    expect(rec.detail).toContain('heavy reliability drag');
    expect(rec.detail).not.toContain('too little evidence');
  });

  it('describes a low-signal MOVE as insufficient evidence, NOT heavy drag', () => {
    const rec = detector.rule(input(tinyReg), 0)!;
    // the low-signal project's drag row is OK (score 0) — must not be called heavy
    expect(rec.detail).toContain('too little evidence');
    expect(rec.detail).not.toContain('heavy reliability drag');
    const tinyRow = rec.evidence!.find((e) => e.includes('tiny'))!;
    expect(tinyRow).toContain('drag 0 (OK)');
  });

  it('disambiguates both kinds when present together', () => {
    const rec = detector.rule(input([...heavyReg, ...tinyReg], heavyTele, heavyDebug), 0)!;
    expect(rec.detail).toContain('heavy reliability drag');
    expect(rec.detail).toContain('too little evidence');
  });
});
