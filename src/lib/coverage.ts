import type { ActionDomain } from '../types';
import { ACTION_DOMAINS } from './digest';
import type { RecommendationInput } from './detectors/types';

export type DomainCoverageStatus = 'PROVE' | 'INFER' | 'CANNOT_SEE';

export interface DomainCoverage {
  domain: ActionDomain;
  status: DomainCoverageStatus;
  staleNote?: string;
}

type InputKey = keyof RecommendationInput;

const CORE_DEPS_BY_DOMAIN: Partial<Record<ActionDomain, readonly InputKey[]>> = {
  safety: ['toolData', 'permissionRows', 'deceitSignals'],
  cost: ['tokenData'],
  'success-rate': ['toolData', 'apiErrors', 'runtimeEvents'],
  speed: ['runtimeEvents', 'modelLatency'],
  'context-health': ['tokenData', 'timelines', 'repoMap'],
  'workflow-hygiene': ['toolData', 'tasks', 'workflows'],
};

const OPTIONAL_DEPS_BY_DOMAIN: Partial<Record<ActionDomain, readonly InputKey[]>> = {
  'success-rate': ['debugLogs'],
};

const STALE_NOTES_BY_DEP: Partial<
  Record<ActionDomain, Partial<Record<InputKey, string>>>
> = {
  'success-rate': {
    debugLogs:
      'Debug logs are absent, so report-card freshness and latency evidence are incomplete.',
  },
};

function hasInputValue(input: RecommendationInput, key: InputKey): boolean {
  const value = input[key];
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function staleNoteFor(
  domain: ActionDomain,
  missingDeps: readonly InputKey[]
): string | undefined {
  const notes = STALE_NOTES_BY_DEP[domain];
  if (!notes) return undefined;
  return missingDeps.map((dep) => notes[dep]).find(Boolean);
}

export function computeDomainCoverage(
  input: RecommendationInput
): DomainCoverage[] {
  return ACTION_DOMAINS.map((domain) => {
    const coreDeps = CORE_DEPS_BY_DOMAIN[domain] ?? [];
    const optionalDeps = OPTIONAL_DEPS_BY_DOMAIN[domain] ?? [];
    const presentCoreDeps = coreDeps.filter((dep) => hasInputValue(input, dep));
    const missingCoreDeps = coreDeps.filter((dep) => !hasInputValue(input, dep));
    const missingOptionalDeps = optionalDeps.filter(
      (dep) => !hasInputValue(input, dep)
    );
    const missingDeps = [...missingCoreDeps, ...missingOptionalDeps];
    const staleNote = staleNoteFor(domain, missingDeps);

    if (coreDeps.length > 0 && presentCoreDeps.length === 0) {
      return { domain, status: 'CANNOT_SEE', staleNote };
    }
    if (missingDeps.length > 0) {
      return { domain, status: 'INFER', staleNote };
    }
    return { domain, status: 'PROVE', staleNote };
  });
}
