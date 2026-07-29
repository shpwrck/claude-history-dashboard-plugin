import { describe, expect, it } from 'vitest';
import { parseIsoInstantMs } from './iso-instant';

describe('parseIsoInstantMs', () => {
  it('rejects out-of-range clock and offset fields before Date.parse can normalize them', () => {
    // `24:00` is the dangerous case: Date.parse accepts it and silently rolls
    // the instant into the next day, so shape + finiteness alone mis-dates the
    // evidence (Codex review, PR #3472).
    expect(Date.parse('2026-06-09T24:00:00Z')).not.toBeNaN();
    expect(parseIsoInstantMs('2026-06-09T24:00:00Z')).toBeUndefined();
    expect(parseIsoInstantMs('2026-06-09T23:60:00Z')).toBeUndefined();
    expect(parseIsoInstantMs('2026-06-09T23:59:60Z')).toBeUndefined();
    expect(parseIsoInstantMs('2026-06-09T23:59:59+14:01')).toBeUndefined();
    expect(parseIsoInstantMs('2026-06-09T23:59:59+15:00')).toBeUndefined();
    expect(parseIsoInstantMs('2026-06-09T23:59:59+14:00')).toBe(
      Date.parse('2026-06-09T23:59:59+14:00')
    );
  });
});
