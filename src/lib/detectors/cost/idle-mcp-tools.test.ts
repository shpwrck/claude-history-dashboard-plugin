import { describe, it, expect } from 'vitest';
import { detector } from './idle-mcp-tools';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { LiveConfig } from '../../../types';
import type { ToolInventory } from '../../parse-tool-inventory';
import type { SessionTokenData } from '../../../types';

const inv = (sessionId: string, available: string[], used: string[]): ToolInventory =>
  ({ sessionId, toolsAvailable: available, toolsUsed: used, unusedTools: [], utilizationPct: 0 });

/** Minimal LiveConfig whose mcpServers carries the given server ids. */
const lc = (serverIds: string[]): LiveConfig =>
  ({ settings: {}, mcpServers: serverIds.map((id) => ({ id, scope: 'global' })) } as unknown as LiveConfig);

/** A token row whose only meaningful content is WHEN its turns were observed. */
const dated = (sessionId: string, ...timestamps: string[]): SessionTokenData =>
  ({
    sessionId,
    entries: timestamps.map((timestamp) => ({
      timestamp,
      model: 'claude-opus-4-8',
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
    })),
  }) as unknown as SessionTokenData;

const input = (
  toolInventories?: ToolInventory[],
  liveConfig: LiveConfig | null = null,
  tokenData: SessionTokenData[] = []
): RecommendationInput => ({
  tokenData, toolData: [], sessions: [], projects: [], permissionRows: [], apiErrors: [],
  liveConfig, toolInventories,
});

const fooLoadedNeverUsed = () => [
  inv('s1', ['mcp__foo__bar', 'Bash'], ['Bash']),
  inv('s2', ['mcp__foo__bar', 'Bash'], ['Bash']),
  inv('s3', ['mcp__foo__bar', 'Bash'], ['Bash']),
];

