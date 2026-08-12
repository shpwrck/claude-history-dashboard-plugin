/**
 * fs-free leaf: plan structural signatures and the deterministic k-means
 * shape clustering, shared by the server-side plans parser (`parse-plans.ts`)
 * and the browser-bundled PlanShapesPf view (#3639, the #3613 extraction
 * pattern).
 *
 * This lives in its OWN dependency-free leaf — NOT in `parse-plans.ts` — on
 * purpose: that module imports `node:fs` (directly and via `bounded-fs`,
 * which `parsePlansDir` needs), and in the sample build `node:fs` resolves to an
 * empty stub that throws at module scope. The view's value import of
 * `clusterPlans` from the fs-touching module dragged the fs graph into the
 * PlanShapesPf view chunk and white-screened it on load. Browser code imports
 * the signature/clustering pieces from here; the dir scanner stays behind
 * with the fs graph.
 *
 * Structure-only extraction: the parser counts structural features and NEVER
 * surfaces file body text, secrets, or credentials.
 */

// ── Core data shape ─────────────────────────────────────────────────────────

/**
 * Structural signature of a single plan file — 4 numeric/boolean features
 * extracted from the markdown without reading any prose content.
 */
export interface PlanSignature {
  /** Display name: the filename sans `.md`, or a provided label. */
  name: string;
  /** Source filename, e.g. `istio-scale-campaign.md`. */
  id: string;
  /** Count of `## ` (H2) section headings in the document. */
  sections: number;
  /** Count of numbered list items (`N. `) — treated as file-change references. */
  fileRefs: number;
  /** Approximate word count. */
  words: number;
  /** True when a `## Verification` or `## Test…` H2 section is present. */
  hasVerification: boolean;
}

// ── Markdown feature extraction ──────────────────────────────────────────────

/**
 * Parse the structural features out of a single plan markdown string.
 * Pure — no I/O, no side effects, tolerant of any input.
 *
 * @param text  The raw markdown text of the plan.
 * @param name  The plan name (filename without `.md`), used as both `name` and `id`.
 */
