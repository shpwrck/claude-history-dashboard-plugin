import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CURATED_CORPUS,
  OBJECTIVE_GATE_KINDS,
  parseCorpus,
  parseCorpusTask,
  validateCorpus,
  corpusTaskRef,
} from './model-eval-corpus';
import { buildFixtureBackedBatchSpec } from './model-eval-batch';

describe('curated corpus', () => {
  it('validates against the schema (non-empty, round-trips clean)', () => {
    const result = validateCorpus(CURATED_CORPUS);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('every task has a unique id and an objective gate of a known kind', () => {
    const ids = new Set<string>();
    for (const task of CURATED_CORPUS) {
      expect(ids.has(task.id)).toBe(false);
      ids.add(task.id);
      expect(OBJECTIVE_GATE_KINDS).toContain(task.gate.kind);
      expect(task.gate.command.length).toBeGreaterThan(0);
      expect(Number.isInteger(task.gate.expectExitCode)).toBe(true);
    }
    // Covers all three gate kinds so a batch can exercise each.
    const kinds = new Set(CURATED_CORPUS.map((t) => t.gate.kind));
    expect([...kinds].sort()).toEqual(['build', 'diff', 'test']);
  });

  it('parses to itself (the constant is its own normal form)', () => {
    expect(parseCorpus(CURATED_CORPUS)).toEqual(CURATED_CORPUS);
  });

  it('matches the committed fixtures manifest byte-for-byte (drift + reproducibility guard)', () => {
    const fixturePath = fileURLToPath(
      new URL('../../fixtures/model-eval-corpus/curated-corpus.json', import.meta.url)
    );
    const fromDisk = parseCorpus(JSON.parse(readFileSync(fixturePath, 'utf8')));
    expect(fromDisk).toEqual(CURATED_CORPUS);
  });
});

describe('parseCorpus / parseCorpusTask', () => {
  it('drops malformed tasks and de-duplicates by id (first wins)', () => {
    const raw = [
      { id: 'a', title: 'A', instruction: 'do a', gate: { kind: 'test', command: 'npm test' } },
      { id: 'a', title: 'dup', instruction: 'dup', gate: { kind: 'build', command: 'x' } }, // dup id
      { id: 'b', title: 'B', instruction: 'do b', gate: { kind: 'nope', command: 'x' } }, // bad kind
      { id: 'c', title: 'C', instruction: 'do c', gate: { kind: 'diff', command: '' } }, // empty cmd
      { title: 'no id', instruction: 'x', gate: { kind: 'test', command: 'x' } }, // no id
    ];
    const parsed = parseCorpus(raw);
    expect(parsed.map((t) => t.id)).toEqual(['a']);
    expect(parsed[0].gate.expectExitCode).toBe(0); // defaulted
  });

  it('returns null for non-objects and missing fields', () => {
    expect(parseCorpusTask(null)).toBeNull();
    expect(parseCorpusTask('x')).toBeNull();
    expect(parseCorpusTask({ id: 'a' })).toBeNull();
  });

  it('parseCorpus returns [] for non-arrays', () => {
    expect(parseCorpus({})).toEqual([]);
    expect(parseCorpus(null)).toEqual([]);
  });
});

describe('buildFixtureBackedBatchSpec', () => {
  const input = {
    candidates: ['claude-haiku-4-5-20251001'],
    baselines: ['claude-sonnet-4-6'],
    createdAt: '2026-06-01T00:00:00.000Z',
  };

  it('forces curated-fixtures source and references the corpus tasks', () => {
    const spec = buildFixtureBackedBatchSpec(input, CURATED_CORPUS);
    expect(spec.corpus.source).toBe('curated-fixtures');
    expect(spec.corpusTasks).toEqual(CURATED_CORPUS.map(corpusTaskRef));
    expect(spec.corpusTasks?.[0]).toMatchObject({ taskId: 'pure-fn-fizzbuzz', gateKind: 'test' });
  });

  it('respects the task limit', () => {
    const spec = buildFixtureBackedBatchSpec({ ...input, limit: 2 }, CURATED_CORPUS);
    expect(spec.corpus.limit).toBe(2);
    expect(spec.corpusTasks).toHaveLength(2);
  });

  it('is deterministic: same models + corpus + createdAt → identical spec', () => {
    const a = buildFixtureBackedBatchSpec(input, CURATED_CORPUS);
    const b = buildFixtureBackedBatchSpec(input, CURATED_CORPUS);
    expect(a).toEqual(b);
  });

  it('throws on an empty corpus', () => {
    expect(() => buildFixtureBackedBatchSpec(input, [])).toThrow(/non-empty curated corpus/);
  });

  it('throws (via the base builder) when no candidate is given', () => {
    expect(() => buildFixtureBackedBatchSpec({ candidates: [], baselines: ['claude-sonnet-4-6'] }, CURATED_CORPUS)).toThrow(
      /candidate/
    );
  });
});
