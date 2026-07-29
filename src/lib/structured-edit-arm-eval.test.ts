import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { scoreStructuredEdit } from '../../scripts/lib/model-edit-benchmark';
import {
  buildStructuredEditArmComparison,
  type StructuredEditArmOutcome,
} from './structured-edit-eval';
import {
  generateStructuredEditArmSample,
  parseStructuredEditArmCorpus,
  scriptedStructuredEditEndpoint,
  scriptedStructuredEditTransport,
  liveStructuredEditTransport,
  type StructuredEditArmSample,
} from './structured-edit-arm-eval';
import type { TaskClass } from './task-class';

const SOURCE = 'export function canRetry(a: number, max: number): boolean {\n  return a < max;\n}\n';
const EXPECTED = SOURCE.replace('a < max', 'a <= max');

const VALID_DSL = JSON.stringify({ edits: [{ find: 'a < max', replace: 'a <= max' }] });
const HALLUCINATED_DSL = JSON.stringify({ edits: [{ find: 'a > max', replace: 'a >= max' }] });

const sample = (
  over: Partial<StructuredEditArmSample> & { id: string }
): StructuredEditArmSample => ({
  taskClass: 'authoring',
  instruction: 'Allow attempt equal to max.',
  source: SOURCE,
  expected: EXPECTED,
  freeFormResponse: SOURCE, // unchanged -> wrong by default
  constrainedResponses: [VALID_DSL],
  ...over,
});

describe('generateStructuredEditArmSample', () => {
  it('improved: free-form is wrong, constrained repairs to the corrected file', async () => {
    const s = sample({
      id: 'improved',
      freeFormResponse: SOURCE,
      constrainedResponses: [HALLUCINATED_DSL, VALID_DSL],
    });
    const gen = await generateStructuredEditArmSample(s, scriptedStructuredEditTransport, 2);
    expect(gen.freeFormContent).toBe(SOURCE);
    expect(gen.freeFormContent).not.toBe(EXPECTED);
    expect(gen.constrainedContent).toBe(EXPECTED);
    expect(gen.constrainedSchemaValid).toBe(true);
    expect(gen.repairRounds).toBe(1);
  });

  it('no-change (both correct): first constrained completion validates, zero repair rounds', async () => {
    const s = sample({
      id: 'both',
      freeFormResponse: EXPECTED,
      constrainedResponses: [VALID_DSL],
    });
    const gen = await generateStructuredEditArmSample(s, scriptedStructuredEditTransport, 2);
    expect(gen.freeFormContent).toBe(EXPECTED);
    expect(gen.constrainedContent).toBe(EXPECTED);
    expect(gen.repairRounds).toBe(0);
  });

  it('worse: free-form is correct but the constrained arm exhausts its budget unchanged', async () => {
    const s = sample({
      id: 'worse',
      freeFormResponse: EXPECTED,
      constrainedResponses: [HALLUCINATED_DSL, HALLUCINATED_DSL, HALLUCINATED_DSL],
    });
    const gen = await generateStructuredEditArmSample(s, scriptedStructuredEditTransport, 2);
    expect(gen.freeFormContent).toBe(EXPECTED);
    // On exhaustion the produced file is the source unchanged (an honest no-op).
    expect(gen.constrainedContent).toBe(SOURCE);
    expect(gen.constrainedSchemaValid).toBe(false);
    expect(gen.repairRounds).toBe(2);
  });

  it('honors a custom maxRounds bound (no budget -> the improved sample never repairs)', async () => {
    const s = sample({
      id: 'no-budget',
      constrainedResponses: [HALLUCINATED_DSL, VALID_DSL],
    });
    const gen = await generateStructuredEditArmSample(s, scriptedStructuredEditTransport, 0);
    expect(gen.constrainedSchemaValid).toBe(false);
    expect(gen.repairRounds).toBe(0);
  });
});

