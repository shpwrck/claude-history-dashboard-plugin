import type { DashboardFilter } from './routing';
import { ALL_PROJECTS } from './routing';
import { shortenProject } from './format';

const TIME_LABELS: Record<DashboardFilter['time'], string> = {
  '24h': 'the last 24 hours',
  '7d': 'the last 7 days',
  '30d': 'the last 30 days',
  all: 'all time',
};

export function isDashboardFilterActive(filter: DashboardFilter): boolean {
  return filter.time !== 'all' || filter.project !== ALL_PROJECTS;
}

export function describeDashboardFilter(filter: DashboardFilter): string {
  const parts: string[] = [];
  if (filter.time !== 'all') parts.push(TIME_LABELS[filter.time]);
  if (filter.project !== ALL_PROJECTS) {
    parts.push(`project ${shortenProject(filter.project)}`);
  }
  return parts.length > 0 ? parts.join(' and ') : 'all data';
}

export function describeActiveDashboardFilter(
  filter: DashboardFilter | undefined
): string | null {
  if (!filter || !isDashboardFilterActive(filter)) return null;
  return describeDashboardFilter(filter);
}
