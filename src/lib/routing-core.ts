/**
 * React-free routing primitives (#2718). The time-preset vocabulary, the project
 * sentinel, and the pure `presetToRange` window math, extracted out of routing.ts
 * (which imports React and nav-prefs) so the SERVER — which must never import
 * React — can reproduce the masthead time filter's dataset-relative window
 * exactly, via the same code the browser runs. routing.ts re-exports every symbol
 * here, so all existing `from './routing'` imports are unaffected.
 */
export const TIME_PRESETS = ['24h', '7d', '30d', 'all'] as const;
export type TimePreset = (typeof TIME_PRESETS)[number];

export const ALL_PROJECTS = 'All projects';
export const DEFAULT_TIME_PRESET: TimePreset = '24h';

export interface TimeRange {
  from: number | null;
  to: number | null;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function presetToRange(
  preset: TimePreset,
  now = Date.now()
): TimeRange {
  if (preset === 'all') return { from: null, to: null };
  const to = Number.isFinite(now) ? now : Date.now();
  const span =
    preset === '24h' ? DAY_MS : preset === '7d' ? 7 * DAY_MS : 30 * DAY_MS;
  return { from: to - span, to };
}
