/**
 * doc-neighborhood.test.ts — vitest tests for the pure doc-neighborhood
 * retrieval helper (#2263, epic #2262).
 *
 * The helper is a pure function of an already-built {@link DocGraph}, so every
 * fixture is a hand-built graph literal — no filesystem, no `buildDocGraph`.
 *
 * Covers the issue's acceptance bullets:
 *  - cluster bounds: a distance-N bound includes N-hop nodes and excludes N+1;
 *  - ranking: higher centrality / recency / declared-status ranks first;
 *  - hygiene: a dangling / stale / contradictory node surfaces its flag, and the
 *    neighborhood exposes the #1934 ambiguity trigger iff a contradiction/
 *    staleness flag is present;
 *  - empty / unknown-anchor / empty-graph -> empty result;
 *  - anchor resolution across doc slug, issue number, and changed file path.
 */
import { describe, expect, it } from 'vitest';
import type { DocEdge, DocGraph, DocNode } from './parse-docs';
import {
  docNeighborhood,
  type NeighborhoodAnchor,
} from './doc-neighborhood';

// ── Fixture builders ────────────────────────────────────────────────────────────

function node(slug: string, extra: Partial<DocNode> = {}): DocNode {
  return {
    slug,
    path: `${slug}.md`,
    category: 'doc',
    frontmatter: {},
    headings: [],
    gitMtimeIso: null,
    ...extra,
  };
}
const md = (from: string, to: string): DocEdge => ({ from, to, kind: 'md-link' });
const issue = (from: string, n: number): DocEdge => ({
  from,
  to: `issue:${n}`,
  kind: 'issue-ref',
});
const src = (from: string, p: string): DocEdge => ({
  from,
  to: `src:${p}`,
  kind: 'src-ref',
});
const graph = (nodes: DocNode[], edges: DocEdge[]): DocGraph => ({
  root: '/repo',
  nodes,
  edges,
});

const slugs = (r: { nodes: { slug: string }[] }): string[] =>
  r.nodes.map((n) => n.slug).sort();
const order = (r: { nodes: { slug: string }[] }, s: string): number =>
  r.nodes.findIndex((n) => n.slug === s);
const docAnchor = (slug: string): NeighborhoodAnchor => ({ kind: 'doc', slug });

// ── Cluster bounds ──────────────────────────────────────────────────────────────

describe('cluster bounds (distance)', () => {
  // S -> A -> B -> C, treated undirected during expansion.
  const g = graph(
    [node('S'), node('A'), node('B'), node('C')],
    [md('S', 'A'), md('A', 'B'), md('B', 'C')]
  );

  it('includes N-hop nodes and excludes N+1 at maxDistance=2', () => {
    const r = docNeighborhood(g, docAnchor('S'), { maxDistance: 2 });
    expect(slugs(r)).toEqual(['A', 'B', 'S']);
    expect(r.nodes.some((n) => n.slug === 'C')).toBe(false);
    // Distances are the hop count from the seed.
    const byslug = new Map(r.nodes.map((n) => [n.slug, n.distance]));
    expect(byslug.get('S')).toBe(0);
    expect(byslug.get('A')).toBe(1);
    expect(byslug.get('B')).toBe(2);
  });

  it('tightens to 1 hop at maxDistance=1', () => {
    const r = docNeighborhood(g, docAnchor('S'), { maxDistance: 1 });
    expect(slugs(r)).toEqual(['A', 'S']);
  });

  it('returns seeds only at maxDistance=0', () => {
    const r = docNeighborhood(g, docAnchor('S'), { maxDistance: 0 });
    expect(slugs(r)).toEqual(['S']);
    expect(r.seeds).toEqual(['S']);
  });

  it('expands via backlinks too (anchor on the leaf reaches its parent)', () => {
    const r = docNeighborhood(g, docAnchor('C'), { maxDistance: 1 });
    expect(slugs(r)).toEqual(['B', 'C']);
  });
});

// ── Ranking ─────────────────────────────────────────────────────────────────────

