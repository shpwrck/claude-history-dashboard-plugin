/**
 * Warm the lazy `Recommendations` chunk once data is ready so the first
 * navigation to that view is instant.
 *
 * Skipped under Vitest (`import.meta.env.MODE === 'test'`, compile-time so it is
 * dead-code-eliminated from every real build). A fire-and-forget dynamic import
 * left in flight past the test environment's teardown throws
 * `EnvironmentTeardownError: Cannot load '…' after the environment was torn down`
 * (#2390): the `Recommendations` chunk pulls in `coverage.ts`, whose own static
 * imports (`domain-registry`, `parse-runtime-events`) are still-unresolved async
 * fetches at exactly the teardown boundary. Removing the `digest.ts` edge only
 * renamed the module the flake surfaced under; gating the prefetch removes the
 * race itself. The prefetch is a pure perf warm-up, so skipping it under test is
 * behavior-neutral.
 *
 * Returns the kicked-off promises so a caller (or a teardown hook) can await
 * them; the array is empty under test.
 */
export function warmLazyChunks(): Promise<unknown>[] {
  if (import.meta.env.MODE === 'test') return [];
  return [import('../components/Recommendations')];
}
