/**
 * Normalize only filesystem identities that are proven Windows paths.
 *
 * Drive roots and raw UNC paths are case-insensitive and accept either path
 * separator. Forward-slash `//...` paths are deliberately not treated as UNC:
 * on POSIX they remain case-sensitive identities.
 */
export function windowsProjectIdentityKey(project: string): string | null {
  const drive = /^[A-Za-z]:[\\/]/.test(project);
  const unc = /^\\\\(?![\\/])/.test(project);
  if (!drive && !unc) return null;
  const slashes = project.replace(/\\/g, '/');
  const collapsed = unc
    ? `//${slashes.replace(/^\/+/, '').replace(/\/{2,}/g, '/')}`
    : slashes.replace(/\/{2,}/g, '/');
  const rootLength = unc ? 2 : /^[A-Za-z]:\//.test(collapsed) ? 3 : 0;
  const prefix = collapsed.slice(0, rootLength);
  const tail = collapsed
    .slice(rootLength)
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
  const normalized = tail ? `${prefix}${tail}` : prefix;
  return `windows:${normalized.toLowerCase()}`;
}

/** Collapse only redundant separators and `.` segments in a relative POSIX
 * spelling. Literal backslashes, case, and `..` segments remain untouched. */
export function normalizePosixRelativePath(path: string): string | null {
  if (path.startsWith('/')) return null;
  return path
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
}

/**
 * Normalize a proven absolute POSIX path without treating backslashes as
 * separators. Exactly two leading slashes remain a distinct implementation-
 * defined root; three or more collapse to the ordinary `/` root.
 */
export function normalizePosixAbsolutePath(path: string): string | null {
  if (!path.startsWith('/')) return null;
  const doubleRoot = path.startsWith('//') && !path.startsWith('///');
  const root = doubleRoot ? '//' : '/';
  const tail = path
    .replace(/^\/+/, '')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
  const normalized = `${root}${tail}`;
  return normalized === root ? root : normalized.replace(/\/+$/, '');
}

/** Stable key for every proven absolute project identity. */
export function projectIdentityKey(project: string): string | null {
  const windows = windowsProjectIdentityKey(project);
  if (windows) return windows;
  const posix = normalizePosixAbsolutePath(project);
  return posix == null ? null : `posix:${posix}`;
}

/** Resolve one project per session across local artifact sources. Invalid
 * spellings do not mask a valid fallback, while two distinct valid identities
 * fail the session closed. The first spelling for an identity is retained for
 * human-facing output so every consumer applies the same arbitration contract. */
export function resolveProjectBySession(
  observations: Iterable<{
    sessionId?: string | null;
    project?: string | null;
  }>
): Map<string, string> {
  const identitiesBySession = new Map<string, Map<string, string>>();
  for (const { sessionId, project } of observations) {
    if (!sessionId || !project) continue;
    const identity = projectIdentityKey(project);
    if (!identity) continue;
    const identities =
      identitiesBySession.get(sessionId) ?? new Map<string, string>();
    if (!identities.has(identity)) identities.set(identity, project);
    identitiesBySession.set(sessionId, identities);
  }

  const displayByIdentity = new Map<string, string>();
  const resolved = new Map<string, string>();
  for (const [sessionId, identities] of identitiesBySession) {
    if (identities.size !== 1) continue;
    const [[identity, project]] = identities;
    const display = displayByIdentity.get(identity) ?? project;
    displayByIdentity.set(identity, display);
    resolved.set(sessionId, display);
  }
  return resolved;
}

/** Compare project identities without folding POSIX case or backslashes. */
export function sameProjectIdentity(left: string, right: string): boolean {
  const leftIdentity = projectIdentityKey(left);
  const rightIdentity = projectIdentityKey(right);
  return leftIdentity != null && rightIdentity != null
    ? leftIdentity === rightIdentity
    : left === right;
}
