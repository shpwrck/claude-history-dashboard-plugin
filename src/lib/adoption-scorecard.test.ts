import { describe, it, expect } from 'vitest';
import {
  buildAdoptionScorecard,
  liveClaudeMdHunk,
} from './adoption-scorecard';
import { findingMarkerCatalog } from './detectors';
import type {
  AdoptionReceipt,
  SurfacedReceipt,
  SuppressedReceipt,
} from './adoption-receipts';
import type { LiveConfig } from '../types';

function surfaced(
  ts: string,
  findingIds: string[],
  sessionHash = 'sess'
): SurfacedReceipt {
  return { schemaVersion: '1', kind: 'SURFACED', ts, sessionHash, findingIds };
}

function suppressed(
  ts: string,
  findingId: string,
  markerHeading = 'Rate-limit hygiene',
  contentFingerprint = 'sha256:abc'
): SuppressedReceipt {
  return {
    schemaVersion: '1',
    kind: 'SUPPRESSED',
    ts,
    findingId,
    markerHeading,
    contentFingerprint,
  };
}

const CLAUDE_MD = `# Project conventions

Some intro prose.

## Rate-limit hygiene

Serialize heavy automated batches so the engine stays under the cap.

- one
- two

## Another section

Unrelated body.
`;

// CLAUDE.md carrying the FULL `reliability.api-errors` marker signature
// (MARKERS_RATE_LIMITS): the `## Rate-limit hygiene` heading AND its body phrase
// "Avoid launching many parallel agent runs". Used for the catalog-backed
// surfaced→ADOPTED path (#1785). The heading alone is not enough — the strict-AND
// markers also require the body phrase.
const CLAUDE_MD_RATE_LIMIT_ADOPTED = `# Project conventions

## Rate-limit hygiene

Avoid launching many parallel agent runs; serialize heavy automated batches so
the engine stays under the cap.

## Another section

Unrelated body.
`;

function config(global: string | null): LiveConfig {
  return {
    settings: {},
    claudeMd: { global, perProject: {} },
    plugins: [],
    mcpServers: [],
    skills: [],
    subagents: [],
    commands: [],
  } as unknown as LiveConfig;
}

describe('liveClaudeMdHunk', () => {
  it('extracts the section body by heading text, live (never stored)', () => {
    const hunk = liveClaudeMdHunk(config(CLAUDE_MD), 'Rate-limit hygiene');
    expect(hunk).toContain('## Rate-limit hygiene');
    expect(hunk).toContain('Serialize heavy automated batches');
    // stops before the next same-depth heading
    expect(hunk).not.toContain('Another section');
  });

  it('matches case-insensitively and tolerates heading depth', () => {
    const md = `### rate-limit HYGIENE\n\nbody here\n`;
    const hunk = liveClaudeMdHunk(config(md), 'Rate-limit hygiene');
    expect(hunk).toContain('rate-limit HYGIENE');
    expect(hunk).toContain('body here');
  });

  it('returns null when the section is absent (e.g. deleted)', () => {
    expect(liveClaudeMdHunk(config('# nothing here\n'), 'Rate-limit hygiene')).toBeNull();
    expect(liveClaudeMdHunk(config(null), 'Rate-limit hygiene')).toBeNull();
    expect(liveClaudeMdHunk(null, 'Rate-limit hygiene')).toBeNull();
  });

  it('returns null for an empty heading', () => {
    expect(liveClaudeMdHunk(config(CLAUDE_MD), '   ')).toBeNull();
  });
});

