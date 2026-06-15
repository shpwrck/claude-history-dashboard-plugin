// Pure dispatch helpers for the dashboard server's /api/sessions routes: validate input, derive the
// deterministic RemoteSession name, and build the CR manifest. No I/O, no node_modules — kept pure so
// it's unit-testable and stays in the zero-dep server boot graph.
//
// The naming functions here are a BYTE-FOR-BYTE mirror of src/lib/provision-naming.ts (the server
// can't import from src/). src/lib/provision-naming.test.ts asserts a shared fixture table produces
// identical output across the two copies — that drift guard is load-bearing.

export const MAX_POOL = 8;

export function parseGitHubRepo(input) {
  if (!input) return null;
  const s = String(input).trim().replace(/\.git$/i, '');
  // Host ANCHORED to github.com (rejects https://attacker.example/github.com/o/r); owner/repo must
  // start with alphanumeric/_/- so "." / ".." / "owner/.." are rejected. BYTE-IDENTICAL to
  // src/lib/provision-naming.ts (drift-guarded by src/lib/provision-naming.test.ts).
  const url = s.match(
    /^(?:https?:\/\/|git@|ssh:\/\/git@)?(?:www\.)?github\.com[/:]([A-Za-z0-9_-][A-Za-z0-9._-]*)\/([A-Za-z0-9_-][A-Za-z0-9._-]*?)\/?$/i
  );
  if (url) return { owner: url[1], repo: url[2] };
  const bare = s.match(/^([A-Za-z0-9_-][A-Za-z0-9._-]*)\/([A-Za-z0-9_-][A-Za-z0-9._-]*)$/);
  if (bare) return { owner: bare[1], repo: bare[2] };
  return null;
}

export function rfc1123Slug(s) {
  const out = String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out.slice(0, 63).replace(/-+$/g, '');
}

export function remoteSessionName(cluster, repoInput) {
  const parts = parseGitHubRepo(repoInput);
  const base = parts ? `${cluster}-${parts.owner}-${parts.repo}` : `${cluster}-${repoInput}`;
  return rfc1123Slug(base) || rfc1123Slug(cluster) || 'session';
}

export function envNameFor(cluster, repoInput) {
  const parts = parseGitHubRepo(repoInput);
  return parts ? `${cluster}/${parts.owner}/${parts.repo}` : `${cluster}/${repoInput}`;
}

// Validate + normalize a dispatch request body. Returns { ok, errors, ...normalized }.
export function validateDispatchInput(input) {
  const errors = [];
  const repo = String(input?.repo || '').trim();
  if (!repo) errors.push('repo is required');
  const parts = repo ? parseGitHubRepo(repo) : null;
  if (repo && !parts) errors.push('repo must be a github.com URL or owner/repo');

  let poolSize = input?.poolSize;
  if (poolSize === undefined || poolSize === null || poolSize === '') poolSize = 1;
  poolSize = Number(poolSize);
  if (!Number.isInteger(poolSize) || poolSize < 0 || poolSize > MAX_POOL) {
    errors.push(`poolSize must be an integer 0..${MAX_POOL}`);
  }

  const ref = String(input?.ref || '').trim();
  if (ref.length > 256) errors.push('ref too long');
  if (ref && !/^[A-Za-z0-9._\-/]+$/.test(ref)) errors.push('ref has invalid characters');

  const displayName = String(input?.displayName || '').trim();
  if (displayName.length > 128) errors.push('displayName too long');

  return { ok: errors.length === 0, errors, repo, parts, poolSize, ref, displayName };
}

// Build the RemoteSession CR manifest. cluster names the environment; the clone URL is rebuilt from
// the validated owner/repo (never the raw input), so a malformed/hostile repo string cannot reach
// the operator's clone step.
export function buildRemoteSessionManifest({ cluster, repo, ref, displayName, poolSize }) {
  const name = remoteSessionName(cluster, repo);
  const env = displayName && displayName.trim() ? displayName.trim() : envNameFor(cluster, repo);
  const parts = parseGitHubRepo(repo);
  const spec = {
    mode: 'interactive',
    poolSize: Number.isInteger(poolSize) ? poolSize : 1,
    displayName: env,
  };
  if (parts) spec.repo = `https://github.com/${parts.owner}/${parts.repo}`;
  if (ref) spec.ref = ref;
  return {
    apiVersion: 'probaitio.com/v1alpha1',
    kind: 'RemoteSession',
    metadata: { name },
    spec,
  };
}
