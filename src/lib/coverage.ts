import type { ActionDomain } from '../types';
import { ACTION_DOMAINS } from './digest';
import type { RecommendationInput } from './detectors/types';
import { aggregateStopHooks } from './parse-runtime-events';
// Coverage types live in a dependency-free leaf (#1582) so `digest.ts` can import
// them without a (type-only) cycle back through this module, which imports a value
// from digest. Re-exported here so every existing `from './coverage'` importer is
// unaffected.
import type { DomainCoverage } from './coverage-types';
export type { DomainCoverage, DomainCoverageStatus } from './coverage-types';

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

/**
 * Percentage of stop events that carried a measured hook `durationMs`, rounded
 * to a whole percent. `durationMs` is present on only a minority (~7%) of fires
 * (see {@link aggregateStopHooks}), so this is the timed fraction the speed
 * card's emptiness should be read against. `0` when there are no stop events.
 */
export function timedEventFractionPct(
  timedEvents: number,
  events: number
): number {
  if (events <= 0) return 0;
  return Math.round((timedEvents / events) * 100);
}

/**
 * Speed-domain staleness note. Hook timing (`durationMs`) is recorded on only a
 * sparse subset of stop events, so when speed signal exists at all we report
 * how many turns we actually timed — that timed fraction, not silent absence,
 * is the explanation for an empty speed card when it falls below the detector's
 * firing threshold. Reads via {@link aggregateStopHooks} inline (no
 * pre-aggregated field on RecommendationInput).
 */
function speedStaleNote(input: RecommendationInput): string | undefined {
  const { timedEvents, events } = aggregateStopHooks(input.runtimeEvents ?? []);
  if (events === 0) return undefined;
  const pct = timedEventFractionPct(timedEvents, events);
  return `Hook timing recorded for ${timedEvents} of ${events} stop events (${pct}%), so speed evidence covers only the timed subset.`;
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
    const staleNote =
      domain === 'speed'
        ? speedStaleNote(input) ?? staleNoteFor(domain, missingDeps)
        : staleNoteFor(domain, missingDeps);

    if (coreDeps.length > 0 && presentCoreDeps.length === 0) {
      return { domain, status: 'CANNOT_SEE', staleNote };
    }
    if (missingDeps.length > 0) {
      return { domain, status: 'INFER', staleNote };
    }
    return { domain, status: 'PROVE', staleNote };
  });
}
