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

  it('does not let an unrelated installed id suppress a capability gap (#3112)', () => {
    // Substring matching used to treat any overlap as coverage: `webhook`
    // contains `web`, `github-backup` starts with `github`, `browserless-metrics`
    // contains `browser`. None of those servers provides the mapped capability,
    // so every gap must survive — suppressing one is itself a claim.
    const usage: ToolUsageSignal[] = [
      ...USAGE,
      {
        capability: 'browser',
        evidence: 'Bash `playwright` invoked 9 time(s)',
        weight: 9,
      },
    ];
    const installed = ['webhook', 'github-backup', 'browserless-metrics'];
    const gaps = detectCapabilityGaps(installed, usage);
    expect(gaps.map((g) => g.capability).sort()).toEqual([
      'browser',
      'github',
      'web-fetch',
    ]);
  });

  it('still treats a namespaced or packaging-suffixed id as coverage (#3112)', () => {
    // Coverage requires the id to EQUAL a registered alias once the enumerated
    // namespace prefixes and `-mcp`/`-server` suffixes are removed.
    const caps = (installed: string[], usage = USAGE) =>
      detectCapabilityGaps(installed, usage)
        .map((g) => g.capability)
        .sort();
    expect(caps(['claude_ai_GitHub'])).toEqual(['web-fetch']);
    expect(caps(['github-mcp'])).toEqual(['web-fetch']);
    expect(caps(['mcp__github__server'])).toEqual(['web-fetch']);
    // A multi-token alias matches as a unit...
    expect(caps(['mcp__brave-search'])).toEqual(['github']);
    // ...but a server that merely SHARES one of its tokens does not.
    expect(caps(['search-index'])).toEqual(['github', 'web-fetch']);
  });

  it('does not accept an arbitrary PREFIX as a namespace (#3392 P2)', () => {
    // `liveConfig.mcpServers[].id` is an arbitrary key from ~/.claude.json, so
    // `backup-github` and `internal-web` are ordinary ids for unrelated servers.
    // Treating any leading token as a namespace made them suppress the very gaps
    // `github-backup` / `webhook` were fixed for — the same false suppression
    // from the other end. Only the enumerated namespace forms are removable.
    const usage: ToolUsageSignal[] = [
      ...USAGE,
      {
        capability: 'browser',
        evidence: 'Bash `playwright` invoked 9 time(s)',
        weight: 9,
      },
    ];
    const caps = (installed: string[]) =>
      detectCapabilityGaps(installed, usage)
        .map((g) => g.capability)
        .sort();
    const ALL = ['browser', 'github', 'web-fetch'];

    // Prefix direction (this finding).
    expect(caps(['backup-github'])).toEqual(ALL);
    expect(caps(['internal-web'])).toEqual(ALL);
    expect(caps(['legacy-playwright', 'staging-fetch'])).toEqual(ALL);
    // Suffix direction (#3112) still holds.
    expect(caps(['github-backup'])).toEqual(ALL);
    expect(caps(['webhook'])).toEqual(ALL);
    expect(caps(['browserless-metrics'])).toEqual(ALL);
    // Both ends at once, and a bare unrelated id.
    expect(caps(['internal-github-backup'])).toEqual(ALL);
    expect(caps(['backup', 'internal'])).toEqual(ALL);

    // The pinned positives are untouched: an enumerated namespace prefix, a
    // packaging suffix, and a bare alias all still count as coverage.
    expect(caps(['claude_ai_GitHub'])).toEqual(['browser', 'web-fetch']);
    expect(caps(['github-mcp'])).toEqual(['browser', 'web-fetch']);
    expect(caps(['mcp__brave-search'])).toEqual(['browser', 'github']);
    expect(caps(['github'])).toEqual(['browser', 'web-fetch']);
    expect(caps(['mcp__playwright'])).toEqual(['github', 'web-fetch']);
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
