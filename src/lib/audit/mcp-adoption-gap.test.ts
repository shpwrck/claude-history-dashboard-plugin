/**
 * Tests for the MCP adoption-gap audit (#605 / #740).
 *
 * The judge is injected, so these cover the deterministic capability-gap
 * selection -> judge-interpret path without the network. The load-bearing case
 * the acceptance requires is the installed-vs-gap distinction: the SAME
 * capability surfaces as a gap when no matching server is installed, and is
 * EXCLUDED when one is (already-installed = the cost concern, not adoption).
 */
import { describe, it, expect } from 'vitest';
import {
  detectCapabilityGaps,
  runMcpAdoptionGapAudit,
  DEFAULT_DETECT_OPTIONS,
  type ToolUsageSignal,
  type CapabilityGap,
} from './mcp-adoption-gap';
import type { JudgeFn } from './judge';

// Heavy web + github usage, well above the default minWeight of 5.
const USAGE: ToolUsageSignal[] = [
  { capability: 'web-fetch', evidence: 'WebFetch used 40 time(s)', weight: 40 },
  { capability: 'github', evidence: 'Bash `gh` invoked 12 time(s)', weight: 12 },
];

const accept: JudgeFn = async () => ({
  isFinding: true,
  rationale: 'Recurring need an MCP server would cover.',
  confidence: 'high',
});

describe('detectCapabilityGaps', () => {
  it('surfaces a capability with no matching installed server as a gap', () => {
    const gaps = detectCapabilityGaps([], USAGE);
    expect(gaps.map((g) => g.capability)).toEqual(['web-fetch', 'github']);
    // Ranked by weight desc.
    expect(gaps[0].capability).toBe('web-fetch');
    expect(gaps[0].candidateServer).toBe('fetch');
    expect(gaps[0].evidence).toContain('WebFetch');
  });

  it('EXCLUDES a capability already covered by an installed server', () => {
    // `github` is installed -> the github gap is dropped, web-fetch survives.
    const gaps = detectCapabilityGaps(['github'], USAGE);
    expect(gaps.map((g) => g.capability)).toEqual(['web-fetch']);
  });

  it('matches installed servers case-insensitively and namespaced', () => {
    // A namespaced installed id like `claude_ai_GitHub` still covers `github`.
    const gaps = detectCapabilityGaps(['claude_ai_GitHub'], USAGE);
    expect(gaps.map((g) => g.capability)).toEqual(['web-fetch']);
  });

  it('does not fire on weak / low-weight signals', () => {
    const weak: ToolUsageSignal[] = [
      { capability: 'web-fetch', evidence: 'WebFetch used 2 time(s)', weight: 2 },
    ];
    expect(detectCapabilityGaps([], weak)).toEqual([]);
  });

  it('ignores signals for capabilities not in the map', () => {
    const unknown: ToolUsageSignal[] = [
      { capability: 'telepathy', evidence: 'mind read 99 time(s)', weight: 99 },
    ];
    expect(detectCapabilityGaps([], unknown)).toEqual([]);
  });

  it('merges multiple signals for the same capability', () => {
    const split: ToolUsageSignal[] = [
      { capability: 'web-fetch', evidence: 'WebFetch x3', weight: 3 },
      { capability: 'web-fetch', evidence: 'WebSearch x4', weight: 4 },
    ];
    const gaps = detectCapabilityGaps([], split);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].weight).toBe(7);
    expect(gaps[0].evidence).toContain('WebFetch x3');
    expect(gaps[0].evidence).toContain('WebSearch x4');
  });

  it('respects the topN cap', () => {
    const many: ToolUsageSignal[] = [
      { capability: 'web-fetch', evidence: 'w', weight: 40 },
      { capability: 'github', evidence: 'g', weight: 30 },
      { capability: 'database', evidence: 'd', weight: 20 },
      { capability: 'browser', evidence: 'b', weight: 10 },
    ];
    const gaps = detectCapabilityGaps([], many, {
      ...DEFAULT_DETECT_OPTIONS,
      topN: 2,
    });
    expect(gaps.map((g) => g.capability)).toEqual(['web-fetch', 'github']);
  });
});

describe('runMcpAdoptionGapAudit', () => {
  it('emits a finding naming the candidate server + evidence', async () => {
    const gaps = detectCapabilityGaps([], USAGE);
    const findings = await runMcpAdoptionGapAudit(gaps, accept);
    expect(findings).toHaveLength(2);
    const web = findings.find((f) => f.id === 'mcp-adoption-gap:fetch');
    expect(web).toBeDefined();
    expect(web?.domain).toBe('workflow');
    expect(web?.summary).toContain('not installed');
    expect(web?.summary).toContain('fetch');
    expect(web?.evidenceRefs).toEqual([
      'capability:web-fetch',
      'candidate-server:fetch',
    ]);
    expect(web?.confidence).toBe('high');
  });

  it('the installed-vs-gap distinction carries through to findings', async () => {
    // github installed -> only the web-fetch adoption gap is emitted.
    const gaps = detectCapabilityGaps(['github'], USAGE);
    const findings = await runMcpAdoptionGapAudit(gaps, accept);
    expect(findings.map((f) => f.id)).toEqual(['mcp-adoption-gap:fetch']);
  });

  it('emits nothing when the judge rejects every gap', async () => {
    const reject: JudgeFn = async () => ({
      isFinding: false,
      rationale: 'A one-off, not worth a server.',
      confidence: 'low',
    });
    const gaps = detectCapabilityGaps([], USAGE);
    expect(await runMcpAdoptionGapAudit(gaps, reject)).toEqual([]);
  });

  it('isolates a per-candidate judge failure', async () => {
    // The web-fetch judge call throws (skipped); github still surfaces.
    const flaky: JudgeFn = async ({ user }) => {
      if (user.includes('fetch')) throw new Error('transient');
      return { isFinding: true, rationale: 'real', confidence: 'medium' };
    };
    const gaps = detectCapabilityGaps([], USAGE);
    const findings = await runMcpAdoptionGapAudit(gaps, flaky);
    expect(findings.map((f) => f.id)).toEqual(['mcp-adoption-gap:github']);
  });

  it('returns [] for empty input', async () => {
    const none: CapabilityGap[] = [];
    expect(await runMcpAdoptionGapAudit(none, accept)).toEqual([]);
  });

  it('returns [] when the deterministic seed produces no gaps', async () => {
    // All usage is below the support floor -> no candidates -> no judge calls.
    const weak: ToolUsageSignal[] = [
      { capability: 'web-fetch', evidence: 'WebFetch x1', weight: 1 },
    ];
    const gaps = detectCapabilityGaps([], weak);
    expect(gaps).toEqual([]);
    expect(await runMcpAdoptionGapAudit(gaps, accept)).toEqual([]);
  });
});
