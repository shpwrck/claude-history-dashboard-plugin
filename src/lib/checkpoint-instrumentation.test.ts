import { describe, expect, it } from 'vitest';
import {
  buildCheckpointAnswerRecord,
  withLateCorrection,
  createInMemoryCheckpointSink,
} from './checkpoint-instrumentation';
import type { DocNeighborhood } from './doc-neighborhood';

function neighborhood(overrides: Partial<DocNeighborhood> = {}): DocNeighborhood {
  return {
    anchor: { kind: 'doc', slug: 'AGENTS' },
    seeds: ['AGENTS'],
    nodes: [
      {
        slug: 'AGENTS',
        path: 'AGENTS.md',
        category: 'root',
        distance: 0,
        relevance: 3,
        gitMtimeIso: '2026-06-01T00:00:00Z',
        hygiene: { danglingLinks: [], stale: false, contradictory: false },
      },
      {
        slug: 'docs/conventions/old',
        path: 'docs/conventions/old.md',
        category: 'doc',
        distance: 1,
        relevance: 1,
        gitMtimeIso: '2025-01-01T00:00:00Z',
        hygiene: { danglingLinks: [], stale: true, contradictory: true, declaredStatus: 'superseded' },
      },
    ],
    ambiguityTrigger: true,
    ambiguitySources: ['docs/conventions/old'],
    ...overrides,
  };
}

describe('buildCheckpointAnswerRecord', () => {
  it('computes elapsed time and derives auditable provenance', () => {
    const record = buildCheckpointAnswerRecord({
      checkpointId: 'cp-1',
      shownAt: 1_000,
      answeredAt: 4_500,
      answer: 'use-worktree',
      neighborhood: neighborhood(),
    });
    expect(record).not.toBeNull();
    expect(record!.kind).toBe('CHECKPOINT_ANSWER');
    expect(record!.elapsedMs).toBe(3_500);
    expect(record!.answer).toBe('use-worktree');
    expect(record!.lateCorrection).toBeNull();
    // Timestamps normalise to ISO.
    expect(record!.shownAtIso).toBe(new Date(1_000).toISOString());
    expect(record!.answeredAtIso).toBe(new Date(4_500).toISOString());
    // Provenance cites what the human saw + which nodes were demoted.
    expect(record!.provenance.source).toBe('doc-neighborhood');
    expect(record!.provenance.anchor).toEqual({ kind: 'doc', slug: 'AGENTS' });
    expect(record!.provenance.shownSlugs).toEqual([
      'AGENTS',
      'docs/conventions/old',
    ]);
    expect(record!.provenance.ambiguityTrigger).toBe(true);
    expect(record!.provenance.demotedSlugs).toEqual(['docs/conventions/old']);
  });

  it('clamps a negative elapsed (clock skew) to zero, never negative', () => {
    const record = buildCheckpointAnswerRecord({
      checkpointId: 'cp-1',
      shownAt: 5_000,
      answeredAt: 4_000,
      answer: 'x',
      neighborhood: neighborhood(),
    });
    expect(record!.elapsedMs).toBe(0);
  });

  it('accepts epoch-ms, ISO string, and Date timestamps', () => {
    const iso = buildCheckpointAnswerRecord({
      checkpointId: 'cp',
      shownAt: '2026-07-11T00:00:00Z',
      answeredAt: new Date('2026-07-11T00:00:05Z'),
      answer: 'x',
      neighborhood: neighborhood(),
    });
    expect(iso!.elapsedMs).toBe(5_000);
  });

  it('honours a narrower shownSlugs override in provenance', () => {
    const record = buildCheckpointAnswerRecord({
      checkpointId: 'cp',
      shownAt: 0,
      answeredAt: 1,
      answer: 'x',
      neighborhood: neighborhood(),
      shownSlugs: ['AGENTS'],
    });
    expect(record!.provenance.shownSlugs).toEqual(['AGENTS']);
    // The demoted node was not shown, so it is not in the demoted set.
    expect(record!.provenance.demotedSlugs).toEqual([]);
  });

  it('fails closed on a blank id, blank answer, or unparseable time', () => {
    const base = {
      shownAt: 0,
      answeredAt: 1,
      answer: 'x',
      neighborhood: neighborhood(),
    };
    expect(buildCheckpointAnswerRecord({ ...base, checkpointId: '  ' })).toBeNull();
    expect(
      buildCheckpointAnswerRecord({ ...base, checkpointId: 'cp', answer: '' })
    ).toBeNull();
    expect(
      buildCheckpointAnswerRecord({
        ...base,
        checkpointId: 'cp',
        answeredAt: 'not-a-date',
      })
    ).toBeNull();
  });
});

describe('withLateCorrection', () => {
  it('returns a copy with the late-correction resolved, without mutating', () => {
    const record = buildCheckpointAnswerRecord({
      checkpointId: 'cp',
      shownAt: 0,
      answeredAt: 1,
      answer: 'x',
      neighborhood: neighborhood(),
    })!;
    const corrected = withLateCorrection(record, true);
    expect(corrected.lateCorrection).toBe(true);
    // Original is untouched (still open).
    expect(record.lateCorrection).toBeNull();
    expect(corrected).not.toBe(record);
  });
});

describe('createInMemoryCheckpointSink', () => {
  it('collects emitted records', () => {
    const { sink, records } = createInMemoryCheckpointSink();
    const record = buildCheckpointAnswerRecord({
      checkpointId: 'cp',
      shownAt: 0,
      answeredAt: 10,
      answer: 'x',
      neighborhood: neighborhood(),
    })!;
    sink(record);
    expect(records).toHaveLength(1);
    expect(records[0]).toBe(record);
  });
});
