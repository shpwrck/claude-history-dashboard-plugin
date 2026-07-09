// Leaf module: the cwd-path <-> `~/.claude/projects/<slug>` join used by the
// memories project filter. Kept dependency-free so the eager view-registry
// (first-paint shell, frozen budget per ADR 0016) can import the join without
// pulling the parse-memories graph into the entry chunk.

/**
 * Convert a project cwd path to the `~/.claude/projects/<slug>` directory name.
 *
 * Claude Code derives the slug by replacing every non-alphanumeric character in
 * the absolute cwd with `-`, so `/home/dev/acme-web` becomes
 * `-home-dev-acme-web`. `ProjectMemories.project` is that on-disk slug, whereas
 * the dashboard's project filter/picker keys on the cwd path, so callers that
 * need to join the two must slug the path first.
 *
 * NOTE: the mapping is one-way and lossy — `/home/dev/acme-web`,
 * `/home/dev/acme.web`, and `/home/dev/acme/web` all slug identically. Forward
 * slugging (path → slug) is deterministic and safe for an equality join; do not
 * attempt to reverse a slug back into a path.
 */
export function projectPathToSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Does a project's memory group belong to the given cwd path? Matches the
 * on-disk slug (`ProjectMemories.project`) against the forward-slugged path.
 * When `project` is not itself a well-formed slug (e.g. already a path, or
 * empty), we keep the memory rather than drop it — a false keep is a strictly
 * safer failure than emptying the view (adversarial-review guidance on #2426).
 */
export function memoriesMatchProject(project: string, cwdPath: string): boolean {
  if (project === projectPathToSlug(cwdPath)) return true;
  // Defensive: if the stored group key is not a canonical slug, don't silently
  // drop it on an uncertain compare.
  return project !== projectPathToSlug(project);
}
