export function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError('timing samples must be a non-empty array');
  }
  if (values.some((value) => !Number.isFinite(value))) {
    throw new TypeError('timing samples must contain only finite numbers');
  }
  // perf-index-contract: cold-load-median-order always-consumed: every median call immediately reads the sorted samples to return its statistic
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function timingStats(values) {
  const measuredMedian = median(values);
  return {
    runs: values.map(Math.round),
    // Keep gate inputs at measurement precision. Formatting rounds for humans,
    // but 700.4 ms must not pass a 700 ms ceiling merely because it prints as
    // 700 ms.
    median: measuredMedian,
    best: Math.min(...values),
  };
}
