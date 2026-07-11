/**
 * sample-doc-neighborhood.ts — a small, self-contained sample doc-graph and the
 * neighborhood computed from it, so the human relationship view (#2323) and the
 * checkpoint surface render meaningful content on the marketing/SPA sample build
 * (no `~/.claude` mount, no server) and in tests.
 *
 * This is NOT hand-faked node state: it runs the REAL {@link docNeighborhood}
 * retrieval (#2263) over a hand-built {@link DocGraph}, so every ranking,
 * distance, and hygiene flag the view shows is produced by the same code path a
 * live neighborhood would use. The graph deliberately exercises the hygiene
 * classes the view must render:
 *   - a **contradiction** (a live convention still links into a retired one);
 *   - a **staleness** flag (a plan doc older than the staleness horizon,
 *     demoted "as of <date>");
 *   - a **graceful supersession** (a retired ADR that redirects to its live
 *     replacement — retired but NOT demoted);
 *   - a **dangling link** (a convention links to a doc that is not a node).
 *
 * PURE + browser-safe: imports only the browser-safe retrieval + types. The
 * host-only `buildDocGraph` (node:fs) is never imported here — the graph is a
 * literal.
 */
import type { DocGraph, DocNode } from './parse-docs';
import {
  docNeighborhood,
  type DocNeighborhood,
  type NeighborhoodAnchor,
} from './doc-neighborhood';
import {
  induceNeighborhoodEdges,
  type DocNeighborhoodEdge,
} from './doc-relationship';

function node(
  slug: string,
  category: DocNode['category'],
  gitMtimeIso: string,
  frontmatter: Record<string, string> = {},
  extra: Partial<DocNode> = {}
): DocNode {
  return {
    slug,
    path: `${slug}.md`,
    category,
    frontmatter,
    headings: [],
    gitMtimeIso,
    ...extra,
  };
}

/** The hand-built sample doc graph the sample neighborhood is retrieved from. */
export const SAMPLE_DOC_GRAPH: DocGraph = {
  nodes: [
    node('AGENTS', 'root', '2026-06-01T00:00:00Z', { status: 'active' }),
    node('docs/adr/0008-server-llm-governance', 'adr', '2026-05-01T00:00:00Z', {
      status: 'accepted',
    }, { indexKind: 'adr-sequence', ordinal: 8 }),
    // Recent mtime (inside the staleness horizon) so its ONLY signal is the
    // retired status — which resolves via graceful supersession, so it is NOT
    // demoted as stale.
    node('docs/adr/0005-free-path', 'adr', '2026-06-15T00:00:00Z', {
      status: 'superseded',
    }, { indexKind: 'adr-sequence', ordinal: 5 }),
    node('docs/conventions/worktrees', 'doc', '2026-06-10T00:00:00Z', {
      status: 'current',
    }),
    node('docs/conventions/old-branching', 'doc', '2025-01-01T00:00:00Z', {
      status: 'superseded',
    }),
    // Old plan doc — no retired status, but its git mtime predates the staleness
    // horizon, so it flags stale under an explicit `now` (demoted "as of …").
    node('docs/plans/legacy-roadmap', 'plan', '2024-01-01T00:00:00Z', {
      status: 'draft',
    }),
  ],
  edges: [
    { from: 'AGENTS', to: 'docs/adr/0008-server-llm-governance', kind: 'md-link' },
    { from: 'AGENTS', to: 'docs/conventions/worktrees', kind: 'md-link' },
    { from: 'AGENTS', to: 'docs/plans/legacy-roadmap', kind: 'md-link' },
    // Live convention still links INTO the retired one -> contradiction.
    { from: 'docs/conventions/worktrees', to: 'docs/conventions/old-branching', kind: 'md-link' },
    // Backlink the other way (retired -> live) makes the two-way conflict clear.
    { from: 'docs/conventions/old-branching', to: 'docs/conventions/worktrees', kind: 'md-link' },
    // A broken link: the target is not a node -> dangling hygiene flag.
    { from: 'docs/conventions/worktrees', to: 'docs/conventions/does-not-exist', kind: 'md-link' },
    // Retired ADR that gracefully redirects to its live replacement (retained in
    // the cluster) -> retired but NOT stale.
    { from: 'docs/adr/0005-free-path', to: 'docs/adr/0008-server-llm-governance', kind: 'md-link' },
  ],
};

/** The anchor the sample neighborhood is seeded from (the root conventions doc). */
export const SAMPLE_ANCHOR: NeighborhoodAnchor = { kind: 'doc', slug: 'AGENTS' };

/**
 * A fixed "now" for the sample so mtime staleness is deterministic across
 * environments (the retrieval itself reads no clock; the caller supplies time).
 */
export const SAMPLE_NOW_ISO = '2026-07-11T00:00:00Z';

/** The sample neighborhood + the induced link/backlink edges the view draws. */
export interface SampleDocNeighborhood {
  neighborhood: DocNeighborhood;
  edges: DocNeighborhoodEdge[];
  /** True so the view can label this a preview, not the user's real docs. */
  isSample: true;
}

/**
 * Compute the sample neighborhood from {@link SAMPLE_DOC_GRAPH} via the real
 * {@link docNeighborhood} retrieval, plus its induced edges. Deterministic.
 */
export function sampleDocNeighborhood(): SampleDocNeighborhood {
  const neighborhood = docNeighborhood(SAMPLE_DOC_GRAPH, SAMPLE_ANCHOR, {
    now: SAMPLE_NOW_ISO,
  });
  const edges = induceNeighborhoodEdges(SAMPLE_DOC_GRAPH, neighborhood);
  return { neighborhood, edges, isSample: true };
}
