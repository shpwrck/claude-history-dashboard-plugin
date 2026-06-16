import type { View } from '../types';
import type { Recommendation, RecCategory } from './recommendations';
import { DOMAIN_FOR_CATEGORY, DOMAIN_LANDING } from './digest';

export type CanonicalEvidenceSignal =
  | 'token-usage'
  | 'model-routing'
  | 'agent-usage'
  | 'automation-runs';

export interface CanonicalEvidenceTarget {
  signal: CanonicalEvidenceSignal | null;
  view: View;
}

type EvidenceRec = Pick<Recommendation, 'id' | 'category' | 'view'>;

const CANONICAL_EVIDENCE_DESTINATIONS = {
  'token-usage': 'tokens',
  'model-routing': 'model-evals',
  'agent-usage': 'agents',
  'automation-runs': 'automation',
} as const satisfies Record<CanonicalEvidenceSignal, View>;

function tokenSignal(id: string): boolean {
  return (
    (id.startsWith('context.') &&
      (id.includes('cache') ||
        id.includes('compaction') ||
        id.includes('over-window') ||
        id.includes('repo-map') ||
        id.includes('bloated-claude-md'))) ||
    (id.startsWith('cost.') &&
      (id.includes('cache') ||
        id === 'cost.unknown-model' ||
        id === 'cost.legacy-model-overpay'))
  );
}

function agentSignal(id: string): boolean {
  return (
    id === 'cost.expensive-agent-type' ||
    id === 'speed.hook-overhead' ||
    id.includes('unused-installed-subagent') ||
    id.includes('unused-installed-skill') ||
    id.includes('unused-installed-plugin')
  );
}

export function canonicalEvidenceSignalForRecommendation(
  rec: Pick<Recommendation, 'id' | 'view'>
): CanonicalEvidenceSignal | null {
  const id = rec.id.toLowerCase();
  if (id.includes('model-eval') || id === 'cost.model-routing-rollup') {
    return 'model-routing';
  }
  if (tokenSignal(id)) return 'token-usage';
  if (agentSignal(id)) return 'agent-usage';
  if (id === 'cost.automation-share' || id === 'workflow.autonomy-over-steered') {
    return 'automation-runs';
  }
  return null;
}

function domainLandingForCategory(category: RecCategory): View {
  return DOMAIN_LANDING[DOMAIN_FOR_CATEGORY[category]];
}

export function canonicalEvidenceTargetForRecommendation(
  rec: EvidenceRec
): CanonicalEvidenceTarget {
  const signal = canonicalEvidenceSignalForRecommendation(rec);
  return {
    signal,
    view: signal
      ? CANONICAL_EVIDENCE_DESTINATIONS[signal]
      : rec.view ?? domainLandingForCategory(rec.category),
  };
}
