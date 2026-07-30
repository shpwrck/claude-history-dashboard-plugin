import { describe, it, expect } from 'vitest';
import { detector } from './output-verbosity';
import type { RecommendationInput } from '../types';
import type { SessionTokenData, AssistantFeatures, LiveConfig } from '../../../types';
import { runReclaimCascade } from '../../reclaim';
import { getModelPricing } from '../../pricing';

const af = (sessionId: string, textLength: number): AssistantFeatures =>
  ({
    sessionId,
    assistantTurnCount: 30,
    textLength,
    codeBlockCount: 0,
    toolCallCount: 5,
    refusalCount: 0,
    hedgingCount: 0,
    endsWithQuestionCount: 0,
    thinkingByteLen: 0,
  }) as AssistantFeatures;

const session = (sessionId: string, outputTokens: number, turns = 20): SessionTokenData =>
  ({
    sessionId,
    entries: Array.from({ length: turns }, () => ({
      timestamp: 't',
      model: 'claude-opus-4-7',
      inputTokens: 0,
      outputTokens: Math.round(outputTokens / turns),
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 50_000,
      webSearchRequests: 0,
      webFetchRequests: 0,
    })),
  }) as unknown as SessionTokenData;

// Verbose, prose-dominant session: ~100k prose tokens (400k chars) of 120k output.
const proseDominant = (): Partial<RecommendationInput> => ({
  assistantFeatures: [af('s1', 400_000)],
  tokenData: [session('s1', 120_000)],
});

const input = (overrides?: Partial<RecommendationInput>): RecommendationInput =>
  ({
    tokenData: [],
    toolData: [],
    assistantFeatures: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    ...overrides,
  }) as RecommendationInput;

