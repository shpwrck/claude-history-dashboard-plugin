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
    expect(text).toContain('42 timed Stop event');
  });

  it('describes a heavy mean as covering only the timed subset', () => {
    const heavy = hookOverheadCorrective({
      meanTimedDurationMs: 5000,
      maxDurationMs: 7000,
      timedEvents: 10,
    });
    expect(heavy).toContain('Among 10 timed Stop events');
    expect(heavy).toContain('averaged 5.0s');
    expect(heavy).not.toMatch(/\b(?:every|each|per) turn\b/i);
    expect(heavy).not.toContain('worth reviewing before it grows');
  });

  it('uses the lighter review framing below the heavy bar', () => {
    const light = hookOverheadCorrective({
      meanTimedDurationMs: 2500,
      maxDurationMs: 4000,
      timedEvents: 7,
    });
    expect(light).toContain('worth reviewing before it grows');
    expect(light).not.toMatch(/\b(?:every|each|per) turn\b/i);
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
