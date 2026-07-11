import { describe, expect, it } from 'vitest';
import {
  sampleDocNeighborhood,
  SAMPLE_DOC_GRAPH,
} from './sample-doc-neighborhood';
import { induceNeighborhoodEdges, neighborsOf } from './doc-relationship';
import { docNeighborhood } from './doc-neighborhood';

describe('sampleDocNeighborhood', () => {
  const { neighborhood, edges, isSample } = sampleDocNeighborhood();
  const bySlug = (slug: string) => neighborhood.nodes.find((n) => n.slug === slug);

  it('is flagged as a sample and seeds from AGENTS', () => {
    expect(isSample).toBe(true);
    expect(neighborhood.seeds).toEqual(['AGENTS']);
    expect(neighborhood.nodes.length).toBeGreaterThan(3);
  });

  it('exercises every hygiene class the view must render', () => {
    // Contradiction: a live convention links into the retired one.
    expect(bySlug('docs/conventions/old-branching')?.hygiene.contradictory).toBe(true);
    // Staleness by git mtime: the legacy plan predates the horizon -> demoted.
    expect(bySlug('docs/plans/legacy-roadmap')?.hygiene.stale).toBe(true);
    // Dangling link: worktrees links to a non-node.
    expect(
      bySlug('docs/conventions/worktrees')?.hygiene.danglingLinks
    ).toContain('docs/conventions/does-not-exist');
    // Graceful supersession: the retired ADR redirects to its retained
    // replacement, so it is NOT demoted as stale.
    expect(bySlug('docs/adr/0005-free-path')?.hygiene.stale).toBe(false);
  });

  it('trips the #1934 ambiguity trigger with the flagged nodes as sources', () => {
    expect(neighborhood.ambiguityTrigger).toBe(true);
    expect(neighborhood.ambiguitySources).toEqual(
      expect.arrayContaining([
        'docs/conventions/old-branching',
        'docs/plans/legacy-roadmap',
      ])
    );
  });

  it('induces only intra-cluster md-link edges', () => {
    // The dangling target is not a node, so no edge to it survives.
    for (const edge of edges) {
      expect(edge.to).not.toBe('docs/conventions/does-not-exist');
    }
    // The seed links out to the governance ADR.
    expect(edges).toContainEqual({
      from: 'AGENTS',
      to: 'docs/adr/0008-server-llm-governance',
    });
  });
});

describe('induceNeighborhoodEdges / neighborsOf', () => {
  it('returns [] for an empty neighborhood', () => {
    const empty = docNeighborhood(SAMPLE_DOC_GRAPH, { kind: 'doc', slug: 'nope' });
    expect(induceNeighborhoodEdges(SAMPLE_DOC_GRAPH, empty)).toEqual([]);
  });

  it('partitions a node into its outbound links and inbound backlinks', () => {
    const { neighborhood, edges } = sampleDocNeighborhood();
    expect(neighborhood.nodes.some((n) => n.slug === 'docs/conventions/worktrees')).toBe(true);
    const nb = neighborsOf(edges, 'docs/conventions/worktrees');
    // worktrees links out to old-branching, and old-branching backlinks in.
    expect(nb.outbound).toContain('docs/conventions/old-branching');
    expect(nb.inbound).toEqual(
      expect.arrayContaining(['AGENTS', 'docs/conventions/old-branching'])
    );
  });
});
