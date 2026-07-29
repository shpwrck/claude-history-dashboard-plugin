/**
 * Detector: reliability.config-drift — project-scoped MCP/config drift.
 *
 * Persona P11 Tariq (issue #568): "Did my project's MCP/tooling config
 * silently drift, and when?" The timestamped ~/.claude.json backups in
 * ~/.claude/backups/ are the free, local audit log. This detector receives
 * pre-computed DriftEvent[] from ingest (so it stays pure) and flags any
 * recent project-scoped drift — especially a server moving into
 * disabledMcpjsonServers, the usual "my tool stopped working" cause.
 *
 * Data dependency: `configBackups` — a new optional field on RecommendationInput,
 * expected to be pre-computed by ingest (scripts/ingest.mjs assembleDataset)
 * using parseBackupsDir + diffConfigDrift from src/lib/parse-backups.ts.
 * When absent or empty, the detector emits nothing.
 *
 * The detector is PURE. It reads no filesystem, calls no clock, and depends on
 * no external state. `now` is passed in by the harness for testability.
 *
 * Category: reliability (config misconfiguration → silent tool failures).
 */

import type { Detector, RecommendationInput } from '../types';
import type { DriftEvent } from '../../parse-backups';

/** How far back to look for "recent" drift events (7 days in ms). */
const RECENCY_MS = 7 * 24 * 60 * 60 * 1000;

/** Minimum number of drift events before we surface a finding. */
const MIN_EVENTS = 1;

export function formatConfigDriftEvidence(e: DriftEvent): string {
  const ts = new Date(e.timestamp).toISOString().slice(0, 16) + 'Z';
  const proj = e.project ? ` [${e.project}]` : '';
  const srv = e.server ? ` server=${e.server}` : '';
  return `${ts}${proj}${srv} ${e.kind} ${e.from ?? '?'} -> ${e.to ?? '?'}`;
}

export const detector: Detector = {
  id: 'reliability.config-drift',
  category: 'reliability',
  /**
   * `configBackups` is an optional field on RecommendationInput. Ingest
   * pre-computes the full account-wide DriftEvent[] (all projects, all windows)
   * using `diffConfigDrift` and ships it here. The detector filters to recent
   * project-scoped events — it never touches the filesystem.
   */
  dataDeps: ['configBackups'],
  rule(input: RecommendationInput, now: number): import('../types').Recommendation | null {
    const data = input.configBackups ?? [];
    if (!data.length) return null;

    const cutoff = now - RECENCY_MS;

    // Project-scoped events only (global-churn is de-emphasised per P11 design)
    const projectEvents = data.filter(
      (e) => e.kind !== 'global-churn' && e.timestamp >= cutoff
    );

    if (projectEvents.length < MIN_EVENTS) return null;

    // Warnings: any event with severity === 'warning' escalates the finding
    const warnings = projectEvents.filter((e) => e.severity === 'warning');
    const disabled = projectEvents.filter((e) => e.kind === 'server-disabled');

    // Build a severity that escalates on ANY warning-level event
    const severity = warnings.length > 0 ? 'warning' : 'info';

    // Headline: if servers were disabled, call that out specifically
    const disabledNames = [...new Set(disabled.map((e) => e.server).filter(Boolean))];
    const disabledSummary = disabledNames.length
      ? ` MCP server(s) disabled for a project: ${disabledNames.join(', ')}.`
      : '';

    // Distinct projects affected
    const projects = [...new Set(projectEvents.map((e) => e.project).filter((p): p is string => Boolean(p)))];

    // Evidence: format the most recent warning events (up to 5)
    const evidence = warnings
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 5)
      .map(formatConfigDriftEvidence);

    return {
      id: 'reliability.config-drift',
      category: 'reliability',
      severity,
      title: disabled.length
        ? `MCP server silently disabled — tool may have stopped working`
        : `Project MCP/config drifted in the last 7 days`,
      detail:
        `${projectEvents.length} config-drift event(s) detected in the last 7 days` +
        ` across ${projects.length} project(s).` +
        disabledSummary +
        ` ${warnings.length} event(s) need attention (trust flip, server disabled, blanket-enable on).`,
      action:
        disabled.length
          ? `Re-enable the disabled server(s) in the affected project's MCP settings, ` +
            `or re-accept the trust dialog if the tool should still be active.`
          : `Review the flagged config changes in ~/.claude/backups/ to confirm they were intentional.`,
      affected: projectEvents.length,
      evidence,
      view: 'permissions',
      ...(projects.length ? { projects } : {}),
      provenance: {
        observations: [
          {
            claim: `${projectEvents.length} project-scoped config-drift event(s) fell inside the ${RECENCY_MS / 86_400_000}-day window`,
            source: 'parse-backups (diffConfigDrift over ~/.claude/backups/)',
            field: 'configBackups[].timestamp',
            value: projectEvents.length,
          },
          {
            claim: `across ${projects.length} distinct project(s)`,
            source: 'parse-backups (diffConfigDrift over ~/.claude/backups/)',
            field: 'configBackups[].project',
            value: projects.length,
          },
          {
            claim: `${warnings.length} of them are warning-severity (trust flip, server disabled, blanket-enable on)`,
            source: 'parse-backups (diffConfigDrift over ~/.claude/backups/)',
            field: 'configBackups[].severity',
            value: warnings.length,
          },
          {
            claim: disabledNames.length
              ? `${disabledNames.length} MCP server(s) moved into a disabled state: ${disabledNames.join(', ')}`
              : 'no MCP server moved into a disabled state',
            source: 'parse-backups (diffConfigDrift over ~/.claude/backups/)',
            field: 'configBackups[].kind=server-disabled',
            ...(disabledNames.length ? { value: disabledNames.join(',') } : {}),
          },
          {
            claim: 'global-churn events are excluded — only project-scoped drift is counted',
            source: 'parse-backups (diffConfigDrift over ~/.claude/backups/)',
            field: 'configBackups[].kind',
          },
        ],
        inference:
          'A server that left the enabled set without anyone noticing is the usual ' +
          'cause of "my tool stopped working"; the timestamped backups are the only ' +
          'local record of when it changed.',
        // Dated by the newest drift event in the window rather than by `now` —
        // the claim is about when the config moved (#3205).
        asOf: new Date(
          projectEvents.reduce((max, e) => (e.timestamp > max ? e.timestamp : max), 0)
        )
          .toISOString()
          .slice(0, 10),
        // Selection is already bounded to the last 7 days, so anything that
        // reaches here is fresh by construction.
        stale: false,
      },
    };
  },
};
