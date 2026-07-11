/**
 * doc-neighborhood-inject.test.ts — vitest tests for the agent-inject surface
 * over the #2263 retrieval (#2322).
 *
 * Covers the issue's acceptance bullets:
 *  - injection payload shape (ranked cluster + hygiene passthrough);
 *  - empty / no-graph / unresolved-anchor / empty-cluster suppression: the
 *    builder returns `null` (inject nothing, log nothing);
 *  - trigger-signal emission + provenance citing the #2263 node id + flag kind;
 *  - stale-flag handling: a node whose hygiene flag is "as of <date>" is
 *    surfaced as DEMOTED, not current.
 *
 * Fixtures are hand-built {@link DocGraph} literals — no filesystem, no
 * `buildDocGraph` — mirroring `doc-neighborhood.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { DocEdge, DocGraph, DocNode } from './parse-docs';
import {
  docNeighborhood,
  type NeighborhoodAnchor,
} from './doc-neighborhood';
import {
  buildDocNeighborhoodInjection,
  emitAmbiguityTriggerSignal,
} from './doc-neighborhood-inject';

// ── Fixture builders (same shape as doc-neighborhood.test.ts) ───────────────────

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
const graph = (nodes: DocNode[], edges: DocEdge[]): DocGraph => ({ nodes, edges });
const docAnchor = (slug: string): NeighborhoodAnchor => ({ kind: 'doc', slug });

// ── Injection payload shape ─────────────────────────────────────────────────────

describe('buildDocNeighborhoodInjection — payload shape', () => {
  it('returns the ranked cluster with seeds, distances, and hygiene passthrough', () => {
    const g = graph(
      [node('S'), node('A'), node('B')],
      [md('S', 'A'), md('A', 'B')]
    );
    const inj = buildDocNeighborhoodInjection(g, docAnchor('S'), { maxDistance: 2 });
    expect(inj).not.toBeNull();
    expect(inj!.anchor).toEqual(docAnchor('S'));
    expect(inj!.seeds).toEqual(['S']);
    // Every node carries the injected shape.
    const s = inj!.nodes.find((n) => n.slug === 'S')!;
    expect(s).toMatchObject({
      slug: 'S',
      path: 'S.md',
      category: 'doc',
      distance: 0,
      status: 'current',
    });
    expect(typeof s.relevance).toBe('number');
    expect(s.hygiene).toEqual({ danglingLinks: [], stale: false, contradictory: false });
    // A healthy neighborhood has no ambiguity concern -> trigger null.
    expect(inj!.ambiguityTrigger).toBe(false);
    expect(inj!.ambiguitySources).toEqual([]);
    expect(inj!.trigger).toBeNull();
  });

  it('mirrors the #2263 node order (relevance-ranked)', () => {
    const g = graph(
      [node('S'), node('A'), node('B'), node('X'), node('Y')],
      [md('S', 'A'), md('S', 'B'), md('A', 'X'), md('A', 'Y')]
    );
    const inj = buildDocNeighborhoodInjection(g, docAnchor('S'), { maxDistance: 1 });
    const nb = docNeighborhood(g, docAnchor('S'), { maxDistance: 1 });
    expect(inj!.nodes.map((n) => n.slug)).toEqual(nb.nodes.map((n) => n.slug));
  });
});

// ── Empty / no-graph / unresolved suppression ───────────────────────────────────

describe('buildDocNeighborhoodInjection — suppression (inject nothing)', () => {
  it('returns null for a null / undefined graph', () => {
    expect(buildDocNeighborhoodInjection(null, docAnchor('S'))).toBeNull();
    expect(buildDocNeighborhoodInjection(undefined, docAnchor('S'))).toBeNull();
  });

  it('returns null for an empty graph', () => {
    expect(buildDocNeighborhoodInjection(graph([], []), docAnchor('S'))).toBeNull();
  });

  it('returns null when the anchor resolves to no seed', () => {
    const g = graph([node('A')], []);
    expect(buildDocNeighborhoodInjection(g, docAnchor('does-not-exist'))).toBeNull();
    // A file anchor that no node references also yields nothing.
    expect(
      buildDocNeighborhoodInjection(g, { kind: 'file', path: 'src/unreferenced.ts' })
    ).toBeNull();
    // An issue anchor no doc mentions yields nothing.
    expect(
      buildDocNeighborhoodInjection(g, { kind: 'issue', issue: 999999 })
    ).toBeNull();
  });
});

// ── Trigger-signal emission + provenance ────────────────────────────────────────

describe('ambiguity-trigger signal', () => {
  it('emits a signal with provenance citing the node id + flag kind (contradiction)', () => {
    // Live S still links into superseded B -> contradiction + staleness.
    const g = graph(
      [
        node('S', { frontmatter: { status: 'accepted' } }),
        node('B', {
          frontmatter: { status: 'superseded' },
          gitMtimeIso: '2023-02-03T00:00:00.000Z',
        }),
      ],
      [md('S', 'B')]
    );
    const inj = buildDocNeighborhoodInjection(g, docAnchor('S'), { maxDistance: 1 });
    expect(inj!.ambiguityTrigger).toBe(true);
    expect(inj!.ambiguitySources).toEqual(['B']);

    const sig = inj!.trigger!;
    expect(sig.kind).toBe('doc-ambiguity');
    expect(sig.anchor).toEqual(docAnchor('S'));
    expect(sig.authorityConflict).toBe(true);

    const src = sig.sources.find((s) => s.slug === 'B')!;
    expect(src.flags).toEqual(['contradictory', 'stale']);
    expect(src.declaredStatus).toBe('superseded');
    expect(src.asOf).toBe('2023-02-03');

    // Provenance cites the #2263 node id + the hygiene field it read.
    const obs = sig.provenance.observations.find((o) =>
      o.field.includes('slug=B')
    )!;
    expect(obs.source).toBe('doc-neighborhood (#2263)');
    expect(obs.field).toContain('hygiene.{contradictory,stale}');
    expect(obs.value).toBe('contradictory+stale');
    // The value-of-human-input stays an explicit hypothesis, not a saving.
    expect(sig.provenance.inference).toMatch(/hypothesis/i);
    expect(JSON.stringify(sig)).not.toMatch(/estSavingsUsd|\$\d/);
  });

  it('fires on a dangling link but keeps authorityConflict false', () => {
    // A dangling md-link is a broken pointer, not an authority conflict.
    const g = graph([node('A')], [md('A', 'docs/missing')]);
    const inj = buildDocNeighborhoodInjection(g, docAnchor('A'));
    // #2263's own trigger does NOT fire for dangling alone.
    expect(inj!.ambiguityTrigger).toBe(false);
    // …but the agent-facing signal still surfaces it (per #2322 acceptance).
    const sig = inj!.trigger!;
    expect(sig.authorityConflict).toBe(false);
    const src = sig.sources.find((s) => s.slug === 'A')!;
    expect(src.flags).toEqual(['dangling']);
    expect(src.danglingLinks).toEqual(['docs/missing']);
  });

  it('emitAmbiguityTriggerSignal returns null for a clean neighborhood', () => {
    const nb = docNeighborhood(
      graph([node('S'), node('A')], [md('S', 'A')]),
      docAnchor('S')
    );
    expect(emitAmbiguityTriggerSignal(nb)).toBeNull();
  });
});

// ── Stale-flag handling (demoted, not current) ──────────────────────────────────

describe('stale-flag handling', () => {
  it('surfaces a retired-by-status node as DEMOTED with an as-of date', () => {
    // Two retired docs pointing at each other: stale, no live conflict.
    const g = graph(
      [
        node('S', { frontmatter: { status: 'deprecated' } }),
        node('B', {
          frontmatter: { status: 'superseded' },
          gitMtimeIso: '2022-05-06T12:00:00.000Z',
        }),
      ],
      [md('S', 'B')]
    );
    const inj = buildDocNeighborhoodInjection(g, docAnchor('S'), { maxDistance: 1 });
    const b = inj!.nodes.find((n) => n.slug === 'B')!;
    expect(b.status).toBe('demoted');
    expect(b.asOf).toBe('2022-05-06');
    expect(b.hygiene.stale).toBe(true);

    // The signal phrases the stale source "as of <date>", never as current.
    const obs = inj!.trigger!.provenance.observations.find((o) =>
      o.field.includes('slug=B')
    )!;
    expect(obs.claim).toContain('as of 2022-05-06');
    expect(obs.claim).toContain('not current authority');
    expect(obs.claim).not.toMatch(/\bis currently\b/);
  });

  it('demotes a mtime-stale node when a `now` is supplied', () => {
    const g = graph([node('A', { gitMtimeIso: '2020-01-01T00:00:00.000Z' })], []);
    const inj = buildDocNeighborhoodInjection(g, docAnchor('A'), {
      now: '2026-01-01T00:00:00.000Z',
      staleAfterDays: 180,
    });
    const a = inj!.nodes.find((n) => n.slug === 'A')!;
    expect(a.status).toBe('demoted');
    expect(a.asOf).toBe('2020-01-01');
    expect(inj!.trigger!.provenance.asOf).toBe('2020-01-01');
  });

  it('keeps a healthy node CURRENT and carries no as-of', () => {
    const g = graph(
      [node('S'), node('A', { frontmatter: { status: 'accepted' } })],
      [md('S', 'A')]
    );
    const inj = buildDocNeighborhoodInjection(g, docAnchor('S'), { maxDistance: 1 });
    const a = inj!.nodes.find((n) => n.slug === 'A')!;
    expect(a.status).toBe('current');
    expect(a.asOf).toBeUndefined();
  });

  it('does NOT demote a gracefully-superseded seed (redirects to a retained live doc)', () => {
    // oldSeed (superseded) redirects forward to the live, retained `fresh` — a
    // resolved supersession is not stale, so it stays current-presentation.
    const g = graph(
      [
        node('oldSeed', { frontmatter: { status: 'superseded' } }),
        node('fresh', { frontmatter: { status: 'accepted' } }),
      ],
      [md('oldSeed', 'fresh')]
    );
    const inj = buildDocNeighborhoodInjection(g, docAnchor('oldSeed'), { maxDistance: 1 });
    const seed = inj!.nodes.find((n) => n.slug === 'oldSeed')!;
    expect(seed.hygiene.stale).toBe(false);
    expect(seed.status).toBe('current');
    expect(inj!.trigger).toBeNull();
  });
});
