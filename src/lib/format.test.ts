import { describe, expect, it } from 'vitest';
import {
  formatDurationBetween,
  formatMetric,
  formatTokens,
  truncateMiddle,
  truncateTick,
} from './format';

describe('formatDurationBetween (#3271)', () => {
  it('marks a reversed-timestamp span as unavailable rather than negative', () => {
    // endIso precedes startIso by 1s → impossible duration, not "-1.0s".
    expect(
      formatDurationBetween('2026-01-01T00:00:01Z', '2026-01-01T00:00:00Z')
    ).toBe('—');
  });

  it('marks unparseable timestamps as unavailable', () => {
    expect(formatDurationBetween('not-a-date', '2026-01-01T00:00:00Z')).toBe('—');
    expect(formatDurationBetween('2026-01-01T00:00:00Z', 'not-a-date')).toBe('—');
  });

  it('renders a zero-length span as 0.0s', () => {
    expect(
      formatDurationBetween('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    ).toBe('0.0s');
  });

  it('retains sub-second, second, minute, and hour formatting for valid spans', () => {
    expect(
      formatDurationBetween('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.500Z')
    ).toBe('0.5s');
    expect(
      formatDurationBetween('2026-01-01T00:00:00Z', '2026-01-01T00:00:45Z')
    ).toBe('45.0s');
    expect(
      formatDurationBetween('2026-01-01T00:00:00Z', '2026-01-01T00:03:00Z')
    ).toBe('3.0m');
    expect(
      formatDurationBetween('2026-01-01T00:00:00Z', '2026-01-01T02:00:00Z')
    ).toBe('2.0h');
  });
});

describe('truncateMiddle (#457)', () => {
  it('returns the input unchanged when it already fits', () => {
    expect(truncateMiddle('Read', 18)).toBe('Read');
    expect(truncateMiddle('exactly-eighteen!!', 18)).toBe('exactly-eighteen!!');
  });

  it('keeps both ends with a middle ellipsis when too long', () => {
    const out = truncateMiddle('bridge-cse_0112WsGgVyWw9WM4XB6vonzT', 18);
    expect(out.length).toBe(18);
    expect(out).toContain('…');
    expect(out.startsWith('bridge')).toBe(true);
    expect(out.endsWith('vonzT')).toBe(true);
  });

  it('preserves the meaningful tail of a path-like label', () => {
    const out = truncateMiddle('~/project/claude-history-dashboard', 20);
    expect(out.length).toBe(20);
    expect(out.startsWith('~/')).toBe(true);
    expect(out.endsWith('dashboard')).toBe(true);
  });

  it('is a no-op for degenerate max values', () => {
    expect(truncateMiddle('anything', 1)).toBe('anything');
    expect(truncateMiddle('anything', 0)).toBe('anything');
  });

  it('truncateTick coerces non-strings and applies the cap', () => {
    const fmt = truncateTick(10);
    expect(fmt('short')).toBe('short');
    expect(fmt(1234)).toBe('1234');
    expect(fmt('a-very-long-tool-name').length).toBe(10);
  });
});

describe('formatMetric (#792 bounded card compaction)', () => {
  it('leaves sub-thousand counts whole', () => {
    expect(formatMetric(0)).toBe('0');
    expect(formatMetric(42)).toBe('42');
    expect(formatMetric(999)).toBe('999');
  });

  it('compacts with the right K/M/B/T suffix', () => {
    expect(formatMetric(1_000)).toBe('1K');
    expect(formatMetric(1_234)).toBe('1.2K');
    expect(formatMetric(12_345)).toBe('12.3K');
    expect(formatMetric(123_456)).toBe('123K');
    expect(formatMetric(1_234_567)).toBe('1.2M');
    expect(formatMetric(2_500_000_000)).toBe('2.5B');
    expect(formatMetric(3_000_000_000_000)).toBe('3T');
  });

  it('promotes a rounding carry into the next unit (no "1000K")', () => {
    expect(formatMetric(999_999)).toBe('1M');
    expect(formatMetric(999_500)).toBe('1M');
    expect(formatMetric(999_999_999)).toBe('1B');
    expect(formatMetric(999_999_999_999)).toBe('1T');
  });

  it('keeps the sign on negatives', () => {
    expect(formatMetric(-1_500)).toBe('-1.5K');
  });

  it('never exceeds the 6-char card budget for finite inputs below 1e15', () => {
    // The metric-card layout + #793 gate are sized for <=6 chars. Spot-check a
    // dense sweep of magnitudes and the awkward round-up boundaries.
    const samples = [
      0, 1, 9, 99, 999, 1_000, 9_999, 99_999, 999_999, 1_000_000, 9_999_999,
      999_999_999, 1_000_000_000, 999_999_999_999, 1_000_000_000_000,
      999_949_999_999, // rounds toward `1T` territory without expanding
    ];
    for (const n of samples) {
      expect(formatMetric(n).length).toBeLessThanOrEqual(6);
      expect(formatMetric(-n).length).toBeLessThanOrEqual(7); // sign adds one
    }
  });

  it('falls back to 0 for non-finite input', () => {
    expect(formatMetric(Infinity)).toBe('0');
    expect(formatMetric(NaN)).toBe('0');
  });
});

describe('formatTokens (#795 B/T suffixes)', () => {
  it('keeps the one-decimal K/M style', () => {
    expect(formatTokens(42)).toBe('42');
    expect(formatTokens(1_234)).toBe('1.2K');
    expect(formatTokens(1_234_567)).toBe('1.2M');
  });

  it('uses B for billions instead of expanding to thousands of M (#795)', () => {
    // The regression: 4,813,900,000 rendered as `4813.9M` next to formatMetric's `4.8B`.
    expect(formatTokens(4_813_900_000)).toBe('4.8B');
    expect(formatTokens(2_500_000_000)).toBe('2.5B');
  });

  it('uses T for trillions', () => {
    expect(formatTokens(1_000_000_000_000)).toBe('1.0T');
    expect(formatTokens(3_400_000_000_000)).toBe('3.4T');
  });
});
