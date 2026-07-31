import { describe, it, expect } from 'vitest';
import { detector } from './hook-errors';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { LiveConfig } from '../../../types';
import type { RuntimeEvents } from '../../parse-runtime-events';

const stop = (
  hadErrors: boolean,
  prevented = false,
  timestamp = '2026-06-01T10:00:00.000Z'
) => ({
  sessionId: 's1', timestamp, hookCount: 1, totalDurationMs: 0,
  hadErrors, preventedContinuation: prevented,
});
const runtime = (stopHooks: ReturnType<typeof stop>[]): RuntimeEvents =>
  ({ sessionId: 's1', turns: [], stopHooks, awaySummaries: [], scheduledFires: [] } as unknown as RuntimeEvents);

/** Minimal LiveConfig with a controllable Stop-hook presence. */
const lc = (stopConfigured: boolean): LiveConfig =>
  ({
    settings: stopConfigured ? { hooks: { Stop: [{ hooks: [{ command: 'x' }] }] } } : { hooks: {} },
    mcpServers: [],
  } as unknown as LiveConfig);

const input = (runtimeEvents?: RuntimeEvents[], liveConfig: LiveConfig | null = null): RecommendationInput => ({
  tokenData: [], toolData: [], sessions: [], projects: [], permissionRows: [], apiErrors: [],
  liveConfig, runtimeEvents,
});

const threeErrors = () => [
  runtime([
    stop(true, false, '2026-05-30T10:00:00.000Z'),
    stop(true, false, '2026-06-01T10:00:00.000Z'),
    stop(true, false, '2026-05-31T10:00:00.000Z'),
  ]),
];

describe('reliability.hook-errors (#419)', () => {
  it('fires at 3+ error events', () => {
    const rec = detector.rule(input(threeErrors(), lc(true)), 0);
    expect(rec?.id).toBe('reliability.hook-errors');
    expect(rec?.affected).toBe(3);
  });
  it('stays silent below 3 or with no events', () => {
    expect(detector.rule(input([runtime([stop(true), stop(false)])]), 0)).toBeNull();
    expect(detector.rule(input(), 0)).toBeNull();
  });

  // ── Stale-input demotion (#1102, tightened by #3210) ─────────────────────
  it('keeps present-tense warning only when a Stop hook IS confirmed configured', () => {
    const rec = detector.rule(input(threeErrors(), lc(true)), 0);
    expect(rec!.severity).toBe('warning');
    expect(rec!.title).toContain('are firing');
    // Even the current-tense claim carries its newest-event anchor date.
    expect(rec!.provenance!.asOf).toBe('2026-06-01');
  });
  it('demotes to dated historical info when liveConfig is null (#3210 acceptance)', () => {
    const rec = detector.rule(input(threeErrors(), null), 0)!;
    expect(rec.severity).toBe('info');
    expect(rec.title).toContain('current hook status unknown');
    // Newest event date surfaces as "As of YYYY-MM-DD" and matches provenance.
    expect(rec.detail).toContain('As of 2026-06-01');
    expect(rec.provenance!.asOf).toBe('2026-06-01');
    // No present-tense current-failure assertion survives the demotion.
    expect(rec.detail).not.toContain('silently does nothing');
    expect(rec.title).not.toContain('are firing');
  });
  it('demotes to past tense + info when readable config has NO Stop hook', () => {
    const rec = detector.rule(input(threeErrors(), lc(false)), 0);
    expect(rec!.severity).toBe('info');
    expect(rec!.title).toContain('none configured now');
    expect(rec!.detail).toContain('historical');
    expect(rec!.detail).toContain('As of 2026-06-01');
    expect(rec!.detail).not.toContain('silently does nothing'); // present-tense claim gone
  });
  it('never fabricates a date when event timestamps are unreadable', () => {
    const rec = detector.rule(
      input([runtime([stop(true, false, 't'), stop(true, false, 't'), stop(true, false, 't')])], null),
      0
    )!;
    expect(rec.severity).toBe('info');
    expect(rec.detail).not.toContain('As of');
    expect(rec.provenance!.asOf).toBeUndefined();
    expect(validateRecommendationProvenance(rec)).toEqual([]);
  });
  it('always emits contract-compliant provenance citing both sources', () => {
    for (const cfg of [null, lc(true), lc(false)] as (LiveConfig | null)[]) {
      const rec = detector.rule(input(threeErrors(), cfg), 0)!;
      expect(validateRecommendationProvenance(rec)).toEqual([]);
      expect(rec.provenance!.observations.map((o) => o.source)).toEqual(
        expect.arrayContaining(['parse-runtime-events', 'settings.json'])
      );
    }
  });
});
