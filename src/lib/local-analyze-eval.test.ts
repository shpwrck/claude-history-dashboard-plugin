import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ANALYZE_EVAL_TASK_CLASS,
  buildAnalyzeEvalRecord,
  parseAnalyzeEvalCorpus,
  runAnalyzeEval,
  runAnalyzeEvalSample,
  scriptedAnalyzeEndpoint,
  scriptedAnalyzeTransport,
  liveAnalyzeTransport,
  type AnalyzeEvalSample,
} from './local-analyze-eval';
import type { LocalAnalyzeRecommendation } from './local-analyze';
import { validateClaimProvenance } from './claim-provenance';

const rec = (id: string): LocalAnalyzeRecommendation => ({
  id,
  category: 'context',
  severity: 'high',
  title: `Finding ${id}`,
  detail: `Detail for ${id}`,
  action: `Act on ${id}`,
});

const validFor = (ids: string[], summary = 'A grounded, non-empty analysis of the findings.') =>
  JSON.stringify({ summary, rankedFindingIds: ids });

const EMPTY_SUMMARY = (ids: string[]) => JSON.stringify({ summary: '', rankedFindingIds: ids });
const HALLUCINATED = JSON.stringify({ summary: 'ok', rankedFindingIds: ['not-a-real-id'] });
const PROSE = 'Here is a free-form analysis with no JSON object at all.';

const sample = (over: Partial<AnalyzeEvalSample> & { id: string }): AnalyzeEvalSample => ({
  recommendations: [rec('a'), rec('b')],
  freeFormResponse: PROSE,
  constrainedResponses: [validFor(['a', 'b'])],
  ...over,
});

const ASOF = '2026-07-21T00:00:00.000Z';

describe('runAnalyzeEvalSample outcomes', () => {
  it('improved: free-form fails, constrained repairs to a pass', async () => {
    const s = sample({
      id: 'improved',
      freeFormResponse: PROSE,
      constrainedResponses: [EMPTY_SUMMARY(['a', 'b']), validFor(['a', 'b'])],
    });
    const out = await runAnalyzeEvalSample(s, scriptedAnalyzeEndpoint, 2);
    expect(out.passFreeForm).toBe(false);
    expect(out.passConstrained).toBe(true);
    expect(out.repairRounds).toBe(1);
  });

  it('no-change (both pass): first constrained completion validates, zero repair rounds', async () => {
    const s = sample({
      id: 'both-pass',
      freeFormResponse: validFor(['a']),
      constrainedResponses: [validFor(['a', 'b'])],
    });
    const out = await runAnalyzeEvalSample(s, scriptedAnalyzeEndpoint, 2);
    expect(out.passFreeForm).toBe(true);
    expect(out.passConstrained).toBe(true);
    expect(out.repairRounds).toBe(0);
  });

  it('no-change (both fail): constrained exhausts its repair budget', async () => {
    const s = sample({
      id: 'both-fail',
      freeFormResponse: PROSE,
      constrainedResponses: [HALLUCINATED, HALLUCINATED, HALLUCINATED],
    });
    const out = await runAnalyzeEvalSample(s, scriptedAnalyzeEndpoint, 2);
    expect(out.passFreeForm).toBe(false);
    expect(out.passConstrained).toBe(false);
    expect(out.repairRounds).toBe(2);
  });

  it('worse: free-form parses but the constrained arm keeps failing', async () => {
    const s = sample({
      id: 'worse',
      freeFormResponse: validFor(['a', 'b']),
      constrainedResponses: [HALLUCINATED, HALLUCINATED, HALLUCINATED],
    });
    const out = await runAnalyzeEvalSample(s, scriptedAnalyzeEndpoint, 2);
    expect(out.passFreeForm).toBe(true);
    expect(out.passConstrained).toBe(false);
    expect(out.repairRounds).toBe(2);
  });
});

