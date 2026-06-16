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

  it('defaults every domain to healthy coverage when no coverage signal is supplied', () => {
    const out = topPerDomain([rec('cost', 'warning')]);
    expect(out.every((d) => d.coverage === 'healthy')).toBe(true);
  });

  it('maps the per-domain coverage signal (#1480) onto all three levels', () => {
    const coverage: DomainCoverage[] = [
      { domain: 'safety', status: 'PROVE' },
      { domain: 'cost', status: 'CANNOT_SEE' },
      { domain: 'success-rate', status: 'INFER' },
    ];
    const out = topPerDomain([], coverage);
    const byDomain = new Map(out.map((d) => [d.domain, d.coverage]));
    // PROVE -> healthy, INFER -> sparse, CANNOT_SEE -> blind-spot.
    expect(byDomain.get('safety')).toBe('healthy');
    expect(byDomain.get('cost')).toBe('blind-spot');
    expect(byDomain.get('success-rate')).toBe('sparse');
    // Domains absent from the coverage array fall back to healthy.
    expect(byDomain.get('speed')).toBe('healthy');
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

describe('digestVerdict', () => {
  it('reports healthy when there are no findings', () => {
    expect(digestVerdict([]).tone).toBe('ok');
  });

  it('leads with safety when a safety finding is critical', () => {
    const v = digestVerdict([rec('cost', 'critical'), rec('safety', 'critical')]);
    expect(v.tone).toBe('critical');
    expect(v.text.toLowerCase()).toContain('safety');
  });

  it('flags attention for non-critical findings', () => {
    expect(digestVerdict([rec('cost', 'warning')]).tone).toBe('attention');
  });

  it('attention verdict names the top finding (no critical)', () => {
    const v = digestVerdict([
      rec('cost', 'warning', 'c1'),
      rec('context', 'info', 'x1'),
    ]);
    expect(v.tone).toBe('attention');
    expect(v.text).toContain('cost warning');
  });

  it('attention verdict names the top finding (critical present)', () => {
    const v = digestVerdict([
      rec('cost', 'critical', 'c1'),
      rec('context', 'info', 'x1'),
    ]);
    expect(v.tone).toBe('attention');
    expect(v.text).toContain('cost critical');
  });

  it('attention verdict names the top non-safety finding even when a non-critical safety finding ranks first', () => {
    const v = digestVerdict([
      rec('cost', 'warning', 'c1'),
      rec('safety', 'warning', 's1'),
    ]);
    expect(v.tone).toBe('attention');
    // safety ranks first in the digest, but the verdict names the top *non-safety* finding
    expect(v.text).toContain('cost warning');
  });
});