describe('cost.output-verbosity (#1923)', () => {
  it('fires on prose-dominant output with a conservative output-pool reclaim', () => {
    const rec = detector.rule(input(proseDominant()), 0);
    expect(rec?.id).toBe('cost.output-verbosity');
    expect(rec?.category).toBe('cost');
    expect(rec?.estSavingsUsd).toBeGreaterThan(0);
    expect(rec?.reclaim?.ownedPools).toEqual(['output']);
    expect(rec?.reclaim?.counterfactual.kind).toBe('scaleTokens');
    expect(rec?.savingsAttribution?.tier).toBe('tier-0-estimate');
    expect(rec?.savingsAttribution?.confidence).toBe('low'); // unproven lever
    expect(rec?.detail).toMatch(/[Pp]rose only/);
  });

  it('books a positive output marginal through the cascade and preserves the identity', () => {
    const rec = detector.rule(input(proseDominant()), 0);
    const result = runReclaimCascade([rec!.reclaim!], input(proseDominant()).tokenData);
    expect(result.total).toBeGreaterThan(0);
    expect(result.byCategory.cost).toBeCloseTo(result.total, 9);
    expect(result.billOriginal - result.billFinal).toBeCloseTo(result.total, 9);
  });

  it('does not credit tool/JSON-heavy output (prose-only, honest-null)', () => {
    // Lots of output but tiny prose (textLength small) → prose share below floor.
    const rec = detector.rule(
      input({ assistantFeatures: [af('s1', 4_000)], tokenData: [session('s1', 200_000)] }),
      0
    );
    expect(rec).toBeNull();
  });

  it('self-suppresses once CLAUDE.md documents output brevity', () => {
    const liveConfig = {
      claudeMd: {
        global:
          '## Output brevity\n\n- Keep assistant output terse, especially in headless runs.',
        perProject: {},
      },
    } as unknown as LiveConfig;
    const rec = detector.rule(input({ ...proseDominant(), liveConfig }), 0);
    expect(rec).toBeNull();
  });

  it('stays silent with no assistant features', () => {
    expect(detector.rule(input({ assistantFeatures: [], tokenData: [session('s1', 120_000)] }), 0)).toBeNull();
  });

  it('ships the validated CLAUDE.md brevity fix with self-suppression markers', () => {
    const rec = detector.rule(input(proseDominant()), 0);
    expect(rec?.fix?.target).toBe('CLAUDE.md');
    expect(rec?.fix?.snippet).toContain('keep assistant output terse'.replace(/^k/, 'K'));
    expect(rec?.fix?.appliedMarkers).toBeDefined();
  });

  // ── #3200: the displayed prose basis must BE the computed prose basis ──────
  //
  // `proseTokens` is capped at the session's billed output before it is used
  // for savings, but the displayed figure was accumulated from the RAW
  // `textLength`. When parsed text length exceeds billed output x 4 the card
  // reported more prose tokens than exist in the whole output bill.
  describe('reported prose tokens never exceed the billed output they came from (#3200)', () => {
    // One USABLE session (400,000 chars = 100,000 prose tokens against a
    // 120,000-token bill) plus one whose proxy saturates (1,000,000 chars =
    // 250,000 raw tokens against the same 120,000 bill). Every published figure
    // must describe the usable session; the saturated one is counted, not
    // folded in.
    const overCapped = (): Partial<RecommendationInput> => ({
      assistantFeatures: [af('s1', 400_000), af('s2', 1_000_000)],
      tokenData: [session('s1', 120_000), session('s2', 120_000)],
    });
    const BILLED_OUTPUT = 120_000;
    const USABLE_PROSE = 100_000;
    const COMPRESSION_FRAC = 0.4;

    /** The first `~<n>` figure in a rendered evidence line, as a number. */
    const figure = (line: string | undefined): number => {
      const m = /~([\d,]+)/.exec(line ?? '');
      return m ? Number(m[1].replace(/,/g, '')) : Number.NaN;
    };

    it('caps the evidence prose-token figure at the billed output tokens', () => {
      const rec = detector.rule(input(overCapped()), 0);
      expect(rec).not.toBeNull();
      const reported = figure(rec!.evidence?.[0]);
      expect(reported).toBeGreaterThan(0);
      expect(reported).toBeLessThanOrEqual(BILLED_OUTPUT);
    });

    it('reports a prose basis the compressible figure is actually derived from', () => {
      const rec = detector.rule(input(overCapped()), 0);
      const reportedProse = figure(rec!.evidence?.[0]);
      const reportedCompressible = figure(rec!.evidence?.[1]);
      expect(reportedCompressible).toBeCloseTo(reportedProse * COMPRESSION_FRAC, -1);
    });

    it('cites the prose-token figure as its OWN value, not the session count', () => {
      const rec = detector.rule(input(overCapped()), 0);
      const proseObs = rec!.provenance?.observations.find((o) =>
        /prose output tokens/.test(o.claim)
      );
      expect(proseObs, 'no observation carries the prose-token claim').toBeDefined();
      expect(typeof proseObs!.value).toBe('number');
      // The scalar must reproduce the figure the claim states. Citing the
      // session count against a token claim passes the schema validator while
      // still being unreproducible — the second face of defect class 5.
      expect(proseObs!.value as number).toBe(figure(proseObs!.claim));
      expect(proseObs!.value as number).toBeLessThanOrEqual(BILLED_OUTPUT);
    });

    // ── Codex finding 3: cap activation was invisible ────────────────────────
    it('distinguishes a capped session from one that legitimately fills its bill', () => {
      // Both saturate to the same 120,000-token basis, so before disclosure the
      // two cards were identical and booked the same dollars. A reader could
      // not tell a measurement from a clamped upper bound.
      const capped = detector.rule(input(overCapped()), 0)!;
      const exact = detector.rule(
        input({
          // 480,000 chars / 4 = exactly the 120,000-token bill: not capped.
          assistantFeatures: [af('s1', 480_000)],
          tokenData: [session('s1', 120_000)],
        }),
        0
      )!;
      expect(capped.detail).not.toBe(exact.detail);
    });

    it('says out loud that a saturated session was excluded, and how many', () => {
      // The card no longer caps-and-books such a session, it drops it — so the
      // promise a consumer is owed is the EXCLUSION and its count, not a
      // description of the cap.
      const rec = detector.rule(input(overCapped()), 0)!;
      expect(rec.detail).toMatch(/exclude/i);
      const excludedObs = rec.provenance?.observations.find((o) => /exclud/i.test(o.claim));
      expect(excludedObs, 'the exclusion count is not in provenance').toBeDefined();
      expect(excludedObs!.value).toBe(1);
    });

    it('publishes the raw proxy alongside the bounded basis', () => {
      const rec = detector.rule(input(overCapped()), 0)!;
      const raw = rec.provenance?.observations.find((o) => /raw/i.test(o.claim));
      expect(raw, 'raw proxy is not reproducible from provenance').toBeDefined();
      expect(raw!.value).toBe(USABLE_PROSE); // 400,000 chars / 4, usable only
      // Match on the FIELD, not the prose — several claims mention "billed
      // output" and only one is the summed bill itself.
      const billed = rec.provenance?.observations.find(
        (o) => o.field === 'sum(tokenData[].entries[].outputTokens)'
      );
      expect(billed, 'billed output is not reproducible from provenance').toBeDefined();
      expect(billed!.value).toBe(BILLED_OUTPUT);
    });

    // ── Codex finding 5: the pricing observation stored the wrong quantity ───
    it('cites a price against the pricing field, not a token count', () => {
      const rec = detector.rule(input(overCapped()), 0)!;
      const priced = rec.provenance!.observations.find((o) =>
        /getModelPricing/.test(o.field ?? '')
      );
      expect(priced, 'no observation cites the pricing field').toBeDefined();
      // A value under a pricing field must be money, not a token count.
      expect(priced!.value).toBe(Math.round(rec.estSavingsUsd! * 100) / 100);
      expect(priced!.value).not.toBe(48_000);
    });

    it('names every artifact each observation actually reads', () => {
      const rec = detector.rule(input(overCapped()), 0)!;
      const bounded = rec.provenance!.observations.find((o) =>
        /prose output tokens/.test(o.claim)
      )!;
      // The capped basis is min(textLength/4, billed output) — it reads BOTH
      // assistant features and token data, so citing only the former names a
      // source that cannot reproduce the number.
      expect(bounded.source).toMatch(/parse-assistant-features/);
      expect(bounded.source).toMatch(/parse-sessions/);
    });
  });

  // ── Round-9 review: disclosure is not exclusion ───────────────────────────
  //
  // Every assertion below is written against what the card PROMISES a consumer,
  // not against what the code currently does. An assertion derived from reading
  // the implementation can only ever confirm the implementation.
  describe('capped and mixed-model evidence (Codex #2, #3)', () => {
    /** Output split across models, with the largest single ENTRY on Opus. */
    const mixed = (sessionId: string): SessionTokenData => {
      const cell = (model: string, outputTokens: number) => ({
        timestamp: 't',
        model,
        inputTokens: 0,
        outputTokens,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
        webSearchRequests: 0,
        webFetchRequests: 0,
      });
      return {
        sessionId,
        entries: [
          // 100,000 tokens of Haiku across ten 10k entries...
          ...Array.from({ length: 10 }, () => cell('claude-haiku-4-5-20251001', 10_000)),
          // ...and 20,000 of Opus in ONE entry: the largest single entry, but a
          // minority of the session's actual output.
          cell('claude-opus-4-8', 20_000),
        ],
      } as unknown as SessionTokenData;
    };
    const mixedInput = () => ({
      assistantFeatures: [af('m1', 400_000)],
      tokenData: [mixed('m1')],
    });

    it('books the same dollars it tells the reclaim cascade to book', () => {
      // The card publishes estSavingsUsd AND a reclaim claim. One
      // recommendation must not hand a consumer two different numbers.
      const rec = detector.rule(input(mixedInput()), 0)!;
      expect(rec).not.toBeNull();
      const cascade = runReclaimCascade([rec.reclaim!], [mixed('m1')]);
      expect(rec.estSavingsUsd!).toBeCloseTo(cascade.total, 6);
    });

    it('does not price a mixed session at its largest single entry rate', () => {
      const rec = detector.rule(input(mixedInput()), 0)!;
      // Everything compressible priced at the Opus rate would be this. Haiku
      // carries 100k of the 120k, so the true figure must be well under it.
      const allAtOpus =
        ((100_000 + 20_000) * 0.4) / 1_000_000 * getModelPricing('claude-opus-4-8').output;
      expect(rec.estSavingsUsd!).toBeLessThan(allAtOpus);
    });

    it('excludes a capped session from the booked dollars entirely', () => {
      const clean = { assistantFeatures: [af('s1', 400_000)], tokenData: [session('s1', 120_000)] };
      const withCapped = {
        assistantFeatures: [af('s1', 400_000), af('s2', 1_000_000)],
        tokenData: [session('s1', 120_000), session('s2', 120_000)],
      };
      const a = detector.rule(input(clean), 0)!;
      const b = detector.rule(input(withCapped), 0)!;
      expect(b.estSavingsUsd).toBeCloseTo(a.estSavingsUsd!, 9);
      expect(b.affected).toBe(1);
    });

    it('tells a consumer when every candidate was rejected, instead of going silent', () => {
      // The promise: "we rejected everything" stays distinguishable from
      // "there was nothing here". A null return collapses the two.
      const allCapped = {
        assistantFeatures: [af('s1', 1_000_000), af('s2', 1_000_000)],
        tokenData: [session('s1', 120_000), session('s2', 120_000)],
      };
      const rec = detector.rule(input(allCapped), 0);
      expect(rec, 'all-capped input returned null — indistinguishable from no data').not.toBeNull();
      expect(rec!.id).toBe('cost.output-verbosity');
      // A data-quality signal, never an opportunity.
      expect(rec!.estSavingsUsd).toBeUndefined();
      expect(rec!.reclaim).toBeUndefined();
      expect(rec!.detail).toMatch(/could not|cannot|unusable|saturat/i);
      const obs = rec!.provenance?.observations.find((o) => /capped|rejected/i.test(o.claim));
      expect(obs, 'the rejection count is not in provenance').toBeDefined();
      expect(obs!.value).toBe(2);
    });

    it('stays silent when there was genuinely nothing, not merely nothing usable', () => {
      // Guard against manufacturing a card where none would ever have appeared.
      expect(detector.rule(input({ assistantFeatures: [], tokenData: [] }), 0)).toBeNull();
      expect(
        detector.rule(
          input({ assistantFeatures: [af('s1', 4_000)], tokenData: [session('s1', 200_000)] }),
          0
        )
      ).toBeNull();
    });
  });
});
