import type { Detector } from '../types';
import { analyzeUpdateHealth } from '../../parse-last-update';
import { newestIsoDate, STALE_WEEKS } from '../shared';
import { isAsOfStale } from '../provenance';

function updateHealthSnippet(): string {
  return ['claude --version', 'cat ~/.claude/.last-update-result.json'].join('\n');
}

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
  dataDeps: ['updateResults'],
  rule(input, now) {
    const data = input.updateResults ?? [];

    if (!data.length) return null;

    const report = analyzeUpdateHealth(data);

    // Nothing to flag when every attempt succeeded.
    if (report.failedCount === 0) return null;

    const pctValue = Number((report.successRate * 100).toFixed(0));
    const pct = `${pctValue}%`;
    const codeStr =
      report.errorCodes.length > 0 ? report.errorCodes.join(', ') : 'unknown error';
    const cadenceStr =
      report.cadenceDays != null
        ? `~1 update / ${report.cadenceDays.toFixed(1)}d`
        : 'n/a (single record)';

    const asOf = newestIsoDate(data.map((result) => result.timestamp));
    const stale = asOf
      ? isAsOfStale(asOf, now, STALE_WEEKS * 7)
      : undefined;
    // An undated historical snapshot cannot certify current health either.
    const current = asOf !== undefined && stale === false;
    const measuredSeverity = report.successRate < 0.7 ? 'warning' : 'info';
    const severity = current ? measuredSeverity : 'info';
    const reportDetail =
      `${report.total} captured update snapshot(s), ` +
      `${report.successCount} succeeded (${pct}). ` +
      `${report.failedCount} failed/blocked` +
      (report.errorCodes.length ? ` (${codeStr})` : '') +
      `. ` +
      `${report.immediateRetries} immediate retry(s). ` +
      `Cadence: ${cadenceStr}. ` +
      `Version drift: ${report.versionDrift ?? 'unknown'}.`;
    const detail =
      stale === true && asOf
        ? `As of ${asOf}, across ${reportDetail}`
        : asOf
          ? `Across ${reportDetail}`
          : `In captured update history (date unavailable), ${reportDetail}`;
    const action = !current
      ? asOf
        ? `This update history is stale; re-check the current CLI version and update result before deciding whether to pin or repair it.`
        : `This update history has no readable date; check the current CLI version and update result before deciding whether to pin or repair it.`
      : measuredSeverity === 'warning'
        ? `Pin a known-good version or investigate the failing update path (${codeStr}) before trusting auto-update.`
        : `Some update attempts failed (${codeStr}). Monitor for recurrence; pin a version if failures become frequent.`;

    return {
      id: 'reliability.self-update-health',
      category: 'reliability',
      severity,
      title: 'CLI self-update health',
      detail,
      action,
      affected: report.failedCount,
      view: 'recommendations' as const,
      fix: {
        target: 'command',
        label: 'Check update health',
        note: 'Copy and run to inspect the installed CLI version and last self-update result before pinning or repairing updates.',
        snippet: updateHealthSnippet(),
      },
      provenance: {
        observations: [
          {
            claim: `${report.successCount} of ${report.total} captured update snapshot(s) succeeded (${pct})`,
            source: 'parse-last-update (.last-update-result.json snapshots)',
            field: 'analyzeUpdateHealth().{total,successCount,successRate}',
            value: `${report.total}/${report.successCount}/${pctValue}`,
          },
          {
            claim: `${report.failedCount} captured update snapshot(s) failed or were blocked`,
            source: 'parse-last-update (.last-update-result.json snapshots)',
            field: 'analyzeUpdateHealth().failedCount',
            value: report.failedCount,
          },
          {
            claim: `${report.immediateRetries} consecutive update pair(s) were less than one hour apart`,
            source: 'parse-last-update (.last-update-result.json snapshots)',
            field: 'analyzeUpdateHealth().immediateRetries',
            value: report.immediateRetries,
          },
          report.cadenceDays != null
            ? {
                claim: `mean update cadence was one update per ${report.cadenceDays.toFixed(1)} day(s)`,
                source: 'parse-last-update (.last-update-result.json snapshots)',
                field: 'analyzeUpdateHealth().cadenceDays',
                value: Number(report.cadenceDays.toFixed(1)),
              }
            : {
                claim: 'a single snapshot provides no update interval',
                source: 'parse-last-update (.last-update-result.json snapshots)',
                field: 'analyzeUpdateHealth().cadenceDays',
              },
          {
            claim: `observed version drift was ${report.versionDrift ?? 'unknown'}`,
            source: 'parse-last-update (.last-update-result.json snapshots)',
            field: 'analyzeUpdateHealth().versionDrift',
            ...(report.versionDrift ? { value: report.versionDrift } : {}),
          },
          {
            claim: report.errorCodes.length
              ? `observed failure codes were ${codeStr}`
              : 'no failure code was recorded',
            source: 'parse-last-update (.last-update-result.json snapshots)',
            field: 'analyzeUpdateHealth().errorCodes',
            ...(report.errorCodes.length ? { value: codeStr } : {}),
          },
          asOf
            ? {
                claim: `the newest readable update snapshot date was ${asOf}`,
                source: 'parse-last-update (.last-update-result.json snapshots)',
                field: 'updateResults[].timestamp',
                value: asOf,
              }
            : {
                claim: 'no update snapshot carried a readable timestamp',
                source: 'parse-last-update (.last-update-result.json snapshots)',
                field: 'updateResults[].timestamp',
              },
        ],
        inference:
          current
            ? 'These timestamped outcomes describe recent captured update health; they do not guarantee the next update will behave the same way.'
            : 'These outcomes are historical or undated and cannot establish current CLI update health, so the posture is demoted pending a fresh check.',
        ...(asOf ? { asOf, stale } : {}),
      },
    };
  },
};
