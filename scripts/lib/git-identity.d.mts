export const FULL_GIT_HEAD_RE: RegExp;
export const GIT_COMMIT_PREFIX_RE: RegExp;

export function isFullGitHead(value: unknown): value is string;
export function isGitCommitPrefix(value: unknown): value is string;
