/**
 * Detector: maintenance.doc-hygiene
 *
 * The repo tracks ~190 markdown docs — ADRs, plans, audits, competitive
 * analysis, and root governance (`REFERENCES.md`, `AGENTS.md`, `CLAUDE.md`).
 * That corpus grows and decays silently: links break, docs fall out of every
 * index, and a `REFERENCES.md` parser-table row keeps pointing at a
 * `src/lib/parse-*.ts` file that was renamed away. Today three conventions are
 * policed BY HAND (AGENTS.md calls out the REFERENCES.md drift explicitly); this
 * is the docs analogue of `maintenance.memory-hygiene`, which did the same for
 * the agent-memory markdown tree.
 *
 * This slice (#2258, epic #2256) implements the THREE deterministic signals that
 * are near-certain from the parsed doc graph — no heuristics, no NL:
 *
 *   1. broken-internal-link — an `md-link` edge whose resolved target doc is not
 *      a node in the graph (its file is not on disk). Restricted to links that
 *      land inside the walked doc namespace (repo-root `*.md` + `docs/**`), since
 *      a link out to `src/` was never walked and so cannot be judged missing.
 *   2. orphan             — a doc with zero inbound `md-link` edges, EXCLUDING
 *      declared entry points (repo-root governance, directory `README`s, and the
 *      declared partial indices: REFERENCES table / competitive tracker / ADR
 *      sequence). Suppressed unless the corpus actually cross-links at all, so a
 *      link-less corpus is not one big false-positive storm.
 *   3. dangling-src-ref   — a `src-ref` edge to a `src/…` path that is absent
 *      from the repo-map file inventory (the REFERENCES.md drift AGENTS.md
 *      polices by hand). The graph itself has no source-file oracle, so this
 *      signal is checked against `input.repoMap`, and only when that inventory is
 *      trustworthy: present, NOT truncated (an incomplete map cannot prove
 *      absence), and only for file extensions the inventory actually covers (a
 *      `.css` ref against a TS-only map is never flagged).
 *
 * #2487 adds two checker-native signals from the commit-bound, allowlisted
 * agents-lint adapter: missing non-source context paths and missing npm scripts.
 * An adapted `src/…` finding maps to dangling-src-ref and replaces the graph
 * copy when both identify the same source-doc/target pair, preserving its line.
 *
 * The higher-signal / lower-certainty signals (staleness, declared-vs-derived,
 * dangling issue-ref) are #2259, a separate slice — not this one.
 *
 * Reads `input.docGraph` (built by `buildDocGraph` in `parse-docs.ts`, #2257),
 * `input.repoMap` for signal 3, and `input.docHygieneArtifact` for the host
 * checkers. Recommend-only: the output is advisory and never edits or deletes a
 * doc. Every finding is current commit/filesystem state, not a time-derived
 * trend, so it carries structured `provenance` but needs no staleness demotion.
 *
 * Issues: #2258, #2487 (epic #2256 — doc artifact hygiene)
 */

import type {
  Detector,
  RecommendationInput,
  Recommendation,
  RecObservation,
  RecSeverity,
} from '../types';
import type { DocGraph, DocNode } from '../../parse-docs';
import type { RepoMapDataset } from '../../parse-repo-map-join';
import type {
  DocHygieneArtifact,
  DocHygieneFinding,
} from '../../doc-hygiene-artifact';

/** Deterministic graph- and checker-native doc-hygiene signals. */
export type DocHygieneSignal =
  | 'broken-internal-link'
  | 'orphan'
  | 'dangling-src-ref'
  | 'dangling-context-ref'
  | 'dangling-npm-script';

/** One flagged doc-hygiene item: which doc, which signal, what to do. */
export interface DocHygieneItem {
  /** Repo-relative POSIX path of the doc the finding lives in. */
  path: string;
  signal: DocHygieneSignal;
  /** The broken link target / dangling source path, when the signal has one. */
  target?: string;
  /** One-based checker line, when tool-native evidence supplied a span. */
  line?: number | null;
  /** Exact local source used to reproduce this item. */
  origin: 'doc-graph' | 'lychee.local-links' | 'agents-lint.context-refs';
}

