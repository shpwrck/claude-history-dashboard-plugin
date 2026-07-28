import { describe, expect, it } from 'vitest';
import type { Recommendation, RecCategory, RecSeverity } from './recommendations';
import {
  rankForDigest,
  safetyLeadForDigest,
  topPerDomain,
  digestVerdict,
  domainForRec,
  coverageLevelForStatus,
  DOMAIN_FOR_CATEGORY,
  emptyStateForDomainFinding,
  ACTION_DOMAINS,
} from './digest';
import type { DomainCoverage } from './coverage';

function rec(
  category: RecCategory,
  severity: RecSeverity,
  id = `${category}.${severity}`
): Recommendation {
  return {
    id,
    category,
    severity,
    title: `${category} ${severity}`,
    detail: 'detail',
    action: 'action',
  };
}

describe('DOMAIN_FOR_CATEGORY', () => {
  it('maps engine categories onto the action-domain taxonomy', () => {
    expect(DOMAIN_FOR_CATEGORY.cost).toBe('cost');
    expect(DOMAIN_FOR_CATEGORY.reliability).toBe('success-rate');
    expect(DOMAIN_FOR_CATEGORY.safety).toBe('safety');
    expect(DOMAIN_FOR_CATEGORY.context).toBe('context-health');
    expect(DOMAIN_FOR_CATEGORY.workflow).toBe('workflow-hygiene');
    expect(DOMAIN_FOR_CATEGORY.speed).toBe('speed');
    expect(DOMAIN_FOR_CATEGORY.activity).toBe('workflow-hygiene');
    expect(DOMAIN_FOR_CATEGORY.maintenance).toBe('workflow-hygiene');
  });

  it('routes a speed-category rec onto the speed domain card', () => {
    const speedRec = rec('speed', 'warning');
    expect(domainForRec(speedRec)).toBe('speed');
    const out = topPerDomain([speedRec]);
    expect(out.find((d) => d.domain === 'speed')?.rec?.id).toBe(speedRec.id);
  });
});

describe('rankForDigest', () => {
  it('puts safety first even when its severity is lower than a cost finding', () => {
    // Engine order: critical cost ahead of a mere warning safety finding.
    const input = [rec('cost', 'critical'), rec('safety', 'warning')];
    const ranked = rankForDigest(input);
    expect(ranked[0].category).toBe('safety');
    expect(ranked[1].category).toBe('cost');
  });

  it('keeps critical safety ahead of a higher-impact cost finding and drives the verdict', () => {
    const costlyWaste = {
      ...rec('cost', 'critical', 'cost.high-impact-waste'),
      title: 'High-impact cost waste',
      estSavingsUsd: 5_000,
      estTimeReclaimedMin: 1_200,
      affected: 50,
    };
    const safetyRisk = {
      ...rec('safety', 'critical', 'safety.dangerous-bypass'),
      title: 'Dangerous bypass ran',
      estSavingsUsd: 10,
      affected: 1,
    };
    const input = [costlyWaste, safetyRisk];

    expect(rankForDigest(input).map((r) => r.id)).toEqual([
      'safety.dangerous-bypass',
      'cost.high-impact-waste',
    ]);

    const verdict = digestVerdict(input, fullCoverage);
    expect(verdict.tone).toBe('critical');
    expect(verdict.text).toContain('Dangerous bypass ran');
    expect(verdict.text).not.toContain('High-impact cost waste');
  });

  it('preserves the engine order within each partition', () => {
    const input = [
      rec('safety', 'critical', 's1'),
      rec('cost', 'critical', 'c1'),
      rec('safety', 'warning', 's2'),
      rec('context', 'info', 'x1'),
    ];
    expect(rankForDigest(input).map((r) => r.id)).toEqual([
      's1',
      's2',
      'c1',
      'x1',
    ]);
  });

  it('is a no-op for an empty list', () => {
    expect(rankForDigest([])).toEqual([]);
  });
});

