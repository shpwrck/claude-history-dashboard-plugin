/**
 * Tests for workflow.correction-mining (#1040).
 *
 * Synthetic failed→succeeded tool sequences (the acceptance fixture): the
 * detector emits at least the file-path-correction category with evidence rows,
 * carries a marker-bearing CLAUDE.md fix, stays silent with no corrections, and
 * suppresses when the user has already written the facts down.
 */
import { describe, it, expect } from 'vitest';
import { detector } from './correction-mining';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { ToolCall, ToolUsageData } from '../../parse-tools';
import type { LiveConfig } from '../../../types';

const call = (over: Partial<ToolCall>): ToolCall => ({
  timestamp: 't', toolName: 'Bash', input: {}, toolUseId: 'u', isError: null, resultBytes: 0, ...over,
});
const read = (file_path: string, isError: boolean | null): ToolCall =>
  call({ toolName: 'Read', input: { file_path }, isError });
const bash = (command: string, isError: boolean | null): ToolCall =>
  call({ toolName: 'Bash', input: { command }, isError });
const session = (sessionId: string, calls: ToolCall[]): ToolUsageData => ({ sessionId, calls });

const input = (toolData: ToolUsageData[], liveConfig: LiveConfig | null = null): RecommendationInput => ({
  tokenData: [], toolData, sessions: [], projects: [], permissionRows: [], apiErrors: [], liveConfig,
});

const pathFix = () => [session('s1', [
  read('axion-formats/src/FirstClassEntity.java', true),
  read('axion-scala-common/src/FirstClassEntity.scala', false),
])];

describe('workflow.correction-mining (#1040)', () => {
  it('fires on a file-path correction with a failed→succeeded evidence row', () => {
    const rec = detector.rule(input(pathFix()), 0)!;
    expect(rec.id).toBe('workflow.correction-mining');
    expect(rec.category).toBe('workflow');
    expect(rec.affected).toBe(1);
    expect(rec.evidence![0]).toMatch(/Read: .*FirstClassEntity\.java → .*FirstClassEntity\.scala/);
  });

  it('ships a marker-bearing CLAUDE.md fix (adoption/suppression can track it)', () => {
    const rec = detector.rule(input(pathFix()), 0)!;
    expect(rec.fix?.target).toBe('CLAUDE.md');
    expect(rec.fix?.appliedMarkers?.headings?.length).toBeGreaterThan(0);
    expect(rec.fix?.snippet).toContain('FirstClassEntity.scala');
  });

  it('does not fire on command-only sequences (command category deferred)', () => {
    expect(detector.rule(input([session('s', [
      bash('python3 run.py', true),
      bash('uv run python run.py', false),
    ])]), 0)).toBeNull();
  });

  it('stays silent when there are no corrections', () => {
    // different stems → no pairing; generic stem → no pairing
    expect(detector.rule(input([session('s', [read('Widget.ts', true), read('Gadget.ts', false)])]), 0)).toBeNull();
    expect(detector.rule(input([session('s', [read('pkgA/index.ts', true), read('pkgB/index.ts', false)])]), 0)).toBeNull();
    expect(detector.rule(input([]), 0)).toBeNull();
  });

  it('suppresses when CLAUDE.md already records the corrections', () => {
    const lc = {
      settings: {}, mcpServers: [],
      claudeMd: { global: '## Known paths & gotchas\n\nThese are not the first place the agent looked.' },
    } as unknown as LiveConfig;
    expect(detector.rule(input(pathFix(), lc), 0)).toBeNull();
  });
});

// ── Provenance (#3232) ──────────────────────────────────────────────────────

