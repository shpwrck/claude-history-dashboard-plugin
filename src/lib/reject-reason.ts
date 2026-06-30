/**
 * The recommendation reject-reason vocabulary (#1294, epic #1298).
 *
 * Kept in its own node-free module so BOTH the browser UI (RejectControl) and the
 * node-only persistence lib (`reject-signals.ts`, which imports `node:fs`) can
 * share one source of truth without the component pulling node builtins into the
 * client bundle. `reject-signals.ts` re-exports these for server-side callers.
 */

/** The reason a recommendation was rejected. The enum the UI offers. */
export const REJECT_REASONS = ['dismiss', 'wrong', 'not-relevant'] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** Human-facing button labels for each reason. */
export const REJECT_REASON_LABEL: Record<RejectReason, string> = {
  dismiss: 'Dismiss',
  wrong: "It's wrong",
  'not-relevant': 'Not relevant',
};
