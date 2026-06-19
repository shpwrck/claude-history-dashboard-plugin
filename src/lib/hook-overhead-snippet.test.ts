import { describe, expect, it } from 'vitest';
import { hookOverheadCorrective } from './hook-overhead-snippet';

describe('hookOverheadCorrective', () => {
  it('quotes the actual measured mean/max/timed-events so it never fabricates overhead', () => {
    const text = hookOverheadCorrective({
      meanTimedDurationMs: 6200,
      maxDurationMs: 9100,
      timedEvents: 42,
    });
    expect(text).toContain('6.2s'); // mean
    expect(text).toContain('9.1s'); // max
    expect(text).toContain('42 timed stop event');
  });

  it('escalates the lead line when the mean clears the detector heavy bar (>= 5s)', () => {
    const heavy = hookOverheadCorrective({
      meanTimedDurationMs: 5000,
      maxDurationMs: 7000,
      timedEvents: 10,
    });
    expect(heavy).toContain('paid on every turn');
    expect(heavy).not.toContain('worth reviewing before it grows');
  });

  it('uses the lighter review framing below the heavy bar', () => {
    const light = hookOverheadCorrective({
      meanTimedDurationMs: 2500,
      maxDurationMs: 4000,
      timedEvents: 7,
    });
    expect(light).toContain('worth reviewing before it grows');
    expect(light).not.toContain('paid on every turn');
  });

  it('steers to the settings.json hooks as the actionable path, not a navigate', () => {
    const text = hookOverheadCorrective({
      meanTimedDurationMs: 5500,
      maxDurationMs: 8000,
      timedEvents: 12,
    });
    expect(text).toContain('.claude/settings.json');
    expect(text.toLowerCase()).toContain('asynchronous');
    expect(text.toLowerCase()).toContain('drop the hook');
  });

  it('is prose only — no heredoc / shell-injection delimiters', () => {
    const text = hookOverheadCorrective({
      meanTimedDurationMs: 5500,
      maxDurationMs: 8000,
      timedEvents: 12,
    });
    expect(text).not.toContain('<<');
    expect(text).not.toContain('EOF');
    expect(text).not.toContain('$(');
    expect(text).not.toContain('`;');
  });
});
