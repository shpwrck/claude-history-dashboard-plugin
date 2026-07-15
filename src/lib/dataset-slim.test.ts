import { describe, it, expect } from 'vitest';
import { slimDataset, rehydrateDataset } from './dataset-slim';
import { estimateEntryCost } from './parse-sessions';
import type { TokenEntry } from '../types';

// A representative TokenEntry with a mix of zero and non-zero numeric fields,
// matching the live-corpus shape (web-search/web-fetch ~always 0; 1h-cache split
// often 0; thinkingTokens optional).
function fullEntry(over: Partial<TokenEntry> = {}): TokenEntry {
  return {
    timestamp: '2026-05-30T18:57:31.486Z',
    inputTokens: 6,
    outputTokens: 135,
    cacheCreationTokens: 21868,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    thinkingTokens: 86,
    toolUseIds: ['toolu_01UrjohcQ8jMp2ehiNPN8ogW'],
    toolResultBytes: 6812,
    model: 'claude-opus-4-7',
    ...over,
  };
}

const fullCall = (over: Record<string, unknown> = {}) => ({
  timestamp: '2026-05-30T18:57:31.486Z',
  toolName: 'Bash',
  input: { command: 'git -C /repo status' },
  toolUseId: 'toolu_abc',
  isError: null,
  resultBytes: 0,
  commandFingerprint: 'abc:19',
  commandPreview: 'git -C /repo status',
  commandHead: 'git',
  ...over,
});

describe('slimDataset', () => {
  it('drops zero-valued TokenEntry numeric members on the wire', () => {
    const ds = { tokenData: [{ sessionId: 's1', entries: [fullEntry()] }] };
    const slim = slimDataset(ds) as typeof ds;
    const e = slim.tokenData[0].entries[0] as Record<string, unknown>;
    // Zeros dropped.
    expect(e.cacheCreation1hTokens).toBeUndefined();
    expect(e.cacheReadTokens).toBeUndefined();
    expect(e.webSearchRequests).toBeUndefined();
    expect(e.webFetchRequests).toBeUndefined();
    // Non-zero kept; strings always kept.
    expect(e.inputTokens).toBe(6);
    expect(e.outputTokens).toBe(135);
    expect(e.cacheCreationTokens).toBe(21868);
    expect(e.thinkingTokens).toBe(86);
    expect(e.timestamp).toBe('2026-05-30T18:57:31.486Z');
    expect(e.model).toBe('claude-opus-4-7');
    expect(e.toolUseIds).toEqual(['toolu_01UrjohcQ8jMp2ehiNPN8ogW']);
    expect(e.toolResultBytes).toBe(6812);
  });

  it('leaves toolData calls completely untouched (verbatim by reference)', () => {
    const calls = [fullCall(), fullCall({ isError: null, resultBytes: 0 })];
    const ds = { toolData: [{ sessionId: 's1', calls }] };
    const slim = slimDataset(ds) as typeof ds;
    // toolData rows are passed through by reference — no clone, no field drop.
    expect(slim.toolData).toBe(ds.toolData);
    expect(slim.toolData[0].calls[0]).toEqual(fullCall());
    expect(slim.toolData[0].calls[1].isError).toBeNull();
    expect(slim.toolData[0].calls[1].resultBytes).toBe(0);
  });

  it('does not mutate the input dataset', () => {
    const entry = fullEntry();
    const ds = { tokenData: [{ sessionId: 's1', entries: [entry] }] };
    slimDataset(ds);
    expect(entry.webSearchRequests).toBe(0); // original untouched
    expect(ds.tokenData[0].entries[0]).toBe(entry); // same reference
  });

  it('passes through non-dataset / missing fields unchanged', () => {
    expect(slimDataset(null)).toBeNull();
    expect(slimDataset(undefined)).toBeUndefined();
    const ds = { sessions: [{ id: 'a' }] };
    expect(slimDataset(ds)).toEqual(ds);
  });
});

