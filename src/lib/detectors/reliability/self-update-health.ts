import type { Detector } from '../types';
import type { RecommendationInput } from '../types';
import type { UpdateResult } from '../../parse-last-update';
import { analyzeUpdateHealth } from '../../parse-last-update';

/**
 * Flags a low CLI self-update success rate so users know to pin a known-good
 * version rather than trusting auto-update blindly (#566, persona P7 Owen).
 *
 * Consumes the optional `updateResults` field of RecommendationInput (added by
 * this epic's ingest wiring). An empty/absent array silences the detector — no
 * update history, nothing to report.
 *
 * The detector works on a 1..N series. Today (single live file), the server
 * wraps the one parsed record in a 1-element array; the analysis will improve
 * once snapshot-history ingest is implemented (#566 future enhancement).
 *
 * Severity:
 *   warning  — success rate < 70% (grade D)
 *   info     — success rate < 100% but >= 70% (grade B/C: some failures seen)
 *   null     — all attempts succeeded (grade A, no failures) or no data
 */
export const detector: Detector = {
  id: 'reliability.self-update-health',
  category: 'reliability',
  dataDeps: ['updateResults' as keyof RecommendationInput],
  rule(input) {
    // Pull the optional field without touching the shared RecommendationInput type.
    const data =
      (input as RecommendationInput & { updateResults?: UpdateResult[] }).updateResults ?? [];

    if (!data.length) return null;

    const report = analyzeUpdateHealth(data);

    // Nothing to flag when every attempt succeeded.
    if (report.failedCount === 0) return null;

    const pct = `${(report.successRate * 100).toFixed(0)}%`;
    const codeStr =
      report.errorCodes.length > 0 ? report.errorCodes.join(', ') : 'unknown error';
    const cadenceStr =
      report.cadenceDays != null
        ? `~1 update / ${report.cadenceDays.toFixed(1)}d`
        : 'n/a (single record)';

    const severity = report.successRate < 0.7 ? 'warning' : 'info';

    return {
      id: 'reliability.self-update-health',
      category: 'reliability',
      severity,
      title: 'CLI self-update health',
      detail:
        `Across ${report.total} captured update snapshot(s), ` +
        `${report.successCount} succeeded (${pct}). ` +
        `${report.failedCount} failed/blocked` +
        (report.errorCodes.length ? ` (${codeStr})` : '') +
        `. ` +
        `${report.immediateRetries} immediate retry(s). ` +
        `Cadence: ${cadenceStr}. ` +
        `Version drift: ${report.versionDrift ?? 'unknown'}.`,
      action:
        severity === 'warning'
          ? `Pin a known-good version or investigate the failing update path (${codeStr}) before trusting auto-update.`
          : `Some update attempts failed (${codeStr}). Monitor for recurrence; pin a version if failures become frequent.`,
      affected: report.failedCount,
      view: 'recommendations' as const,
    };
  },
};