export function parsePlanMarkdown(text: string, name: string): PlanSignature {
  // H2 section count (`## `-prefixed lines)
  const sections = (text.match(/^##\s/gm) ?? []).length;

  // Numbered list items at line start — file-change refs (e.g. `1. src/foo.ts`)
  const fileRefs = (text.match(/^[0-9]+\.\s/gm) ?? []).length;

  // Approximate word count
  const words = (text.match(/\S+/g) ?? []).length;

  // Presence of a Verification or Test H2 section
  const hasVerification = /^##\s+(verification|test)/im.test(text);

  return { name, id: name, sections, fileRefs, words, hasVerification };
}

// ── Clustering ───────────────────────────────────────────────────────────────

/** Shape label assigned to each cluster. */
export type PlanShape = 'A' | 'B' | 'C';

/** Per-cluster statistics. */
export interface ClusterStats {
  shape: PlanShape;
  /** Human-readable cluster description. */
  label: string;
  /** Number of plans in this cluster. */
  count: number;
  /** Average section count. */
  avgSections: number;
  /** Average file-change ref count. */
  avgFileRefs: number;
  /** Average word count (rounded). */
  avgWords: number;
  /** Percentage of plans in this cluster carrying a Verification section (0-100). */
  verifyPct: number;
}

/** Assignment record for one plan. */
export interface PlanClusterAssignment {
  plan: PlanSignature;
  /** Cluster shape label. */
  shape: PlanShape;
  /** Raw cluster index (0/1/2) before stable label mapping. */
  clusterIndex: number;
}

/** Full clustering result. */
export interface ClusterResult {
  /** Per-plan cluster assignments, in the same order as the input array. */
  assignments: PlanClusterAssignment[];
  /** One stats record per cluster shape (always A, B, C — even if empty). */
  stats: ClusterStats[];
}

const SHAPE_LABELS: Record<PlanShape, string> = {
  A: 'Tight surgical fix (few files, lean prose)',
  B: 'Verified multi-file build (broad fan-out + Verification)',
  C: 'Sprawling campaign / dump (big, often no Verification)',
};

/**
 * Cluster plans by structural shape using deterministic k-means (k=3).
 *
 * Features used: `fileRefs`, `words`, `sections`, and `hasVerification` (0/1).
 * Initialization is fixed to indices [3, 2, 0] of the normalized feature matrix
 * (mirroring the prototype) so results are stable across runs given the same
 * input ordering. Returns empty assignments+stats when fewer than k plans are
 * provided.
 *
 * Stable label mapping:
 *   C = cluster with the highest average words (sprawling)
 *   B = among the rest, highest (verify*2 + fileRefs) score (verified multi-file)
 *   A = the remaining cluster (tight)
 *
 * @param sigs  Array of plan signatures to cluster.
 * @param k     Number of clusters (default 3).
 */
export function clusterPlans(sigs: PlanSignature[], k = 3): ClusterResult {
  const empty = (): ClusterResult => ({
    assignments: sigs.map((plan) => ({ plan, shape: 'A', clusterIndex: 0 })),
    stats: (['A', 'B', 'C'] as PlanShape[]).map((shape) => ({
      shape,
      label: SHAPE_LABELS[shape],
      count: 0,
      avgSections: 0,
      avgFileRefs: 0,
      avgWords: 0,
      verifyPct: 0,
    })),
  });

  if (sigs.length < k) return empty();

  // ── Normalize features ────────────────────────────────────────────────────
  const featureKeys = ['fileRefs', 'words', 'sections'] as const;
  type FK = typeof featureKeys[number];

  const mins: Record<FK, number> = { fileRefs: Infinity, words: Infinity, sections: Infinity };
  const maxs: Record<FK, number> = { fileRefs: -Infinity, words: -Infinity, sections: -Infinity };
  for (const s of sigs) {
    for (const fk of featureKeys) {
      if (s[fk] < mins[fk]) mins[fk] = s[fk];
      if (s[fk] > maxs[fk]) maxs[fk] = s[fk];
    }
  }

  const normalize = (s: PlanSignature): number[] => [
    maxs.fileRefs === mins.fileRefs ? 0 : (s.fileRefs - mins.fileRefs) / (maxs.fileRefs - mins.fileRefs),
    maxs.words === mins.words ? 0 : (s.words - mins.words) / (maxs.words - mins.words),
    maxs.sections === mins.sections ? 0 : (s.sections - mins.sections) / (maxs.sections - mins.sections),
    s.hasVerification ? 1 : 0,
  ];

  const X = sigs.map(normalize);

  const dist = (a: number[], b: number[]): number =>
    Math.sqrt(a.reduce((sum, _, i) => sum + (a[i] - b[i]) ** 2, 0));

  // ── Fixed-seed initialization: indices 3, 2, 0 (clamped to array bounds) ─
  const seedIdx = [
    Math.min(3, sigs.length - 1),
    Math.min(2, sigs.length - 1),
    0,
  ];
  let centroids: number[][] = seedIdx.map((i) => X[i].slice());

  let assignments: number[] = new Array(sigs.length).fill(0);

  for (let iter = 0; iter < 40; iter++) {
    // Assign each point to the nearest centroid
    const newAssign = X.map((x) => {
      let best = 0;
      let bestDist = Infinity;
      for (let ci = 0; ci < k; ci++) {
        const d = dist(x, centroids[ci]);
        if (d < bestDist) {
          bestDist = d;
          best = ci;
        }
      }
      return best;
    });

    // Recompute centroids
    const newCentroids = centroids.map((c, ci) => {
      const group = X.filter((_, i) => newAssign[i] === ci);
      if (group.length === 0) return c;
      return group[0].map((_, d) =>
        group.reduce((sum, g) => sum + g[d], 0) / group.length
      );
    });

    // Check convergence
    const converged = assignments.every((a, i) => a === newAssign[i]);
    assignments = newAssign;
    centroids = newCentroids;
    if (converged && iter > 0) break;
  }

  // ── Stable label mapping ─────────────────────────────────────────────────
  const profileOf = (ci: number) => {
    const idx = sigs.map((_, i) => i).filter((i) => assignments[i] === ci);
    const avg = (k: keyof PlanSignature) =>
      idx.length === 0
        ? 0
        : idx.reduce((s, i) => s + (sigs[i][k] as number), 0) / idx.length;
    return {
      ci,
      idx,
      words: avg('words'),
      fileRefs: avg('fileRefs'),
      verify: idx.length === 0 ? 0 : idx.filter((i) => sigs[i].hasVerification).length / idx.length,
      sections: avg('sections'),
    };
  };

  const profiles = [0, 1, 2].map(profileOf);

  // C = highest average words (sprawling)
  // perf-index-contract: plan-cluster-labels always-consumed: each sorted copy is indexed [0] immediately to pick the C/B cluster labels
  const cC = [...profiles].sort((a, b) => b.words - a.words)[0].ci;
  // B = among remaining, highest (verify*2 + fileRefs)
  // perf-index-contract: plan-cluster-labels always-consumed: each sorted copy is indexed [0] immediately to pick the C/B cluster labels
  const cB = [...profiles]
    .filter((p) => p.ci !== cC)
    .sort((a, b) => b.verify * 2 + b.fileRefs - (a.verify * 2 + a.fileRefs))[0].ci;
  // A = the rest
  const cA = profiles.find((p) => p.ci !== cC && p.ci !== cB)!.ci;

  const label: Record<number, PlanShape> = {};
  label[cA] = 'A';
  label[cB] = 'B';
  label[cC] = 'C';

  const planAssignments: PlanClusterAssignment[] = sigs.map((plan, i) => ({
    plan,
    shape: label[assignments[i]],
    clusterIndex: assignments[i],
  }));

  const statsFor = (shape: PlanShape): ClusterStats => {
    const members = sigs.filter((_, i) => label[assignments[i]] === shape);
    if (members.length === 0) {
      return { shape, label: SHAPE_LABELS[shape], count: 0, avgSections: 0, avgFileRefs: 0, avgWords: 0, verifyPct: 0 };
    }
    const avg = (k: keyof PlanSignature) =>
      members.reduce((s, m) => s + (m[k] as number), 0) / members.length;
    return {
      shape,
      label: SHAPE_LABELS[shape],
      count: members.length,
      avgSections: parseFloat(avg('sections').toFixed(1)),
      avgFileRefs: parseFloat(avg('fileRefs').toFixed(1)),
      avgWords: Math.round(avg('words')),
      verifyPct: Math.round(
        (members.filter((m) => m.hasVerification).length / members.length) * 100
      ),
    };
  };

  return {
    assignments: planAssignments,
    stats: (['A', 'B', 'C'] as PlanShape[]).map(statsFor),
  };
}
