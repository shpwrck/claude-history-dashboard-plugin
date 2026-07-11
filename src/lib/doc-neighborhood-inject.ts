/**
 * doc-neighborhood-inject.ts — the AGENT-INJECT surface over the #2263
 * doc-neighborhood retrieval (#2322, second slice of the #2262 doc-comprehension
 * routing bridge; ships FIRST of the two comprehension surfaces).
 *
 * Where {@link docNeighborhood} (#2263) is the reader-agnostic retrieval — a
 * bounded, ranked doc cluster + per-node hygiene flags — this module serves the
 * **agent** reader. It turns that payload into two things:
 *
 *  1. an **injection payload** ({@link DocNeighborhoodInjection}) — the ranked
 *     cluster the agent can self-serve so it stops chasing dead pointers, with
 *     each node's lifecycle **presentation** made honest: a retired / stale node
 *     is marked `status: 'demoted'` and carries an `asOf` date so it is read
 *     "as of <date>", NEVER surfaced as current authority; and
 *  2. an **ambiguity-trigger signal** ({@link AmbiguityTriggerSignal}) — the
 *     #1934 value-of-human-input lever, structured so #2202's PreToolUse
 *     front-load steer can consume it. It carries structured `provenance`
 *     (reusing the engine's {@link RecProvenance} shape) that cites the #2263
 *     node id + hygiene-flag kind, so the downstream steer's claim is auditable.
 *
 * GATING (callers stay silent): an empty / no-graph / unresolved-anchor / empty
 * cluster yields `null` from {@link buildDocNeighborhoodInjection} — inject
 * NOTHING, log NOTHING. A neighborhood that resolves but carries no hygiene
 * concern yields an injection with `trigger: null` — the cluster is still worth
 * self-serving, there is just no ambiguity to front-load a question about.
 *
 * EPISTEMICS (auditable-claims contract + #1757 accuracy gate). The MEASUREMENT
 * — "these neighborhood nodes carry contradiction / staleness / dangling flags"
 * — is auditable: every flag cites the #2263 node id + flag kind. The VALUE — a
 * cheap upfront human clarification averts a costly agent excursion — is a
 * LOW-TIER causal HYPOTHESIS (#1934), kept in `provenance.inference` and NOT
 * asserted as a measured saving: this module emits no `estSavingsUsd` and makes
 * no reclaim/$ claim. Whether the injection actually cuts dead-pointer /
 * repeated-read excursions (the #1288 late-correction / #1924 runaway signals)
 * is unproven until a race/replay trial backs it.
 *
 * PURE + BROWSER-SAFE. Like {@link docNeighborhood} it is a pure function of its
 * arguments — no I/O, no clock, deterministic — and imports only TYPES from
 * `parse-docs` / `detectors/types`, so it never pulls `node:fs` into a bundle.
 * The graph is fed to it by the caller; the host-side producer
 * (`scripts/doc-neighborhood-inject.mjs`) walks the repo with `buildDocGraph`.
 */
import type { DocCategory, DocGraph } from './parse-docs';
import type { RecObservation, RecProvenance } from './detectors/types';
import {
  docNeighborhood,
  type DocHygieneFlags,
  type DocNeighborhood,
  type DocNeighborhoodNode,
  type DocNeighborhoodOptions,
  type NeighborhoodAnchor,
} from './doc-neighborhood';

// ── The ambiguity-trigger signal (#1934, consumed by #2202) ─────────────────────

/** Which hygiene concern a neighborhood node carries. Mirrors the #2263 flags. */
export type AmbiguityFlagKind = 'contradictory' | 'stale' | 'dangling';

/** One flagged node behind the {@link AmbiguityTriggerSignal}. */
export interface AmbiguitySource {
  /** The #2263 node id ({@link DocNeighborhoodNode.slug}) — the auditable anchor. */
  slug: string;
  /** Repo-relative POSIX path of the flagged doc. */
  path: string;
  /** The hygiene flag(s) this node carries, sorted & de-duplicated. */
  flags: AmbiguityFlagKind[];
  /** Declared lifecycle status behind a stale / contradictory flag, if any. */
  declaredStatus?: string;
  /** As-of date (`YYYY-MM-DD`) from `gitMtimeIso`, when derivable. Drives the
   *  "as of <date>" demotion phrasing — a stale node is never "current". */
  asOf?: string;
  /** Dangling `md-link` targets, present only when `flags` includes `dangling`. */
  danglingLinks?: string[];
}