describe('buildAdoptionScorecard', () => {
  it('joins SURFACED + SUPPRESSED on finding id and reads the hunk live', () => {
    const receipts: AdoptionReceipt[] = [
      surfaced('2026-05-28T00:00:00.000Z', ['reliability.rate-limits']),
      suppressed('2026-05-29T00:00:00.000Z', 'reliability.rate-limits'),
    ];
    const sc = buildAdoptionScorecard(receipts, config(CLAUDE_MD));
    expect(sc.rows).toHaveLength(1);
    const row = sc.rows[0];
    expect(row.findingId).toBe('reliability.rate-limits');
    expect(row.status).toBe('SUPPRESSED');
    expect(row.surfaced).not.toBeNull();
    expect(row.suppressed).not.toBeNull();
    // live hunk derived from liveConfig, not from the receipt
    expect(row.liveHunk).toContain('Serialize heavy automated batches');
    expect(row.daysToAdopt).toBe(1);
    expect(row.attributionPending).toBe(false);
  });

  it('header: N surfaced / M adopted / median days-to-adopt', () => {
    const receipts: AdoptionReceipt[] = [
      surfaced('2026-05-20T00:00:00.000Z', ['a', 'b', 'c']),
      suppressed('2026-05-22T00:00:00.000Z', 'a', 'Heading A'),
      suppressed('2026-05-26T00:00:00.000Z', 'b', 'Heading B'),
    ];
    const sc = buildAdoptionScorecard(receipts, config(CLAUDE_MD));
    expect(sc.header.surfacedCount).toBe(3);
    expect(sc.header.adoptedCount).toBe(2);
    // days-to-adopt: a=2, b=6 → median 4
    expect(sc.header.medianDaysToAdopt).toBe(4);
  });

  it('uses the earliest surface and first suppression per finding', () => {
    const receipts: AdoptionReceipt[] = [
      surfaced('2026-05-28T00:00:00.000Z', ['x']),
      surfaced('2026-05-25T00:00:00.000Z', ['x']),
      suppressed('2026-05-30T00:00:00.000Z', 'x'),
      suppressed('2026-05-27T00:00:00.000Z', 'x'),
    ];
    const sc = buildAdoptionScorecard(receipts, config(CLAUDE_MD));
    const row = sc.rows[0];
    expect(row.surfaced?.ts).toBe('2026-05-25T00:00:00.000Z');
    expect(row.suppressed?.ts).toBe('2026-05-27T00:00:00.000Z');
    expect(row.daysToAdopt).toBe(2);
  });

  it('SURFACED-only finding with no catalog entry stays SURFACED', () => {
    const receipts: AdoptionReceipt[] = [
      surfaced('2026-05-28T00:00:00.000Z', ['pending.thing']),
    ];
    // `pending.thing` is not a marker-bearing detector, so even with the live
    // catalog supplied there are no markers to resolve → SURFACED.
    const sc = buildAdoptionScorecard(
      receipts,
      config(CLAUDE_MD),
      findingMarkerCatalog()
    );
    expect(sc.rows[0].status).toBe('SURFACED');
    expect(sc.rows[0].liveHunk).toBeNull();
    expect(sc.header.adoptedCount).toBe(0);
  });

  it('SURFACED finding whose detector markers are present live (no suppression yet) is ADOPTED (#1785)', () => {
    const receipts: AdoptionReceipt[] = [
      surfaced('2026-05-28T00:00:00.000Z', ['reliability.api-errors']),
    ];
    // No suppression record, so no stored markerHeading — the heading is
    // resolved from the live detector catalog by finding id. The fix's full
    // strict-AND markers are present in CLAUDE.md, so the fix has landed and the
    // row reaches the "awaiting quiet" ADOPTED state with the live hunk rendered.
    const sc = buildAdoptionScorecard(
      receipts,
      config(CLAUDE_MD_RATE_LIMIT_ADOPTED),
      findingMarkerCatalog()
    );
    expect(sc.rows[0].status).toBe('ADOPTED');
    expect(sc.rows[0].liveHunk).toContain('## Rate-limit hygiene');
    expect(sc.rows[0].liveHunk).toContain('Avoid launching many parallel agent runs');
    // Still excluded from the coached M count — that requires a suppression.
    expect(sc.header.adoptedCount).toBe(0);
  });

  it('SURFACED finding whose markers are only partially present stays SURFACED (strict-AND)', () => {
    const receipts: AdoptionReceipt[] = [
      surfaced('2026-05-28T00:00:00.000Z', ['reliability.api-errors']),
    ];
    // CLAUDE_MD has the `## Rate-limit hygiene` heading but NOT the required body
    // phrase, so the strict-AND markers are not satisfied → stays SURFACED.
    const sc = buildAdoptionScorecard(
      receipts,
      config(CLAUDE_MD),
      findingMarkerCatalog()
    );
    expect(sc.rows[0].status).toBe('SURFACED');
    expect(sc.rows[0].liveHunk).toBeNull();
  });

  it('without a marker catalog, a SURFACED-only finding stays SURFACED (back-compat)', () => {
    const receipts: AdoptionReceipt[] = [
      surfaced('2026-05-28T00:00:00.000Z', ['reliability.api-errors']),
    ];
    // Omitting the third arg (e.g. the SPA build) preserves the prior behaviour:
    // surfaced-only findings cannot reach ADOPTED without the catalog.
    const sc = buildAdoptionScorecard(receipts, config(CLAUDE_MD_RATE_LIMIT_ADOPTED));
    expect(sc.rows[0].status).toBe('SURFACED');
    expect(sc.rows[0].liveHunk).toBeNull();
  });

  it('attribution pending: suppression with no prior surface excluded from M', () => {
    const receipts: AdoptionReceipt[] = [
      suppressed('2026-05-29T00:00:00.000Z', 'organic.finding'),
    ];
    const sc = buildAdoptionScorecard(receipts, config(CLAUDE_MD));
    const row = sc.rows[0];
    expect(row.status).toBe('SUPPRESSED');
    expect(row.attributionPending).toBe(true);
    expect(row.surfaced).toBeNull();
    expect(sc.header.adoptedCount).toBe(0); // organic excluded from coached M
  });

  it('median across odd/even counts and empty', () => {
    expect(buildAdoptionScorecard([], config(CLAUDE_MD)).header.medianDaysToAdopt).toBeNull();
  });

  it('orders SUPPRESSED before ADOPTED before SURFACED', () => {
    const receipts: AdoptionReceipt[] = [
      surfaced('2026-05-20T00:00:00.000Z', ['z-surfaced-only']),
      surfaced('2026-05-20T00:00:00.000Z', ['a-suppressed']),
      suppressed('2026-05-21T00:00:00.000Z', 'a-suppressed'),
    ];
    const sc = buildAdoptionScorecard(receipts, config(CLAUDE_MD));
    expect(sc.rows.map((r) => r.status)).toEqual(['SUPPRESSED', 'SURFACED']);
  });

  it('suppression hunk is null when the marker section was deleted live', () => {
    const receipts: AdoptionReceipt[] = [
      surfaced('2026-05-28T00:00:00.000Z', ['reliability.rate-limits']),
      suppressed('2026-05-29T00:00:00.000Z', 'reliability.rate-limits', 'Gone heading'),
    ];
    const sc = buildAdoptionScorecard(receipts, config(CLAUDE_MD));
    expect(sc.rows[0].status).toBe('SUPPRESSED');
    expect(sc.rows[0].liveHunk).toBeNull();
  });

  it('co-adopted findings sharing one section heading each resolve their OWN hunk (#1915)', () => {
    // safety.dangerous-bypass and reliability.tool-errors (#1783) both key on the
    // shared `## Claude Coach Adopted Recommendations` heading; adopting each
    // appends its own copy of that section. The stored markerHeading is identical
    // for both, so resolving by heading text alone would render the FIRST section
    // for both rows. Resolution must disambiguate by each finding's body phrase.
    const claudeMd = [
      '# Project conventions',
      '',
      '## Claude Coach Adopted Recommendations',
      '',
      '### Dangerous commands ran under bypassed permissions (`safety.dangerous-bypass`)',
      '',
      'Adopted: 2026-06-18T00:00:00.000Z',
      '',
      '{ "permissions": { "deny": ["Bash(rm -rf:*)"] } }',
      '',
      '## Claude Coach Adopted Recommendations',
      '',
      '### Tools with high error rates (`reliability.tool-errors`)',
      '',
      'Adopted: 2026-06-18T00:00:00.000Z',
      '',
      '{ "hooks": { "PostToolUse": [] } }',
    ].join('\n');
    const receipts: AdoptionReceipt[] = [
      surfaced('2026-06-15T00:00:00.000Z', [
        'safety.dangerous-bypass',
        'reliability.tool-errors',
      ]),
      suppressed('2026-06-18T00:00:00.000Z', 'safety.dangerous-bypass', 'Claude Coach Adopted Recommendations'),
      suppressed('2026-06-18T00:00:00.000Z', 'reliability.tool-errors', 'Claude Coach Adopted Recommendations'),
    ];
    const sc = buildAdoptionScorecard(receipts, config(claudeMd), findingMarkerCatalog());
    const byId = Object.fromEntries(sc.rows.map((r) => [r.findingId, r]));

    const bypass = byId['safety.dangerous-bypass'];
    expect(bypass.status).toBe('SUPPRESSED');
    expect(bypass.liveHunk).toContain('Dangerous commands ran under bypassed permissions');
    expect(bypass.liveHunk).toContain('Bash(rm -rf:*)');
    expect(bypass.liveHunk).not.toContain('Tools with high error rates');

    const toolErrors = byId['reliability.tool-errors'];
    expect(toolErrors.status).toBe('SUPPRESSED');
    expect(toolErrors.liveHunk).toContain('Tools with high error rates');
    expect(toolErrors.liveHunk).toContain('PostToolUse');
    expect(toolErrors.liveHunk).not.toContain('Dangerous commands ran under bypassed permissions');
  });
});