describe('buildStructuredEditArmComparison (synthetic outcomes: improved / no-change / worse)', () => {
  const outcome = (over: Partial<StructuredEditArmOutcome> & { task_id: string }): StructuredEditArmOutcome => ({
    task_class: 'authoring',
    pass_free_form: false,
    pass_constrained: false,
    repair_rounds: 0,
    ...over,
  });

  it('aggregates per-arm pass counts, the repair histogram, and all three classes', () => {
    const outcomes: StructuredEditArmOutcome[] = [
      // improved: free fail, constrained pass after 1 repair (authoring)
      outcome({ task_id: 'a1', task_class: 'authoring', pass_free_form: false, pass_constrained: true, repair_rounds: 1 }),
      // no-change both pass, 0 rounds (mechanical)
      outcome({ task_id: 'm1', task_class: 'mechanical', pass_free_form: true, pass_constrained: true, repair_rounds: 0 }),
      // worse: free pass, constrained fail, exhausted at 2 (review)
      outcome({ task_id: 'r1', task_class: 'review', pass_free_form: true, pass_constrained: false, repair_rounds: 2 }),
    ];
    const record = buildStructuredEditArmComparison(outcomes, {
      asOf: '2026-07-21T00:00:00.000Z',
      maxRepairRounds: 2,
      endpointKind: 'scripted',
    });
    expect(record.kind).toBe('structured-edit-arm-comparison');
    expect(record.schemaVersion).toBe(1);
    expect(record.n).toBe(3);
    expect(record.pass_free_form).toBe(2);
    expect(record.pass_constrained).toBe(2);
    expect(record.asOf).toBe('2026-07-21T00:00:00.000Z');
    expect(record.maxRepairRounds).toBe(2);
    // Provenance defaults to scripted for the committed/synthetic driver.
    expect(record.endpointKind).toBe('scripted');
    // All three classes always present so callers can partition without loss.
    expect(record.by_task_class.map((c) => c.task_class)).toEqual([
      'authoring',
      'mechanical',
      'review',
    ]);
    const byClass = Object.fromEntries(record.by_task_class.map((c) => [c.task_class, c]));
    expect(byClass.authoring.pass_free_form).toBe(0);
    expect(byClass.authoring.pass_constrained).toBe(1);
    expect(byClass.authoring.repair_rounds_histogram).toEqual({ '1': 1 });
    expect(byClass.review.pass_free_form).toBe(1);
    expect(byClass.review.pass_constrained).toBe(0);
    expect(byClass.review.repair_rounds_histogram).toEqual({ '2': 1 });
    expect(record.totals.repair_rounds_histogram).toEqual({ '0': 1, '1': 1, '2': 1 });
  });

  it('injects asOf/endpointKind verbatim and emits an all-zero all-class record for no outcomes', () => {
    const record = buildStructuredEditArmComparison([], {
      asOf: '2026-01-01T00:00:00.000Z',
      maxRepairRounds: 2,
      endpointKind: 'live',
    });
    expect(record.asOf).toBe('2026-01-01T00:00:00.000Z');
    expect(record.endpointKind).toBe('live');
    expect(record.n).toBe(0);
    expect(record.by_task_class).toHaveLength(3);
    expect(record.by_task_class.every((c) => c.n === 0)).toBe(true);
    expect(record.totals.repair_rounds_histogram).toEqual({});
  });
});