/**
 * The #1934 ambiguity-trigger signal. Emitted whenever a neighborhood node
 * carries ANY hygiene concern (contradiction / staleness / dangling), so the
 * agent-facing steer can surface all three per the #2322 acceptance. The
 * `authorityConflict` flag preserves #2263's own, narrower `ambiguityTrigger`
 * semantics (contradiction OR staleness — the authority conflict a dangling
 * link alone does NOT create), so #2202 can weight a true authority conflict
 * above a merely-broken pointer.
 */
export interface AmbiguityTriggerSignal {
  /** Stable discriminator for the #2202 consumer. */
  kind: 'doc-ambiguity';
  /** The anchor whose neighborhood produced the signal (echoed from #2263). */
  anchor: NeighborhoodAnchor;
  /**
   * True iff #2263's own `ambiguityTrigger` fired — a contradiction or
   * staleness flag (the authority conflict #1934 keys on). A dangling link
   * alone is `false` here even though it still appears in {@link sources}.
   */
  authorityConflict: boolean;
  /** The flagged nodes, ranked as they appear in the injected cluster. */
  sources: AmbiguitySource[];
  /** Structured, auditable provenance citing each node id + flag kind. */
  provenance: RecProvenance;
}

// ── The injection payload (the ranked cluster the agent self-serves) ────────────

/** One node of the injected cluster, with an honest lifecycle presentation. */
export interface InjectedDocNode {
  /** Stable node id ({@link DocNeighborhoodNode.slug}). */
  slug: string;
  /** Repo-relative POSIX path. */
  path: string;
  /** Category derived from the directory. */
  category: DocCategory;
  /** Hop distance from the nearest seed (0 = a seed). */
  distance: number;
  /** Relevance score (the descending sort key from #2263). */
  relevance: number;
  /**
   * Lifecycle presentation. A retired-by-status or mtime-stale node is
   * `'demoted'` and MUST be read "as of {@link asOf}", never as current. A
   * healthy node is `'current'`. (A contradictory-but-not-stale node stays
   * `'current'` in status — the conflict is surfaced via {@link hygiene} and
   * the trigger signal, not by demoting the node's own freshness.)
   */
  status: 'current' | 'demoted';
  /** As-of date (`YYYY-MM-DD`) from `gitMtimeIso`; set when `status` is
   *  `'demoted'` and a clock is derivable. */
  asOf?: string;
  /** The raw #2263 hygiene flags, carried through unchanged for inspection. */
  hygiene: DocHygieneFlags;
}

/** The agent-inject payload: the ranked cluster + the ambiguity-trigger signal. */
export interface DocNeighborhoodInjection {
  /** The resolved anchor (echoed from #2263). */
  anchor: NeighborhoodAnchor;
  /** Seed node slugs (the docs that anchored the neighborhood). */
  seeds: string[];
  /** The ranked cluster nodes with honest lifecycle presentation. */
  nodes: InjectedDocNode[];
  /** #2263's ambiguity trigger (contradiction OR staleness). */
  ambiguityTrigger: boolean;
  /** Slugs of the nodes that set {@link ambiguityTrigger} (from #2263). */
  ambiguitySources: string[];
  /**
   * The structured #1934 signal for #2202, or `null` when the neighborhood
   * carries no hygiene concern at all (nothing to front-load a question about).
   */
  trigger: AmbiguityTriggerSignal | null;
}

// ── Small pure helpers ──────────────────────────────────────────────────────────

/** ISO string / epoch-ms → `YYYY-MM-DD`, or `undefined` when unparseable. */
function asOfDate(gitMtimeIso: string | null): string | undefined {
  if (!gitMtimeIso) return undefined;
  const t = Date.parse(gitMtimeIso);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}

/** The hygiene concern(s) a node carries, as sorted {@link AmbiguityFlagKind}s. */
function flagsOf(hygiene: DocHygieneFlags): AmbiguityFlagKind[] {
  const flags: AmbiguityFlagKind[] = [];
  if (hygiene.contradictory) flags.push('contradictory');
  if (hygiene.stale) flags.push('stale');
  if (hygiene.danglingLinks.length > 0) flags.push('dangling');
  return flags;
}

/** Map a #2263 node to its injected form, demoting a stale node's presentation. */
function toInjectedNode(n: DocNeighborhoodNode): InjectedDocNode {
  const asOf = asOfDate(n.gitMtimeIso);
  const demoted = n.hygiene.stale;
  const node: InjectedDocNode = {
    slug: n.slug,
    path: n.path,
    category: n.category,
    distance: n.distance,
    relevance: n.relevance,
    status: demoted ? 'demoted' : 'current',
    hygiene: n.hygiene,
  };
  // Only carry an as-of when the node is demoted AND a clock is derivable, so a
  // renderer/steer shows the stale doc "as of <date>" instead of as live truth.
  if (demoted && asOf) node.asOf = asOf;
  return node;
}