describe('cost.idle-mcp-tools (#416)', () => {
  it('fires for an MCP tool loaded in 3+ sessions and never used (no config to reconcile)', () => {
    const rec = detector.rule(input(fooLoadedNeverUsed()), 0);
    expect(rec?.id).toBe('cost.idle-mcp-tools');
    expect(rec?.fix?.note).toContain('foo');
  });
  it('ignores used MCP tools and sub-threshold load counts', () => {
    expect(detector.rule(input([
      inv('s1', ['mcp__foo__bar'], ['mcp__foo__bar']),
      inv('s2', ['mcp__foo__bar'], ['mcp__foo__bar']),
      inv('s3', ['mcp__foo__bar'], ['mcp__foo__bar']),
    ]), 0)).toBeNull();
    expect(detector.rule(input([inv('s1', ['mcp__foo__bar'], []), inv('s2', ['mcp__foo__bar'], [])]), 0)).toBeNull();
    expect(detector.rule(input(), 0)).toBeNull();
  });

  // ── Stale-input reconciliation (#1102) ───────────────────────────────────
  it('fires when the idle server is still configured', () => {
    const rec = detector.rule(input(fooLoadedNeverUsed(), lc(['foo'])), 0);
    expect(rec?.id).toBe('cost.idle-mcp-tools');
    expect(rec!.fix?.note).toContain('foo');
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });
  it('suppresses when the idle server is already gone from current config', () => {
    expect(detector.rule(input(fooLoadedNeverUsed(), lc(['github'])), 0)).toBeNull();
    expect(detector.rule(input(fooLoadedNeverUsed(), lc([])), 0)).toBeNull();
  });
  it('does not advise removing a server absent from current config (the audited bug)', () => {
    // foo + baz both idle historically, but only foo is still configured.
    const rec = detector.rule(input([
      inv('s1', ['mcp__foo__a', 'mcp__baz__a', 'Bash'], ['Bash']),
      inv('s2', ['mcp__foo__a', 'mcp__baz__a', 'Bash'], ['Bash']),
      inv('s3', ['mcp__foo__a', 'mcp__baz__a', 'Bash'], ['Bash']),
    ], lc(['foo'])), 0);
    expect(rec!.fix?.note).toContain('foo');
    expect(rec!.fix?.note).not.toContain('baz');
  });

  // ── #3197: the inventory is historical, so it must be dated, and the ──────
  // per-tool manifest overhead is not measured anywhere, so it must not be
  // quoted as a figure.
  describe('undated historical evidence and the unobserved token range (#3197)', () => {
    const OBSERVED = '2026-06-09T18:00:00.000Z';
    const RUN_AT = Date.parse('2026-06-10T00:00:00.000Z');
    const dates = (...ts: string[]) => [
      dated('s1', ...ts),
      dated('s2', ...ts),
      dated('s3', ...ts),
    ];

    it('quotes no manifest-token figure it never measured', () => {
      const rec = detector.rule(input(fooLoadedNeverUsed(), lc(['foo']), dates(OBSERVED)), RUN_AT)!;
      const wording = [rec.detail, rec.action, rec.provenance?.inference ?? ''].join('\n');
      // The old copy asserted "~50-200 tokens" on both surfaces. No inventory
      // field measures manifest token size, so no numeric range may appear.
      expect(wording).not.toMatch(/50\s*[-–]\s*200/);
      expect(wording).not.toMatch(/\d+\s*[-–]\s*\d+\s*tokens/);
    });

    it('dates the claim from the newest OBSERVED turn, not the clock', () => {
      // Fixture observes 2026-06-09 and runs at 2026-06-10: a clock-derived
      // date is off by one day and fails here (the #3459 guard shape).
      const rec = detector.rule(input(fooLoadedNeverUsed(), lc(['foo']), dates(OBSERVED)), RUN_AT)!;
      expect(rec.provenance?.asOf).toBe('2026-06-09');
      expect(rec.detail).toContain('2026-06-09');
    });

    it('demotes an inventory older than the staleness window', () => {
      const rec = detector.rule(
        input(fooLoadedNeverUsed(), lc(['foo']), dates('2026-03-01T00:00:00.000Z')),
        RUN_AT
      )!;
      expect(rec.provenance?.asOf).toBe('2026-03-01');
      expect(rec.provenance?.stale).toBe(true);
      // The demotion has to be visible to a reader, not just to the schema.
      expect(rec.detail).toMatch(/no longer|historical|confirm/i);
    });

    it('says out loud when the inventory could not be dated', () => {
      // No tokenData to join: the evidence is real but undatable. The refusal
      // must be observable rather than looking like fresh evidence.
      const rec = detector.rule(input(fooLoadedNeverUsed(), lc(['foo'])), RUN_AT)!;
      expect(rec.provenance?.asOf).toBeUndefined();
      expect(rec.provenance?.stale).toBeUndefined();
      expect(rec.detail).toMatch(/could not be dated|undated/i);
      expect(validateRecommendationProvenance(rec)).toEqual([]);
    });

    // ── Codex finding 4: unrelated sessions certified stale evidence fresh ───
    const twoServers = () => [
      inv('a1', ['mcp__foo__x', 'Bash'], ['Bash']),
      inv('a2', ['mcp__foo__x', 'Bash'], ['Bash']),
      inv('a3', ['mcp__foo__x', 'Bash'], ['Bash']),
      inv('b1', ['mcp__baz__x', 'Bash'], ['Bash']),
      inv('b2', ['mcp__baz__x', 'Bash'], ['Bash']),
      inv('b3', ['mcp__baz__x', 'Bash'], ['Bash']),
    ];

    it('dates from sessions that LOADED the flagged tool, not from any inventory', () => {
      // foo is idle across three January-2025 sessions. A fourth, unrelated
      // session from July 2026 loaded only Bash — it contributes nothing to
      // the idle finding and must not make it look current.
      const rec = detector.rule(
        input([...fooLoadedNeverUsed(), inv('s-unrelated', ['Bash'], ['Bash'])], lc(['foo']), [
          dated('s1', '2025-01-15T00:00:00.000Z'),
          dated('s2', '2025-01-15T00:00:00.000Z'),
          dated('s3', '2025-01-15T00:00:00.000Z'),
          dated('s-unrelated', '2026-07-29T00:00:00.000Z'),
        ]),
        RUN_AT
      )!;
      expect(rec.provenance?.asOf).toBe('2025-01-15');
      expect(rec.provenance?.stale).toBe(true);
    });

    it('never dates the claim fresher than its stalest flagged tool', () => {
      // One card, two tools: foo last seen 2025-01, baz 2026-06. The aggregate
      // claim is only as fresh as the older evidence behind it.
      const rec = detector.rule(
        input(twoServers(), lc(['foo', 'baz']), [
          dated('a1', '2025-01-15T00:00:00.000Z'),
          dated('a2', '2025-01-15T00:00:00.000Z'),
          dated('a3', '2025-01-15T00:00:00.000Z'),
          dated('b1', '2026-06-09T00:00:00.000Z'),
          dated('b2', '2026-06-09T00:00:00.000Z'),
          dated('b3', '2026-06-09T00:00:00.000Z'),
        ]),
        RUN_AT
      )!;
      expect(rec.provenance?.asOf).toBe('2025-01-15');
    });

    it('discloses when some flagged tools could not be dated at all', () => {
      // foo is datable, baz is not. Partial coverage must be visible rather
      // than absorbed into foo's date.
      const rec = detector.rule(
        input(twoServers(), lc(['foo', 'baz']), [
          dated('a1', '2026-06-09T00:00:00.000Z'),
          dated('a2', '2026-06-09T00:00:00.000Z'),
          dated('a3', '2026-06-09T00:00:00.000Z'),
        ]),
        RUN_AT
      )!;
      expect(rec.detail).toMatch(/could not be dated/i);
      const coverage = rec.provenance?.observations.find((o) =>
        /could not be dated/i.test(o.claim)
      );
      expect(coverage, 'undated coverage not surfaced in provenance').toBeDefined();
      expect(coverage!.value).toBe(1);
      expect(validateRecommendationProvenance(rec)).toEqual([]);
      // Derived from the CLAIM, not from the code: the card promises it does
      // not assert a date it cannot support. A structured consumer reads
      // provenance.asOf, never the prose caveat — so deriving an aggregate
      // date from the SURVIVING dated tools certifies the whole finding fresh.
      expect(rec.provenance?.asOf).toBeUndefined();
      expect(rec.provenance?.stale).toBeUndefined();
    });

    it('asserts no aggregate freshness while any flagged tool is undated', () => {
      // One tool dated INSIDE the freshness window, one undated. Deriving
      // `asOf` from the dated survivor would publish stale:false over a
      // population that is only half observed.
      const rec = detector.rule(
        input(twoServers(), lc(['foo', 'baz']), [
          dated('a1', '2026-06-09T00:00:00.000Z'),
          dated('a2', '2026-06-09T00:00:00.000Z'),
          dated('a3', '2026-06-09T00:00:00.000Z'),
        ]),
        RUN_AT
      )!;
      expect(rec.provenance?.stale).not.toBe(false);
      expect(rec.provenance?.asOf).toBeUndefined();
    });

    it('cites the loaded-vs-invoked counts that actually back the claim', () => {
      const rec = detector.rule(input(fooLoadedNeverUsed(), lc(['foo']), dates(OBSERVED)), RUN_AT)!;
      const loaded = rec.provenance?.observations.find((o) =>
        /loaded/i.test(o.claim) && /loadedIn/.test(o.field ?? '')
      );
      expect(loaded, 'no observation cites the loaded-in counts').toBeDefined();
      expect(loaded!.value).toBe(3);
      expect(validateRecommendationProvenance(rec)).toEqual([]);
    });
  });
});
