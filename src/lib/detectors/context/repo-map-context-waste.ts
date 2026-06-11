import type { Detector } from '../types';
import type { AppliedMarkers } from '../types';
import { claudeMdMarksApplied, basename } from '../shared';
import { parseFileReread } from '../../parse-file-reread';
import { scopeKeyOf, type ReclaimClaim } from '../../reclaim';
import type { RepoMapFileJoin, RepoMapProjectJoin } from '../../parse-repo-map-join';

/**
 * Repo-map-aware structural context-waste detector (#890, epic #871 + #944).
 *
 * The generic `workflow.redundant-reads` rule already says "you re-read these
 * files, pin them". It is derived from a FLAT reread list with no structural
 * awareness, so it cannot tell a stable API/config file repeatedly re-loaded
 * across sessions (worth pinning / referencing) from an incidental re-read
 * inside one tight loop. This detector replaces that generic pin guidance with
 * STRUCTURAL candidates drawn from the server-only `repoMap` join (#889):
 *
 *  1. **Stable API/config files** — files that export a public surface
 *     (interface/type/const/function/class/enum) OR back a CLAUDE.md config
 *     section, are re-read across sessions, and are NOT churned (read-only).
 *     The content is stable, so re-reading it re-pays a cost that one pin would
 *     erase.
 *  2. **High-centrality files** — files many other modules import, re-read
 *     read-only across sessions. Centrality is computed from the map's own
 *     import edges (how many sibling files import this one), never a guess.
 *
 * Each surviving candidate names the specific FILE and a few of its SYMBOLS
 * (not a bare path list), carries the measured reread-token estimate, and emits
 * a structured {@link ReclaimClaim} (`cause: 'structural-prefix'`, `scaleTokens`
 * on the re-reading sessions' cache-read prefix pool) so the re-read tokens it
 * identifies become a PRICED claim against the cache-read pool — consumable by
 * the #944 cascade (PR3 / #949), not just an advisory pin list.
 */

