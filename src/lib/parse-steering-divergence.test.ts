import { describe, expect, it } from 'vitest';
import type { SessionTokenData, TokenEntry } from '../types';
import { parseRuntimeEvents } from './parse-runtime-events';
import {
  extractTaskSteeringFromTranscript,
  isStructuralCorrective,
} from './parse-steering';
import {
  STEERING_ANCHOR_FIXTURE,
  type LabeledSteeringTurn,
} from './__fixtures__/steering-anchor-fixture';

// ── Precision/recall harness against the labeled anchor fixture (#1751) ───────

interface ConfusionMatrix {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

function evaluate(turns: LabeledSteeringTurn[]): ConfusionMatrix {
  const m: ConfusionMatrix = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const turn of turns) {
    const pred = isStructuralCorrective(turn.text, turn.firstInSpan);
    if (pred && turn.corrective) m.tp += 1;
    else if (pred && !turn.corrective) m.fp += 1;
    else if (!pred && turn.corrective) m.fn += 1;
    else m.tn += 1;
  }
  return m;
}

function precision(m: ConfusionMatrix): number {
  const denom = m.tp + m.fp;
  return denom === 0 ? 1 : m.tp / denom;
}

function recall(m: ConfusionMatrix): number {
  const denom = m.tp + m.fn;
  return denom === 0 ? 1 : m.tp / denom;
}

const PRECISION_GATE = 0.7;

describe('structural-anchor corrective classifier (#1751)', () => {
  it('ships a labeled anchor fixture of at least 50 turns', () => {
    expect(STEERING_ANCHOR_FIXTURE.length).toBeGreaterThanOrEqual(50);
    // Reasonably balanced so precision/recall are meaningful.
    const corrective = STEERING_ANCHOR_FIXTURE.filter((t) => t.corrective).length;
    expect(corrective).toBeGreaterThan(STEERING_ANCHOR_FIXTURE.length * 0.3);
    expect(corrective).toBeLessThan(STEERING_ANCHOR_FIXTURE.length * 0.7);
  });

  it('clears the corrective precision gate on the anchor set', () => {
    const m = evaluate(STEERING_ANCHOR_FIXTURE);
    const p = precision(m);
    const r = recall(m);
    // Reported for the audit trail; the gate is precision >= 0.7.
    console.log(
      `[#1751] anchor-set precision=${p.toFixed(3)} recall=${r.toFixed(3)} ` +
        `(tp=${m.tp} fp=${m.fp} fn=${m.fn} tn=${m.tn})`
    );
    expect(p).toBeGreaterThanOrEqual(PRECISION_GATE);
  });

  it('treats the kickoff turn (no prior assistant action) as non-corrective', () => {
    // The same text is corrective mid-span but a fresh task kickoff first.
    expect(isStructuralCorrective('no, that uses the wrong endpoint', true)).toBe(
      false
    );
    expect(isStructuralCorrective('no, that uses the wrong endpoint', false)).toBe(
      true
    );
  });

  it('rejects additive instructions even when they contain stray lexicon words', () => {
    expect(
      isStructuralCorrective('now add a check for the wrong-password case', false)
    ).toBe(false);
    expect(
      isStructuralCorrective('also create a test that asserts the error path', false)
    ).toBe(false);
  });

  it('does not concentrate errors in a single user cohort (bias test)', () => {
    const cohorts: LabeledSteeringTurn['cohort'][] = [
      'terse',
      'polite',
      'verbose',
    ];
    const errorRates = cohorts.map((cohort) => {
      const turns = STEERING_ANCHOR_FIXTURE.filter((t) => t.cohort === cohort);
      const m = evaluate(turns);
      const errors = m.fp + m.fn;
      return { cohort, rate: errors / turns.length, errors, n: turns.length };
    });
    console.log(
      '[#1751] per-cohort error rate: ' +
        errorRates
          .map((e) => `${e.cohort}=${e.rate.toFixed(3)} (${e.errors}/${e.n})`)
          .join(', ')
    );
    // No single cohort may carry more than 60% of all classifier errors — i.e.
    // the failures are spread across phrasing styles, not concentrated in one
    // user's voice.
    const totalErrors = errorRates.reduce((sum, e) => sum + e.errors, 0);
    if (totalErrors > 0) {
      const worst = Math.max(...errorRates.map((e) => e.errors));
      expect(worst / totalErrors).toBeLessThanOrEqual(0.6);
    }
    // And every cohort must independently clear a loose error ceiling so the
    // signal is not silently useless for one style.
    for (const e of errorRates) {
      expect(e.rate).toBeLessThanOrEqual(0.3);
    }
  });
});

