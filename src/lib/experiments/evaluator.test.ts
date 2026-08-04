import { describe, it, expect } from 'vitest';
import {
  evaluateExperiments,
  MIN_SESSIONS_PER_ARM,
  EFFECT_THRESHOLD,
} from './evaluator';
import type { SessionEnrollment } from './enrollment-ledger';
import type { SessionTimeline, TimelineEntry } from '../parse-timeline';

const T0 = Date.parse('2026-06-10T00:00:00Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const SEC = 1000;

/**
 * Build a session whose metric is exactly `bfcCount` BFC windows out of
 * `toolCalls` total tool calls. Each BFC is one blocking backgroundable call
 * (30s block) followed by an assistant continuation; the remaining tool calls are
 * quick non-backgroundable reads. Normalized metric = bfcCount/toolCalls*100.
 */
function session(
  sessionId: string,
  bfcCount: number,
  toolCalls: number
): SessionTimeline {
  const entries: TimelineEntry[] = [{ timestamp: iso(0), kind: 'user', summary: 'go' }];
  let t = SEC;
  let placed = 0;
  for (let i = 0; i < toolCalls; i++) {
    entries.push({ timestamp: iso(t), kind: 'assistant', summary: 'ok' });
    t += SEC;
    if (placed < bfcCount) {
      // a blocking, backgroundable foreground call
      entries.push({ timestamp: iso(t), kind: 'tool_use', toolName: 'Bash', backgroundableKind: true });
      t += 30 * SEC; // > 10s floor
      placed++;
    } else {
      entries.push({ timestamp: iso(t), kind: 'tool_use', toolName: 'Read' });
      t += SEC;
    }
  }
  entries.push({ timestamp: iso(t), kind: 'assistant', summary: 'done' });
  return { sessionId, startTime: iso(0), endTime: iso(t), entries };
}

const enr = (
  sessionId: string,
  arm: string,
  assignment: SessionEnrollment['assignment'] = 'menu'
): SessionEnrollment => ({ sessionId, axis: 'background-first', arm, assignment });

function enrollMap(list: SessionEnrollment[]): Map<string, SessionEnrollment> {
  return new Map(list.map((e) => [e.sessionId, e]));
}

const AXIS_META = [{ key: 'background-first', label: 'Background-first (conversational availability)' }];

// Build N enrolled sessions for one arm at a fixed bfc-per-100-tool-calls rate.
// rate = bfc/toolCalls*100; with toolCalls=100, bfc === rate.
function arm(
  prefix: string,
  count: number,
  ratePer100: number
): { timelines: SessionTimeline[]; enrollments: SessionEnrollment[]; armId: string } {
  const armId = prefix.startsWith('on') ? 'on' : 'off';
  const timelines: SessionTimeline[] = [];
  const enrollments: SessionEnrollment[] = [];
  for (let i = 0; i < count; i++) {
    const id = `${prefix}-${i}`;
    timelines.push(session(id, ratePer100, 100));
    enrollments.push(enr(id, armId));
  }
  return { timelines, enrollments, armId };
}

describe('evaluateExperiments', () => {
  it('aggregates per arm with per-100-tool-call normalization', () => {
    // ON: 2 BFC per 100 calls; OFF: 8 per 100.
    const on = arm('on', MIN_SESSIONS_PER_ARM, 2);
    const off = arm('off', MIN_SESSIONS_PER_ARM, 8);
    const verdicts = evaluateExperiments(
      [...on.timelines, ...off.timelines],
      enrollMap([...on.enrollments, ...off.enrollments]),
      AXIS_META
    );
    expect(verdicts).toHaveLength(1);
    const v = verdicts[0];
    expect(v.arms.on.n).toBe(MIN_SESSIONS_PER_ARM);
    expect(v.arms.off.n).toBe(MIN_SESSIONS_PER_ARM);
    expect(v.arms.on.meanMetric).toBeCloseTo(2);
    expect(v.arms.off.meanMetric).toBeCloseTo(8);
    expect(v.n_total).toBe(2 * MIN_SESSIONS_PER_ARM);
    expect(v.label).toBe('Background-first (conversational availability)');
  });

  it('verdict = success when ON beats OFF by >= threshold and min-n met', () => {
    // ON 2/100 vs OFF 8/100 -> delta = (8-2)/8 = 0.75 >> threshold.
    const on = arm('on', MIN_SESSIONS_PER_ARM, 2);
    const off = arm('off', MIN_SESSIONS_PER_ARM, 8);
    const v = evaluateExperiments(
      [...on.timelines, ...off.timelines],
      enrollMap([...on.enrollments, ...off.enrollments]),
      AXIS_META
    )[0];
    expect(v.verdict).toBe('success');
    expect(v.delta).toBeGreaterThanOrEqual(EFFECT_THRESHOLD);
  });

  it('verdict = failure when ON is worse by >= threshold and min-n met', () => {
    // ON worse: ON 10/100 vs OFF 4/100 -> delta = (4-10)/4 = -1.5.
    const on = arm('on', MIN_SESSIONS_PER_ARM, 10);
    const off = arm('off', MIN_SESSIONS_PER_ARM, 4);
    const v = evaluateExperiments(
      [...on.timelines, ...off.timelines],
      enrollMap([...on.enrollments, ...off.enrollments]),
      AXIS_META
    )[0];
    expect(v.verdict).toBe('failure');
    expect(v.delta).toBeLessThanOrEqual(-EFFECT_THRESHOLD);
  });

  it('verdict = inconclusive when delta is within the noise band', () => {
    // ON 10/100 vs OFF 11/100 -> delta = 1/11 ≈ 0.09 < 0.15.
    const on = arm('on', MIN_SESSIONS_PER_ARM, 10);
    const off = arm('off', MIN_SESSIONS_PER_ARM, 11);
    const v = evaluateExperiments(
      [...on.timelines, ...off.timelines],
      enrollMap([...on.enrollments, ...off.enrollments]),
      AXIS_META
    )[0];
    expect(v.verdict).toBe('inconclusive');
  });

  it('division guard: OFF arm with all-zero metric -> inconclusive, delta null', () => {
    // Every OFF session has 0 BFC over real work (rate 0) -> off.meanMetric === 0,
    // so there is no usable baseline to divide by. Both arms meet min-n, so this
    // exercises the off.meanMetric===0 guard specifically (not the min-n gate).
    const on = arm('on', MIN_SESSIONS_PER_ARM, 2);
    const off = arm('off', MIN_SESSIONS_PER_ARM, 0);
    const v = evaluateExperiments(
      [...on.timelines, ...off.timelines],
      enrollMap([...on.enrollments, ...off.enrollments]),
      AXIS_META
    )[0];
    expect(v.arms.on.n).toBe(MIN_SESSIONS_PER_ARM);
    expect(v.arms.off.n).toBe(MIN_SESSIONS_PER_ARM);
    expect(v.arms.off.meanMetric).toBe(0);
    expect(v.verdict).toBe('inconclusive');
    expect(v.delta).toBeNull();
  });

  it('min-n gate: below MIN_SESSIONS_PER_ARM -> inconclusive even with a big delta', () => {
    // A huge ON advantage, but only n=1 ON / 0 OFF (the acceptance case).
    const onTl = session('on-solo', 0, 100); // 0 BFC -> best possible
    const verdicts = evaluateExperiments(
      [onTl],
      enrollMap([enr('on-solo', 'on')]),
      AXIS_META
    );
    expect(verdicts[0].verdict).toBe('inconclusive');
    expect(verdicts[0].arms.on.n).toBe(1);
    expect(verdicts[0].arms.off.n).toBe(0);
    expect(verdicts[0].arms.off.meanMetric).toBeNull();
  });

  it('min-n gate: just one arm under the floor -> inconclusive', () => {
    const on = arm('on', MIN_SESSIONS_PER_ARM, 2);
    const off = arm('off', MIN_SESSIONS_PER_ARM - 1, 8); // one short
    const v = evaluateExperiments(
      [...on.timelines, ...off.timelines],
      enrollMap([...on.enrollments, ...off.enrollments]),
      AXIS_META
    )[0];
    expect(v.verdict).toBe('inconclusive');
  });

  it('always carries provisional counterMetric + observational confidence + caveats', () => {
    const on = arm('on', MIN_SESSIONS_PER_ARM, 2);
    const off = arm('off', MIN_SESSIONS_PER_ARM, 8);
    const v = evaluateExperiments(
      [...on.timelines, ...off.timelines],
      enrollMap([...on.enrollments, ...off.enrollments]),
      AXIS_META
    )[0];
    expect(v.verdict).toBe('success'); // even on a success...
    expect(v.confidence).toBe('observational'); // ...menu assignment stays observational
    expect(v.counterMetric.status).toBe('not-auto-measured');
    expect(v.counterMetric.note).toMatch(/provisional/i);
    expect(v.caveats.length).toBeGreaterThanOrEqual(1);
    expect(v.caveats.join(' ')).toMatch(/under-count/i); // control-arm bias caveat
  });

  it('blind assignment upgrades confidence to causal', () => {
    const timelines: SessionTimeline[] = [];
    const enrollments: SessionEnrollment[] = [];
    for (let i = 0; i < MIN_SESSIONS_PER_ARM; i++) {
      timelines.push(session(`on-${i}`, 2, 100));
      enrollments.push(enr(`on-${i}`, 'on', 'blind'));
      timelines.push(session(`off-${i}`, 8, 100));
      enrollments.push(enr(`off-${i}`, 'off', 'blind'));
    }
    const v = evaluateExperiments(timelines, enrollMap(enrollments), AXIS_META)[0];
    expect(v.assignment).toBe('blind');
    expect(v.confidence).toBe('causal');
    // The menu-only caveat should be dropped under blind.
    expect(v.caveats.join(' ')).not.toMatch(/self-selected/i);
  });

  it('mixed regimes stay observational in BOTH insertion orders (#3126)', () => {
    // Same axis, one blind and one menu contributing session. The OLD code seeded
    // the axis assignment from the FIRST enrollment only, so a blind-first order
    // reported `causal` and dropped the self-selection caveat — a claim its mixed
    // evidence cannot support, flippable by map-insertion order alone. Both orders
    // must now be observational and keep the self-selection caveat.
    const blind = enr('on-blind', 'on', 'blind');
    const menu = enr('off-menu', 'off', 'menu');
    const timelines = [session('on-blind', 2, 100), session('off-menu', 8, 100)];

    for (const order of [
      [blind, menu], // blind FIRST — the order that used to mislabel as causal
      [menu, blind], // menu FIRST
    ]) {
      const v = evaluateExperiments(timelines, enrollMap(order), AXIS_META)[0];
      expect(v.confidence).toBe('observational');
      expect(v.assignment).toBe('menu'); // never claims the blind regime
      // The self-selection contamination caveat is retained on the mix.
      expect(v.caveats.join(' ')).toMatch(/self-selected/i);
    }
  });

  it('falls back to the axis key when no registry label is supplied', () => {
    const v = evaluateExperiments(
      [session('on-solo', 0, 100)],
      enrollMap([enr('on-solo', 'on')]),
      [] // no axis metadata
    )[0];
    expect(v.label).toBe('background-first');
  });

  it('ignores enrolled sessions with no ingested timeline or no work', () => {
    const timelines = [session('on-1', 2, 100)]; // only one has a timeline
    const enrollments = enrollMap([
      enr('on-1', 'on'),
      enr('missing', 'off'), // no timeline -> ignored
      enr('no-work', 'off'), // timeline present but zero tool calls -> ignored
    ]);
    timelines.push(session('no-work', 0, 0));
    const v = evaluateExperiments(timelines, enrollments, AXIS_META)[0];
    expect(v.arms.on.n).toBe(1);
    expect(v.arms.off.n).toBe(0);
  });

  it('returns [] when there are no enrollments', () => {
    expect(evaluateExperiments([session('s', 1, 10)], new Map(), AXIS_META)).toEqual([]);
  });
});
