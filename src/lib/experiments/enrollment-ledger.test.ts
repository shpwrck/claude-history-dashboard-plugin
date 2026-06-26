import { describe, it, expect } from 'vitest';
import { parseEnrollmentLedger } from './enrollment-ledger';

const line = (o: Record<string, unknown>) => JSON.stringify(o);

describe('parseEnrollmentLedger', () => {
  it('parses one enrollment into a per-session record', () => {
    const text = line({
      ts: '2026-06-26T18:33:27.464Z',
      sessionId: 's1',
      axis: 'background-first',
      arm: 'on',
      assignment: 'menu',
    });
    const m = parseEnrollmentLedger(text);
    expect(m.size).toBe(1);
    expect(m.get('s1')).toEqual({
      sessionId: 's1',
      axis: 'background-first',
      arm: 'on',
      assignment: 'menu',
    });
  });

  it('latest record per session wins', () => {
    const text = [
      line({ sessionId: 's1', axis: 'background-first', arm: 'off', assignment: 'menu' }),
      line({ sessionId: 's2', axis: 'background-first', arm: 'on', assignment: 'menu' }),
      // s1 re-enrolls — the later line must win.
      line({ sessionId: 's1', axis: 'background-first', arm: 'on', assignment: 'menu' }),
    ].join('\n');
    const m = parseEnrollmentLedger(text);
    expect(m.get('s1')?.arm).toBe('on');
    expect(m.get('s2')?.arm).toBe('on');
    expect(m.size).toBe(2);
  });

  it('is fail-open on missing/empty input (no crash, empty map)', () => {
    expect(parseEnrollmentLedger(null).size).toBe(0);
    expect(parseEnrollmentLedger(undefined).size).toBe(0);
    expect(parseEnrollmentLedger('').size).toBe(0);
    expect(parseEnrollmentLedger('   \n  \n').size).toBe(0);
  });

  it('skips garbage lines individually but keeps the valid ones', () => {
    const text = [
      'not json at all',
      '{ broken',
      line({ sessionId: 's1', axis: 'background-first', arm: 'on', assignment: 'menu' }),
      // missing required fields -> skipped
      line({ sessionId: 's2', axis: 'background-first' }),
      // bad assignment -> skipped
      line({ sessionId: 's3', axis: 'background-first', arm: 'on', assignment: 'whatever' }),
      // empty sessionId -> skipped
      line({ sessionId: '', axis: 'background-first', arm: 'on', assignment: 'menu' }),
    ].join('\n');
    const m = parseEnrollmentLedger(text);
    expect([...m.keys()]).toEqual(['s1']);
  });

  it('accepts the blind assignment regime', () => {
    const text = line({
      sessionId: 's1',
      axis: 'background-first',
      arm: 'on',
      assignment: 'blind',
    });
    expect(parseEnrollmentLedger(text).get('s1')?.assignment).toBe('blind');
  });
});
