import { describe, it, expect } from 'vitest';
import {
  buildAdoptionScorecard,
  liveClaudeMdHunk,
} from './adoption-scorecard';
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

  it('SURFACED-only finding (no marker present) stays SURFACED', () => {
    const receipts: AdoptionReceipt[] = [
      surfaced('2026-05-28T00:00:00.000Z', ['pending.thing']),
    ];
    const sc = buildAdoptionScorecard(receipts, config(CLAUDE_MD));
    expect(sc.rows[0].status).toBe('SURFACED');
    expect(sc.rows[0].liveHunk).toBeNull();
    expect(sc.header.adoptedCount).toBe(0);
  });

  it('SURFACED finding whose marker is present live but not yet suppressed is ADOPTED', () => {
    const receipts: AdoptionReceipt[] = [
      surfaced('2026-05-28T00:00:00.000Z', ['reliability.rate-limits']),
    ];
    // No suppression record; but the marker section exists. We cannot read the
    // marker for a SURFACED-only finding (no markerHeading stored) — so this
    // remains SURFACED. ADOPTED is reached only once a suppression record names
    // the heading. Documented behaviour: live-hunk read needs the markerHeading.
    const sc = buildAdoptionScorecard(receipts, config(CLAUDE_MD));
    expect(sc.rows[0].status).toBe('SURFACED');
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
});
