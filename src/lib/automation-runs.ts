import type { SessionTimeline } from './parse-timeline';
import { isUnattendedEntrypoint } from './parse-sessions';

/**
 * One unattended (`sdk-*`) run, positioned within the dataset window for the
 * Automation timeline strip (#300). `leftPct`/`widthPct` are 0–100 offsets so
 * the strip can render each run with a single absolutely-positioned bar,
 * mirroring how the rest of the dashboard places time-bucketed marks.
 */
export interface AutomationRun {
  sessionId: string;
  entrypoint: string;
  startMs: number;
  endMs: number;
  entryCount: number;
  /** Left edge as a percentage of the dataset window (0–100). */
  leftPct: number;
  /** Width as a percentage of the dataset window (0–100); zero-duration runs
   * use CSS min-width:2px for visibility without lying about duration. */
  widthPct: number;
}

export interface AutomationTimeline {
  runs: AutomationRun[];
  /** Window start (epoch ms) — earliest start across the selected runs. */
  windowStartMs: number;
  /** Window end (epoch ms) — latest end across the selected runs. */
  windowEndMs: number;
}

function toMs(iso: string): number {
  const t = new Date(iso).getTime();
  return isNaN(t) ? NaN : t;
}

/**
 * Select the unattended (`sdk-*`) runs from a set of parsed session timelines
 * and position each over the dataset time window.
 *
 * Read-only reuse of the `entrypoint`/`startTime`/`endTime` fields already on
 * `SessionTimeline` (no parser change). Interactive `cli` runs are excluded.
 * Runs with unparseable timestamps are dropped. The result is sorted by start
 * time ascending. The window spans the earliest start to the latest end across
 * the selected runs; an empty selection yields an empty `runs` array and a
 * zero window.
 */
export function selectAutomationRuns(
  timelines: SessionTimeline[]
): AutomationTimeline {
  const selected = timelines
    .filter((t) => isUnattendedEntrypoint(t.entrypoint))
    .map((t) => ({
      sessionId: t.sessionId,
      entrypoint: t.entrypoint as string,
      startMs: toMs(t.startTime),
      endMs: toMs(t.endTime),
      entryCount: t.entries.length,
    }))
    .filter((r) => !isNaN(r.startMs) && !isNaN(r.endMs))
    // A run can't end before it starts; clamp by treating it as instantaneous.
    .map((r) => ({ ...r, endMs: Math.max(r.endMs, r.startMs) }))
    .sort((a, b) => a.startMs - b.startMs);

  if (selected.length === 0) {
    return { runs: [], windowStartMs: 0, windowEndMs: 0 };
  }

  const windowStartMs = selected[0].startMs;
  const windowEndMs = selected.reduce((max, r) => Math.max(max, r.endMs), windowStartMs);
  const span = windowEndMs - windowStartMs;

  const runs: AutomationRun[] = selected.map((r) => {
    const leftPct = span > 0 ? ((r.startMs - windowStartMs) / span) * 100 : 0;
    const rawWidth = span > 0 ? ((r.endMs - r.startMs) / span) * 100 : 0;
    // Do not inflate width artificially — rely on CSS min-width:2px for
    // visibility so bar length stays proportional to true duration. Clamp so
    // it never overflows the strip.
    const widthPct = Math.min(100 - leftPct, Math.max(rawWidth, 0));
    return { ...r, leftPct, widthPct };
  });

  return { runs, windowStartMs, windowEndMs };
}
