import { describe, it, expect } from 'vitest';
import {
  detector,
  INDEX_SIZE_BUDGET_BYTES,
  INDEX_LINE_MAX_CHARS,
} from './memory-hygiene';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type {
  AgentMemory,
  MemoryIndexEntry,
  ProjectMemoryStore,
} from '../../parse-memories';

// ── Fixture builders ───────────────────────────────────────────────────────

function mem(file: string, body = '', name = file.replace(/\.md$/, '')): AgentMemory {
  return { name, description: '', type: 'project', body, file };
}

function idx(file: string, raw?: string, title = file): MemoryIndexEntry {
  return { title, file, hook: '', raw: raw ?? `- [${title}](${file})` };
}

function store(over: Partial<ProjectMemoryStore> = {}): ProjectMemoryStore {
  const index = over.index ?? [];
  const archiveIndex = over.archiveIndex ?? [];
  return {
    project: over.project ?? 'proj',
    memories: over.memories ?? [],
    index,
    indexRaw:
      over.indexRaw ??
      (index.length ? index.map((e) => e.raw).join('\n') : ''),
    indexPresent:
      over.indexPresent ?? Boolean(over.indexRaw ?? index.length),
    archiveIndex,
    archiveIndexRaw:
      over.archiveIndexRaw ??
      (archiveIndex.length ? archiveIndex.map((e) => e.raw).join('\n') : ''),
    archiveIndexPresent:
      over.archiveIndexPresent ?? Boolean(over.archiveIndexRaw ?? archiveIndex.length),
    readCompleteness: over.readCompleteness ?? {
      facts: true,
      mainIndex: true,
      archiveIndex: true,
    },
  };
}

function run(stores: ProjectMemoryStore[] | null | undefined) {
  const input = { memoryStores: stores } as unknown as RecommendationInput;
  return detector.rule(input, 0);
}

// ── Silence cases ──────────────────────────────────────────────────────────

describe('maintenance.memory-hygiene — silence', () => {
  it('emits nothing when no memory stores are present', () => {
    expect(run(null)).toBeNull();
    expect(run(undefined)).toBeNull();
    expect(run([])).toBeNull();
  });

  it('stays silent on a clean, well-indexed store', () => {
    const clean = store({
      memories: [mem('a.md', 'links [[b]]'), mem('b.md')],
      index: [idx('a.md'), idx('b.md')],
    });
    expect(run([clean])).toBeNull();
  });
});

// ── Each deterministic debt signal fires in isolation ──────────────────────