describe('workflow.correction-mining provenance (#3232)', () => {
  const at = (ts: string, c: ToolCall): ToolCall => ({ ...c, timestamp: ts });

  /**
   * One correction seen ONCE and another seen TWICE, with the twice-repeated
   * one declared LAST, so the "most repeated" citation cannot pass by reading
   * insertion order. Timestamps are real so the asOf anchor is derivable.
   */
  const repeated = (): ToolUsageData[] => [
    session('s1', [
      at('2026-06-01T09:00:00.000Z', read('pkg/Once.ts', true)),
      at('2026-06-01T09:00:01.000Z', read('other/Once.ts', false)),
      at('2026-06-02T09:00:00.000Z', read('pkg/Twice.ts', true)),
      at('2026-06-02T09:00:01.000Z', read('other/Twice.ts', false)),
    ]),
    session('s2', [
      at('2026-06-09T09:00:00.000Z', read('pkg/Twice.ts', true)),
      at('2026-06-09T12:00:00.000Z', read('other/Twice.ts', false)),
    ]),
  ];

  it('passes the contract when it fires', () => {
    const rec = detector.rule(input(repeated()), 0)!;
    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.provenance!.observations.length).toBeGreaterThan(0);
  });

  it('reproduces the displayed distinct-correction count from the cited field', () => {
    const rec = detector.rule(input(repeated()), 0)!;
    const distinct = rec.provenance!.observations.find((o) =>
      o.claim.includes('distinct failed')
    );
    expect(distinct!.value).toBe(rec.affected);
    expect(distinct!.value).toBe(2); // Once + Twice, deduplicated
    expect(distinct!.claim).toContain('3 matched sequence(s)');
  });

  it('cites the genuinely most-repeated correction', () => {
    const rec = detector.rule(input(repeated()), 0)!;
    const most = rec.provenance!.observations.find((o) =>
      o.claim.includes('most repeated')
    );
    expect(most!.value).toBe(2);
    expect(most!.claim).toContain('Twice.ts');
    expect(most!.claim).not.toContain('Once.ts');
  });

  it('anchors asOf to the newest observed fix call, not to now', () => {
    // The newest successful fix is 2026-06-09; `now` is nearly a year later.
    const rec = detector.rule(input(repeated()), Date.parse('2027-05-01T00:00:00.000Z'))!;
    expect(rec.provenance!.asOf).toBe('2026-06-09');
  });

  // ── Freshness demotion (Codex review, PR #3472) ──────────────────────────
  //
  // A mined path is only known to have worked on the day it was seen to work.
  // Past the standard window the card must stop asserting where the file IS,
  // and must stop offering a one-click write of that path into CLAUDE.md —
  // pinning a path that has since moved is worse than pinning none.

  const FRESH_NOW = Date.parse('2026-06-20T00:00:00.000Z'); // 11 days later
  const STALE_NOW = Date.parse('2027-05-01T00:00:00.000Z'); // ~11 months later

  it('keeps present-tense wording and a one-click fix while the evidence is fresh', () => {
    const rec = detector.rule(input(repeated()), FRESH_NOW)!;
    expect(rec.provenance!.stale).toBe(false);
    expect(rec.detail).toContain('Through 2026-06-09');
    expect(rec.detail).not.toMatch(/As of/);
    expect(rec.fix!.fixKind).toBe('validated');
    expect(rec.fix!.snippet).toContain('is the real path');
  });

  it('demotes wording, snippet and fix affordance once the evidence is stale', () => {
    const rec = detector.rule(input(repeated()), STALE_NOW)!;
    expect(rec.provenance!.stale).toBe(true);
    expect(rec.provenance!.asOf).toBe('2026-06-09');
    // Dated lead instead of a present-tense claim.
    expect(rec.detail).toContain('As of 2026-06-09');
    expect(rec.detail).toMatch(/may have moved/);
    // No longer offered as a one-click CLAUDE.md write.
    expect(rec.fix!.fixKind).toBe('illustrative');
    expect(rec.fix!.note).toMatch(/[Rr]e-verify/);
    // …and the text that would land IN the user's CLAUDE.md is past-tense.
    expect(rec.fix!.snippet).not.toContain('is the real path');
    expect(rec.fix!.snippet).toContain('was the working path as of 2026-06-09');
  });

  it('treats an UNDATABLE correction as unsafe, not as fresh', () => {
    // `isAsOfStale(undefined, ...)` is false by design, and reading that as
    // "fresh" is absence of evidence standing in for evidence of absence.
    // `parse-tools` normalizes a missing transcript timestamp to '', so an
    // arbitrarily old correction reaches here undated (Codex review, #3472).
    const rec = detector.rule(input(pathFix()), FRESH_NOW)!;
    expect(rec.provenance!.asOf).toBeUndefined();
    // Not asserted as current: no one-click write, no present-tense claim.
    expect(rec.fix!.fixKind).toBe('illustrative');
    expect(rec.fix!.snippet).not.toContain('is the real path');
    expect(rec.fix!.snippet).toContain('date unknown');
    expect(rec.detail).toMatch(/undated/);
    expect(rec.detail).toMatch(/Re-check each path/);
    // …and it must not claim a staleness it cannot demonstrate either.
    expect(rec.provenance!.stale).toBeUndefined();
    expect(validateRecommendationProvenance(rec)).toEqual([]);
  });

  it('judges freshness PER correction, not once for the corpus', () => {
    // One correction re-confirmed recently, one last seen long ago. A single
    // corpus-wide flag would let the fresh one certify the stale one as "the
    // real path" (Codex review, PR #3472).
    const mixed: ToolUsageData[] = [
      session('s-old', [
        at('2026-01-05T09:00:00.000Z', read('pkg/Ancient.ts', true)),
        at('2026-01-05T09:00:01.000Z', read('other/Ancient.ts', false)),
      ]),
      session('s-new', [
        at('2026-06-08T09:00:00.000Z', read('pkg/Recent.ts', true)),
        at('2026-06-09T09:00:00.000Z', read('other/Recent.ts', false)),
      ]),
    ];
    const rec = detector.rule(input(mixed), FRESH_NOW)!;
    const snippet = rec.fix!.snippet;
    // The recent one keeps the present tense…
    expect(snippet).toMatch(/`other\/Recent\.ts` is the real path/);
    // …and the ancient one is demoted with ITS OWN date, not the corpus's.
    expect(snippet).toMatch(/`other\/Ancient\.ts` was the working path as of 2026-01-05/);
    // One demoted row makes the whole pasteable block a template, not one-click.
    expect(rec.fix!.fixKind).toBe('illustrative');
    expect(validateRecommendationProvenance(rec)).toEqual([]);
  });

  it('describes MIXED dated evidence as stale, never as undated', () => {
    // One fresh + one old-but-dated correction leaves the corpus-wide `stale`
    // flag false (asOf picks the fresh one) while not every row is current.
    // Saying "no readable timestamp" there is false — the demoted row has a
    // perfectly usable date (Codex review, PR #3472).
    const mixed: ToolUsageData[] = [
      session('s-old', [
        at('2026-01-05T09:00:00.000Z', read('pkg/Ancient.ts', true)),
        at('2026-01-05T09:00:01.000Z', read('other/Ancient.ts', false)),
      ]),
      session('s-new', [
        at('2026-06-08T09:00:00.000Z', read('pkg/Recent.ts', true)),
        at('2026-06-09T09:00:00.000Z', read('other/Recent.ts', false)),
      ]),
    ];
    const rec = detector.rule(input(mixed), FRESH_NOW)!;
    expect(rec.provenance!.stale).toBe(false); // corpus-wide flag is NOT stale
    expect(rec.detail).not.toMatch(/no readable\s+timestamp/);
    expect(rec.detail).toMatch(/at least one was last seen to work/);
    expect(rec.fix!.note).not.toMatch(/no readable timestamp/);
    expect(rec.fix!.note).toMatch(/at least one was last seen to work/);
  });

  it('describes FRESH-plus-UNDATED as unknown age, not as stale', () => {
    // A two-way dated/undated split gets this wrong: nothing here is old, so
    // claiming "seen over 4 weeks ago" would be false, yet not everything is
    // undated either (Codex review, PR #3472).
    const freshPlusUndated: ToolUsageData[] = [
      session('s-undated', [
        read('pkg/NoDate.ts', true),
        read('other/NoDate.ts', false),
      ]),
      session('s-new', [
        at('2026-06-08T09:00:00.000Z', read('pkg/Recent.ts', true)),
        at('2026-06-09T09:00:00.000Z', read('other/Recent.ts', false)),
      ]),
    ];
    const rec = detector.rule(input(freshPlusUndated), FRESH_NOW)!;
    expect(rec.fix!.fixKind).toBe('illustrative');
    expect(rec.detail).toMatch(/no readable timestamp/);
    expect(rec.detail).not.toMatch(/weeks ago/);
    expect(rec.fix!.note).not.toMatch(/weeks ago/);
    // The fresh row keeps its present tense; the undated row does not.
    expect(rec.fix!.snippet).toMatch(/`other\/Recent\.ts` is the real path/);
    expect(rec.fix!.snippet).toMatch(/`other\/NoDate\.ts` was the working path when last observed, date unknown/);
  });

  it('names BOTH reasons when stale and undated evidence are mixed', () => {
    const allThree: ToolUsageData[] = [
      session('s-undated', [read('pkg/NoDate.ts', true), read('other/NoDate.ts', false)]),
      session('s-old', [
        at('2026-01-05T09:00:00.000Z', read('pkg/Ancient.ts', true)),
        at('2026-01-05T09:00:01.000Z', read('other/Ancient.ts', false)),
      ]),
    ];
    const rec = detector.rule(input(allThree), FRESH_NOW)!;
    expect(rec.detail).toMatch(/weeks ago/);
    expect(rec.detail).toMatch(/no readable timestamp at all/);
  });

  it('dates an aggregate from its NEWEST occurrence, not its first', () => {
    // The same correction seen in January and again in June is a live fact;
    // keeping the first timestamp would demote it on the strength of the
    // oldest sighting.
    const twice: ToolUsageData[] = [
      session('s1', [
        at('2026-01-05T09:00:00.000Z', read('pkg/Repeat.ts', true)),
        at('2026-01-05T09:00:01.000Z', read('other/Repeat.ts', false)),
      ]),
      session('s2', [
        at('2026-06-08T09:00:00.000Z', read('pkg/Repeat.ts', true)),
        at('2026-06-09T09:00:00.000Z', read('other/Repeat.ts', false)),
      ]),
    ];
    const rec = detector.rule(input(twice), FRESH_NOW)!;
    expect(rec.fix!.snippet).toMatch(/`other\/Repeat\.ts` is the real path/);
    expect(rec.fix!.fixKind).toBe('validated');
  });

  it('declares fixKind explicitly rather than inheriting the validated default', () => {
    // An absent fixKind silently defaults to 'validated', which is exactly how
    // a stale path would have kept its one-click affordance.
    const rec = detector.rule(input(repeated()), FRESH_NOW)!;
    expect(Object.prototype.hasOwnProperty.call(rec.fix!, 'fixKind')).toBe(true);
  });

  it('omits asOf rather than inventing one when no timestamp is readable', () => {
    // The other fixtures in this file use `timestamp: 't'`, which is not a
    // date. An undatable corpus must produce no asOf at all — a fabricated
    // date would assert a freshness the evidence does not have.
    const rec = detector.rule(input(pathFix()), Date.parse('2026-06-20T00:00:00.000Z'))!;
    expect(rec.provenance!.asOf).toBeUndefined();
    expect(validateRecommendationProvenance(rec)).toEqual([]);
  });
});
