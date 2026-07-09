/**
 * doc-neighborhood.ts — pure retrieval over the repo doc-graph (#2263, epic
 * #2262, the "doc-comprehension routing" bridge).
 *
 * Given a **task anchor** — a changed file path, a GitHub issue number, or a doc
 * slug — return the **relevant doc neighborhood** built from an already-computed
 * {@link DocGraph} (produced host-side by `buildDocGraph` in `parse-docs.ts`):
 *
 *  - the connected cluster reached over doc-to-doc `md-link` edges, treated as
 *    **undirected** (backlinks + forward links), **bounded by hop distance**;
 *  - each node **ranked by relevance** — a configurable blend of graph
 *    centrality, recency (from `gitMtimeIso`), declared lifecycle status, and
 *    proximity to the anchor;
 *  - per-node **hygiene flags** — dangling links, staleness, and contradiction;
 *  - a single **ambiguity trigger** boolean (the #1934 signal, consumed later by
 *    #2200/#2202) that fires when the neighborhood carries a contradiction or
 *    staleness flag.
 *
 * This is **reader-agnostic**: the agent-inject path and the human-view path
 * both consume the same JSON payload.
 *
 * PURE + STANDALONE. It is a pure function of its arguments — it takes the graph
 * as a parameter, never re-parses docs, reads no files, calls no clock
 * (`Date.now` is never used — recency is derived from `gitMtimeIso` ordering, and
 * absolute mtime staleness is opt-in via an explicit `now` option), and imports
 * only TYPES from `parse-docs` (so it stays browser-safe — no `node:fs` is pulled
 * in). It does NOT touch `scripts/ingest.mjs`, `RecommendationInput`, or
 * `detectors/types.ts`; the graph is fed to it by the caller.
 *
 * Empty / no-graph / unresolved-anchor input yields an **empty result** so
 * callers can stay silent.
 */
import type {
  DocCategory,
  DocEdge,
  DocGraph,
  DocNode,
} from './parse-docs';

// ── Anchor ─────────────────────────────────────────────────────────────────────

/**
 * A task anchor to seed the neighborhood from. One of:
 *  - `file` — a changed file path (a source file docs reference via a `src-ref`
 *    edge, or a doc file that is itself a node);
 *  - `issue` — a GitHub issue number (docs that mention it via an `issue-ref`);
 *  - `doc` — a doc slug (or `.md` path) naming a node directly.
 */
export type NeighborhoodAnchor =
  | { kind: 'file'; path: string }
  | { kind: 'issue'; issue: number }
  | { kind: 'doc'; slug: string };

// ── Options ────────────────────────────────────────────────────────────────────

/** Relevance-blend weights. All default to sane values; override any subset. */
export interface DocNeighborhoodWeights {
  /** Weight on graph centrality (distinct doc-link neighbors). */
  centrality: number;
  /** Weight on recency (newer `gitMtimeIso` ranks higher). */
  recency: number;
  /** Weight on declared lifecycle status (authoritative > retired). */
  status: number;
  /** Weight on proximity to the anchor (nearer hops rank higher). */
  proximity: number;
}

export interface DocNeighborhoodOptions {
  /**
   * Max hop distance from any seed, inclusive (seeds are distance 0). A node at
   * distance N is included; N+1 is excluded. Default 2. Values < 0 are treated
   * as 0 (seeds only).
   */
  maxDistance?: number;
  /**
   * Optional cap on the number of ranked nodes returned (the highest-ranked are
   * kept). `undefined`/`0`/negative means no cap. Default: no cap. Two classes of
   * node are always retained even past the cap: anchor **seeds** (the docs that
   * anchored the neighborhood) and **ambiguity sources** (flagged
   * `stale`/`contradictory`), so every seed and every
   * {@link DocNeighborhood.ambiguitySources} slug stays present in `nodes` — the
   * returned list may therefore exceed `maxNodes` by those retained nodes.
   */
  maxNodes?: number;
  /** Relevance-blend weights (see {@link DocNeighborhoodWeights}). */
  weights?: Partial<DocNeighborhoodWeights>;
  /**
   * Optional "now" — an ISO string or epoch-ms number — enabling **absolute**
   * mtime staleness: a node whose `gitMtimeIso` is older than `staleAfterDays`
   * is flagged stale. Omit it and staleness is derived purely from declared
   * status (fully deterministic, no clock). Provided so callers stay in control
   * of time; the function itself never reads a clock.
   */
  now?: string | number;
  /** With `now` set, a node older than this many days is stale. Default 180. */
  staleAfterDays?: number;
  /** Frontmatter key holding the declared lifecycle status. Default `status`. */
  statusKey?: string;
  /**
   * Declared statuses (case-insensitive) that mark a doc **retired** — no longer
   * authoritative. Drives both the stale flag and, when a live doc still links
   * to it, the contradiction flag. Default:
   * superseded/deprecated/obsolete/archived/retired/replaced/abandoned.
   */
  retiredStatuses?: string[];
  /**
   * Declared-status -> ranking weight (higher = more authoritative, so ranks
   * higher). Default: accepted/current/active/stable/final/approved = +1;
   * proposed/draft/wip = 0; retired statuses = -1; unknown/absent = 0.
   */
  statusWeight?: (status: string | undefined) => number;
}

