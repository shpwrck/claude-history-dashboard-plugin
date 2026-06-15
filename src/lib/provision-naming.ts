// Pure naming for Probaitio session provisioning. Shared by the provisioning card (name/label
// preview) and mirrored BYTE-FOR-BYTE by scripts/lib/remotesession-dispatch.mjs, which is the
// authority that writes the real RemoteSession metadata.name (the server stays in the zero-dep boot
// graph and cannot import from src/). A vitest fixture table guards the two copies against drift.

export interface RepoParts {
  owner: string;
  repo: string;
}

// Accept a github.com URL (https/ssh) or a bare owner/repo. The host is ANCHORED to github.com (an
// arbitrary host that merely contains the substring "github.com" in its path, e.g.
// https://attacker.example/github.com/o/r, is rejected) — that anchor is the allowlist. owner/repo
// must START with an alphanumeric/_/- (never a dot), so "." / ".." / "owner/.." are rejected, and
// the [A-Za-z0-9._-] class keeps the rebuilt clone URL injection-safe. null for anything else.
export function parseGitHubRepo(input: string): RepoParts | null {
  if (!input) return null;
  const s = input.trim().replace(/\.git$/i, '');
  const url = s.match(
    /^(?:https?:\/\/|git@|ssh:\/\/git@)?(?:www\.)?github\.com[/:]([A-Za-z0-9_-][A-Za-z0-9._-]*)\/([A-Za-z0-9_-][A-Za-z0-9._-]*?)\/?$/i
  );
  if (url) return { owner: url[1], repo: url[2] };
  const bare = s.match(/^([A-Za-z0-9_-][A-Za-z0-9._-]*)\/([A-Za-z0-9_-][A-Za-z0-9._-]*)$/);
  if (bare) return { owner: bare[1], repo: bare[2] };
  return null;
}

// RFC1123 label: lowercase alphanumeric and '-', no leading/trailing '-', <= 63 chars.
export function rfc1123Slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out.slice(0, 63).replace(/-+$/g, '');
}

// Deterministic RemoteSession metadata.name: <cluster>-<owner>-<repo>, slugged. Deterministic so a
// re-provision of the same repo is idempotent (the operator keeps the existing pool; a duplicate
// create returns 409 AlreadyExists, surfaced as "already provisioned").
export function remoteSessionName(cluster: string, repoInput: string): string {
  const parts = parseGitHubRepo(repoInput);
  const base = parts ? `${cluster}-${parts.owner}-${parts.repo}` : `${cluster}-${repoInput}`;
  return rfc1123Slug(base) || rfc1123Slug(cluster) || 'session';
}

// Human-readable environment label shown in claude.ai/code: <cluster>/<owner>/<repo>.
export function envNameFor(cluster: string, repoInput: string): string {
  const parts = parseGitHubRepo(repoInput);
  return parts ? `${cluster}/${parts.owner}/${parts.repo}` : `${cluster}/${repoInput}`;
}