describe('rehydrateDataset', () => {
  it('normalizes a pre-v8 shadowCalls aggregate at the cache rehydration seam', () => {
    const legacy = {
      shadowCalls: {
        total: 5,
        byAxis: [
          { axis: 'recs', samples: 3, live: 2, replay: 1 },
          { axis: 'config-scoping', samples: 2, live: 1, replay: 1 },
        ],
      },
    };

    const result = rehydrateDataset(legacy);

    expect(result).toBe(legacy);
    expect(legacy.shadowCalls).toMatchObject({
      total: 5,
      counted: 5,
      synthetic: 0,
      skipped: 0,
      live: 3,
      replay: 2,
    });
  });

  it('leaves a current shadowCalls aggregate untouched', () => {
    const current = {
      total: 10,
      counted: 7,
      synthetic: 1,
      skipped: 2,
      live: 3,
      replay: 4,
      byAxis: [{ axis: 'recs', live: 3, replay: 4 }],
    };
    const before = JSON.parse(JSON.stringify(current));
    const dataset = { shadowCalls: current };

    const result = rehydrateDataset(dataset);

    expect(result).toBe(dataset);
    expect(dataset.shadowCalls).toBe(current);
    expect(current).toEqual(before);
  });

  it.each([
    ['fractional total', { total: 1.5, byAxis: [{ samples: 1, live: 1, replay: 0 }] }],
    ['fractional axis count', { total: 1, byAxis: [{ samples: 1, live: 0.5, replay: 0.5 }] }],
    ['axis sample mismatch', { total: 2, byAxis: [{ samples: 1, live: 1, replay: 1 }] }],
    ['non-reconciling buckets', { total: 5, byAxis: [{ samples: 2, live: 1, replay: 1 }] }],
    [
      'overflowing axis sum',
      {
        total: Number.MAX_SAFE_INTEGER,
        byAxis: [
          { samples: Number.MAX_SAFE_INTEGER, live: Number.MAX_SAFE_INTEGER, replay: 0 },
          { samples: 1, live: 1, replay: 0 },
        ],
      },
    ],
  ])('fails closed on a malformed legacy aggregate: %s', (_name, shadowCalls) => {
    const before = structuredClone(shadowCalls);
    const dataset = { shadowCalls };

    rehydrateDataset(dataset);

    expect(dataset.shadowCalls).toEqual(before);
    expect('counted' in dataset.shadowCalls).toBe(false);
  });

  it.each([
    [
      'v8 disposition bucket',
      {
        total: 2,
        synthetic: 1,
        byAxis: [{ axis: 'recs', samples: 1, live: 1, replay: 0 }],
      },
    ],
    [
      'post-v8 truncation marker',
      {
        total: 1,
        truncated: true,
        byAxis: [{ axis: 'recs', samples: 1, live: 1, replay: 0 }],
      },
    ],
  ])('leaves an ambiguous current-like aggregate untouched: %s', (_name, shadowCalls) => {
    const before = structuredClone(shadowCalls);

    rehydrateDataset({ shadowCalls });

    expect(shadowCalls).toEqual(before);
    expect('counted' in shadowCalls).toBe(false);
  });

  it('restores every dropped TokenEntry default to its exact value', () => {
    const ds = { tokenData: [{ sessionId: 's1', entries: [fullEntry()] }] };
    const wire = JSON.parse(JSON.stringify(slimDataset(ds)));
    rehydrateDataset(wire);
    expect(wire.tokenData[0].entries[0]).toEqual(fullEntry());
  });

  it('does NOT re-add toolResultBytes (parser omits it when 0, so rehydrate must too)', () => {
    // An entry whose toolResultBytes is 0 is emitted by the parser WITHOUT the
    // key. Slim drops it (no-op, already absent); rehydrate must leave it absent
    // so the client shape matches the server/parser shape (no present-0 divergence).
    const ds = {
      tokenData: [
        {
          sessionId: 's1',
          entries: [{ timestamp: 't', model: 'm', inputTokens: 5, webSearchRequests: 0 }],
        },
      ],
    };
    const wire = JSON.parse(JSON.stringify(slimDataset(ds)));
    rehydrateDataset(wire);
    const e = wire.tokenData[0].entries[0];
    expect('toolResultBytes' in e).toBe(false); // stays absent
    expect(e.webSearchRequests).toBe(0); // always-present numeric restored
    expect(e.inputTokens).toBe(5);
  });

  it('leaves toolData untouched on rehydrate', () => {
    const ds = { toolData: [{ sessionId: 's1', calls: [fullCall()] }] };
    const wire = JSON.parse(JSON.stringify(slimDataset(ds)));
    rehydrateDataset(wire);
    expect(wire.toolData[0].calls[0]).toEqual(fullCall());
  });

  it('is idempotent on an already-full (never-slimmed) dataset', () => {
    const full = {
      tokenData: [{ sessionId: 's1', entries: [fullEntry()] }],
      toolData: [{ sessionId: 's1', calls: [fullCall()] }],
    };
    const copy = JSON.parse(JSON.stringify(full));
    rehydrateDataset(copy);
    expect(copy.tokenData[0].entries[0]).toEqual(fullEntry());
    expect(copy.toolData[0].calls[0]).toEqual(fullCall());
  });

  it('slim -> JSON roundtrip -> rehydrate is value-preserving across entries and calls', () => {
    const ds = {
      generatedAt: 'T',
      tokenData: [
        {
          sessionId: 's1',
          entries: [
            fullEntry(),
            // A near-empty entry whose always-present numerics are 0. Mirrors the
            // parser, which OMITS toolResultBytes when 0, so the fixture omits it.
            fullEntry({
              inputTokens: 0,
              outputTokens: 0,
              thinkingTokens: 0,
              cacheCreationTokens: 0,
              toolUseIds: [],
              toolResultBytes: undefined,
            }),
          ],
        },
      ],
      toolData: [
        {
          sessionId: 's1',
          calls: [fullCall(), fullCall({ isError: true, resultBytes: 99 })],
        },
      ],
    };
    const before = JSON.parse(JSON.stringify(ds)); // deep snapshot of the full shape
    const wire = JSON.parse(JSON.stringify(slimDataset(ds)));
    rehydrateDataset(wire);
    expect(wire.tokenData).toEqual(before.tokenData);
    expect(wire.toolData).toEqual(before.toolData);
  });
});

describe('cost accuracy is preserved (auditable totals byte-identical)', () => {
  it('estimateEntryCost is identical before slim and after slim->rehydrate', () => {
    const entries = [
      fullEntry(),
      fullEntry({ webSearchRequests: 3, webFetchRequests: 2, cacheCreation1hTokens: 100, cacheReadTokens: 500 }),
      fullEntry({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0 }),
    ];
    const ds = { tokenData: [{ sessionId: 's1', entries }] };
    const costBefore = entries.reduce((s, e) => s + estimateEntryCost(e), 0);
    const wire = JSON.parse(JSON.stringify(slimDataset(ds)));
    rehydrateDataset(wire);
    const costAfter = (wire.tokenData[0].entries as TokenEntry[]).reduce(
      (s, e) => s + estimateEntryCost(e),
      0
    );
    expect(costAfter).toBe(costBefore);
  });
});