/** Short label per signal for evidence rows. */
const SIGNAL_LABEL: Record<DocHygieneSignal, string> = {
  'broken-internal-link': 'broken internal doc link or fragment',
  orphan: 'doc has no inbound links',
  'dangling-src-ref': 'source reference no longer exists',
  'dangling-context-ref': 'context file reference no longer exists',
  'dangling-npm-script': 'npm script no longer exists',
};

/** Signals that are structural breakage (dead pointers), not just sprawl. */
const STRUCTURAL: ReadonlySet<DocHygieneSignal> = new Set([
  'broken-internal-link',
  'dangling-src-ref',
  'dangling-context-ref',
  'dangling-npm-script',
]);

/** Normalise a path for comparison: backslashes → slashes, strip a `./` prefix. */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Match URI-escaped graph targets to Lychee's decoded file-URL paths. */
function canonicalLinkPath(p: string): string {
  const normalized = normPath(p);
  try {
    return decodeURI(normalized);
  } catch {
    return normalized;
  }
}

/**
 * Lower-cased file extension (including the dot), or `''` when there is none or
 * the basename is a dotfile (`.gitignore`). Browser-safe (no `node:path`).
 */
function extOf(p: string): string {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

/**
 * A slug is inside the walked doc namespace (`buildDocGraph` walks repo-root
 * `*.md` + `docs/**`) iff it is a root-level doc (no `/`) or lives under `docs/`.
 * Only such targets can be judged "missing on disk" — the walk visited exactly
 * that namespace, so a link out to `src/`/`scripts/` is out of scope, not broken.
 */
function inWalkedNamespace(slug: string): boolean {
  return !slug.includes('/') || slug.startsWith('docs/');
}

const README_BASENAME_RE = /(^|\/)README$/i;

/**
 * Whether a node is a declared entry point that is legitimately allowed to have
 * zero inbound links: repo-root governance (`root` category — README, AGENTS,
 * CLAUDE, REFERENCES, …), a directory index `README`, or a declared partial
 * index (`indexKind`: REFERENCES table / competitive tracker / ADR sequence).
 */
function isEntryPoint(node: DocNode): boolean {
  return (
    node.category === 'root' ||
    README_BASENAME_RE.test(node.slug) ||
    node.indexKind !== undefined
  );
}

/** Signal 1: `md-link` edges whose in-scope target doc is not on disk. */
function scanBrokenLinks(
  graph: DocGraph,
  nodeSlugs: ReadonlySet<string>,
  pathBySlug: ReadonlyMap<string, string>
): DocHygieneItem[] {
  const items: DocHygieneItem[] = [];
  for (const edge of graph.edges) {
    if (edge.kind !== 'md-link') continue;
    if (nodeSlugs.has(edge.to)) continue; // resolves to a real doc → fine
    if (!inWalkedNamespace(edge.to)) continue; // outside the walk → can't judge
    const fromPath = pathBySlug.get(edge.from) ?? edge.from;
    const target = `${edge.to}.md`;
    items.push({
      path: fromPath,
      signal: 'broken-internal-link',
      target,
      origin: 'doc-graph',
    });
  }
  return items;
}

/** Signal 2: docs with zero inbound `md-link` edges that are not entry points. */
function scanOrphans(graph: DocGraph): DocHygieneItem[] {
  // Only meaningful once the corpus actually cross-links: `linkedTo` is the set
  // of nodes that some doc resolves an `md-link` to. If nothing resolves,
  // flagging every non-entry doc would be a false-positive storm.
  const linkedTo = new Set<string>();
  const nodeSlugs = new Set(graph.nodes.map((n) => n.slug));
  for (const edge of graph.edges) {
    if (edge.kind === 'md-link' && nodeSlugs.has(edge.to)) linkedTo.add(edge.to);
  }
  if (linkedTo.size === 0) return [];

  const items: DocHygieneItem[] = [];
  for (const node of graph.nodes) {
    if (linkedTo.has(node.slug)) continue; // has an inbound doc link
    if (isEntryPoint(node)) continue; // a declared entry point
    items.push({
      path: node.path,
      signal: 'orphan',
      origin: 'doc-graph',
    });
  }
  return items;
}

/**
 * Signal 3: `src-ref` edges to `src/…` paths absent from the repo-map inventory.
 * The doc graph has no source-file oracle, so this uses `repoMap` — and only
 * when it is a trustworthy inventory (present, non-truncated, and for extensions
 * it actually covers) so absence is real, not a coverage gap.
 */
function scanDanglingSrcRefs(
  graph: DocGraph,
  repoMap: RepoMapDataset | null | undefined,
  pathBySlug: ReadonlyMap<string, string>
): DocHygieneItem[] {
  if (!repoMap || repoMap.projects.length === 0) return [];
  // A truncated map is an incomplete inventory — it cannot prove a file is gone.
  if (repoMap.projects.some((p) => p.truncated)) return [];

  const known = new Set<string>();
  const coveredExts = new Set<string>();
  for (const proj of repoMap.projects) {
    for (const file of proj.files) {
      const p = normPath(file.path);
      known.add(p);
      const ext = extOf(p);
      if (ext) coveredExts.add(ext);
    }
  }
  if (known.size === 0) return [];

  const items: DocHygieneItem[] = [];
  for (const edge of graph.edges) {
    if (edge.kind !== 'src-ref') continue;
    const raw = edge.to.startsWith('src:') ? edge.to.slice(4) : edge.to;
    const path = normPath(raw);
    const ext = extOf(path);
    // Only judge refs whose extension the inventory can see; a ref of an
    // extension the map never contains is a coverage gap, not a dead reference.
    if (!ext || !coveredExts.has(ext)) continue;
    if (known.has(path)) continue; // the file exists → fine
    const fromPath = pathBySlug.get(edge.from) ?? edge.from;
    items.push({
      path: fromPath,
      signal: 'dangling-src-ref',
      target: path,
      origin: 'doc-graph',
    });
  }
  return items;
}

function artifactBrokenLink(finding: DocHygieneFinding): boolean {
  return (
    finding.check === 'lychee.local-links' &&
    finding.signal === 'broken-internal-link'
  );
}

function artifactContextRef(finding: DocHygieneFinding): boolean {
  const expectedField =
    finding.signal === 'missing-path'
      ? 'reports[].results[checker=filesystem].issues[rule=no-missing-path]'
      : finding.signal === 'missing-npm-script'
        ? 'reports[].results[checker=npm-scripts].issues[rule=no-missing-script]'
        : null;
  return (
    finding.check === 'agents-lint.context-refs' &&
    finding.source.tool === 'agents-lint' &&
    expectedField !== null &&
    finding.source.field === expectedField
  );
}

/** Tool-native findings, preserving each checker's one-based line span. */
function scanArtifactFindings(
  artifact: DocHygieneArtifact | null | undefined
): DocHygieneItem[] {
  if (!artifact) return [];
  const items: DocHygieneItem[] = artifact.findings.filter(artifactBrokenLink).map((finding) => ({
    path: normPath(finding.path),
    signal: 'broken-internal-link',
    target: normPath(finding.target),
    line: finding.line,
    origin: 'lychee.local-links',
  }));
  for (const finding of artifact.findings.filter(artifactContextRef)) {
    const target = normPath(finding.target);
    const signal: DocHygieneSignal =
      finding.signal === 'missing-npm-script'
        ? 'dangling-npm-script'
        : target.startsWith('src/')
          ? 'dangling-src-ref'
          : 'dangling-context-ref';
    items.push({
      path: normPath(finding.path),
      signal,
      target,
      line: finding.line,
      origin: 'agents-lint.context-refs',
    });
  }
  return items;
}

/**
 * The graph and Lychee observe the same missing-link fact at different
 * resolutions. Prefer all line-bearing Lychee occurrences whenever one maps to
 * a graph edge; retain graph-only edges and every non-link graph signal.
 */
function mergeGraphAndArtifactItems(
  graphItems: DocHygieneItem[],
  artifactItems: DocHygieneItem[]
): DocHygieneItem[] {
  const linkKey = (item: DocHygieneItem): string => {
    const target = canonicalLinkPath(item.target ?? '').split('#', 1)[0];
    return `${canonicalLinkPath(item.path)}\u0000${target}`;
  };
  const artifactKeys = new Set(
    artifactItems.filter((item) => item.origin === 'lychee.local-links').map(linkKey),
  );
  const contextKey = (item: DocHygieneItem): string =>
    `${canonicalLinkPath(item.path)}\u0000${canonicalLinkPath(item.target ?? '')}`;
  const adaptedSrcKeys = new Set(
    artifactItems
      .filter(
        (item) => item.origin === 'agents-lint.context-refs' && item.signal === 'dangling-src-ref',
      )
      .map(contextKey),
  );
  const merged = [
    ...graphItems.filter(
      (item) =>
        (item.signal !== 'broken-internal-link' || !artifactKeys.has(linkKey(item))) &&
        (item.signal !== 'dangling-src-ref' || !adaptedSrcKeys.has(contextKey(item))),
    ),
    ...artifactItems,
  ];

  const seen = new Set<string>();
  return merged.filter((item) => {
    const key = JSON.stringify([
      item.signal,
      normPath(item.path),
      item.target ? normPath(item.target) : null,
      item.origin === 'agents-lint.context-refs' ? null : (item.line ?? null),
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const detector: Detector = {
  id: 'maintenance.doc-hygiene',
  category: 'maintenance',
  dataDeps: ['docGraph', 'repoMap', 'docHygieneArtifact'],
  rule(input: RecommendationInput): Recommendation | null {
    const graph = input.docGraph;
    const artifactItems = scanArtifactFindings(input.docHygieneArtifact);
    let graphItems: DocHygieneItem[] = [];
    if (graph && graph.nodes.length > 0) {
      const pathBySlug = new Map(graph.nodes.map((n) => [n.slug, n.path]));
      const nodeSlugs = new Set(graph.nodes.map((n) => n.slug));
      graphItems = [
        ...scanBrokenLinks(graph, nodeSlugs, pathBySlug),
        ...scanOrphans(graph),
        ...scanDanglingSrcRefs(graph, input.repoMap, pathBySlug),
      ];
    }

    const items = mergeGraphAndArtifactItems(graphItems, artifactItems);
    if (items.length === 0) return null;

    // Per-signal counts drive the breakdown and the observations.
    const counts = {} as Record<DocHygieneSignal, number>;
    for (const it of items) counts[it.signal] = (counts[it.signal] ?? 0) + 1;

    const order: DocHygieneSignal[] = [
      'broken-internal-link',
      'dangling-src-ref',
      'dangling-context-ref',
      'dangling-npm-script',
      'orphan',
    ];
    const breakdown = order
      .filter((s) => counts[s])
      .map((s) => `${counts[s]} ${SIGNAL_LABEL[s]}`)
      .join(', ');

    const severity: RecSeverity = items.some((it) => STRUCTURAL.has(it.signal))
      ? 'warning'
      : 'info';

    // A handful of supporting rows, structural breakage first.
    const evidence = [...items]
      .sort(
        (a, b) =>
          Number(STRUCTURAL.has(b.signal)) - Number(STRUCTURAL.has(a.signal)) ||
          a.path.localeCompare(b.path) ||
          (a.line ?? 0) - (b.line ?? 0)
      )
      .slice(0, 8)
      .map(
        (it) =>
          `${it.path}${it.line ? `:${it.line}` : ''}` +
          `${it.target ? ` -> ${it.target}` : ''} — ${SIGNAL_LABEL[it.signal]}`
      );

    const graphItemCount = items.filter((item) => item.origin === 'doc-graph').length;
    const artifactItemCount = items.filter((item) => item.origin === 'lychee.local-links').length;
    const agentsLintItemCount = items.filter(
      (item) => item.origin === 'agents-lint.context-refs',
    ).length;
    const graphDanglingSrcCount = items.filter(
      (item) => item.origin === 'doc-graph' && item.signal === 'dangling-src-ref',
    ).length;
    const trackedDocs = Math.max(
      graph?.nodes.length ?? 0,
      input.docHygieneArtifact?.repo.markdownFiles ?? 0
    );
    const observations: RecObservation[] = [];
    if (graphItemCount > 0) {
      observations.push({
        claim: `${graphItemCount} deterministic graph-native doc-hygiene issue(s) across ${graph?.nodes.length ?? 0} parsed doc(s)`,
        source: 'parse-docs',
        field:
          'docGraph (buildDocGraph: nodes[].slug/path/category/indexKind + edges[].from/to/kind)',
        value: graphItemCount,
      });
    }
    if (artifactItemCount > 0) {
      observations.push({
        claim: `${artifactItemCount} broken local Markdown link occurrence(s) reported for the artifact's committed repo state`,
        source: 'doc-hygiene artifact',
        field:
          'findings[check=lychee.local-links,signal=broken-internal-link].{id,path,line,target}',
        value: artifactItemCount,
      });
    }
    if (agentsLintItemCount > 0) {
      observations.push({
        claim: `${agentsLintItemCount} missing governance-doc path or npm-script reference(s) reported for the artifact's committed repo state`,
        source: 'doc-hygiene artifact',
        field: 'findings[check=agents-lint.context-refs].{id,signal,path,line,target,source}',
        value: agentsLintItemCount,
      });
    }
    // Signal 3's existence oracle is the repo map, not the doc graph — cite it.
    if (graphDanglingSrcCount > 0) {
      observations.push({
        claim: `${graphDanglingSrcCount} source reference(s) absent from the repo-map file inventory`,
        source: 'parse-repo-map-join',
        field: 'repoMap.projects[].files[].path',
        value: graphDanglingSrcCount,
      });
    }

    const n = items.length;
    return {
      id: 'maintenance.doc-hygiene',
      category: 'maintenance',
      severity,
      title: `Repo docs need cleanup: ${n} hygiene issue${n === 1 ? '' : 's'}`,
      detail:
        `The repo's ${trackedDocs} tracked markdown doc${trackedDocs === 1 ? '' : 's'} have ${n} deterministic hygiene issue${n === 1 ? '' : 's'} — ${breakdown}. ` +
        `Broken links and dead file or npm-script references rot the doc graph the same way an unmaintained REFERENCES.md does.`,
      action:
        `Review the flagged docs (recommend-only — nothing is edited for you): fix or drop the broken internal links, ` +
        `update stale file and npm-script references, and link or retire the orphaned docs.`,
      affected: n,
      // No honest dollar unit — score on minutes to review each flagged item.
      estTimeReclaimedMin: n,
      evidence,
      provenance: {
        observations,
        inference:
          `Each issue is read from the parsed doc graph or a commit-bound adapted host-checker artifact; overlapping missing-link and source-reference facts prefer exact checker line spans, while ` +
          `graph-native source references use the repo-map inventory and adapted source references use the commit-bound host checker, so all ${n} are reproducible — ` +
          `a maintenance pass to keep the repo doc corpus linked and its references live.`,
      },
    };
  },
};
