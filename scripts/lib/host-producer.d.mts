export interface ResolveExpectedCommitOptions {
  env?: Record<string, string | undefined>;
  fallbackEnvNames?: readonly string[];
  fallback?: string | null;
}

export {
  FULL_GIT_HEAD_RE,
  GIT_COMMIT_PREFIX_RE,
  isFullGitHead,
  isGitCommitPrefix,
} from './git-identity.mjs';

export function resolveExpectedCommit(
  primaryEnvName: string,
  options?: ResolveExpectedCommitOptions
): string | null;