// ── Result ─────────────────────────────────────────────────────────────────────

/** Per-node hygiene signals surfaced by the neighborhood. */
export interface DocHygieneFlags {
  /**
   * Outbound `md-link` targets that resolve to no node in the graph — broken
   * doc links. Empty when the node's links all resolve.
   */
  danglingLinks: string[];
  /**
   * Retired by declared status — UNLESS the doc gracefully redirects forward to a
   * live replacement that is itself retained in this payload's `nodes` (that
   * resolved, replacement-visible case is not stale) — or, with an explicit
   * `now`, older than the staleness horizon.
   */
  stale: boolean;
  /**
   * A **conflict**: this doc is retired, yet a *live* (non-retired) doc in the
   * neighborhood still links **into** it (a directed `md-link` from live to
   * retired) — so the agent cannot tell which is authoritative. Judged on
   * DIRECTED incoming edges, so a normal retired->live supersession (where the
   * retired doc merely points at its replacement) is NOT a contradiction.
   */
  contradictory: boolean;
  /** The declared lifecycle status that drove stale/contradictory, if any. */
  declaredStatus?: string;
}

/** One node of the ranked neighborhood. */
export interface DocNeighborhoodNode {
  /** Stable node id (`DocNode.slug`). */
  slug: string;
  /** Repo-relative POSIX path (`DocNode.path`). */
  path: string;
  /** Category derived from the directory (`DocNode.category`). */
  category: DocCategory;
  /** Hop distance from the nearest seed (0 = a seed). */
  distance: number;
  /** Relevance score; the descending sort key (higher = more relevant). */
  relevance: number;
  /** As-of clock, copied from the graph node (`DocNode.gitMtimeIso`). */
  gitMtimeIso: string | null;
  /** Per-node hygiene flags. */
  hygiene: DocHygieneFlags;
}

/** The structured doc neighborhood — the shared payload both readers consume. */
export interface DocNeighborhood {
  /** The anchor that was resolved (echoed back). */
  anchor: NeighborhoodAnchor;
  /** Seed node slugs (distance 0). Empty when the anchor did not resolve. */
  seeds: string[];
  /** Cluster nodes, ranked by relevance descending (deterministic tie-break). */
  nodes: DocNeighborhoodNode[];
  /**
   * The #1934 **ambiguity trigger**: `true` when the neighborhood carries a
   * contradiction or staleness flag (any node flagged `contradictory` or
   * `stale`). Consumed downstream by #2200/#2202 to gate an ambiguity prompt.
   * A dangling link alone does NOT trip it — dangling is a separate hygiene
   * class (a broken link, not a contradiction of authority).
   */
  ambiguityTrigger: boolean;
  /** Slugs of the nodes that set {@link ambiguityTrigger} (stale/contradictory). */
  ambiguitySources: string[];
}

// ── Defaults ────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_DISTANCE = 2;
const DEFAULT_STALE_AFTER_DAYS = 180;
const DEFAULT_STATUS_KEY = 'status';

const DEFAULT_WEIGHTS: DocNeighborhoodWeights = {
  centrality: 1,
  recency: 1,
  status: 1,
  proximity: 2,
};

const DEFAULT_RETIRED_STATUSES: readonly string[] = [
  'superseded',
  'deprecated',
  'obsolete',
  'archived',
  'retired',
  'replaced',
  'abandoned',
];

const DEFAULT_STATUS_WEIGHTS: Record<string, number> = {
  accepted: 1,
  current: 1,
  active: 1,
  stable: 1,
  final: 1,
  approved: 1,
  proposed: 0,
  draft: 0,
  wip: 0,
  superseded: -1,
  deprecated: -1,
  obsolete: -1,
  archived: -1,
  retired: -1,
  replaced: -1,
  abandoned: -1,
};