describe('runAnalyzeEval / buildAnalyzeEvalRecord', () => {
  it('aggregates counts, histogram, taskClass, and stamps asOf', async () => {
    const samples: AnalyzeEvalSample[] = [
      // improved -> constrained pass, rounds 1
      sample({
        id: 'improved',
        freeFormResponse: PROSE,
        constrainedResponses: [EMPTY_SUMMARY(['a', 'b']), validFor(['a', 'b'])],
      }),
      // both pass -> rounds 0
      sample({
        id: 'both-pass',
        freeFormResponse: validFor(['a']),
        constrainedResponses: [validFor(['a', 'b'])],
      }),
      // both fail -> rounds 2
      sample({
        id: 'both-fail',
        freeFormResponse: PROSE,
        constrainedResponses: [HALLUCINATED, HALLUCINATED, HALLUCINATED],
      }),
      // worse -> free pass, constrained fail, rounds 2
      sample({
        id: 'worse',
        freeFormResponse: validFor(['a', 'b']),
        constrainedResponses: [HALLUCINATED, HALLUCINATED, HALLUCINATED],
      }),
    ];
    const record = await runAnalyzeEval({ samples, asOf: ASOF });
    expect(record.taskClass).toBe(ANALYZE_EVAL_TASK_CLASS);
    expect(record.taskClass).toBe('analyze-ranking');
    expect(record.nSamples).toBe(4);
    // free-form: both-pass + worse
    expect(record.passFreeForm).toBe(2);
    // constrained: improved + both-pass
    expect(record.passConstrained).toBe(2);
    expect(record.maxRepairRounds).toBe(2);
    expect(record.repairRoundsHistogram).toEqual({ '0': 1, '1': 1, '2': 2 });
    expect(record.asOf).toBe(ASOF);
    expect(record.schemaVersion).toBe(1);
    expect(record.kind).toBe('local-analyze-repair-eval');
    // Default provenance is the synthetic fixture, never a live receipt.
    expect(record.endpointKind).toBe('scripted');
  });

  /**
   * CHANGED in #3131. This test used to pass `endpoint: scriptedAnalyzeEndpoint`
   * together with `endpointKind: 'live'` and assert the record came out `live` —
   * i.e. it VALIDATED publishing synthetic fixture results as real local-model
   * calibration evidence, which is the defect rather than the contract. That
   * pairing is now unrepresentable: provenance rides on the transport.
   */
  it('reads provenance off the transport that actually ran', async () => {
    const samples = [
      sample({
        id: 'both-pass',
        freeFormResponse: validFor(['a']),
        constrainedResponses: [validFor(['a', 'b'])],
      }),
    ];
    const scripted = await runAnalyzeEval({ samples, asOf: ASOF });
    expect(scripted.endpointKind).toBe('scripted');

    // Only a constructed live transport can emit 'live', and it must wrap a
    // transport that is not the fixture.
    const realish: typeof scriptedAnalyzeEndpoint = async () => ({
      text: validFor(['a']),
      model: 'local-test-model',
    });
    const live = await runAnalyzeEval({
      samples,
      asOf: ASOF,
      transport: liveAnalyzeTransport(realish),
    });
    expect(live.endpointKind).toBe('live');
  });

  it('refuses to label the scripted fixture as a live transport (#3131)', () => {
    // The exact call the old test asserted worked.
    expect(() => liveAnalyzeTransport(scriptedAnalyzeEndpoint)).toThrow(
      /refusing to label the scripted fixture/i
    );
  });

  it('the scripted transport cannot be relabelled', () => {
    expect(scriptedAnalyzeTransport.kind).toBe('scripted');
    // Frozen, so a caller cannot mutate provenance after the fact.
    expect(Object.isFrozen(scriptedAnalyzeTransport)).toBe(true);
    expect(() => {
      (scriptedAnalyzeTransport as { kind: string }).kind = 'live';
    }).toThrow();
    expect(scriptedAnalyzeTransport.kind).toBe('scripted');
  });

  it('stamps asOf/endpointKind verbatim onto an empty corpus without inventing samples', () => {
    const record = buildAnalyzeEvalRecord([], { asOf: ASOF, maxRounds: 2, endpointKind: 'scripted' });
    expect(record.asOf).toBe(ASOF);
    expect(record.endpointKind).toBe('scripted');
    expect(record.nSamples).toBe(0);
    expect(record.passFreeForm).toBe(0);
    expect(record.passConstrained).toBe(0);
    expect(record.repairRoundsHistogram).toEqual({});
  });

  it('honors a custom maxRounds bound for the constrained arm', async () => {
    // With no repair budget, the improved sample never gets its second (valid)
    // completion, so it fails and spends 0 rounds.
    const s = sample({
      id: 'improved',
      freeFormResponse: PROSE,
      constrainedResponses: [EMPTY_SUMMARY(['a', 'b']), validFor(['a', 'b'])],
    });
    const record = await runAnalyzeEval({ samples: [s], asOf: ASOF, maxRounds: 0 });
    expect(record.passConstrained).toBe(0);
    expect(record.maxRepairRounds).toBe(0);
    expect(record.repairRoundsHistogram).toEqual({ '0': 1 });
  });
});