describe('parseStructuredEditArmCorpus (fail-closed)', () => {
  const one = (over: Record<string, unknown> = {}) => ({
    id: 'authoring-x',
    taskClass: 'authoring' as TaskClass,
    instruction: 'fix it',
    source: SOURCE,
    expected: EXPECTED,
    freeFormResponse: SOURCE,
    constrainedResponses: [VALID_DSL],
    ...over,
  });
  // A corpus covering all three classes (the parser requires full coverage).
  const allClasses = {
    samples: [
      one(),
      one({ id: 'mechanical-x', taskClass: 'mechanical' }),
      one({ id: 'review-x', taskClass: 'review' }),
    ],
  };

  it('accepts a full-coverage { samples: [...] } envelope and a bare array', () => {
    expect(parseStructuredEditArmCorpus(allClasses)).not.toBeNull();
    expect(parseStructuredEditArmCorpus(allClasses.samples)).not.toBeNull();
  });

  it('rejects a corpus missing a task class (no silent short class)', () => {
    expect(parseStructuredEditArmCorpus({ samples: [one(), one({ id: 'mechanical-x', taskClass: 'mechanical' })] })).toBeNull();
  });

  it('rejects malformed samples (bad id, unknown class, empty fields, bad responses)', () => {
    expect(parseStructuredEditArmCorpus(null)).toBeNull();
    expect(parseStructuredEditArmCorpus({ samples: [] })).toBeNull();
    expect(
      parseStructuredEditArmCorpus({ samples: [{ ...one(), id: 'Bad Id' }, one({ id: 'mechanical-x', taskClass: 'mechanical' }), one({ id: 'review-x', taskClass: 'review' })] })
    ).toBeNull();
    expect(
      parseStructuredEditArmCorpus({ samples: [{ ...one(), taskClass: 'nope' }, one({ id: 'mechanical-x', taskClass: 'mechanical' }), one({ id: 'review-x', taskClass: 'review' })] })
    ).toBeNull();
    expect(
      parseStructuredEditArmCorpus({ samples: [{ ...one(), source: '' }, one({ id: 'mechanical-x', taskClass: 'mechanical' }), one({ id: 'review-x', taskClass: 'review' })] })
    ).toBeNull();
    expect(
      parseStructuredEditArmCorpus({ samples: [{ ...one(), freeFormResponse: 123 }, one({ id: 'mechanical-x', taskClass: 'mechanical' }), one({ id: 'review-x', taskClass: 'review' })] })
    ).toBeNull();
    expect(
      parseStructuredEditArmCorpus({ samples: [{ ...one(), constrainedResponses: [] }, one({ id: 'mechanical-x', taskClass: 'mechanical' }), one({ id: 'review-x', taskClass: 'review' })] })
    ).toBeNull();
    expect(
      parseStructuredEditArmCorpus({ samples: [{ ...one(), constrainedResponses: [1] }, one({ id: 'mechanical-x', taskClass: 'mechanical' }), one({ id: 'review-x', taskClass: 'review' })] })
    ).toBeNull();
  });

  it('rejects duplicate ids', () => {
    expect(parseStructuredEditArmCorpus({ samples: [one(), one(), one({ id: 'mechanical-x', taskClass: 'mechanical' }), one({ id: 'review-x', taskClass: 'review' })] })).toBeNull();
  });
});