function defaultStatusWeight(status: string | undefined): number {
  if (!status) return 0;
  return DEFAULT_STATUS_WEIGHTS[status.trim().toLowerCase()] ?? 0;
}

const EMPTY = (anchor: NeighborhoodAnchor): DocNeighborhood => ({
  anchor,
  seeds: [],
  nodes: [],
  ambiguityTrigger: false,
  ambiguitySources: [],
});

// ── Small pure helpers ──────────────────────────────────────────────────────────

/** Normalise a path to repo-relative POSIX form (`\`→`/`, drop leading `./`). */
function normPath(p: string): string {
  const posix = p.split('\\').join('/').trim();
  return posix.replace(/^\.\//, '');
}

/** Repo-relative POSIX path with the `.md` suffix removed — the stable slug. */
function slugForPath(p: string): string {
  return normPath(p).replace(/\.md$/i, '');
}

/** Parse an ISO string / epoch-ms into epoch ms, or `null` when unparseable. */
function toEpochMs(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

// ── Anchor -> seed slugs ────────────────────────────────────────────────────────

/**
 * Resolve an anchor to its seed node slugs against `graph`. A seed is a doc node
 * the anchor points at directly (a doc slug/path) or that references the anchor
 * (a doc mentioning the issue, or referencing the changed source file).
 */
function resolveSeeds(
  anchor: NeighborhoodAnchor,
  nodeBySlug: Map<string, DocNode>,
  nodeByPath: Map<string, DocNode>,
  edges: DocEdge[]
): string[] {
  const seeds = new Set<string>();
  if (anchor.kind === 'doc') {
    const slug = slugForPath(anchor.slug);
    if (nodeBySlug.has(slug)) seeds.add(slug);
    return [...seeds];
  }
  if (anchor.kind === 'issue') {
    if (!Number.isFinite(anchor.issue)) return [];
    const target = `issue:${anchor.issue}`;
    for (const e of edges) {
      if (e.kind === 'issue-ref' && e.to === target && nodeBySlug.has(e.from)) {
        seeds.add(e.from);
      }
    }
    return [...seeds];
  }
  // kind === 'file'
  const path = normPath(anchor.path);
  if (!path) return [];
  // The changed file may be a doc node itself…
  const asDoc = nodeByPath.get(path) ?? nodeBySlug.get(slugForPath(path));
  if (asDoc) seeds.add(asDoc.slug);
  // …and/or a source file docs reference via a `src-ref` edge.
  const srcTarget = `src:${path}`;
  for (const e of edges) {
    if (e.kind === 'src-ref' && e.to === srcTarget && nodeBySlug.has(e.from)) {
      seeds.add(e.from);
    }
  }
  return [...seeds];
}

// ── Main ────────────────────────────────────────────────────────────────────────

/**
 * Retrieve the relevant doc neighborhood around `anchor` from `graph`. Pure: no
 * I/O, no clock, deterministic. Returns an empty neighborhood (empty `seeds` and
 * `nodes`, `ambiguityTrigger: false`) when the graph is empty or the anchor
 * resolves to nothing.
 */
export function docNeighborhood(
  graph: DocGraph | null | undefined,
  anchor: NeighborhoodAnchor,
  options: DocNeighborhoodOptions = {}
): DocNeighborhood {
  if (!graph || graph.nodes.length === 0) return EMPTY(anchor);

  const maxDistance = Math.max(0, Math.trunc(options.maxDistance ?? DEFAULT_MAX_DISTANCE));
  const weights: DocNeighborhoodWeights = { ...DEFAULT_WEIGHTS, ...options.weights };
  const statusKey = options.statusKey ?? DEFAULT_STATUS_KEY;
  const retired = new Set(
    (options.retiredStatuses ?? DEFAULT_RETIRED_STATUSES).map((s) => s.trim().toLowerCase())
  );
  const statusWeight = options.statusWeight ?? defaultStatusWeight;
  const nowMs = toEpochMs(options.now);
  const staleAfterMs = (options.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS) * 86_400_000;

  const nodeBySlug = new Map<string, DocNode>(graph.nodes.map((n) => [n.slug, n]));
  const nodeByPath = new Map<string, DocNode>(graph.nodes.map((n) => [n.path, n]));

  const seeds = resolveSeeds(anchor, nodeBySlug, nodeByPath, graph.edges);
  if (seeds.length === 0) return EMPTY(anchor);

  // Doc-to-doc link maps over `md-link` edges whose endpoints are both real
  // nodes: `adj` is UNDIRECTED (drives BFS expansion + centrality — backlinks
  // and forward links both traverse); `incoming`/`outgoing` keep the DIRECTED
  // edges, needed to tell a live->retired conflict from a retired->live
  // supersession. `dangling` holds md-links to slugs that are not nodes.
  const adj = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>(); // to -> { from }
  const outgoing = new Map<string, Set<string>>(); // from -> { to }
  const dangling = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, k: string, v: string): void => {
    (m.get(k) ?? m.set(k, new Set()).get(k)!).add(v);
  };
  for (const e of graph.edges) {
    if (e.kind !== 'md-link') continue;
    if (!nodeBySlug.has(e.from)) continue;
    if (nodeBySlug.has(e.to)) {
      add(adj, e.from, e.to);
      add(adj, e.to, e.from);
      add(incoming, e.to, e.from);
      add(outgoing, e.from, e.to);
    } else {
      add(dangling, e.from, e.to);
    }
  }

  // BFS out from all seeds over the undirected adjacency, bounded by maxDistance.
  const distance = new Map<string, number>();
  let frontier: string[] = [];
  for (const s of seeds) {
    if (!distance.has(s)) {
      distance.set(s, 0);
      frontier.push(s);
    }
  }
  for (let d = 0; d < maxDistance && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const nb of adj.get(cur) ?? []) {
        if (!distance.has(nb)) {
          distance.set(nb, d + 1);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }

  const clusterSlugs = [...distance.keys()];
  const clusterSet = new Set(clusterSlugs);

  // Centrality: distinct doc-link neighbors (full graph), normalised by the max
  // among cluster nodes so the most-connected cluster hub scores 1.
  const rawCentrality = new Map<string, number>();
  let maxCentrality = 0;
  for (const slug of clusterSlugs) {
    const c = adj.get(slug)?.size ?? 0;
    rawCentrality.set(slug, c);
    if (c > maxCentrality) maxCentrality = c;
  }

  // Recency: rank distinct gitMtimeIso values among cluster nodes (oldest 0 …
  // newest 1). Purely from ordering — no clock needed.
  const mtimes = clusterSlugs
    .map((s) => toEpochMs(nodeBySlug.get(s)!.gitMtimeIso))
    .filter((t): t is number => t !== null);
  const distinctMtimes = [...new Set(mtimes)].sort((a, b) => a - b);
  const recencyRank = new Map<number, number>();
  if (distinctMtimes.length === 1) {
    recencyRank.set(distinctMtimes[0], 1);
  } else {
    distinctMtimes.forEach((t, i) => recencyRank.set(t, i / (distinctMtimes.length - 1)));
  }

  // `isRetired` reads a node's declared lifecycle status.
  const isRetired = (node: DocNode): { retired: boolean; status?: string } => {
    const raw = node.frontmatter[statusKey];
    const s = raw?.trim();
    return { retired: !!s && retired.has(s.toLowerCase()), status: s };
  };

  // Pass 1 — everything that does NOT depend on which nodes ultimately survive
  // the cap: contradiction (directed live incoming), mtime staleness, the ranking
  // relevance (a pure blend of centrality/recency/status/proximity — never of the
  // hygiene flags, so ranking is stable), and the in-cluster live redirect targets
  // that could gracefully supersede a retired doc. Graceful supersession itself is
  // deferred to pass 2 because it depends on whether the replacement is retained.
  type NodeFact = {
    node: DocNode;
    slug: string;
    d: number;
    isRet: boolean;
    status?: string;
    contradictory: boolean;
    tooOld: boolean;
    liveTargets: string[];
    relevance: number;
  };
  const facts: NodeFact[] = [];
  for (const slug of clusterSlugs) {
    const node = nodeBySlug.get(slug)!;
    const d = distance.get(slug)!;
    const { retired: isRet, status } = isRetired(node);

    // Contradiction: a *live* (non-retired) cluster node has a DIRECTED md-link
    // INTO this retired node — a live doc still points at retired content, so the
    // reader cannot tell which is authoritative. Uses the directed `incoming`
    // edges, NOT the undirected BFS adjacency: a normal retired->live
    // supersession (the only edge is retired->live) is therefore NOT a conflict.
    let contradictory = false;
    if (isRet) {
      for (const from of incoming.get(slug) ?? []) {
        if (!clusterSet.has(from)) continue;
        const fromNode = nodeBySlug.get(from);
        if (fromNode && !isRetired(fromNode).retired) {
          contradictory = true;
          break;
        }
      }
    }

    // Candidate graceful-supersession targets: live (non-retired) replacements
    // this retired doc redirects FORWARD to that are INSIDE the cluster (only an
    // in-cluster target can appear in the payload). Irrelevant once contradictory.
    const liveTargets: string[] = [];
    if (isRet && !contradictory) {
      for (const to of outgoing.get(slug) ?? []) {
        if (!clusterSet.has(to)) continue;
        const toNode = nodeBySlug.get(to);
        if (toNode && !isRetired(toNode).retired) liveTargets.push(to);
      }
    }

    const mtimeMs = toEpochMs(node.gitMtimeIso);
    const tooOld = nowMs !== null && mtimeMs !== null && nowMs - mtimeMs > staleAfterMs;

    const centralityNorm = maxCentrality > 0 ? (rawCentrality.get(slug) ?? 0) / maxCentrality : 0;
    const recencyNorm = mtimeMs !== null ? recencyRank.get(mtimeMs) ?? 0 : 0;
    const statusScore = statusWeight(status);
    const proximityNorm = maxDistance === 0 ? 1 : (maxDistance - d) / maxDistance;
    const relevance =
      weights.centrality * centralityNorm +
      weights.recency * recencyNorm +
      weights.status * statusScore +
      weights.proximity * proximityNorm;

    const fact: NodeFact = { node, slug, d, isRet, contradictory, tooOld, liveTargets, relevance };
    if (status !== undefined) fact.status = status;
    facts.push(fact);
  }

  // Rank: relevance desc, then nearer, then slug asc (deterministic).
  facts.sort(
    (a, b) => b.relevance - a.relevance || a.d - b.d || a.slug.localeCompare(b.slug)
  );

  // Retention base = the top-ranked `maxNodes` PLUS the anchor seeds. A seed is
  // the doc that anchored the neighborhood, so it must stay visible even when it
  // ranks below the cut (e.g. a superseded seed pointing at a newer doc). With no
  // cap every cluster node is in the base.
  const cap = options.maxNodes && options.maxNodes > 0 ? options.maxNodes : Infinity;
  const baseRetained = new Set<string>();
  facts.forEach((f, i) => {
    if (i < cap) baseRetained.add(f.slug);
  });
  for (const s of seeds) baseRetained.add(s);

  // Whether a node survives into the payload — decided WITHOUT the graceful result
  // (a live replacement target is never itself graceful-dependent, so this is
  // well-defined): it is base-retained, or independently flagged (contradictory /
  // mtime-stale). This is exactly the final-membership test for a live target.
  const factBySlug = new Map(facts.map((f) => [f.slug, f]));
  const willBeRetained = (slug: string): boolean => {
    if (baseRetained.has(slug)) return true;
    const f = factBySlug.get(slug);
    return !!f && (f.contradictory || f.tooOld);
  };

  // Pass 2 — decide graceful supersession against the retained payload, finalize
  // staleness + hygiene, and collect ambiguity sources.
  const ambiguitySources: string[] = [];
  const ranked: DocNeighborhoodNode[] = facts.map((f) => {
    // A retired doc is "gracefully superseded" (staleness resolved, not a source)
    // ONLY when it redirects to a live replacement that is RETAINED in the
    // payload — otherwise the reader would see it as fresh with no replacement
    // evidence present, so it stays stale (and a source).
    let gracefullySuperseded = false;
    if (f.isRet && !f.contradictory) {
      for (const to of f.liveTargets) {
        if (willBeRetained(to)) {
          gracefullySuperseded = true;
          break;
        }
      }
    }
    const stale = (f.isRet && !gracefullySuperseded) || f.tooOld;
    const danglingLinks = [...(dangling.get(f.slug) ?? [])].sort();
    const hygiene: DocHygieneFlags = { danglingLinks, stale, contradictory: f.contradictory };
    if (f.status !== undefined) hygiene.declaredStatus = f.status;
    if (stale || f.contradictory) ambiguitySources.push(f.slug);
    return {
      slug: f.slug,
      path: f.node.path,
      category: f.node.category,
      distance: f.d,
      relevance: f.relevance,
      gitMtimeIso: f.node.gitMtimeIso,
      hygiene,
    };
  });

  // Return the base-retained nodes plus every ambiguity source (so each
  // `ambiguitySources` slug stays inspectable), preserving ranked order.
  const sourceSet = new Set(ambiguitySources);
  const nodes = ranked.filter((n) => baseRetained.has(n.slug) || sourceSet.has(n.slug));

  ambiguitySources.sort();
  return {
    anchor,
    seeds: [...seeds].sort(),
    nodes,
    ambiguityTrigger: ambiguitySources.length > 0,
    ambiguitySources,
  };
}