describe('safetyLeadForDigest', () => {
  it('selects a warning safety-domain finding ahead of a critical cost finding', () => {
    const input = [rec('cost', 'critical'), rec('safety', 'warning')];
    expect(safetyLeadForDigest(input)?.category).toBe('safety');
  });

  it('does not promote info-only safety findings into the lead card', () => {
    expect(safetyLeadForDigest([rec('safety', 'info')])).toBeNull();
  });
});

describe('topPerDomain', () => {
  it('returns one finding per action-domain, safety first, with a null speed slot', () => {
    const input = [
      rec('cost', 'critical'),
      rec('safety', 'warning'),
      rec('reliability', 'info'),
      rec('context', 'info'),
      rec('workflow', 'info'),
    ];
    const out = topPerDomain(input);
    expect(out.map((d) => d.domain)).toEqual([
      'safety',
      'cost',
      'success-rate',
      'speed',
      'context-health',
      'workflow-hygiene',
    ]);
    expect(out[0].rec?.category).toBe('safety');
    // No speed detectors yet — the slot is present but empty by design (ADR 0006).
    expect(out.find((d) => d.domain === 'speed')?.rec).toBeNull();
  });

  /**
   * CHANGED in #3123 — the old name said the defect out loud: "defaults every
   * domain to healthy coverage when no coverage signal is supplied". A domain
   * we have no coverage signal for is a blind spot; treating it as healthy
   * turns absent instrumentation into a clean bill of health.
   */
  it('treats a domain with no coverage signal as a blind spot, not healthy', () => {
    const out = topPerDomain([rec('cost', 'warning')]);
    expect(out.every((d) => d.coverage === 'blind-spot')).toBe(true);
  });

  it('maps the per-domain coverage signal (#1480) onto all three levels', () => {
    const coverage: DomainCoverage[] = [
      { domain: 'safety', status: 'PROVE' },
      { domain: 'cost', status: 'CANNOT_SEE' },
      {
        domain: 'success-rate',
        status: 'INFER',
        staleNote: 'Debug logs are stale.',
      },
    ];
    const out = topPerDomain([], coverage);
    const byDomain = new Map(out.map((d) => [d.domain, d]));
    // PROVE -> healthy, INFER -> sparse, CANNOT_SEE -> blind-spot.
    expect(byDomain.get('safety')?.coverage).toBe('healthy');
    expect(byDomain.get('cost')?.coverage).toBe('blind-spot');
    expect(byDomain.get('success-rate')?.coverage).toBe('sparse');
    expect(byDomain.get('success-rate')?.staleNote).toBe(
      'Debug logs are stale.'
    );
    // CHANGED in #3123: a domain absent from the coverage array has no
    // coverage signal, so it is a blind spot. Falling back to healthy reported
    // absent instrumentation as a clean domain.
    expect(byDomain.get('speed')?.coverage).toBe('blind-spot');
  });

  it('classifies empty domain states as clean, uninstrumented, or stale', () => {
    const out = topPerDomain([], [
      { domain: 'safety', status: 'PROVE' },
      { domain: 'speed', status: 'CANNOT_SEE' },
      {
        domain: 'success-rate',
        status: 'INFER',
        staleNote: 'Debug logs are stale.',
      },
    ]);
    const byDomain = new Map(out.map((d) => [d.domain, d]));

    expect(emptyStateForDomainFinding(byDomain.get('safety')!)).toMatchObject({
      kind: 'clean',
      title: 'Clean',
    });
    expect(emptyStateForDomainFinding(byDomain.get('speed')!)).toMatchObject({
      kind: 'uninstrumented',
      title: 'Needs data',
      detail: 'No speed data yet — wire runtime events or model-latency samples.',
    });
    expect(
      emptyStateForDomainFinding(byDomain.get('success-rate')!)
    ).toMatchObject({
      kind: 'stale',
      title: 'Stale evidence',
      detail: 'Debug logs are stale.',
    });
  });
});

describe('coverageLevelForStatus', () => {
  it('maps #1480 coverage statuses onto the digest vocabulary', () => {
    expect(coverageLevelForStatus('PROVE')).toBe('healthy');
    expect(coverageLevelForStatus('INFER')).toBe('sparse');
    expect(coverageLevelForStatus('CANNOT_SEE')).toBe('blind-spot');
  });
});

