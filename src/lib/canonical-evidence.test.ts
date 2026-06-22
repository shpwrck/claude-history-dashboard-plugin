import { describe, expect, it } from 'vitest';

import {
  canonicalEvidenceSignalForRecommendation,
  canonicalEvidenceTargetForRecommendation,
} from './canonical-evidence';
import type { Recommendation } from './recommendations';

function rec(
  partial: Pick<Recommendation, 'id' | 'category'> &
    Partial<Pick<Recommendation, 'view'>>
): Recommendation {
  return {
    severity: 'info',
    title: partial.id,
    detail: '',
    action: '',
    ...partial,
  };
}

describe('canonical evidence routing', () => {
  it('routes each duplicated cross-domain signal family to one destination', () => {
    expect(
      canonicalEvidenceTargetForRecommendation(
        rec({ id: 'cost.model-routing-rollup', category: 'cost', view: 'cost' })
      )
    ).toEqual({ signal: 'model-routing', view: 'model-evals' });
    expect(
      canonicalEvidenceTargetForRecommendation(
        rec({ id: 'context.low-cache-hit', category: 'context', view: 'context' })
      )
    ).toEqual({ signal: 'token-usage', view: 'tokens' });
    expect(
      canonicalEvidenceTargetForRecommendation(
        rec({ id: 'speed.hook-overhead', category: 'speed', view: 'evaluator' })
      )
    ).toEqual({ signal: 'agent-usage', view: 'agents' });
    expect(
      canonicalEvidenceTargetForRecommendation(
        rec({ id: 'workflow.autonomy-over-steered', category: 'workflow' })
      )
    ).toEqual({ signal: 'automation-runs', view: 'automation' });
  });

  it('routes token/cache context findings to the canonical Tokens evidence view', () => {
    const target = canonicalEvidenceTargetForRecommendation(
      rec({
        id: 'context.low-cache-hit',
        category: 'context',
        view: 'context',
      })
    );

    expect(target).toEqual({
      signal: 'token-usage',
      view: 'tokens',
    });
  });

  it('routes duplicated agent signals from cost, speed, and workflow to Agents', () => {
    const inputs = [
      rec({ id: 'cost.expensive-agent-type', category: 'cost', view: 'cost' }),
      rec({ id: 'speed.hook-overhead', category: 'speed', view: 'evaluator' }),
      rec({ id: 'workflow.unused-installed-subagents', category: 'workflow' }),
    ];

    expect(inputs.map(canonicalEvidenceTargetForRecommendation)).toEqual([
      { signal: 'agent-usage', view: 'agents' },
      { signal: 'agent-usage', view: 'agents' },
      { signal: 'agent-usage', view: 'agents' },
    ]);
  });

  it('keeps detector-local routes for non-duplicated signals', () => {
    const recommendation = rec({
      id: 'workflow.prompt-clarity',
      category: 'workflow',
      view: 'patterns',
    });
    const target = canonicalEvidenceTargetForRecommendation(
      recommendation
    );

    expect(canonicalEvidenceSignalForRecommendation(recommendation)).toBeNull();
    expect(target).toEqual({
      signal: null,
      view: 'patterns',
    });
  });

  it('scopes dangerous bypass findings to bypass-mode command evidence', () => {
    expect(
      canonicalEvidenceTargetForRecommendation(
        rec({ id: 'safety.dangerous-bypass', category: 'safety', view: 'permissions' })
      )
    ).toEqual({
      signal: null,
      view: 'permissions',
      filter: { mode: 'bypassPermissions', table: 'dangerous' },
    });
  });

  it('routes continuation-blocked findings to filtered Permissions evidence', () => {
    expect(
      canonicalEvidenceTargetForRecommendation(
        rec({ id: 'safety.continuation-blocked', category: 'safety', view: 'permissions' })
      )
    ).toEqual({
      signal: null,
      view: 'permissions',
      filter: { entrypoint: 'unattended', table: 'unattended' },
    });
  });

  it('scopes policy-change findings to the policy drift evidence card', () => {
    expect(
      canonicalEvidenceTargetForRecommendation(
        rec({ id: 'safety.policy-change', category: 'safety', view: 'permissions' })
      )
    ).toEqual({
      signal: null,
      view: 'permissions',
      filter: { table: 'drift' },
    });
  });

  it('routes unattended-session findings to filtered Permissions evidence', () => {
    expect(
      canonicalEvidenceTargetForRecommendation(
        rec({ id: 'safety.unattended-sessions', category: 'safety', view: 'permissions' })
      )
    ).toEqual({
      signal: null,
      view: 'permissions',
      filter: { entrypoint: 'unattended', table: 'unattended' },
    });
  });

  it('falls back to the domain landing when a detector has no target view', () => {
    expect(
      canonicalEvidenceTargetForRecommendation(
        rec({ id: 'reliability.settings-json-invalid', category: 'reliability' })
      )
    ).toEqual({
      signal: null,
      view: 'errors',
    });
  });
});
