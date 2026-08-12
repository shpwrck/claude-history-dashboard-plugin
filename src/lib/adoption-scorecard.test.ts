import { describe, it, expect } from 'vitest';
import {
  buildAdoptionScorecard,
  liveClaudeMdHunk,
} from './adoption-scorecard';
import { findingMarkerCatalog } from './detectors';
import { nativeBypassGuidanceSnippet } from './native-bypass-snippet';
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
// surfaced→MARKER-CONFIRMED path (#1785). The heading alone is not enough — the strict-AND
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

  it('header: N surfaced / M marker-confirmed / median days-to-marker-match', () => {
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

  it('uses the latest lifecycle when receipts arrive out of timestamp order', () => {
    const receipts: AdoptionReceipt[] = [
      surfaced('2026-05-28T00:00:00.000Z', ['x']),
      surfaced('2026-05-25T00:00:00.000Z', ['x']),
      suppressed('2026-05-30T00:00:00.000Z', 'x'),
      suppressed('2026-05-27T00:00:00.000Z', 'x'),
    ];
    const sc = buildAdoptionScorecard(receipts, config(CLAUDE_MD));
    const row = sc.rows[0];
    expect(row.surfaced?.ts).toBe('2026-05-28T00:00:00.000Z');
    expect(row.suppressed?.ts).toBe('2026-05-30T00:00:00.000Z');
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

  it('SURFACED finding whose detector markers are present live (no suppression yet) is MARKER-CONFIRMED (#1785)', () => {
    // The receipt carries the EMITTED finding id — the api-errors detector's
    // fix-carrying warning branch emits `reliability.rate-limits`, and that is
    // what the /recs hook records (#2965; the catalog keys markers there).
    const receipts: AdoptionReceipt[] = [
      surfaced('2026-05-28T00:00:00.000Z', ['reliability.rate-limits']),
    ];
    // No suppression record, so no stored markerHeading — the heading is
    // resolved from the live detector catalog by finding id. The fix's full
    // strict-AND markers are present in CLAUDE.md, so the fix has landed and the
    // row reaches the "awaiting quiet" MARKER-CONFIRMED state with the live hunk rendered.
    const sc = buildAdoptionScorecard(
      receipts,
      config(CLAUDE_MD_RATE_LIMIT_ADOPTED),
      findingMarkerCatalog()
    );
    expect(sc.rows[0].status).toBe('MARKER-CONFIRMED');
    expect(sc.rows[0].liveHunk).toContain('## Rate-limit hygiene');
    expect(sc.rows[0].liveHunk).toContain('Avoid launching many parallel agent runs');
    // Still excluded from the coached M count — that requires a suppression.
    expect(sc.header.adoptedCount).toBe(0);
  });

  it('SURFACED info-branch id does not borrow the fix markers (dual-emit, #2965)', () => {
    // `reliability.api-errors` is the detector id and the MARKERLESS info
    // branch's emitted id. It must not resolve the rate-limit fix markers —
    // an info finding carrying no fix can never be "adopted", even with the
    // markers present live (the retired catalog serves only the suppressed
    // path, for historical receipts stored under the detector id).
    const receipts: AdoptionReceipt[] = [
      surfaced('2026-05-28T00:00:00.000Z', ['reliability.api-errors']),
    ];
    const sc = buildAdoptionScorecard(
      receipts,
      config(CLAUDE_MD_RATE_LIMIT_ADOPTED),
      findingMarkerCatalog()
    );
    expect(sc.rows[0].status).toBe('SURFACED');
    expect(sc.rows[0].liveHunk).toBeNull();
  });

  it('recognizes the universal native-bypass policy without inventing examples', () => {
    const guidance = nativeBypassGuidanceSnippet([
      { category: 'grep', nativeTool: 'Grep' },
    ]);
    expect(guidance).not.toContain('Bash `find`');
    expect(guidance).not.toContain('Bash `cat`');

    const sc = buildAdoptionScorecard(
      [
        surfaced('2026-05-28T00:00:00.000Z', [
          'workflow.native-bypass',
        ]),
      ],
      config(guidance),
      findingMarkerCatalog()
    );
    expect(sc.rows[0].status).toBe('MARKER-CONFIRMED');
    expect(sc.rows[0].liveHunk).toContain(
      'choose native tools or path-safe alternatives before Bash'
    );
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
    // Omitting the third arg (e.g. the sample build) preserves the prior behaviour:
    // surfaced-only findings cannot reach MARKER-CONFIRMED without the catalog.
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

  it('orders SUPPRESSED before MARKER-CONFIRMED before SURFACED', () => {
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
    // safety.dangerous-bypass retired its active marker in #2642 because current
    // settings, not stale prose, are authoritative. Its suppression-only legacy
    // signature still disambiguates historical receipts by body phrase.
    const claudeMd = [
      '# Project conventions',
      '',
      '## Claude Coach Adopted Recommendations',
      '',
      '### Tools with high error rates (`reliability.tool-errors`)',
      '',
      'Adopted: 2026-06-18T00:00:00.000Z',
      '',
      '{ "hooks": { "PostToolUse": [] } }',
      '',
      '## Claude Coach Adopted Recommendations',
      '',
      '### Dangerous commands ran under bypassed permissions (`safety.dangerous-bypass`)',
      '',
      'Adopted: 2026-06-18T00:00:00.000Z',
      '',
      '{ "permissions": { "deny": ["Bash(rm -rf:*)"] } }',
    ].join('\n');
    const receipts: AdoptionReceipt[] = [
      surfaced('2026-06-15T00:00:00.000Z', [
        'safety.dangerous-bypass',
        'reliability.tool-errors',
      ]),
      suppressed('2026-06-18T00:00:00.000Z', 'safety.dangerous-bypass', 'Claude Coach Adopted Recommendations'),
      suppressed('2026-06-18T00:00:00.000Z', 'reliability.tool-errors', 'Claude Coach Adopted Recommendations'),
    ];
    const sc = buildAdoptionScorecard(
      receipts,
      config(claudeMd),
      findingMarkerCatalog()
    );
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

  it('does not use a retired suppression marker to adopt a surfaced-only finding', () => {
    const claudeMd = [
      '## Claude Coach Adopted Recommendations',
      '',
      '### Dangerous commands ran under bypassed permissions (`safety.dangerous-bypass`)',
    ].join('\n');
    const sc = buildAdoptionScorecard(
      [surfaced('2026-06-15T00:00:00.000Z', ['safety.dangerous-bypass'])],
      config(claudeMd),
      findingMarkerCatalog()
    );

    expect(sc.rows[0].status).toBe('SURFACED');
    expect(sc.rows[0].liveHunk).toBeNull();
  });
});

describe('treatment-scoped findings (#2842)', () => {
  // A CLAUDE.md carrying the shadow-prompt marker signature (heading + body
  // phrase) — i.e. ONE prompt treatment ("structured") has been adopted.
  const SHADOW_PROMPT_ADOPTED = [
    '# Project conventions',
    '',
    '## Winning prompt framing (from shadow-calls #513)',
    '',
    'For the tasks these prompt shadow experiments sampled, prefer the "structured" prompt framing — it won 83% of 6 decided shadow comparisons.',
    '',
    '## Another section',
    '',
    'Unrelated.',
  ].join('\n');

  it('does NOT mark a treatment-scoped finding MARKER-CONFIRMED from generic marker presence', () => {
    // "structured" adopted (marker section present), but a different treatment
    // ("concise") is still live-surfaced — the finding must not read as adopted.
    const sc = buildAdoptionScorecard(
      [surfaced('2026-07-01T00:00:00.000Z', ['workflow.shadow-prompt'])],
      config(SHADOW_PROMPT_ADOPTED),
      findingMarkerCatalog()
    );
    const row = sc.rows.find((r) => r.findingId === 'workflow.shadow-prompt')!;
    expect(row.status).toBe('SURFACED'); // NOT MARKER-CONFIRMED
    expect(row.liveHunk).toBeNull(); // the earlier treatment's hunk is not attributed
    expect(sc.header.adoptedCount).toBe(0);
  });

  it('still reaches SUPPRESSED when quiet (a suppression with no newer surface)', () => {
    const sc = buildAdoptionScorecard(
      [
        surfaced('2026-07-01T00:00:00.000Z', ['workflow.shadow-prompt']),
        suppressed('2026-07-03T00:00:00.000Z', 'workflow.shadow-prompt', 'Winning prompt framing'),
      ],
      config(SHADOW_PROMPT_ADOPTED),
      findingMarkerCatalog()
    );
    const row = sc.rows.find((r) => r.findingId === 'workflow.shadow-prompt')!;
    expect(row.status).toBe('SUPPRESSED');
    expect(sc.header.adoptedCount).toBe(1);
  });

  it('re-fired treatment supersedes an OLDER terminal suppression (the realistic lifecycle)', () => {
    // structured surfaced -> adopted (SUPPRESSED) -> later "concise" qualifies and
    // re-fires: a SURFACED receipt newer than the suppression. The finding is live
    // again (a different unadopted treatment), NOT terminally adopted (#2842 P1).
    const sc = buildAdoptionScorecard(
      [
        surfaced('2026-07-01T00:00:00.000Z', ['workflow.shadow-prompt']),
        suppressed('2026-07-03T00:00:00.000Z', 'workflow.shadow-prompt', 'Winning prompt framing'),
        surfaced('2026-07-05T00:00:00.000Z', ['workflow.shadow-prompt']),
      ],
      config(SHADOW_PROMPT_ADOPTED),
      findingMarkerCatalog()
    );
    const row = sc.rows.find((r) => r.findingId === 'workflow.shadow-prompt')!;
    expect(row.status).toBe('SURFACED'); // re-fired, not terminally SUPPRESSED
    expect(row.surfaced?.ts).toBe('2026-07-05T00:00:00.000Z');
    expect(row.suppressed).toBeNull();
    expect(row.daysToAdopt).toBeNull();
    expect(sc.header.adoptedCount).toBe(0);
  });

  it('a newer surface starts a fresh lifecycle for an ordinary finding too', () => {
    const sc = buildAdoptionScorecard(
      [
        surfaced('2026-07-01T00:00:00.000Z', ['reliability.api-errors'], 's1'),
        suppressed('2026-07-03T00:00:00.000Z', 'reliability.api-errors'),
        surfaced('2026-07-05T00:00:00.000Z', ['reliability.api-errors'], 's3'),
      ],
      null,
      findingMarkerCatalog()
    );
    const row = sc.rows.find((r) => r.findingId === 'reliability.api-errors')!;
    expect(row.status).toBe('SURFACED');
    expect(row.surfaced?.sessionHash).toBe('s3');
    expect(row.suppressed).toBeNull();
    expect(row.daysToAdopt).toBeNull();
    expect(sc.header.adoptedCount).toBe(0);
  });

  it('uses the latest lifecycle pair after a re-fired finding is suppressed again', () => {
    const sc = buildAdoptionScorecard(
      [
        surfaced('2026-07-01T00:00:00.000Z', ['workflow.shadow-prompt'], 's1'),
        suppressed('2026-07-02T00:00:00.000Z', 'workflow.shadow-prompt'),
        surfaced('2026-07-05T00:00:00.000Z', ['workflow.shadow-prompt'], 's3'),
        suppressed('2026-07-07T00:00:00.000Z', 'workflow.shadow-prompt'),
      ],
      config(SHADOW_PROMPT_ADOPTED),
      findingMarkerCatalog()
    );
    const row = sc.rows.find((candidate) => candidate.findingId === 'workflow.shadow-prompt')!;

    expect(row.status).toBe('SUPPRESSED');
    expect(row.surfaced?.sessionHash).toBe('s3');
    expect(row.suppressed?.ts).toBe('2026-07-07T00:00:00.000Z');
    expect(row.daysToAdopt).toBe(2);
    expect(sc.header.adoptedCount).toBe(1);
    expect(sc.header.medianDaysToAdopt).toBe(2);
  });

  it('withholds cross-treatment live evidence after the re-fired treatment is suppressed', () => {
    const twoTreatments = [
      '# Project conventions',
      '',
      '## Winning prompt framing (structured)',
      '',
      'For the tasks these prompt shadow experiments sampled, prefer the "structured" framing.',
      '',
      '## Winning prompt framing (concise)',
      '',
      'For the tasks these prompt shadow experiments sampled, prefer the "concise" framing.',
    ].join('\n');
    const sc = buildAdoptionScorecard(
      [
        surfaced('2026-07-01T00:00:00.000Z', ['workflow.shadow-prompt'], 'structured'),
        suppressed(
          '2026-07-02T00:00:00.000Z',
          'workflow.shadow-prompt',
          'Winning prompt framing',
          'sha256:structured'
        ),
        surfaced('2026-07-05T00:00:00.000Z', ['workflow.shadow-prompt'], 'concise'),
        suppressed(
          '2026-07-07T00:00:00.000Z',
          'workflow.shadow-prompt',
          'Winning prompt framing',
          'sha256:concise'
        ),
      ],
      config(twoTreatments),
      findingMarkerCatalog()
    );
    const row = sc.rows.find((candidate) => candidate.findingId === 'workflow.shadow-prompt')!;

    expect(row.status).toBe('SUPPRESSED');
    expect(row.surfaced?.sessionHash).toBe('concise');
    expect(row.suppressed?.contentFingerprint).toBe('sha256:concise');
    expect(row.liveHunk).toBeNull();
  });

  it('uses append order for equal timestamps in either event order', () => {
    const surface = surfaced(
      '2026-07-01T00:00:00.000Z',
      ['workflow.shadow-prompt'],
      'same-ts'
    );
    const suppression = suppressed(
      '2026-07-01T00:00:00.000Z',
      'workflow.shadow-prompt'
    );

    const surfaceThenSuppress = buildAdoptionScorecard(
      [surface, suppression],
      null,
      findingMarkerCatalog()
    ).rows[0];
    const suppressThenSurface = buildAdoptionScorecard(
      [suppression, surface],
      null,
      findingMarkerCatalog()
    ).rows[0];

    expect(surfaceThenSuppress.status).toBe('SUPPRESSED');
    expect(surfaceThenSuppress.suppressed).toBe(suppression);
    expect(suppressThenSurface.status).toBe('SURFACED');
    expect(suppressThenSurface.surfaced).toBe(surface);
    expect(suppressThenSurface.suppressed).toBeNull();
  });

  it('does not let a delayed older surface reopen a newer terminal suppression', () => {
    const sc = buildAdoptionScorecard(
      [
        surfaced('2026-07-01T00:00:00.000Z', ['ordinary.finding'], 's1'),
        suppressed('2026-07-03T00:00:00.000Z', 'ordinary.finding'),
        surfaced('2026-07-02T00:00:00.000Z', ['ordinary.finding'], 'delayed'),
      ],
      null,
      findingMarkerCatalog()
    );
    const row = sc.rows[0];

    expect(row.status).toBe('SUPPRESSED');
    expect(row.surfaced?.sessionHash).toBe('s1');
    expect(row.suppressed?.ts).toBe('2026-07-03T00:00:00.000Z');
  });

  it('ignores invalid lifecycle timestamps', () => {
    const sc = buildAdoptionScorecard(
      [
        surfaced('2026-07-01T00:00:00.000Z', ['ordinary.finding'], 'valid-surface'),
        suppressed('2026-07-03T00:00:00.000Z', 'ordinary.finding'),
        surfaced('not-a-timestamp', ['ordinary.finding'], 'invalid-time'),
      ],
      null,
      findingMarkerCatalog()
    );
    const row = sc.rows[0];

    expect(row.status).toBe('SUPPRESSED');
    expect(row.surfaced?.sessionHash).toBe('valid-surface');
    expect(row.suppressed?.ts).toBe('2026-07-03T00:00:00.000Z');
  });

  it('trusts a valid server-supplied timestamp without comparing the browser clock', () => {
    const sc = buildAdoptionScorecard(
      [
        surfaced('9999-01-01T00:00:00.000Z', ['ordinary.finding'], 'server-validated'),
      ],
      null,
      findingMarkerCatalog()
    );

    expect(sc.rows).toHaveLength(1);
    expect(sc.rows[0].status).toBe('SURFACED');
    expect(sc.rows[0].surfaced?.sessionHash).toBe('server-validated');
  });

  it('a NON-treatment-scoped finding still reaches MARKER-CONFIRMED from markers (guard is specific)', () => {
    // Uses the EMITTED fix-carrying id (#2965) — the catalog no longer
    // resolves the detector id for this dual-emit detector.
    const sc = buildAdoptionScorecard(
      [surfaced('2026-07-01T00:00:00.000Z', ['reliability.rate-limits'])],
      config(CLAUDE_MD_RATE_LIMIT_ADOPTED),
      findingMarkerCatalog()
    );
    const row = sc.rows.find((r) => r.findingId === 'reliability.rate-limits')!;
    expect(row.status).toBe('MARKER-CONFIRMED');
  });
});