describe('parseAnalyzeEvalCorpus (fail-closed)', () => {
  const good = {
    samples: [
      {
        id: 'ok',
        recommendations: [{ id: 'a', title: 'A' }],
        freeFormResponse: PROSE,
        constrainedResponses: [validFor(['a'])],
      },
    ],
  };

  it('accepts a well-formed { samples: [...] } envelope and a bare array', () => {
    expect(parseAnalyzeEvalCorpus(good)).not.toBeNull();
    expect(parseAnalyzeEvalCorpus(good.samples)).not.toBeNull();
  });

  it('rejects malformed samples (bad id, no recs, missing/empty responses)', () => {
    expect(parseAnalyzeEvalCorpus(null)).toBeNull();
    expect(parseAnalyzeEvalCorpus({ samples: [] })).toBeNull();
    expect(
      parseAnalyzeEvalCorpus({ samples: [{ ...good.samples[0], id: 'Bad Id' }] })
    ).toBeNull();
    expect(
      parseAnalyzeEvalCorpus({ samples: [{ ...good.samples[0], recommendations: [] }] })
    ).toBeNull();
    expect(
      parseAnalyzeEvalCorpus({ samples: [{ ...good.samples[0], constrainedResponses: [] }] })
    ).toBeNull();
    expect(
      parseAnalyzeEvalCorpus({ samples: [{ ...good.samples[0], freeFormResponse: 123 }] })
    ).toBeNull();
    // duplicate ids
    expect(
      parseAnalyzeEvalCorpus({ samples: [good.samples[0], good.samples[0]] })
    ).toBeNull();
  });

  it('is genuinely fail-closed: a malformed rec row is a hard reject, not a silent drop', () => {
    // One valid row + one malformed row (missing `title`): extractRecommendations
    // would silently skip the bad row and shift validIds, so the whole corpus
    // must be rejected.
    const withBadRow = {
      ...good.samples[0],
      recommendations: [{ id: 'a', title: 'A' }, { id: 'b' }],
    };
    expect(parseAnalyzeEvalCorpus({ samples: [withBadRow] })).toBeNull();
  });

  it('is genuinely fail-closed: more than the prompt cap of rec rows is rejected, not truncated', () => {
    // 13 valid rows exceeds MAX_PROMPT_RECOMMENDATIONS (12); the default cap
    // would drop the 13th and shift the measurement, so reject the corpus.
    const thirteen = Array.from({ length: 13 }, (_, i) => ({
      id: `r${i}`,
      title: `Finding ${i}`,
    }));
    const withTooMany = { ...good.samples[0], recommendations: thirteen };
    expect(parseAnalyzeEvalCorpus({ samples: [withTooMany] })).toBeNull();
  });
});

