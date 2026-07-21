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
  type AnalyzeEvalSample,
} from './local-analyze-eval';
import type { LocalAnalyzeRecommendation } from './local-analyze';

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

  it('stamps endpointKind provenance: scripted by default, live when the caller wires a real transport', async () => {
    const samples = [
      sample({
        id: 'both-pass',
        freeFormResponse: validFor(['a']),
        constrainedResponses: [validFor(['a', 'b'])],
      }),
    ];
    const scripted = await runAnalyzeEval({ samples, asOf: ASOF });
    expect(scripted.endpointKind).toBe('scripted');
    // A caller wiring a real local-model transport MUST pass 'live'; the record
    // then carries that provenance so #2138 cannot over-read it as scripted.
    const live = await runAnalyzeEval({
      samples,
      asOf: ASOF,
      endpoint: scriptedAnalyzeEndpoint,
      endpointKind: 'live',
    });
    expect(live.endpointKind).toBe('live');
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
