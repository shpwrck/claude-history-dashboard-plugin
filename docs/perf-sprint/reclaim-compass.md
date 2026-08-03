# Reclaim Compass workload budgets

These deterministic probes protect the Reclaim Compass derivation path against
work and retained-memory regressions. They use synthetic local data only and do
not introduce a server or network dependency.

## Weekly trendline

`src/lib/reclaim-trendline.test.ts` exercises a representative 52-week window
with 20 independently scoped claims per week: 1,040 token scopes and 1,040
claims total.

- Latency budget: less than 750 ms in the Vitest CI process.
- Claim-allocation budget: at most 1,040 narrowed weekly claim inputs, one per
  applicable scope in this fixture.
- Claim-index build budget: one lazy build for a dated window, and zero builds
  when no dated week can query the index.
- Exhaustive-work guard: the probe records the prior 54,080-input upper bound
  (`52 weeks * 1,040 claims`) and fails unless the indexed path stays at 1,040.

The latency ceiling is deliberately wider than the expected runtime; the
deterministic claim-input count is the primary complexity gate. The window-wide
cascade still sees every claim once so gauge, marginal, and rejection outputs
remain authoritative.

## Re-pasted content deduplication

`src/lib/detectors/context/reclaim-potential.test.ts` streams 128 unique pasted
blocks of 32 KiB each through the production aggregation path (slightly over
4 MiB of normalized content).

- Latency budget: less than 750 ms in the Vitest CI process.
- Retained-metadata budget: at most 250 UTF-16 code units per unique block,
  including the digest+length Map key, independent collision discriminator,
  bounded prefix/suffix samples, and the displayed 40-character preview.
- Collision guard: two pinned equal-length FNV-1a-colliding blocks must remain
  distinct duplicate groups and retain reproducible previews.

The source session corpus still owns the original paste strings. The detector
adds no second normalized copy: normalization is streamed into portable 32-bit
digests, and only bounded metadata survives in the aggregation Map.
