import { describe, it, expect } from 'vitest';
import { detector } from './hook-errors';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { LiveConfig } from '../../../types';
import type { RuntimeEvents } from '../../parse-runtime-events';

const stop = (hadErrors: boolean, prevented = false) => ({
  sessionId: 's1', timestamp: 't', hookCount: 1, totalDurationMs: 0,
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

const threeErrors = () => [runtime([stop(true), stop(true), stop(true)])];

describe('reliability.hook-errors (#419)', () => {
  it('fires at 3+ error events', () => {
    const rec = detector.rule(input(threeErrors()), 0);
    expect(rec?.id).toBe('reliability.hook-errors');
    expect(rec?.affected).toBe(3);
  });
  it('stays silent below 3 or with no events', () => {
    expect(detector.rule(input([runtime([stop(true), stop(false)])]), 0)).toBeNull();
    expect(detector.rule(input(), 0)).toBeNull();
  });

  // ── Stale-input demotion (#1102) ─────────────────────────────────────────
  it('keeps present-tense warning when liveConfig is null (can-not-tell)', () => {
    const rec = detector.rule(input(threeErrors(), null), 0);
    expect(rec!.severity).toBe('warning');
    expect(rec!.title).toBe('Stop hooks are firing with errors');
  });
  it('keeps present-tense warning when a Stop hook IS configured', () => {
    const rec = detector.rule(input(threeErrors(), lc(true)), 0);
    expect(rec!.severity).toBe('warning');
    expect(rec!.title).toContain('are firing');
  });
  it('demotes to past tense + info when readable config has NO Stop hook', () => {
    const rec = detector.rule(input(threeErrors(), lc(false)), 0);
    expect(rec!.severity).toBe('info');
    expect(rec!.title).toContain('none configured now');
    expect(rec!.detail).toContain('historical');
    expect(rec!.detail).not.toContain('silently does nothing'); // present-tense claim gone
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