describe('ranking', () => {
  it('ranks higher centrality first (others equal)', () => {
    // S links to A and B (dist 1); A is more connected (also links X, Y).
    const g = graph(
      [node('S'), node('A'), node('B'), node('X'), node('Y')],
      [md('S', 'A'), md('S', 'B'), md('A', 'X'), md('A', 'Y')]
    );
    const r = docNeighborhood(g, docAnchor('S'), { maxDistance: 1 });
    expect(order(r, 'A')).toBeLessThan(order(r, 'B'));
  });

  it('ranks more-recent first (others equal)', () => {
    const g = graph(
      [
        node('S'),
        node('A', { gitMtimeIso: '2026-06-01T00:00:00.000Z' }),
        node('B', { gitMtimeIso: '2020-01-01T00:00:00.000Z' }),
      ],
      [md('S', 'A'), md('S', 'B')]
    );
    const r = docNeighborhood(g, docAnchor('S'), { maxDistance: 1 });
    expect(order(r, 'A')).toBeLessThan(order(r, 'B'));
  });

  it('ranks a more-authoritative declared status first (others equal)', () => {
    const mtime = '2026-01-01T00:00:00.000Z';
    const g = graph(
      [
        node('S'),
        node('A', { gitMtimeIso: mtime, frontmatter: { status: 'accepted' } }),
        node('B', { gitMtimeIso: mtime, frontmatter: { status: 'proposed' } }),
      ],
      [md('S', 'A'), md('S', 'B')]
    );
    const r = docNeighborhood(g, docAnchor('S'), { maxDistance: 1 });
    expect(order(r, 'A')).toBeLessThan(order(r, 'B'));
  });

  it('honours configurable weights (zeroing status flips the status test)', () => {
    const mtime = '2026-01-01T00:00:00.000Z';
    const g = graph(
      // A: accepted but poorly connected; B: proposed but a hub (links X,Y,Z).
      [
        node('S'),
        node('A', { gitMtimeIso: mtime, frontmatter: { status: 'accepted' } }),
        node('B', { gitMtimeIso: mtime, frontmatter: { status: 'proposed' } }),
        node('X'),
        node('Y'),
        node('Z'),
      ],
      [md('S', 'A'), md('S', 'B'), md('B', 'X'), md('B', 'Y'), md('B', 'Z')]
    );
    // With status weight zeroed and centrality dominant, the hub B wins.
    const r = docNeighborhood(g, docAnchor('S'), {
      maxDistance: 1,
      weights: { status: 0, centrality: 10, recency: 0, proximity: 0 },
    });
    expect(order(r, 'B')).toBeLessThan(order(r, 'A'));
  });

  it('caps the result to maxNodes, keeping the highest-ranked', () => {
    const g = graph(
      [node('S'), node('A'), node('B'), node('C')],
      [md('S', 'A'), md('S', 'B'), md('S', 'C')]
    );
    const r = docNeighborhood(g, docAnchor('S'), { maxDistance: 1, maxNodes: 1 });
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0].slug).toBe('S'); // the seed outranks its 1-hop peers
  });

  it('retains a flagged ambiguity source past the maxNodes cap (the #2388 fix)', () => {
    // R (superseded, live-reachable from S) ranks last but is an ambiguity
    // source; a healthy peer B is cut by the cap while R is retained so every
    // ambiguitySources slug stays inspectable in `nodes`.
    const g = graph(
      [
        node('S'),
        node('A', { frontmatter: { status: 'accepted' } }),
        node('B', { frontmatter: { status: 'accepted' } }),
        node('R', { frontmatter: { status: 'superseded' } }),
      ],
      [md('S', 'A'), md('S', 'B'), md('S', 'R')]
    );
    const r = docNeighborhood(g, docAnchor('S'), { maxDistance: 1, maxNodes: 2 });
    const kept = r.nodes.map((n) => n.slug);
    expect(kept).toContain('R'); // flagged source retained despite the cap
    expect(kept).not.toContain('B'); // healthy low-ranked peer dropped by the cap
    expect(r.ambiguitySources).toEqual(['R']);
    expect(r.ambiguityTrigger).toBe(true);
    // Every ambiguity source is present in the returned nodes.
    for (const s of r.ambiguitySources) {
      expect(r.nodes.some((n) => n.slug === s)).toBe(true);
    }
  });

  it('retains a low-ranked anchor seed past the maxNodes cap (the #2388 fix)', () => {
    // `oldSeed` (superseded) anchors the neighborhood but points at a fresher,
    // better-connected `fresh` that outranks it — so with maxNodes:1 the seed
    // falls below the cut. It must still be retained as the anchoring doc.
    const g = graph(
      [
        node('oldSeed', { frontmatter: { status: 'superseded' } }),
        node('fresh', { frontmatter: { status: 'accepted' } }),
        node('P'),
        node('Q'),
      ],
      [md('oldSeed', 'fresh'), md('fresh', 'P'), md('fresh', 'Q')]
    );
    const r = docNeighborhood(g, docAnchor('oldSeed'), { maxDistance: 1, maxNodes: 1 });
    // `fresh` outranks the seed and takes the single cap slot…
    expect(r.nodes[0].slug).toBe('fresh');
    // …yet the anchoring seed is still present in the payload.
    expect(r.seeds).toEqual(['oldSeed']);
    expect(r.nodes.some((n) => n.slug === 'oldSeed')).toBe(true);
    // The seed here is gracefully superseded (fresh is retained), so it is not an
    // ambiguity source — its retention is purely the seed rule, not the flag rule.
    expect(r.ambiguitySources).toEqual([]);
  });
});