describe('maintenance.memory-hygiene — deterministic signals', () => {
  it('flags an oversized MEMORY.md index (signal 1)', () => {
    const indexRaw = 'x'.repeat(INDEX_SIZE_BUDGET_BYTES + 100);
    const rec = run([store({ indexRaw })]);
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(1);
    expect(rec!.evidence!.some((e) => e.includes('index over size budget'))).toBe(true);
  });

  it('flags an over-long index line (signal 2)', () => {
    const longRaw = '- [Foo](foo.md) — ' + 'x'.repeat(INDEX_LINE_MAX_CHARS + 10);
    const rec = run([
      store({ memories: [mem('foo.md')], index: [idx('foo.md', longRaw, 'Foo')] }),
    ]);
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(1);
    expect(rec!.evidence![0]).toContain('index line too long');
  });

  it('flags a dangling index link to a missing file (signal 3)', () => {
    const rec = run([store({ index: [idx('gone.md')] })]);
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(1);
    expect(rec!.evidence![0]).toContain('proj/gone.md');
    expect(rec!.evidence![0]).toContain('missing file');
    // A broken pointer is structural breakage → warning, not info.
    expect(rec!.severity).toBe('warning');
  });

  it('flags an on-disk file that the index omits (signal 4)', () => {
    const rec = run([
      store({ memories: [mem('a.md'), mem('orphan.md')], index: [idx('a.md')] }),
    ]);
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(1);
    expect(rec!.evidence![0]).toContain('proj/orphan.md');
    expect(rec!.evidence![0]).toContain('missing from the index');
  });

  it('does not treat intentional unresolved wikilinks as hygiene debt', () => {
    const rec = run([
      store({
        memories: [mem('a.md', 'see [[future-memory]] and [[planned|alias]]')],
        index: [idx('a.md')],
      }),
    ]);
    expect(rec).toBeNull();
  });

  it('flags files as unindexed when a complete MEMORY.md is prose-only', () => {
    // A present, completely read index is authoritative even when no pointer
    // lines parse; otherwise an empty/prose-only index hides every fact.
    const proseIndex = store({
      memories: [mem('a.md'), mem('b.md')],
      index: [],
      indexRaw: '# Memory index\n\nSome notes, no list links yet.\n',
    });
    const rec = run([proseIndex]);
    expect(rec?.affected).toBe(2);
    expect(rec?.evidence).toEqual(
      expect.arrayContaining([
        'proj/a.md — memory file missing from the index',
        'proj/b.md — memory file missing from the index',
      ])
    );
  });

  it('flags files as unindexed when a complete MEMORY.md is empty', () => {
    const rec = run([
      store({
        memories: [mem('orphan.md')],
        index: [],
        indexRaw: '',
        indexPresent: true,
      }),
    ]);
    expect(rec?.evidence).toContain(
      'proj/orphan.md — memory file missing from the index'
    );
  });

  it('flags a fact missing from both conclusively absent indexes', () => {
    const rec = run([
      store({
        memories: [mem('orphan.md')],
        indexPresent: false,
        archiveIndexPresent: false,
      }),
    ]);
    expect(rec?.evidence).toContain(
      'proj/orphan.md — memory file missing from the index'
    );
  });

  it('does not flag a wikilink that resolves to another memory', () => {
    const ok = store({
      memories: [mem('a.md', 'links [[b]]'), mem('b.md')],
      index: [idx('a.md'), idx('b.md')],
    });
    expect(run([ok])).toBeNull();
  });

  it('uses the union of main and archive indexes for fact coverage', () => {
    const archived = store({
      memories: [mem('archive/old.md')],
      index: [idx('archive/ARCHIVE.md')],
      archiveIndex: [idx('archive/old.md')],
    });
    expect(run([archived])).toBeNull();
  });

  it('treats a present archive index as a valid main-index target', () => {
    const archived = store({
      index: [idx('archive/ARCHIVE.md')],
      archiveIndexRaw: '# Archive index',
    });
    expect(run([archived])).toBeNull();
  });

  it('treats a case-insensitive archive-index spelling as the present index', () => {
    const archived = store({
      index: [idx('archive/archive.md')],
      archiveIndexRaw: '# Archive index',
      archiveIndexPresent: true,
    });
    expect(run([archived])).toBeNull();
  });

  it('still flags a fact omitted from both complete indexes', () => {
    const rec = run([
      store({
        memories: [mem('kept.md'), mem('archive/orphan.md')],
        index: [idx('kept.md')],
        archiveIndexRaw: '# Archive index',
      }),
    ]);
    expect(rec?.evidence).toContain(
      'proj/archive/orphan.md — memory file missing from the index'
    );
  });

  it('suppresses absence-based claims when any required read is incomplete', () => {
    const partial = store({
      memories: [mem('orphan.md')],
      index: [idx('gone.md')],
      readCompleteness: {
        facts: false,
        mainIndex: true,
        archiveIndex: false,
      },
    });
    expect(run([partial])).toBeNull();
  });

  it('keeps directly observed index-size and line-length facts on incomplete reads', () => {
    const longRaw = '- [Foo](foo.md) — ' + 'x'.repeat(INDEX_LINE_MAX_CHARS + 10);
    const partial = store({
      index: [idx('foo.md', longRaw, 'Foo')],
      indexRaw: longRaw + '\n' + 'x'.repeat(INDEX_SIZE_BUDGET_BYTES),
      readCompleteness: {
        facts: false,
        mainIndex: true,
        archiveIndex: false,
      },
    });
    const rec = run([partial]);
    expect(rec?.affected).toBe(2);
    expect(rec?.evidence?.join('\n')).toContain('index over size budget');
    expect(rec?.evidence?.join('\n')).toContain('index line too long');
  });

  it('does not apply hot MEMORY.md size/line budgets to the cold archive index', () => {
    const longRaw = '- [Old](archive/old.md) — ' +
      'x'.repeat(INDEX_LINE_MAX_CHARS + 10);
    const archiveOnly = store({
      archiveIndex: [idx('archive/old.md', longRaw, 'Old')],
      archiveIndexRaw:
        longRaw + '\n' + 'x'.repeat(INDEX_SIZE_BUDGET_BYTES),
      memories: [mem('archive/old.md')],
    });
    expect(run([archiveOnly])).toBeNull();
  });
});