const MARKERS_REPO_MAP_WASTE: AppliedMarkers = {
  headings: [/^##\s+Stable reference files\b/i],
  bodyPhrases: ['Reference these stable files instead of re-reading them'],
};

/** A file is read-only across sessions when the join carries no churn (or zero
 *  mutating ops): nobody is editing it, so its content is stable to pin. */
function isReadOnly(file: RepoMapFileJoin): boolean {
  return !file.churn || file.churn.churn === 0;
}

/** A file exports a public API surface (any exported top-level symbol). */
function hasExportedApi(file: RepoMapFileJoin): boolean {
  return file.symbols.some((s) => s.exported);
}

/** Normalize a module specifier or file path to its extension-stripped
 *  basename — the centrality join key. Specifiers are unresolved module strings
 *  (`'./foo'`, `'../lib/bar'`); we match by basename so a `./reclaim` import
 *  counts toward `src/lib/reclaim.ts`'s centrality without a full module
 *  resolver. Bare package specifiers (`'react'`) never match a repo file
 *  basename, so third-party imports don't inflate centrality. */
function importKey(spec: string): string {
  return basename(spec).replace(/\.[cm]?[jt]sx?$/, '');
}

/**
 * Precompute per-basename in-degree in ONE linear pass (#718).
 *
 * Centrality is "how many OTHER files in the project import this one". The
 * previous `centralityOf(file, project)` re-scanned the whole `project.files`
 * list for each candidate, so a project with N files cost O(N²) import
 * comparisons — the quadratic term the release-gate guards before a large repo
 * trips `coldIngestMaxMs`. Walk the file list once instead, tallying an
 * in-degree per imported basename (deduped per file, so a module imported twice
 * in one file counts once — matching the old `other.imports.some(...)`
 * membership test). A candidate then reads its count in O(1) and subtracts its
 * own self-import, reproducing the old `other.path !== file.path` exclusion
 * exactly (even when two files share a basename). Identical centrality numbers
 * and candidate ordering, linear cost.
 */
function buildCentralityIndex(project: RepoMapProjectJoin): Map<string, number> {
  const importers = new Map<string, number>();
  for (const file of project.files) {
    const seen = new Set<string>();
    for (const spec of file.imports) {
      const key = importKey(spec);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      importers.set(key, (importers.get(key) ?? 0) + 1);
    }
  }
  return importers;
}

/** Read a precomputed file's centrality (OTHER files importing its basename)
 *  in O(1): total importers of the basename minus this file's own self-import. */
function centralityOf(file: RepoMapFileJoin, importers: Map<string, number>): number {
  const fileKey = importKey(file.path);
  if (!fileKey) return 0;
  const total = importers.get(fileKey) ?? 0;
  // Subtract one only if THIS file imports its own basename (its own
  // contribution to the count); other same-basename files still count.
  const self = file.imports.some((spec) => importKey(spec) === fileKey) ? 1 : 0;
  return total - self;
}

/** Minimum sibling-import count for the high-centrality candidate path. */
const CENTRALITY_FLOOR = 2;
/** How many candidate files to surface / name in the finding. */
const MAX_CANDIDATES = 5;
/** How many symbols to name per candidate file. */
const MAX_SYMBOLS_PER_FILE = 3;

interface Candidate {
  path: string;
  /** Why it was selected — drives the human-readable reason. */
  reason: 'stable-api' | 'config-backed' | 'high-centrality';
  rereadTokens: number;
  sessions: number;
  symbols: string[];
  configSections: string[];
  centrality: number;
}

export const detector: Detector = {
  id: 'context.repo-map-context-waste',
  category: 'context',
  dataDeps: ['repoMap', 'toolData', 'tokenData', 'liveConfig'],
  rule(input) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS_REPO_MAP_WASTE)) return null;
    const repoMap = input.repoMap;
    if (!repoMap || repoMap.projects.length === 0) return null;

    // Gather structural candidates across every project in the map.
    const candidates: Candidate[] = [];
    for (const project of repoMap.projects) {
      // Centrality is computed once per project in a single linear pass, then
      // read in O(1) per candidate (#718) — no per-file rescan of the file list.
      const centralityIndex = buildCentralityIndex(project);
      for (const file of project.files) {
        // Only files actually re-read across sessions are context waste.
        if (!file.reread || file.reread.totalEstimatedTokenWaste <= 0) continue;
        // A file being actively edited isn't stable to pin/reference.
        if (!isReadOnly(file)) continue;

        const exportedApi = hasExportedApi(file);
        const configBacked = file.configSections.length > 0;
        const centrality = centralityOf(file, centralityIndex);
        const central = centrality >= CENTRALITY_FLOOR;
        if (!exportedApi && !configBacked && !central) continue;

        // Reason precedence: config-backed (can be referenced) → stable-api →
        // high-centrality. The first matching reason labels the candidate.
        const reason: Candidate['reason'] = configBacked
          ? 'config-backed'
          : exportedApi
            ? 'stable-api'
            : 'high-centrality';

        candidates.push({
          path: file.path,
          reason,
          rereadTokens: file.reread.totalEstimatedTokenWaste,
          sessions: file.reread.sessions,
          symbols: file.symbols
            .filter((s) => s.exported)
            .slice(0, MAX_SYMBOLS_PER_FILE)
            .map((s) => s.name),
          configSections: file.configSections,
          centrality,
        });
      }
    }

    if (candidates.length === 0) return null;

    // Rank by reread-token waste (the priced signal), then by centrality.
    candidates.sort(
      (a, b) => b.rereadTokens - a.rereadTokens || b.centrality - a.centrality
    );
    const top = candidates.slice(0, MAX_CANDIDATES);
    const totalRereadTokens = candidates.reduce((s, c) => s + c.rereadTokens, 0);

    // ── Reclaim claim (epic #944, PR3 / #949) ────────────────────────────────
    // The re-read of a stable structural file re-enters context as a cached
    // prefix; re-reading it across sessions re-pays the cache-read pool. We map
    // the candidate files back to the concrete (session, model) scopes that
    // re-read them via `parseFileReread`, then delete the candidate re-read
    // tokens as a fraction of those scopes' cache-read residual. `scaleTokens`
    // carries one per-pool fraction; the cascade's `residual ≥ 0` guard caps
    // each cell so we never reclaim more than the real cache-read bill. The
    // fraction is GROUNDED in the measured reread tokens — never a constant.
    const candidatePaths = new Set(top.map((c) => c.path));
    const reread = parseFileReread(input.toolData, input.tokenData);
    const wasteBySession = new Map<string, number>();
    for (const r of reread.repeats) {
      if (r.estimatedTokenWaste <= 0) continue;
      // The map path is repo-root-relative; the reread path is the absolute
      // tool-call path. Match by suffix so `src/lib/reclaim.ts` joins
      // `/home/.../src/lib/reclaim.ts`.
      const matches = [...candidatePaths].some(
        (p) => r.path === p || r.path.endsWith(`/${p}`)
      );
      if (!matches) continue;
      wasteBySession.set(
        r.sessionId,
        (wasteBySession.get(r.sessionId) ?? 0) + r.estimatedTokenWaste
      );
    }

    const scopeKeys = new Set<string>();
    let inScopeCacheReadTokens = 0;
    let directWasteTokens = 0;
    for (const d of input.tokenData) {
      const waste = wasteBySession.get(d.sessionId);
      if (!waste) continue;
      directWasteTokens += waste;
      for (const e of d.entries) {
        scopeKeys.add(scopeKeyOf(d.sessionId, e.model || 'unknown'));
        inScopeCacheReadTokens += e.cacheReadTokens;
      }
    }

    let reclaim: ReclaimClaim | undefined;
    if (directWasteTokens > 0 && scopeKeys.size > 0 && inScopeCacheReadTokens > 0) {
      const cacheReadFrac = directWasteTokens / inScopeCacheReadTokens;
      reclaim = {
        leverId: 'context.repo-map-context-waste',
        category: 'context',
        cause: 'structural-prefix',
        // Structural context band [40,90); behavioural causes run ahead.
        orderKey: 65,
        ownedPools: ['cacheRead'],
        scopeKeys: [...scopeKeys],
        counterfactual: { kind: 'scaleTokens', poolDeltaFrac: { cacheRead: cacheReadFrac } },
        evidenceTokens: directWasteTokens,
      };
    }

    const describe = (c: Candidate): string => {
      const sym = c.symbols.length > 0 ? ` (${c.symbols.join(', ')})` : '';
      const why =
        c.reason === 'config-backed'
          ? `backs ${c.configSections.length} config section(s)`
          : c.reason === 'stable-api'
            ? 'stable exported API, read-only'
            : `imported by ${c.centrality} files, read-only`;
      return `${c.path}${sym} — ${why}, re-read across ${c.sessions} session(s), ~${c.rereadTokens.toLocaleString()} tokens`;
    };

    return {
      id: 'context.repo-map-context-waste',
      category: 'context',
      severity: 'info',
      title: 'Stable structural files re-read across sessions',
      detail: `${candidates.length} stable, read-only file(s) from the repo map are re-read across sessions, re-paying ~${totalRereadTokens.toLocaleString()} tokens. These are structural API/config/high-centrality files — pinning or referencing them once removes the repeated cost.`,
      action:
        'Reference these specific files/symbols once in CLAUDE.md (with @-imports) or cite the config section, instead of re-reading the source each session.',
      ...(reclaim ? { reclaim } : {}),
      affected: candidates.length,
      view: 'context',
      evidence: top.map(describe),
      fix: {
        target: 'CLAUDE.md',
        label: 'Reference stable files',
        note: 'Append to your project CLAUDE.md. The @-prefix imports each file so its contents load once into context instead of being re-read each session. These are stable, read-only files from the structural repo map.',
        snippet: `## Stable reference files\n\nReference these stable files instead of re-reading them each session:\n${top
          .map((c) => `- @${c.path}${c.symbols.length > 0 ? ` — ${c.symbols.join(', ')}` : ''}`)
          .join('\n')}`,
        appliedMarkers: MARKERS_REPO_MAP_WASTE,
      },
    };
  },
};