// ── Hygiene + ambiguity trigger ─────────────────────────────────────────────────

describe('hygiene flags', () => {
  it('surfaces a dangling link and does NOT trip the ambiguity trigger', () => {
    const g = graph([node('A')], [md('A', 'docs/missing')]);
    const r = docNeighborhood(g, docAnchor('A'));
    const a = r.nodes.find((n) => n.slug === 'A')!;
    expect(a.hygiene.danglingLinks).toEqual(['docs/missing']);
    expect(a.hygiene.stale).toBe(false);
    expect(a.hygiene.contradictory).toBe(false);
    expect(r.ambiguityTrigger).toBe(false);
  });

  it('flags a retired node stale + contradictory and trips the trigger', () => {
    // Live S still links to superseded B -> conflict of authority.
    const g = graph(
      [node('S', { frontmatter: { status: 'accepted' } }), node('B', { frontmatter: { status: 'superseded' } })],
      [md('S', 'B')]
    );
    const r = docNeighborhood(g, docAnchor('S'), { maxDistance: 1 });
    const b = r.nodes.find((n) => n.slug === 'B')!;
    expect(b.hygiene.stale).toBe(true);
    expect(b.hygiene.contradictory).toBe(true);
    expect(b.hygiene.declaredStatus).toBe('superseded');
    expect(r.ambiguityTrigger).toBe(true);
    expect(r.ambiguitySources).toEqual(['B']);
  });

  it('flags stale (not contradictory) when only retired docs reference it', () => {
    // Two retired docs pointing at each other: stale, but no live conflict.
    const g = graph(
      [
        node('S', { frontmatter: { status: 'deprecated' } }),
        node('B', { frontmatter: { status: 'superseded' } }),
      ],
      [md('S', 'B')]
    );
    const r = docNeighborhood(g, docAnchor('S'), { maxDistance: 1 });
    const b = r.nodes.find((n) => n.slug === 'B')!;
    expect(b.hygiene.stale).toBe(true);
    expect(b.hygiene.contradictory).toBe(false);
    // Still a staleness signal -> trigger fires.
    expect(r.ambiguityTrigger).toBe(true);
  });

  it('flags stale by absolute mtime when a `now` is supplied', () => {
    const g = graph(
      [node('A', { gitMtimeIso: '2020-01-01T00:00:00.000Z' })],
      []
    );
    const r = docNeighborhood(g, docAnchor('A'), {
      now: '2026-01-01T00:00:00.000Z',
      staleAfterDays: 180,
    });
    const a = r.nodes.find((n) => n.slug === 'A')!;
    expect(a.hygiene.stale).toBe(true);
    expect(a.hygiene.contradictory).toBe(false);
    expect(r.ambiguityTrigger).toBe(true);
  });

  it('does not flag stale by mtime when no `now` is supplied (deterministic)', () => {
    const g = graph(
      [node('A', { gitMtimeIso: '2000-01-01T00:00:00.000Z' })],
      []
    );
    const r = docNeighborhood(g, docAnchor('A'));
    expect(r.nodes[0].hygiene.stale).toBe(false);
    expect(r.ambiguityTrigger).toBe(false);
  });

  it('distinguishes supersession direction (the #2388 regression)', () => {
    // retired->live: `old` (superseded) points FORWARD to its live replacement
    // `new` (accepted). A normal, resolved supersession — NOT a conflict, and
    // (since it gracefully redirects) not even an open staleness signal.
    const superseded = graph(
      [
        node('old', { frontmatter: { status: 'superseded' } }),
        node('new', { frontmatter: { status: 'accepted' } }),
      ],
      [md('old', 'new')]
    );
    const rSup = docNeighborhood(superseded, docAnchor('old'), { maxDistance: 1 });
    const oldNode = rSup.nodes.find((n) => n.slug === 'old')!;
    expect(oldNode.hygiene.contradictory).toBe(false);
    expect(oldNode.hygiene.stale).toBe(false);
    expect(rSup.ambiguityTrigger).toBe(false);
    expect(rSup.ambiguitySources).toEqual([]);

    // live->retired: live `S` (accepted) still links INTO retired `old`
    // (superseded) — the reader cannot tell which is authoritative. A conflict.
    const conflict = graph(
      [
        node('S', { frontmatter: { status: 'accepted' } }),
        node('old', { frontmatter: { status: 'superseded' } }),
      ],
      [md('S', 'old')]
    );
    const rConf = docNeighborhood(conflict, docAnchor('S'), { maxDistance: 1 });
    const retired = rConf.nodes.find((n) => n.slug === 'old')!;
    expect(retired.hygiene.contradictory).toBe(true);
    expect(retired.hygiene.stale).toBe(true);
    expect(rConf.ambiguityTrigger).toBe(true);
    expect(rConf.ambiguitySources).toEqual(['old']);
  });

  it('keeps a redirecting retired doc STALE when a live doc still links into it (the #2388 fix)', () => {
    // `old` (superseded) redirects forward to its live replacement `new`, BUT a
    // live `S` still links straight into `old`. The redirect must NOT suppress
    // staleness while `old` is contradictory — else the payload would report
    // contradictory:true + stale:false and hide live-reachable retired content.
    const g = graph(
      [
        node('S', { frontmatter: { status: 'accepted' } }),
        node('old', { frontmatter: { status: 'superseded' } }),
        node('new', { frontmatter: { status: 'accepted' } }),
      ],
      [md('S', 'old'), md('old', 'new')]
    );
    const r = docNeighborhood(g, docAnchor('S'), { maxDistance: 2 });
    const oldNode = r.nodes.find((n) => n.slug === 'old')!;
    expect(oldNode.hygiene.contradictory).toBe(true);
    expect(oldNode.hygiene.stale).toBe(true); // stays stale despite the redirect
    expect(r.ambiguityTrigger).toBe(true);
    expect(r.ambiguitySources).toContain('old');
  });

  it('keeps a retired doc STALE when its live replacement is outside the payload (the #2388 fix)', () => {
    // `old` (superseded) redirects forward to its live replacement `new`.
    const g = graph(
      [
        node('old', { frontmatter: { status: 'superseded' } }),
        node('new', { frontmatter: { status: 'accepted' } }),
      ],
      [md('old', 'new')]
    );

    // Boundary: `new` is beyond the distance bound, so it is NOT in `nodes`;
    // `old` must stay stale + a source (no replacement evidence is present).
    const outside = docNeighborhood(g, docAnchor('old'), { maxDistance: 0 });
    const oldOut = outside.nodes.find((n) => n.slug === 'old')!;
    expect(oldOut.hygiene.stale).toBe(true);
    expect(oldOut.hygiene.contradictory).toBe(false);
    expect(outside.ambiguitySources).toContain('old');
    expect(outside.ambiguityTrigger).toBe(true);
    expect(outside.nodes.some((n) => n.slug === 'new')).toBe(false);

    // Contrast: with `new` retained in the payload, the supersession resolves —
    // `old` is not stale and the trigger stays silent.
    const inside = docNeighborhood(g, docAnchor('old'), { maxDistance: 1 });
    const oldIn = inside.nodes.find((n) => n.slug === 'old')!;
    expect(oldIn.hygiene.stale).toBe(false);
    expect(inside.ambiguityTrigger).toBe(false);
    expect(inside.nodes.some((n) => n.slug === 'new')).toBe(true);
  });

  it('is clean (trigger false) for a healthy neighborhood', () => {
    const g = graph(
      [
        node('S', { frontmatter: { status: 'accepted' } }),
        node('A', { frontmatter: { status: 'accepted' } }),
      ],
      [md('S', 'A')]
    );
    const r = docNeighborhood(g, docAnchor('S'), { maxDistance: 1 });
    expect(r.ambiguityTrigger).toBe(false);
    expect(r.ambiguitySources).toEqual([]);
    expect(r.nodes.every((n) => !n.hygiene.stale && !n.hygiene.contradictory)).toBe(true);
  });
});

