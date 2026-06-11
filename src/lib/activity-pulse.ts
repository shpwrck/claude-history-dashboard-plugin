import type { Session, ProjectStats } from '../types';

export interface DayBucket {
  date: string; // 'YYYY-MM-DD' local
  count: number;
  weekday: number; // 0=Sun..6=Sat (local)
}

export interface HourBucket {
  hour: number; // 0..23
  weekday: number; // 0..6
  count: number;
}

export interface ProjectMomentum {
  project: string;
  projectShort: string;
  sessionCount: number;
  firstSeen: number;
  lastSeen: number;
  weeksActive: number;
  sessionsPerWeek: number;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;

function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Validate session.startTime and return the local Date, or null if unusable.
function validStartDate(s: Session): Date | null {
  if (typeof s.startTime !== 'number' || !isFinite(s.startTime)) return null;
  const d = new Date(s.startTime);
  if (isNaN(d.getTime())) return null;
  return d;
}

export function buildCalendarDays(sessions: Session[], days = 90): DayBucket[] {
  const today = startOfLocalDay(new Date());
  const year = today.getFullYear();
  const month = today.getMonth();
  const date = today.getDate();

  // Initialize the window (oldest first) with zero counts.
  // Step via local calendar (year, month, date - i) so DST transitions don't
  // skew a day forward/back; subtracting ONE_DAY_MS in UTC produces the wrong
  // local day on the DST boundary.
  const buckets: DayBucket[] = [];
  const indexByKey = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(year, month, date - i);
    const key = localDateKey(d);
    indexByKey.set(key, buckets.length);
    buckets.push({ date: key, count: 0, weekday: d.getDay() });
  }

  for (const s of sessions) {
    const d = validStartDate(s);
    if (!d) continue;
    const key = localDateKey(d);
    const idx = indexByKey.get(key);
    if (idx !== undefined) buckets[idx].count += 1;
  }

  return buckets;
}

export function buildHourHeatmap(sessions: Session[]): HourBucket[] {
  // Initialize 7 * 24 buckets zero-filled.
  const buckets: HourBucket[] = [];
  for (let w = 0; w < 7; w++) {
    for (let h = 0; h < 24; h++) {
      buckets.push({ weekday: w, hour: h, count: 0 });
    }
  }

  for (const s of sessions) {
    const d = validStartDate(s);
    if (!d) continue;
    const weekday = d.getDay();
    const hour = d.getHours();
    const idx = weekday * 24 + hour;
    buckets[idx].count += 1;
  }

  return buckets;
}

export function buildProjectMomentum(
  projects: ProjectStats[]
): ProjectMomentum[] {
  const out: ProjectMomentum[] = projects.map((p) => {
    const span = Math.max(0, p.lastSeen - p.firstSeen);
    const weeksActive = Math.max(1, Math.ceil(span / ONE_WEEK_MS));
    const raw = p.sessionCount / weeksActive;
    const sessionsPerWeek = Math.round(raw * 100) / 100;
    return {
      project: p.project,
      projectShort: p.projectShort,
      sessionCount: p.sessionCount,
      firstSeen: p.firstSeen,
      lastSeen: p.lastSeen,
      weeksActive,
      sessionsPerWeek,
    };
  });

  return out.sort((a, b) => b.sessionsPerWeek - a.sessionsPerWeek);
}
