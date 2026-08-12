import { describe, expect, it } from 'vitest';

import { warmLazyChunks } from './prefetch';

describe('warmLazyChunks', () => {
  // Regression guard for #2390: under Vitest the prefetch must be a no-op so no
  // dynamic import (which reaches coverage.ts -> domain-registry/parse-runtime-events)
  // is left resolving past environment teardown. If the `MODE === 'test'` guard is
  // dropped, warmLazyChunks returns in-flight promises and these assertions fail.
  it('kicks off no lazy imports under Vitest', () => {
    expect(warmLazyChunks()).toEqual([]);
  });

  it('runs under the test MODE the guard keys off, so the no-op is exercised for real', () => {
    expect(import.meta.env.MODE).toBe('test');
  });
});
