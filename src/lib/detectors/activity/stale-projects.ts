import type { Detector } from '../types';
import { daysAgo, STALE_WEEKS, MIN_STALE_SESSIONS } from '../shared';

/** Projects with real history that have gone quiet. */
export const detector: Detector = {
  id: 'activity.stale-projects',
  category: 'activity',
  dataDeps: ['projects', 'liveConfig'],
  rule(input, now) {
    // The fix is "set cleanupPeriodDays so old transcripts age out". If the user
    // has any value set, treat the rec as actioned regardless of the chosen
    // window — the value is destructive and intentional, not a default.
    if (typeof input.liveConfig?.settings?.cleanupPeriodDays === 'number') return null;
    const cutoff = now - STALE_WEEKS * 7 * 24 * 60 * 60 * 1000;
    const stale = input.projects.filter(
      (p) => p.sessionCount >= MIN_STALE_SESSIONS && p.lastSeen > 0 && p.lastSeen < cutoff
    );
    if (stale.length === 0) return null;
    stale.sort((a, b) => a.lastSeen - b.lastSeen);
    return {
      id: 'activity.stale-projects',
      category: 'activity',
      severity: 'info',
      title: 'Projects have gone quiet',
      detail: `${stale.length} project(s) with ${MIN_STALE_SESSIONS}+ sessions have had no activity in over ${STALE_WEEKS} weeks.`,
      action: 'If these are done, archive them; if not, they may be stalled and worth a check-in.',
      affected: stale.length,
      evidence: stale
        .slice(0, 5)
        .map((p) => `${p.projectShort}, last ${daysAgo(p.lastSeen, now)}d ago`),
      view: 'activity',
      fix: {
        target: 'settings.json',
        label: 'Auto-clean old transcripts',
        note: `Add to ~/.claude/settings.json to age out idle history automatically. WARNING: this permanently deletes local transcripts older than the given days — including the data this dashboard reads. Default is 30; raise the number to keep more.`,
        snippet: `{\n  "cleanupPeriodDays": ${STALE_WEEKS * 7}\n}`,
      },
    };
  },
};
