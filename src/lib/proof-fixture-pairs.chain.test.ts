// Multi-session chain schema/loader coverage (#2082). Synthetic inputs only —
// not coupled to the committed manifest (which gains chains when the 12 fixtures
// are converted). Guards the chain parse, the "present-but-malformed -> reject"
// rule, the chainSteps fallback, and the multi-session bundle validation.
import { describe, it, expect } from 'vitest';
import {
  parseProofPair,
  parseProofPairBundle,
  validateProofPairBundle,
  chainSteps,
  PRE_REGISTERED_SESSIONS_PER_CHAIN,
  type ProofFixturePair,
} from './proof-fixture-pairs';

const baseRaw = (over: Record<string, unknown> = {}) => ({
  pairId: 'stable-api-chain-demo',
  title: 'Demo chain pair',
  taskShape: 'implement-feature',
  wasteReason: 'stable-api',
  instruction: 'Work across sessions against the shared metrics API.',
  tree: 'pairs/stable-api-chain-demo/tree',
  stableFiles: [{ path: 'src/metrics.mjs', symbols: ['toPerSecond', 'clampRate'] }],
  injectedRecommendation:
    '## Stable reference files\n\nReference these stable files instead of re-reading them each session:\n- @src/metrics.mjs — toPerSecond, clampRate',
  gate: { kind: 'test', command: 'node --test test.mjs', expectExitCode: 0 },
  tags: ['implement-feature', 'stable-api'],
  ...over,
});

const chainOf = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ instruction: `Session ${i + 1}: add feature ${i + 1} using the metrics API.` }));

describe('multi-session chain schema (#2082)', () => {
  it('parses a valid chain and exposes it', () => {
    const pair = parseProofPair(baseRaw({ chain: chainOf(8) })) as ProofFixturePair;
    expect(pair).not.toBeNull();
    expect(pair.chain).toHaveLength(8);
    expect(chainSteps(pair)).toHaveLength(8);
    expect(chainSteps(pair)[0]).toMatch(/Session 1:/);
  });

  it('falls back to the single instruction when no chain is present', () => {
    const pair = parseProofPair(baseRaw()) as ProofFixturePair;
    expect(pair.chain).toBeUndefined();
    expect(chainSteps(pair)).toEqual([baseRaw().instruction]);
  });

  it('REJECTS a pair whose chain key is present but malformed (no silent degrade)', () => {
    expect(parseProofPair(baseRaw({ chain: [] }))).toBeNull(); // too short
    expect(parseProofPair(baseRaw({ chain: [{ instruction: '' }, { instruction: 'ok' }] }))).toBeNull();
    expect(parseProofPair(baseRaw({ chain: 'not-an-array' }))).toBeNull();
    expect(parseProofPair(baseRaw({ chain: [{ nope: 1 }, { nope: 2 }] }))).toBeNull();
  });

  it('rejects a chain longer than the sanity cap', () => {
    expect(parseProofPair(baseRaw({ chain: chainOf(13) }))).toBeNull();
  });

  it('multi-session bundle validation requires every pair at exactly sessionsPerChain', () => {
    const good = {
      bundle: 'b',
      preRegistrationRef: 'docs/v0.4-proof-preregistration.md',
      detectorRef: 'src/lib/detectors/context/repo-map-context-waste.ts',
      minDecidedPairs: 1,
      sessionsPerChain: PRE_REGISTERED_SESSIONS_PER_CHAIN,
      pairs: [
        baseRaw({ pairId: 'p-a', chain: chainOf(8) }),
        baseRaw({ pairId: 'p-b', wasteReason: 'config-backed', chain: chainOf(8) }),
        baseRaw({ pairId: 'p-c', wasteReason: 'high-centrality', chain: chainOf(8) }),
      ],
    };
    const okBundle = parseProofPairBundle(good)!;
    expect(okBundle.sessionsPerChain).toBe(8);
    // Force the min-pairs floor down is not allowed (PRE_REGISTERED_MIN_PAIRS=12),
    // so this asserts only the chain-length rule, not N.
    const chainErr = validateProofPairBundle(okBundle).errors.filter((e) => /step chain/.test(e));
    expect(chainErr).toHaveLength(0);

    const bad = parseProofPairBundle({ ...good, pairs: [...good.pairs, baseRaw({ pairId: 'p-d', chain: chainOf(5) })] })!;
    const badErr = validateProofPairBundle(bad).errors.filter((e) => /p-d.*5-step chain/.test(e));
    expect(badErr).toHaveLength(1);
  });
});
