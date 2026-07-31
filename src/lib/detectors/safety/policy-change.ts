import type { Detector } from '../types';
import type { DriftEvent } from '../../parse-backups';
import { formatConfigDriftEvidence } from '../reliability/config-drift';
import { newestEpochDate, STALE_WEEKS } from '../shared';
import { isAsOfStale } from '../provenance';

/**
 * Backup-drift evidence whose newest contributing transition is older than
 * this demotes to "As of <date>" wording + a verify-live-policy action
 * (#3222, the generic #1102 stale-input rule; same 4-week window as #3194).
 * A years-old final transition must not read as current posture.
 */
const STALE_AFTER_DAYS = STALE_WEEKS * 7;

const KIND_LABEL: Partial<Record<DriftEvent['kind'], string>> = {
  'trust-flip': 'project trust accepted',
  'enable-all-flip': 'blanket MCP enable',
  'server-enabled': 'MCP server enabled',
  'repo-server-appeared': 'repo MCP server appeared',
};

function policyDimension(event: DriftEvent): string | null {
  const project = event.project ?? 'global';
  switch (event.kind) {
    case 'trust-flip':
      return `${project}:trust`;
    case 'enable-all-flip':
      return `${project}:enable-all`;
    case 'server-enabled':
    case 'server-disabled':
      return `${project}:server:${event.server ?? ''}`;
    case 'repo-server-appeared':
    case 'repo-server-vanished':
      return `${project}:repo-server:${event.server ?? ''}`;
    default:
      return null;
  }
}

export function isRiskIncreasingPolicyChange(event: DriftEvent): boolean {
  switch (event.kind) {
    case 'trust-flip':
      return event.to === true;
    case 'enable-all-flip':
      return event.to === true;
    case 'server-enabled':
    case 'repo-server-appeared':
      return true;
    default:
      return false;
  }
}

export function currentRiskIncreasingPolicyChanges(
  events: DriftEvent[]
): DriftEvent[] {
  const latestByDimension = new Map<string, DriftEvent>();
  for (const event of events.slice().sort((a, b) => a.timestamp - b.timestamp)) {
    const dimension = policyDimension(event);
    if (!dimension) continue;
    latestByDimension.set(dimension, event);
  }
  return Array.from(latestByDimension.values())
    .filter(isRiskIncreasingPolicyChange)
    .sort((a, b) => b.timestamp - a.timestamp);
}

function summary(events: DriftEvent[]): string {
  const counts = new Map<string, number>();
  for (const event of events) {
    const label = KIND_LABEL[event.kind] ?? event.kind;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, count]) => `${label} ${count}`)
    .join(', ');
}

export const detector: Detector = {
  id: 'safety.policy-change',
  category: 'safety',
  dataDeps: ['configBackups'],
  rule(input, now) {
    const events = input.configBackups ?? [];
    if (events.length === 0) return null;

    const risky = currentRiskIncreasingPolicyChanges(events);
    if (risky.length === 0) return null;

    const projects = [
      ...new Set(risky.map((event) => event.project).filter((p): p is string => Boolean(p))),
    ];

    // #3222: anchor the posture claim to the newest CONTRIBUTING transition
    // (derived from the drift data, never `now`); demote old backup evidence
    // to dated wording — a stale final transition is an observation about the
    // backups, not proof of the live policy today.
    const asOf = newestEpochDate(risky.map((event) => event.timestamp));
    const stale = isAsOfStale(asOf, now, STALE_AFTER_DAYS);

    return {
      id: 'safety.policy-change',
      category: 'safety',
      severity: 'warning',
      title: 'Permission policy expanded',
      detail: stale
        ? `As of ${asOf}, the latest observed backup transitions left ${risky.length} risk-increasing policy change(s) in place across ${projects.length} project(s): ${summary(risky)}. The backup evidence is dated — verify the live policy before treating this as current posture.`
        : `${risky.length} current risk-increasing policy change(s) across ${projects.length} project(s): ${summary(risky)}.`,
      action: stale
        ? `Verify the current trust state, blanket-enable setting, and MCP server selection against live config first — the newest contributing backup transition is dated ${asOf}. If the expansion is still present and was accidental, restore the prior state before relying on the affected sessions as low-risk.`
        : 'Review the policy drift evidence. If the expansion was accidental, restore the prior trust state, blanket-enable setting, or MCP server selection before relying on the affected sessions as low-risk.',
      affected: risky.length,
      evidence: risky.slice(0, 5).map(formatConfigDriftEvidence),
      view: 'permissions',
      provenance: {
        observations: [
          {
            claim: `${risky.length} latest policy dimension(s) ended in a risk-increasing state`,
            source: 'parse-backups',
            field: 'configBackups',
            value: risky.length,
          },
        ],
        inference: stale
          ? 'The latest observed transition for each policy dimension expanded trust or tool access, but the newest contributing backup is dated — the claim is demoted to as-of wording rather than asserted as current posture.'
          : 'The latest observed transition for each policy dimension expands trust or tool access, so the current posture is riskier than the earlier backup snapshot.',
        ...(asOf !== undefined ? { asOf, stale } : {}),
      },
      ...(projects.length ? { projects } : {}),
    };
  },
};
