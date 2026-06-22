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
  return {
    project: over.project ?? 'proj',
    memories: over.memories ?? [],
    index,
    indexRaw:
      over.indexRaw ??
      (index.length ? index.map((e) => e.raw).join('\n') : ''),
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

// ── Each of the five deterministic signals fires in isolation ──────────────

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

  it('flags a dangling [[wikilink]] with no matching memory (signal 5)', () => {
    const rec = run([store({ memories: [mem('a.md', 'see [[nonexistent]]')] })]);
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(1);
    expect(rec!.evidence![0]).toContain('wikilink to a non-existent memory');
    // Sprawl-only (no structural breakage) stays informational.
    expect(rec!.severity).toBe('info');
  });

  it('does not flag files as unindexed when MEMORY.md is prose-only (no parsed pointers)', () => {
    // A non-empty index with no `- [Title](file.md)` lines parses to `index: []`.
    // Flagging every file against that empty pointer set would be a false positive.
    const proseIndex = store({
      memories: [mem('a.md'), mem('b.md')],
      index: [],
      indexRaw: '# Memory index\n\nSome notes, no list links yet.\n',
    });
    expect(run([proseIndex])).toBeNull();
  });

  it('does not flag a wikilink that resolves to another memory', () => {
    const ok = store({
      memories: [mem('a.md', 'links [[b]]'), mem('b.md')],
      index: [idx('a.md'), idx('b.md')],
    });
    expect(run([ok])).toBeNull();
  });
});

// ── All five together: one grouped card ────────────────────────────────────

describe('maintenance.memory-hygiene — grouped card + contract', () => {
  function kitchenSink(): ProjectMemoryStore {
    const longRaw = '- [Kept](kept.md) — ' + 'x'.repeat(INDEX_LINE_MAX_CHARS + 10);
    const pointers = [idx('kept.md', longRaw, 'Kept'), idx('gone.md')];
    return store({
      memories: [mem('kept.md', 'links [[ghost]]'), mem('orphan.md')],
      index: pointers,
      // Valid pointer lines + padding pushes the index over the byte budget too.
      indexRaw:
        pointers.map((p) => p.raw).join('\n') +
        '\n' +
        'x'.repeat(INDEX_SIZE_BUDGET_BYTES),
    });
  }

  it('emits ONE recommendation covering all five signals', () => {
    const rec = run([kitchenSink()]);
    expect(rec).not.toBeNull();
    expect(rec!.id).toBe('maintenance.memory-hygiene');
    expect(rec!.category).toBe('maintenance');
    // 5 distinct signals, one item each.
    expect(rec!.affected).toBe(5);
    expect(rec!.severity).toBe('warning'); // structural breakage present
    expect(rec!.view).toBe('memories');
    // The detail breaks the count down by signal.
    expect(rec!.detail).toContain('5 deterministic hygiene issues');
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
    const b = store({ memories: [mem('x.md', '[[missing]]')] });
    const rec = run([a, b]);
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(2);
  });
});