// ── All four together: one grouped card ────────────────────────────────────

describe('maintenance.memory-hygiene — grouped card + contract', () => {
  function kitchenSink(): ProjectMemoryStore {
    const longRaw = '- [Kept](kept.md) — ' + 'x'.repeat(INDEX_LINE_MAX_CHARS + 10);
    const pointers = [idx('kept.md', longRaw, 'Kept'), idx('gone.md')];
    return store({
      memories: [mem('kept.md'), mem('orphan.md')],
      index: pointers,
      // Valid pointer lines + padding pushes the index over the byte budget too.
      indexRaw:
        pointers.map((p) => p.raw).join('\n') +
        '\n' +
        'x'.repeat(INDEX_SIZE_BUDGET_BYTES),
    });
  }

  it('emits ONE recommendation covering all four debt signals', () => {
    const rec = run([kitchenSink()]);
    expect(rec).not.toBeNull();
    expect(rec!.id).toBe('maintenance.memory-hygiene');
    expect(rec!.category).toBe('maintenance');
    // 4 distinct signals, one item each.
    expect(rec!.affected).toBe(4);
    expect(rec!.severity).toBe('warning'); // structural breakage present
    expect(rec!.view).toBe('memories');
    // The detail breaks the count down by signal.
    expect(rec!.detail).toContain('4 deterministic hygiene issues');
  });

  it('is recommend-only — never ships an auto-apply fix', () => {
    const rec = run([kitchenSink()]);
    expect(rec!.fix).toBeUndefined();
  });

  it('carries auditable provenance that passes the contract', () => {
    const rec = run([kitchenSink()]);
    expect(rec!.provenance).toBeDefined();
    expect(rec!.provenance!.observations[0].source).toBe('parse-memories');
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('aggregates issues across multiple project stores', () => {
    const a = store({ project: 'a', index: [idx('gone.md')] });
    const b = store({ memories: [mem('x.md'), mem('orphan.md')], index: [idx('x.md')] });
    const rec = run([a, b]);
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(2);
  });

  it('dates both-index completeness evidence to the last memory ingest', () => {
    const now = Date.parse('2026-07-15T12:00:00Z');
    const rec = detector.rule(
      { memoryStores: [kitchenSink()] } as unknown as RecommendationInput,
      now
    );
    expect(rec?.detail).toContain('At the last memory ingest (2026-07-15)');
    expect(rec?.provenance?.asOf).toBe('2026-07-15');
    expect(rec?.provenance?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'memoryStores[].index (MEMORY.md)' }),
        expect.objectContaining({
          field: 'memoryStores[].archiveIndex (archive/ARCHIVE.md)',
        }),
        expect.objectContaining({ field: 'memoryStores[].readCompleteness' }),
      ])
    );
    expect(rec?.fix).toBeUndefined();
  });

  it('bounds per-project provenance while retaining aggregate completeness', () => {
    const stores = Array.from({ length: 32 }, (_, index) =>
      store({
        project: `${'very-long-project-'.repeat(20)}${index}`,
        memories: [mem(`orphan-${index}.md`)],
      })
    );
    const rec = run(stores);
    const values = rec?.provenance?.observations
      .slice(1)
      .map((observation) => String(observation.value));
    expect(values).toHaveLength(3);
    for (const value of values ?? []) {
      expect(value).toContain('stores=32');
      expect(value).toContain('sampled=8/32');
      expect(value.length).toBeLessThan(1_500);
    }
  });
});
