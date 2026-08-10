/**
 * Pure Git identity predicates shared by host producers and artifact consumers.
 *
 * A live HEAD probe must return a complete object id: exactly 40 hex digits
 * for SHA-1 repositories or 64 for SHA-256 repositories. Historical hygiene
 * artifacts predate that rule and may contain an abbreviated commit; that
 * compatibility predicate is deliberately separate and must never validate a
 * live HEAD probe.
 */
export const FULL_GIT_HEAD_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
export const GIT_COMMIT_PREFIX_RE = /^[0-9a-f]{7,64}$/i;

export function isFullGitHead(value) {
  return typeof value === 'string' && FULL_GIT_HEAD_RE.test(value);
}

export function isGitCommitPrefix(value) {
  return typeof value === 'string' && GIT_COMMIT_PREFIX_RE.test(value);
}