/**
 * Build the #1934 ambiguity-trigger signal from a resolved neighborhood, or
 * `null` when NO node carries any hygiene concern. Fires for contradiction,
 * staleness, OR dangling (all three per the #2322 acceptance); `authorityConflict`
 * preserves #2263's narrower contradiction-or-staleness trigger.
 *
 * The provenance is auditable: each source contributes one observation citing
 * the #2263 node id (`slug`) and the exact hygiene field it read, phrased as a
 * fact — a stale doc is stated "as of <date>", never as current authority. The
 * value-of-human-input is kept in `inference` as an explicit hypothesis.
 */
export function emitAmbiguityTriggerSignal(
  neighborhood: DocNeighborhood
): AmbiguityTriggerSignal | null {
  const sources: AmbiguitySource[] = [];
  const observations: RecObservation[] = [];
  let newestAsOf: string | undefined;

  for (const n of neighborhood.nodes) {
    const flags = flagsOf(n.hygiene);
    if (flags.length === 0) continue;

    const asOf = asOfDate(n.gitMtimeIso);
    if (asOf && (!newestAsOf || asOf > newestAsOf)) newestAsOf = asOf;

    const source: AmbiguitySource = { slug: n.slug, path: n.path, flags };
    if (n.hygiene.declaredStatus !== undefined) {
      source.declaredStatus = n.hygiene.declaredStatus;
    }
    if (asOf) source.asOf = asOf;
    if (n.hygiene.danglingLinks.length > 0) {
      source.danglingLinks = n.hygiene.danglingLinks;
    }
    sources.push(source);

    // One observation per source. Stale docs are phrased "as of <date>" so the
    // claim never reads as a current-authority assertion (auditable-claims
    // stale-input rule); the flag list and node id make it reproducible.
    const staleClause =
      n.hygiene.stale && asOf
        ? ` (as of ${asOf}; not current authority)`
        : n.hygiene.stale
          ? ' (retired; not current authority)'
          : '';
    const statusClause = n.hygiene.declaredStatus
      ? ` declared status "${n.hygiene.declaredStatus}",`
      : '';
    observations.push({
      claim:
        `doc "${n.slug}" in the neighborhood is flagged ${flags.join(' + ')}` +
        `${statusClause ? `,${statusClause}` : ''}${staleClause}`,
      source: 'doc-neighborhood (#2263)',
      field: `nodes[slug=${n.slug}].hygiene.{${flags.join(',')}}`,
      value: flags.join('+'),
    });
  }

  if (sources.length === 0) return null;

  const provenance: RecProvenance = {
    observations,
    inference:
      'The task-relevant doc neighborhood carries conflicting, stale, or ' +
      'dangling authority, so an agent that relies on it may chase a dead ' +
      'pointer or the wrong doc. This is the #1934 value-of-human-input lever: ' +
      'a cheap upfront clarification (front-loaded by #2202) MAY avert a costly ' +
      'excursion — a low-tier causal hypothesis, not a measured saving.',
  };
  // A stale/contradictory neighborhood is inherently a historical-authority
  // signal, so carry the newest source date as the provenance as-of for
  // present-tense demotion downstream (#1102), mirroring the engine detectors.
  if (newestAsOf) provenance.asOf = newestAsOf;

  return {
    kind: 'doc-ambiguity',
    anchor: neighborhood.anchor,
    authorityConflict: neighborhood.ambiguityTrigger,
    sources,
    provenance,
  };
}

/**
 * Retrieve the doc neighborhood around `anchor` (via #2263) and turn it into an
 * agent-inject payload — or `null` when there is nothing to inject.
 *
 * GATE (callers stay silent, nothing logged): returns `null` when the graph is
 * empty / absent, the anchor resolves to no seed, or the cluster is empty. A
 * resolved neighborhood with no hygiene concern returns a payload whose
 * `trigger` is `null`.
 */
export function buildDocNeighborhoodInjection(
  graph: DocGraph | null | undefined,
  anchor: NeighborhoodAnchor,
  options: DocNeighborhoodOptions = {}
): DocNeighborhoodInjection | null {
  const nb = docNeighborhood(graph, anchor, options);
  // Empty / no-graph / unresolved-anchor / empty-cluster -> inject nothing.
  if (nb.seeds.length === 0 || nb.nodes.length === 0) return null;

  return {
    anchor: nb.anchor,
    seeds: nb.seeds,
    nodes: nb.nodes.map(toInjectedNode),
    ambiguityTrigger: nb.ambiguityTrigger,
    ambiguitySources: nb.ambiguitySources,
    trigger: emitAmbiguityTriggerSignal(nb),
  };
}
