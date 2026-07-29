import type { Detector } from '../types';
import { daysAgo, isoDateFromMs, STALE_WEEKS, MIN_STALE_SESSIONS } from '../shared';

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
    const quietest = stale[0]; // sorted oldest-first above
    // The freshest activity anywhere in the corpus: history is only readable up
    // to here, so dating the claim any later — `now` above all — would assert a
    // freshness the data does not have.
    const asOf = isoDateFromMs(
      input.projects.reduce((max, p) => (p.lastSeen > max ? p.lastSeen : max), 0)
    );
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
      provenance: {
        observations: [
          {
            // Both halves of the filter belong in the claim: the excluded
            // projects are not simply "the active ones" — some were quiet too
            // and fell below the session floor. "N of M went quiet" alone would
            // misdescribe the population.
            claim: `${stale.length} of ${input.projects.length} known project(s) both cleared the ${MIN_STALE_SESSIONS}-session floor and recorded no activity inside the ${STALE_WEEKS}-week window`,
            source: 'parse-history (groupByProjects)',
            field: 'projects[].lastSeen',
            value: stale.length,
          },
          {
            claim: `the quietest is "${quietest.projectShort}", last active ${daysAgo(quietest.lastSeen, now)} day(s) ago`,
            source: 'parse-history (groupByProjects)',
            field: 'projects[].lastSeen',
            value: daysAgo(quietest.lastSeen, now),
          },
          {
            // The cited value is the CONSTANT, so cite the module that declares
            // it — pointing this at `projects[].sessionCount` would send a
            // reader to a field that never holds this number.
            claim: `only projects with at least MIN_STALE_SESSIONS = ${MIN_STALE_SESSIONS} recorded session(s) are counted, so one-off directories are excluded`,
            source: 'detectors/shared',
            field: 'MIN_STALE_SESSIONS',
            value: MIN_STALE_SESSIONS,
          },
          {
            claim: 'no cleanupPeriodDays is set, so nothing is ageing this history out on its own',
            source: '~/.claude/settings.json',
            field: 'settings.cleanupPeriodDays',
          },
        ],
        inference:
          'Quiet is not the same as finished. This measures the absence of recorded ' +
          'activity in RETAINED history — it cannot separate a completed project ' +
          'from a stalled one, which is why the action asks rather than tells.',
        ...(asOf ? { asOf } : {}),
      },
    };
  },
};