describe('domainForRec', () => {
  it('resolves a rec to its action-domain', () => {
    expect(domainForRec(rec('reliability', 'info'))).toBe('success-rate');
  });
});


/**
 * "We looked, across every domain." Supplied to `digestVerdict` so the tests
 * below exercise VERDICT logic; the coverage-dependent behaviour is tested
 * separately (#3123).
 */
const fullCoverage: DomainCoverage[] = ACTION_DOMAINS.map((domain) => ({
  domain,
  status: 'PROVE' as const,
}));

describe('digestVerdict', () => {
  it('reports healthy when there are no findings', () => {
    expect(digestVerdict([], fullCoverage).tone).toBe('ok');
  });

  it('leads with safety when a safety finding is critical', () => {
    const v = digestVerdict([rec('cost', 'critical'), rec('safety', 'critical')], fullCoverage);
    expect(v.tone).toBe('critical');
    expect(v.text.toLowerCase()).toContain('safety');
  });

  it('flags attention for non-critical findings', () => {
    expect(digestVerdict([rec('cost', 'warning')], fullCoverage).tone).toBe('attention');
  });

  it('attention verdict names the top finding (no critical)', () => {
    const v = digestVerdict([
      rec('cost', 'warning', 'c1'),
      rec('context', 'info', 'x1'),
    ], fullCoverage);
    expect(v.tone).toBe('attention');
    expect(v.text).toContain('cost warning');
  });

  it('attention verdict names the top finding (critical present)', () => {
    const v = digestVerdict([
      rec('cost', 'critical', 'c1'),
      rec('context', 'info', 'x1'),
    ], fullCoverage);
    expect(v.tone).toBe('attention');
    expect(v.text).toContain('cost critical');
  });

  it('attention verdict names the top non-safety finding even when a non-critical safety finding ranks first', () => {
    const v = digestVerdict([
      rec('cost', 'warning', 'c1'),
      rec('safety', 'warning', 's1'),
    ], fullCoverage);
    expect(v.tone).toBe('attention');
    // safety ranks first in the digest, but the verdict names the top *non-safety* finding
    expect(v.text).toContain('cost warning');
  });
});

// ---------------------------------------------------------------------------
// A verdict requires a basis (#3123)
// ---------------------------------------------------------------------------

describe('digestVerdict coverage requirement (#3123)', () => {
  const blindCoverage: DomainCoverage[] = ACTION_DOMAINS.map((domain) => ({
    domain,
    status: 'CANNOT_SEE' as const,
  }));

  it('does not call an unanalysed surface healthy', () => {
    // The regression: digestVerdict([]) returned tone 'ok' with "your recent
    // agent activity looks healthy" whether we had examined everything and
    // found nothing, or examined nothing at all.
    const v = digestVerdict([], []);
    expect(v.tone).toBe('unknown');
    expect(v.text).not.toMatch(/looks healthy/i);
    expect(v.text).toMatch(/not a clean bill of health/i);
  });

  it('does not call an all-blind surface healthy either', () => {
    const v = digestVerdict([], blindCoverage);
    expect(v.tone).toBe('unknown');
  });

  it('still reports healthy when we looked and found nothing', () => {
    const v = digestVerdict([], fullCoverage);
    expect(v.tone).toBe('ok');
    expect(v.text).toMatch(/looks healthy/i);
  });

  it('qualifies a clean verdict when some domains had no data', () => {
    const partial: DomainCoverage[] = [
      { domain: 'safety', status: 'PROVE' },
      { domain: 'cost', status: 'CANNOT_SEE' },
    ];
    const v = digestVerdict([], partial);
    expect(v.tone).toBe('ok');
    // The clean claim is scoped to what was observed, not the whole surface.
    expect(v.text).toMatch(/1 domain\(s\) with data/);
    expect(v.text).toMatch(/1 domain\(s\) had none to judge/);
  });

  it('marks findings provisional when nothing reported coverage', () => {
    const v = digestVerdict([rec('cost', 'warning')], []);
    expect(v.tone).toBe('unknown');
    expect(v.text).toMatch(/provisional/i);
  });
});