// ── The constrained arm delegates to schema-repair.ts + structured-edit-dsl.ts ──
describe('constrained arm reuses schema-repair.ts / structured-edit-dsl.ts (no forked logic)', () => {
  const armSrc = readFileSync(
    fileURLToPath(new URL('./structured-edit-arm-eval.ts', import.meta.url)),
    'utf8'
  );
  const dslSrc = readFileSync(
    fileURLToPath(new URL('./structured-edit-dsl.ts', import.meta.url)),
    'utf8'
  );

  it('imports runRepairLoop from ./schema-repair and calls it', () => {
    expect(armSrc).toMatch(/import[\s\S]*runRepairLoop[\s\S]*from '\.\/schema-repair'/);
    expect(armSrc).toMatch(/runRepairLoop</);
  });

  it('imports the edit-DSL apply/validate rather than re-implementing them', () => {
    expect(armSrc).toMatch(/import[\s\S]*validateEditDsl[\s\S]*from '\.\/structured-edit-dsl'/);
    expect(armSrc).toMatch(/applyEditDsl\(/);
  });

  it('does NOT re-implement the repair loop or its repair prompt', () => {
    expect(armSrc).not.toMatch(/function\s+runRepairLoop/);
    expect(armSrc).not.toMatch(/function\s+defaultRepairMessage/);
    expect(armSrc).not.toMatch(/corrected JSON object/i);
  });

  it('the DSL validator emits domain-phrased errors, not a raw parser trace', () => {
    expect(dslSrc).toMatch(/was not found in the file/);
    expect(dslSrc).not.toMatch(/JSON\.parse/); // parsing is delegated to schema-repair.ts
  });
});

// ── Committed corpus: drift guard + end-to-end offline scoring ─────────────────
describe('committed structured-edit arm corpus', () => {
  const armCorpus = JSON.parse(
    readFileSync(new URL('../../fixtures/structured-edit-arm-eval/corpus.json', import.meta.url), 'utf8')
  );
  const realCorpus = JSON.parse(
    readFileSync(
      new URL('../../fixtures/model-eval-corpus/structured-edit-corpus.json', import.meta.url),
      'utf8'
    )
  );
  const realTasks = new Map<string, { instruction: string; taskClass: string; inputPath: string; expectedPath: string }>(
    realCorpus.tasks.map((t: { id: string; instruction: string; taskClass: string; inputPath: string; expectedPath: string }) => [t.id, t])
  );
  const readFixture = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`../../fixtures/model-eval-corpus/${rel}`, import.meta.url)), 'utf8');

  it('parses fail-closed', () => {
    expect(parseStructuredEditArmCorpus(armCorpus)).not.toBeNull();
  });

  it('drift guard: every sample matches the real committed structured-edit corpus + fixtures', () => {
    const samples = parseStructuredEditArmCorpus(armCorpus)!;
    for (const s of samples) {
      const real = realTasks.get(s.id);
      expect(real, `arm sample ${s.id} must exist in the real structured-edit corpus`).toBeTruthy();
      if (!real) continue;
      expect(s.instruction).toBe(real.instruction);
      expect(s.taskClass).toBe(real.taskClass);
      // source/expected bytes must equal the real fixtures so the generated
      // DIRs are scoreable by `model-eval-run.mjs --responses`.
      expect(s.source).toBe(readFixture(real.inputPath));
      expect(s.expected).toBe(readFixture(real.expectedPath));
    }
  });

  it('runs offline through the existing scorer into a receipt with the constrained arm ahead', async () => {
    const samples = parseStructuredEditArmCorpus(armCorpus)!;
    const outcomes: StructuredEditArmOutcome[] = [];
    for (const s of samples) {
      const gen = await generateStructuredEditArmSample(s, scriptedStructuredEditTransport, 2);
      const [free, constrained] = await Promise.all([
        scoreStructuredEdit(s.expected, gen.freeFormContent, 'task.ts'),
        scoreStructuredEdit(s.expected, gen.constrainedContent, 'task.ts'),
      ]);
      outcomes.push({
        task_id: s.id,
        task_class: s.taskClass,
        pass_free_form: free.verification_passed,
        pass_constrained: constrained.verification_passed,
        repair_rounds: gen.repairRounds,
      });
    }
    const record = buildStructuredEditArmComparison(outcomes, {
      asOf: '2026-07-21T00:00:00.000Z',
      maxRepairRounds: 2,
      endpointKind: 'scripted',
    });
    expect(record.n).toBe(samples.length);
    // The committed direction is honest: the constrained arm beats free-form.
    expect(record.pass_constrained).toBeGreaterThan(record.pass_free_form);
    expect(record.pass_constrained).toBe(6);
    expect(record.pass_free_form).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Provenance travels with the transport (#3430)
// ---------------------------------------------------------------------------

describe('structured-edit transport provenance (#3430)', () => {
  it('the scripted transport is scripted and cannot be relabelled', () => {
    expect(scriptedStructuredEditTransport.kind).toBe('scripted');
    expect(Object.isFrozen(scriptedStructuredEditTransport)).toBe(true);
    expect(() => {
      (scriptedStructuredEditTransport as { kind: string }).kind = 'live';
    }).toThrow();
    expect(scriptedStructuredEditTransport.kind).toBe('scripted');
  });

  it('refuses to label the scripted fixture as a live transport', () => {
    expect(() => liveStructuredEditTransport(scriptedStructuredEditEndpoint)).toThrow(
      /refusing to label the scripted fixture/i
    );
  });

  it('a constructed live transport carries live provenance', () => {
    const realish = async () => ({ text: 'x', model: 'local-test-model' });
    const t = liveStructuredEditTransport(realish);
    expect(t.kind).toBe('live');
    expect(t.complete).toBe(realish);
  });

  it('the generator completes through the transport it was given', async () => {
    // The pairing is structural: whatever answered the calls is the same object
    // the runner reads `kind` from when stamping the record.
    let calls = 0;
    const counting = async (req: Parameters<typeof scriptedStructuredEditEndpoint>[0]) => {
      calls += 1;
      return scriptedStructuredEditEndpoint(req);
    };
    const gen = await generateStructuredEditArmSample(
      sample({ id: 'improved' }),
      liveStructuredEditTransport(counting),
      2
    );
    expect(calls).toBeGreaterThan(0);
    expect(typeof gen.freeFormContent).toBe('string');
  });
});