// ── Anchor resolution ───────────────────────────────────────────────────────────

describe('anchor resolution', () => {
  it('resolves a doc slug (with or without a .md suffix)', () => {
    const g = graph([node('docs/a'), node('docs/b')], [md('docs/a', 'docs/b')]);
    expect(docNeighborhood(g, docAnchor('docs/a')).seeds).toEqual(['docs/a']);
    expect(docNeighborhood(g, { kind: 'doc', slug: 'docs/a.md' }).seeds).toEqual([
      'docs/a',
    ]);
  });

  it('resolves an issue number to the docs that mention it', () => {
    const g = graph(
      [node('docs/plan'), node('docs/other')],
      [issue('docs/plan', 2263), issue('docs/other', 999)]
    );
    const r = docNeighborhood(g, { kind: 'issue', issue: 2263 });
    expect(r.seeds).toEqual(['docs/plan']);
  });

  it('resolves a changed source file to the docs that reference it', () => {
    const g = graph(
      [node('REFERENCES'), node('docs/other')],
      [src('REFERENCES', 'src/lib/parse-docs.ts')]
    );
    const r = docNeighborhood(g, { kind: 'file', path: 'src/lib/parse-docs.ts' });
    expect(r.seeds).toEqual(['REFERENCES']);
  });

  it('resolves a changed doc file to its own node', () => {
    const g = graph([node('docs/adr/0008-x'), node('docs/other')], []);
    const r = docNeighborhood(g, { kind: 'file', path: 'docs/adr/0008-x.md' });
    expect(r.seeds).toEqual(['docs/adr/0008-x']);
  });
});

// ── Empty / unknown ─────────────────────────────────────────────────────────────

describe('empty result (callers stay silent)', () => {
  const g = graph([node('docs/a')], []);
  const empty = (r: ReturnType<typeof docNeighborhood>): void => {
    expect(r.seeds).toEqual([]);
    expect(r.nodes).toEqual([]);
    expect(r.ambiguityTrigger).toBe(false);
    expect(r.ambiguitySources).toEqual([]);
  };

  it('empty graph -> empty', () => {
    empty(docNeighborhood(graph([], []), docAnchor('docs/a')));
  });
  it('null/undefined graph -> empty', () => {
    empty(docNeighborhood(null, docAnchor('docs/a')));
    empty(docNeighborhood(undefined, docAnchor('docs/a')));
  });
  it('unknown doc slug -> empty', () => {
    empty(docNeighborhood(g, docAnchor('docs/nope')));
  });
  it('unknown issue -> empty', () => {
    empty(docNeighborhood(g, { kind: 'issue', issue: 424242 }));
  });
  it('unmatched file path -> empty', () => {
    empty(docNeighborhood(g, { kind: 'file', path: 'src/lib/nope.ts' }));
  });
});