// ── divergenceRate end-to-end through computeTaskSteering ──────────────────────

const line = (value: Record<string, unknown>) => JSON.stringify(value);

function userLine(
  content: unknown,
  timestamp: string,
  extra: Record<string, unknown> = {}
): string {
  return line({
    type: 'user',
    timestamp,
    message: { role: 'user', content },
    ...extra,
  });
}

function stopLine(timestamp: string, preventedContinuation = false): string {
  return line({
    type: 'system',
    subtype: 'stop_hook_summary',
    timestamp,
    hookCount: 1,
    hookInfos: [{ command: 'notify', durationMs: 50 }],
    hookErrors: [],
    preventedContinuation,
  });
}

function tokenEntry(timestamp: string): TokenEntry {
  return {
    timestamp,
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    model: 'claude-sonnet-4',
  };
}

function tokenData(entries: TokenEntry[]): SessionTokenData {
  return {
    sessionId: 'div-session',
    project: '/repo/app',
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    model: 'claude-sonnet-4',
    messageCount: entries.length,
    entries,
    compactionEvents: [],
    hasUnknownModel: false,
  };
}

describe('TaskSteering.divergenceRate', () => {
  it('emits a per-task corrective-rate and excludes the kickoff turn', () => {
    const transcript = [
      // span 0 — kickoff (not corrective even though phrased correctively-ish)
      userLine('implement the parser', '2026-01-01T00:00:00.000Z', {
        cwd: '/repo/app',
      }),
      stopLine('2026-01-01T00:00:05.000Z'),
      // span 1 — two human turns: one corrective, one additive
      userLine('no, revert that, you changed the wrong file', '2026-01-01T00:00:06.000Z', {
        cwd: '/repo/app',
      }),
      userLine('now also add a test', '2026-01-01T00:00:07.000Z', {
        cwd: '/repo/app',
      }),
      stopLine('2026-01-01T00:00:10.000Z'),
    ].join('\n');
    const runtime = parseRuntimeEvents(transcript, 'div-session.jsonl');
    const rows = extractTaskSteeringFromTranscript(transcript, 'div-session.jsonl', {
      fallbackProject: '/repo/app',
      runtimeEvents: runtime,
      tokenData: tokenData([tokenEntry('2026-01-01T00:00:06.500Z')]),
    });

    const span1 = rows.find((row) => row.taskIndex === 1);
    expect(span1).toBeTruthy();
    expect(span1?.humanTurns).toBe(2);
    expect(span1?.corrective).toBe(1);
    // 1 corrective / 2 human turns.
    expect(span1?.divergenceRate).toBeCloseTo(0.5, 3);
  });

  it('reports a zero divergence rate when there are no corrective turns', () => {
    const transcript = [
      userLine('build the feature', '2026-02-01T00:00:00.000Z', {
        cwd: '/repo/app',
      }),
      stopLine('2026-02-01T00:00:05.000Z'),
      userLine('looks good, ship it', '2026-02-01T00:00:06.000Z', {
        cwd: '/repo/app',
      }),
      stopLine('2026-02-01T00:00:09.000Z'),
    ].join('\n');
    const runtime = parseRuntimeEvents(transcript, 'div-session.jsonl');
    const rows = extractTaskSteeringFromTranscript(transcript, 'div-session.jsonl', {
      fallbackProject: '/repo/app',
      runtimeEvents: runtime,
    });
    for (const row of rows) {
      expect(row.corrective).toBe(0);
      expect(row.divergenceRate).toBe(0);
    }
  });
});