describe('committed corpus', () => {
  const corpusPath = fileURLToPath(
    new URL('../../fixtures/local-analyze-eval/corpus.json', import.meta.url)
  );
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));

  it('grounds every current and future recommendation row in structured synthetic evidence', () => {
    const groundedCopy: Record<string, { title: string; detail: string }> = {
      'context.rot': {
        title: 'Compaction re-sends 32K tokens and evicts earlier context',
        detail:
          'The synthetic session re-sent 32,000 tokens at compaction and marked earlier context as evicted.',
      },
      'cost.cache-1h-waste': {
        title: '60-minute cache write covers a 4-minute idle gap',
        detail:
          'The synthetic write used a 60-minute cache TTL for a 4-minute idle gap; it is priced higher than the 5-minute default.',
      },
      'cost.thinking-budget': {
        title: 'Thinking tokens are 12x output tokens',
        detail:
          'The synthetic mechanical task recorded 48,000 thinking tokens and 4,000 output tokens.',
      },
      'workflow.tool-loop': {
        title: 'Four read/edit cycles occur before progress',
        detail:
          'The synthetic history recorded 4 read/edit cycles, with the first progress signal after cycle 4.',
      },
      'config.mcp-sprawl': {
        title: 'Four configured MCP servers receive zero calls',
        detail:
          'The synthetic fixture configured 4 MCP servers, called 0 of them, and included their schemas on all 12 observed turns.',
      },
      'workflow.retry-storm': {
        title: 'Six failing-command attempts use one approach',
        detail:
          'The synthetic fixture recorded 6 failing-command attempts and 1 distinct approach.',
      },
      'reliability.no-verify': {
        title: 'Two success claims have no recorded verification',
        detail:
          'The synthetic fixture recorded 2 success claims, 0 verification runs, and 0 post-change rereads.',
      },
    };
    const samples = corpus.samples as Array<{
      id: string;
      syntheticEvidence: { observedAt: string; [key: string]: unknown };
      recommendations: Array<{
        id?: string;
        title?: string;
        detail?: string;
        provenance?: {
          observations?: Array<{
            source?: string;
            record?: string;
            field?: string;
            value?: unknown;
          }>;
          inference?: string;
          asOf?: string;
        };
      }>;
    }>;
    const recommendations = samples.flatMap((sample) => sample.recommendations);

    expect(recommendations.length).toBeGreaterThan(0);
    expect(recommendations).toHaveLength(Object.keys(groundedCopy).length);
    for (const sample of samples) {
      for (const recommendation of sample.recommendations) {
        expect(recommendation).toMatchObject(
          groundedCopy[recommendation.id ?? '(missing id)']
        );
        expect(
          validateClaimProvenance(recommendation.provenance),
          `${recommendation.id ?? '(missing id)'} must carry valid provenance`
        ).toEqual([]);
        expect(recommendation.provenance?.inference).toEqual(expect.any(String));
        expect(recommendation.provenance?.asOf).toBe(
          sample.syntheticEvidence.observedAt.slice(0, 10)
        );

        for (const observation of recommendation.provenance?.observations ?? []) {
          expect(observation.source).toBe('fixtures/local-analyze-eval/corpus.json');
          expect(observation.record).toBe(`samples[id=${sample.id}]`);
          expect(observation.field).toMatch(/^syntheticEvidence(?:\.[A-Za-z][A-Za-z0-9]*)+$/);
          const resolved = observation.field!
            .split('.')
            .reduce<unknown>((value, key) => {
              if (!value || typeof value !== 'object' || !(key in value)) {
                return undefined;
              }
              return (value as Record<string, unknown>)[key];
            }, sample);
          expect(
            resolved,
            `${recommendation.id ?? '(missing id)'} cites missing ${observation.field}`
          ).toEqual(observation.value);
        }
      }
    }
  });

  it('parses fail-closed and runs offline into a receipt showing the constrained arm ahead', async () => {
    const samples = parseAnalyzeEvalCorpus(corpus);
    expect(samples).not.toBeNull();
    const record = await runAnalyzeEval({ samples: samples!, asOf: ASOF });
    expect(record.nSamples).toBe(samples!.length);
    // The committed corpus is the honest direction: constrained beats free-form.
    expect(record.passConstrained).toBeGreaterThan(record.passFreeForm);
  });
});

describe('constrained arm reuses schema-repair.ts (no duplicated repair loop)', () => {
  const evalSrc = readFileSync(
    fileURLToPath(new URL('./local-analyze-eval.ts', import.meta.url)),
    'utf8'
  );
  const analyzeSrc = readFileSync(
    fileURLToPath(new URL('./local-analyze.ts', import.meta.url)),
    'utf8'
  );

  it('this module imports directly from ./schema-repair', () => {
    expect(evalSrc).toMatch(/from '\.\/schema-repair'/);
  });

  it('the constrained arm delegates to runLocalAnalyze from ./local-analyze', () => {
    expect(evalSrc).toMatch(/import[\s\S]*runLocalAnalyze[\s\S]*from '\.\/local-analyze'/);
    expect(evalSrc).toMatch(/runLocalAnalyze\(/);
  });

  it('does NOT re-implement the repair loop or its repair prompt', () => {
    // No local definition of the loop primitives...
    expect(evalSrc).not.toMatch(/function\s+runRepairLoop/);
    expect(evalSrc).not.toMatch(/function\s+defaultRepairMessage/);
    // ...and no forked repair-prompt copy.
    expect(evalSrc).not.toMatch(/corrected JSON object/i);
  });

  it('the repair loop it delegates to is genuinely rooted in schema-repair.ts', () => {
    expect(analyzeSrc).toMatch(/from '\.\/schema-repair'/);
    expect(analyzeSrc).toMatch(/runRepairLoop/);
  });
});
