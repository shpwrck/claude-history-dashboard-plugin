import { describe, it, expect } from 'vitest';
import {
  splitDataset,
  mergeDataset,
  isSliceKey,
  HEAVY_SLICE_KEYS,
  NON_ARRAY_SLICE_KEYS,
} from './dataset-boot';

// #2443 (epic #1852): the Tier-3 instant-load split. The boot payload carries
// only small metadata + server-computed aggregates + per-slice counts; the heavy
// per-view arrays become lazy slices. These assert the partition is exact
// (boot.meta ∪ slices reconstitute the dataset key-for-key), boot excludes the
// heavy keys, aggregates/counts are real, and the non-array slice (repoMap)
// round-trips as null when unfetched.

function sampleDataset() {
  return {
    generatedAt: 123,
    sourceId: 'claude-code',
    harness: 'claude-code',
    liveConfig: { pid: 1 },
    sessionRegistry: [{ sessionId: 'a' }],
    // heavy keys — entries span sessions a, b, c; 'c' is history-only (no token
    // row), so distinct-session count (3) exceeds tokenData.length (2).
    entries: [
      { sessionId: 'a', id: 'e1' },
      { sessionId: 'b', id: 'e2' },
      { sessionId: 'c', id: 'e3' },
    ],
    timelines: [{ sessionId: 'a' }],
    tokenData: [
      { sessionId: 'a', model: 'opus', totalInputTokens: 10, totalOutputTokens: 5, messageCount: 3 },
      { sessionId: 'b', model: 'sonnet', totalInputTokens: 7, totalOutputTokens: 2, messageCount: 1 },
    ],
    toolData: [{ sessionId: 'a', calls: [] }],
    repoMap: { files: { 'a.ts': 1 } }, // non-array heavy key
    docGraph: { nodes: [{ path: 'README.md' }], edges: [] },
  };
}

describe('splitDataset', () => {
  it('keeps only non-heavy keys in boot.meta; heavy keys become slices', () => {
    const { boot, slices } = splitDataset(sampleDataset());
    // meta has the small keys, none of the heavy ones
    expect(Object.keys(boot.meta).sort()).toEqual(
      ['generatedAt', 'harness', 'liveConfig', 'sessionRegistry', 'sourceId'].sort()
    );
    for (const k of HEAVY_SLICE_KEYS) expect(k in boot.meta).toBe(false);
    // slices carry every present heavy key verbatim
    expect(slices.entries).toEqual([
      { sessionId: 'a', id: 'e1' },
      { sessionId: 'b', id: 'e2' },
      { sessionId: 'c', id: 'e3' },
    ]);
    expect(slices.repoMap).toEqual({ files: { 'a.ts': 1 } });
    expect(slices.docGraph).toEqual({ nodes: [{ path: 'README.md' }], edges: [] });
    expect('toolData' in slices).toBe(true);
  });

  it('computes real aggregates + per-slice counts', () => {
    const { boot } = splitDataset(sampleDataset());
    // distinct sessionId in entries (a,b,c) — NOT tokenData.length (2), so the
    // history-only session 'c' is counted (matches groupBySessions semantics).
    expect(boot.aggregates.sessions).toBe(3);
    expect(boot.aggregates.events).toBe(3); // entries
    expect(boot.aggregates.inputTokens).toBe(17);
    expect(boot.aggregates.outputTokens).toBe(7);
    expect(boot.aggregates.messages).toBe(4);
    expect(boot.aggregates.models).toBe(2); // opus, sonnet (deduped)
    expect(boot.counts.entries).toBe(3);
    expect(boot.counts.repoMap).toBe(1); // non-array object counts as 1
    expect(boot.counts.docGraph).toBe(1);
    // sliceKeys lists only present, non-empty heavy keys
    expect(boot.sliceKeys).toContain('entries');
    expect(boot.sliceKeys).toContain('repoMap');
    expect(boot.sliceKeys).not.toContain('valueFlow'); // absent from sample
  });
});

describe('mergeDataset (inverse of splitDataset)', () => {
  it('boot.meta ∪ slices reconstitutes the dataset key-for-key', () => {
    const ds = sampleDataset();
    const { boot, slices } = splitDataset(ds);
    // only pass the advertised slices, as a client would
    const fetched: Record<string, unknown> = {};
    for (const k of boot.sliceKeys) fetched[k] = slices[k];
    const merged = mergeDataset(boot.meta, fetched);
    // every original key + value is present (aggregates/counts are additive)
    for (const [k, v] of Object.entries(ds)) expect(merged[k]).toEqual(v);
  });

  it('defaults unfetched arrays to [] and non-array objects to null', () => {
    const { boot } = splitDataset(sampleDataset());
    const merged = mergeDataset(boot.meta, {}); // fetched nothing
    expect(merged.entries).toEqual([]);
    expect(merged.timelines).toEqual([]);
    expect(merged.repoMap).toBeNull(); // non-array default
    expect(merged.docGraph).toBeNull();
    expect(NON_ARRAY_SLICE_KEYS.has('repoMap')).toBe(true);
    expect(NON_ARRAY_SLICE_KEYS.has('docGraph')).toBe(true);
  });
});

describe('isSliceKey', () => {
  it('allowlists exactly the heavy keys', () => {
    for (const k of HEAVY_SLICE_KEYS) expect(isSliceKey(k)).toBe(true);
    expect(isSliceKey('liveConfig')).toBe(false);
    expect(isSliceKey('__proto__')).toBe(false);
    expect(isSliceKey('bogus')).toBe(false);
  });
});
