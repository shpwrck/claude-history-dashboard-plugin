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
 *      signal is checked against the `input.repoMap` project whose root exactly
 *      matches the graph root, and only when that inventory is trustworthy:
 *      present, complete, NOT truncated, and for file extensions the inventory
 *      actually covers (a `.css` ref against a TS-only map is never flagged).
 *
 * #2487 adds two checker-native signals from the commit-bound, allowlisted
 * agents-lint adapter: missing non-source context paths and missing npm scripts.
 * An adapted `src/…` finding maps to dangling-src-ref and replaces the graph
 * copy when both identify the same source-doc/target pair, preserving its line.
 *
 * #2488 adds a fourth graph-native signal, `stale-declared-freshness`: an
 * OPT-IN, per-document freshness contract (`freshness.warn_after` /
 * `freshness.error_after` frontmatter keys) evaluated against the AUTHORITATIVE
 * Git modification time carried by #2707 (`gitMtimeProvenance` of `git` or a
 * valid commit-bound `manifest` — never the Docker/filesystem mtime). It is
 * deterministic and declared, not heuristic: a document with no contract, a
 * malformed/reversed contract, or a non-authoritative time is silent. The
 * higher-signal / lower-certainty DERIVED staleness (declared-vs-derived,
 * dangling issue-ref, NL stale-claims) is still #2259, a separate slice.
 *
 * #2489 adds four signals from the strictly parsed, versioned `docs/docs-map.json`
 * declaration (`input.docsMap`, #2709 wrapper): `docs-map-missing-document` (a
 * mapped document is not a node in the doc graph), `docs-map-missing-source` (a
 * declared source file no longer exists in the identity-matched repo-map
 * project), `docs-map-unreferenced-source` (the mapped document exists but has
 * no derived `src-ref` edge to a declared source — declaration drift, not a
 * dead pointer), and `docs-map-missing-symbol` (a declared source-bound symbol
 * is absent from that exact file's repo-map symbols). Direction is strictly
 * ONE-WAY: only paths `docs/docs-map.json` itself declares are ever judged —
 * a body-only `src-ref` to a path the map never opted into is always silent,
 * never treated as an implicit declaration. The repo-map-backed pair
 * (missing-source / missing-symbol) fires only when the wrapper's
 * `repository`+`commit` identity resolves to EXACTLY ONE complete,
 * non-truncated repo-map project — zero, multiple, or a stale/mismatched
 * identity suppresses both entirely, computed once per run. A missing
 * document also suppresses unreferenced-source for it (a gone doc trivially
 * "fails to reference" everything), but its declared sources still get judged
 * for existence/symbols independently, since those are repo-map claims.
 *
 * #2472 adds two graph-native declared-category signals from an OPT-IN top-level
 * `category:` frontmatter declaration, validated (exact-case) against the shared
 * browser-safe vocabulary in `doc-contract.ts`: `declared-category-invalid` (the
 * value is outside the vocabulary — replace the token) and
 * `declared-category-mismatch` (a valid value that differs from the purely
 * directory-derived category — the file may be misfiled OR the label wrong, so
 * the evidence cites both and asserts neither). A missing declaration is neutral
 * and a matching one is silent, so the corpus is not forced to declare anything.
 *
 * #2711 adds two issue-reference signals gated on the OPT-IN, freshness-bounded
 * GitHub issue-state snapshot (#2710, `input.docIssueSnapshot`): `dangling-issue-ref`
 * (an `issue-ref` edge to a `#N` the snapshot resolved to an explicit `not-found`)
 * and `closed-draft-owner` (a doc whose frontmatter declares `status: draft` and
 * owns a `#N` in `issue:` whose snapshot state is `closed` — a merged PR
 * normalizes to `closed` too). Both are gated by ONE shared trust check computed
 * once: a present, `complete`, still-usable (<=24h at the injected `now`) snapshot
 * whose resolved ref set EXACTLY equals the graph's current `issue-ref` numbers
 * (any subset OR superset mismatch suppresses BOTH). Like declared-freshness, the
 * verdict recomputes live, so it embeds an explicit "as of <date>" in its wording
 * rather than demoting via a rec-level asOf, and never asserts the reference is
 * currently gone — only that the snapshot resolved it so as of that date. The
 * owner signal reads frontmatter ONLY, never the edges, so body prose stays silent.
 *
 * Reads `input.docGraph` (built by `buildDocGraph` in `parse-docs.ts`, #2257),
 * `input.repoMap` for signal 3 and the #2489 repo-map-backed pair,
 * `input.docsMap` for the #2489 declared-map signals,
 * `input.docIssueSnapshot` for the #2711 issue-reference pair, and
 * `input.docHygieneArtifact` for the host checkers. Recommend-only: the output
 * is advisory and never edits or deletes a doc. The link/reference/orphan/
 * docs-map signals are current commit/filesystem state, so they need no
 * staleness demotion; the declared-freshness verdict IS time-derived, but it
 * is recomputed live against the injected evaluation `now` (never a stale
 * ingest), so it embeds an explicit "as of <date>" in its wording instead of a
 * provenance-level demotion, and never asserts the content itself is wrong or
 * currently stale.
 *
 * Issues: #2258, #2487, #2488, #2489, #2472, #2711 (epic #2256 — doc artifact hygiene)
 */

import type {
  Detector,
  RecommendationInput,
  Recommendation,
  RecObservation,
  RecSeverity,
} from '../types';
import type { DocFrontmatter, DocGraph, DocNode } from '../../parse-docs';
import { DOC_CATEGORIES, isDocCategory } from '../../doc-contract';
import type { DocCategory } from '../../doc-contract';
import type { DocIssueSnapshot, DocIssueState } from '../../doc-issue-snapshot';
import {
  isDocIssueSnapshotUsable,
  docIssueStateByNumber,
  canonicalRefSet,
} from '../../doc-issue-snapshot';
import type { RepoMapDataset, RepoMapProjectJoin } from '../../parse-repo-map-join';
import { DOC_GIT_TIMES_MIN_TIME_MS } from '../../doc-git-times';
import type { DocsMapArtifact } from '../../parse-docs-map';
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
  | 'dangling-npm-script'
  | 'stale-declared-freshness'
  | 'docs-map-missing-document'
  | 'docs-map-missing-source'
  | 'docs-map-unreferenced-source'
  | 'docs-map-missing-symbol'
  | 'declared-category-mismatch'
  | 'declared-category-invalid'
  | 'dangling-issue-ref'
  | 'closed-draft-owner';

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
  origin:
    | 'doc-graph'
    | 'doc-graph.freshness'
    | 'doc-graph.category'
    | 'doc-graph.issue-ref'
    | 'lychee.local-links'
    | 'agents-lint.context-refs'
    | 'docs-map';
  /**
   * Set only on a `stale-declared-freshness` item: the full declared-freshness
   * verdict (authoritative Git time, provenance, crossed threshold, evaluation
   * `asOf`, verdict) used to render its evidence line and pick its severity.
   */
  freshness?: DeclaredFreshnessFinding;
  /**
   * Set only on a `docs-map-missing-symbol` item: the declared symbol name
   * that is absent from the source file's repo-map symbols.
   */
  symbol?: string;
  /**
   * Set only on a `declared-category-*` item (#2472): the opt-in `category:`
   * frontmatter value and the path-derived category. Used to render neutral
   * evidence that cites both sides without asserting which one is authoritative.
   */
  category?: { declared: string; derived: DocCategory };
  /**
   * Set only on a `dangling-issue-ref` / `closed-draft-owner` item (#2711): the
   * referenced issue number, its snapshot-resolved state, and the snapshot's
   * `YYYY-MM-DD` as-of date embedded in the evidence wording.
   */
  issueRef?: { number: number; state: DocIssueState; asOf: string };
}

/** Short label per signal for evidence rows. */
const SIGNAL_LABEL: Record<DocHygieneSignal, string> = {
  'broken-internal-link': 'broken internal doc link or fragment',
  orphan: 'doc has no inbound links',
  'dangling-src-ref': 'source reference no longer exists',
  'dangling-context-ref': 'context file reference no longer exists',
  'dangling-npm-script': 'npm script no longer exists',
  'stale-declared-freshness': 'document past its declared freshness threshold',
  'docs-map-missing-document': 'docs-map document no longer exists',
  'docs-map-missing-source': 'declared source no longer exists',
  'docs-map-unreferenced-source': 'declared source is not referenced by its document',
  'docs-map-missing-symbol': 'declared source symbol no longer exists',
  'declared-category-mismatch': 'declared category does not match its location',
  'declared-category-invalid': 'declared category is not a recognized value',
  'dangling-issue-ref': 'referenced issue no longer exists',
  'closed-draft-owner': 'draft document owns a closed issue',
};

/** Signals that are structural breakage (dead pointers), not just sprawl. */
const STRUCTURAL: ReadonlySet<DocHygieneSignal> = new Set([
  'broken-internal-link',
  'dangling-src-ref',
  'dangling-context-ref',
  'dangling-npm-script',
  'docs-map-missing-document',
  'docs-map-missing-source',
  'docs-map-missing-symbol',
  // A reference to a nonexistent issue is a dead pointer; the closed-draft-owner
  // signal is advisory (a draft that outlived its issue) and stays info-level.
  'dangling-issue-ref',
]);

// ── Declared-freshness contract (#2488) ────────────────────────────────────
//
// A document may OPT IN to a freshness expectation with two flat frontmatter
// keys. The grammar is deliberately tiny and deterministic — no calendar math,
// no NL — so a verdict is fully reproducible from the parsed graph.

/** Frontmatter key declaring the warn-after threshold. */
export const FRESHNESS_WARN_KEY = 'freshness.warn_after';
/** Frontmatter key declaring the error-after threshold. */
export const FRESHNESS_ERROR_KEY = 'freshness.error_after';

/**
 * Milliseconds per freshness-duration unit. FIXED windows, not calendar months:
 * `d` = 24 h, `w` = 7 days, `m` = 30 days — the same convention as the
 * memory-lifecycle `revalidateEvery` grammar, so a `30d`/`1m` reader is never
 * surprised.
 */
const FRESHNESS_UNIT_MS: Record<'d' | 'w' | 'm', number> = {
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  m: 30 * 24 * 60 * 60 * 1000,
};

/**
 * A positive integer (no leading zero, no sign) followed by exactly one unit.
 * Mirrors the memory-lifecycle interval grammar `/^[1-9][0-9]*[dwm]$/`, so a
 * malformed, zero, or negative value simply fails to match.
 */
const FRESHNESS_DURATION_RE = /^([1-9][0-9]*)([dwm])$/;

/**
 * Parse a `<positive-int><d|w|m>` duration to milliseconds, or `null` when it is
 * malformed, zero, negative, or overflows a safe integer. Pure and total.
 */
export function parseFreshnessDurationMs(raw: string): number | null {
  const match = FRESHNESS_DURATION_RE.exec(raw.trim());
  if (!match) return null;
  const n = Number(match[1]);
  // The regex already excludes zero, negatives, and leading zeros, so the only
  // remaining failure is a digit string long enough to lose integer precision —
  // an overflow, not a real threshold. Reject it rather than silently rounding.
  if (!Number.isSafeInteger(n)) return null;
  const ms = n * FRESHNESS_UNIT_MS[match[2] as 'd' | 'w' | 'm'];
  return Number.isSafeInteger(ms) ? ms : null;
}

/** A declared, self-consistent freshness contract (either threshold optional). */
export interface DeclaredFreshnessContract {
  /** Warn-after threshold in ms, or `null` when the key is absent. */
  warnAfterMs: number | null;
  /** Error-after threshold in ms, or `null` when the key is absent. */
  errorAfterMs: number | null;
  /** Verbatim declared strings, kept for auditable evidence. */
  warnRaw?: string;
  errorRaw?: string;
}

/**
 * Classify the freshness contract declared in a doc's frontmatter:
 *  - `none`    — neither key present (the doc did not opt in; stay silent).
 *  - `invalid` — a present key is malformed/zero/negative/overflow, or both are
 *                present but reversed (`warn_after > error_after`). Suppresses.
 *  - `ok`      — a self-consistent contract (equal thresholds are valid).
 */
export function readFreshnessContract(
  frontmatter: DocFrontmatter
):
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'ok'; contract: DeclaredFreshnessContract } {
  const warnRaw = frontmatter[FRESHNESS_WARN_KEY];
  const errorRaw = frontmatter[FRESHNESS_ERROR_KEY];
  if (warnRaw === undefined && errorRaw === undefined) return { kind: 'none' };
  const warnAfterMs = warnRaw === undefined ? null : parseFreshnessDurationMs(warnRaw);
  const errorAfterMs = errorRaw === undefined ? null : parseFreshnessDurationMs(errorRaw);
  // A present-but-unparseable threshold invalidates the whole contract — a doc
  // that tried to declare a threshold and got it wrong gets no partial verdict.
  if (warnRaw !== undefined && warnAfterMs === null) return { kind: 'invalid' };
  if (errorRaw !== undefined && errorAfterMs === null) return { kind: 'invalid' };
  // Reversed ordering when both appear is a contradiction, not a contract.
  if (warnAfterMs !== null && errorAfterMs !== null && warnAfterMs > errorAfterMs) {
    return { kind: 'invalid' };
  }
  return {
    kind: 'ok',
    contract: { warnAfterMs, errorAfterMs, warnRaw, errorRaw },
  };
}

/** A fired declared-freshness verdict, carrying every auditable evidence field. */
export interface DeclaredFreshnessFinding {
  /** Repo-relative POSIX path of the document. */
  path: string;
  /** `error` at/after `error_after`, else `warn` at/after `warn_after`. */
  verdict: 'warn' | 'error';
  /** Authoritative Git modification time (ISO 8601). */
  gitIso: string;
  /** `gitIso` truncated to `YYYY-MM-DD` for evidence wording. */
  gitDate: string;
  /** Authoritative provenance of `gitIso` (`git` or a commit-bound `manifest`). */
  provenance: 'git' | 'manifest';
  /** Which declared threshold was crossed. */
  thresholdKey: 'warn_after' | 'error_after';
  /** The verbatim declared threshold string that was crossed (e.g. `180d`). */
  thresholdRaw: string;
  /** Evaluation date (`YYYY-MM-DD`) the age was measured as of. */
  asOf: string;
}

/** `YYYY-MM-DD` for an epoch-ms instant (UTC), matching memory-hygiene's asOf. */
function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Evaluate a node's OPT-IN declared-freshness contract against its authoritative
 * Git time at the injected `now`. Returns a `warn`/`error` finding, or `null`
 * when the doc did not opt in, the contract is invalid, or the time is not
 * authoritative/usable (missing, non-`git`/`manifest` provenance, unparseable,
 * implausibly old, or future/clock-skewed). A `pass` (still fresh) also yields
 * `null` — only a crossed threshold is a finding. Pure: no I/O, deterministic
 * in `now`.
 */
export function evaluateDeclaredFreshness(
  node: DocNode,
  now: number
): DeclaredFreshnessFinding | null {
  const parsed = readFreshnessContract(node.frontmatter);
  if (parsed.kind !== 'ok') return null;
  // Only authoritative Git time may be judged. An absent provenance is treated
  // exactly like `filesystem`/`unavailable` — never as Git history (#2707).
  const provenance = node.gitMtimeProvenance;
  if (provenance !== 'git' && provenance !== 'manifest') return null;
  const iso = node.gitMtimeIso;
  if (!iso) return null;
  const gitMs = Date.parse(iso);
  if (!Number.isFinite(gitMs)) return null;
  // Epoch-adjacent or future/clock-skewed times are not trustworthy evidence.
  if (gitMs < DOC_GIT_TIMES_MIN_TIME_MS) return null;
  if (gitMs > now) return null;
  const age = now - gitMs;
  const { warnAfterMs, errorAfterMs, warnRaw, errorRaw } = parsed.contract;
  const base = {
    path: node.path,
    gitIso: iso,
    gitDate: isoDate(gitMs),
    provenance,
    asOf: isoDate(now),
  } as const;
  // error wins at/after its boundary; equal thresholds therefore resolve to
  // error at the shared boundary because error is checked first.
  if (errorAfterMs !== null && age >= errorAfterMs) {
    return { ...base, verdict: 'error', thresholdKey: 'error_after', thresholdRaw: errorRaw! };
  }
  if (warnAfterMs !== null && age >= warnAfterMs) {
    return { ...base, verdict: 'warn', thresholdKey: 'warn_after', thresholdRaw: warnRaw! };
  }
  return null;
}

/** Signal 4: docs whose authoritative Git time is past their declared contract. */
function scanDeclaredFreshness(graph: DocGraph, now: number): DocHygieneItem[] {
  const items: DocHygieneItem[] = [];
  for (const node of graph.nodes) {
    const finding = evaluateDeclaredFreshness(node, now);
    if (!finding) continue;
    items.push({
      path: finding.path,
      signal: 'stale-declared-freshness',
      origin: 'doc-graph.freshness',
      freshness: finding,
    });
  }
  return items;
}

/**
 * Signal (#2472): a document's OPT-IN `category:` frontmatter declaration drifts
 * from its path-derived category. Two DISTINGUISHABLE items, because the fix
 * differs:
 *  - `declared-category-invalid` — the declared value is outside the exact-case
 *    vocabulary (a typo, or a wrong-case token like `ADR`). The fix is to
 *    replace the token, so it must never be described as an ordinary mismatch.
 *  - `declared-category-mismatch` — a VALID declaration that differs from the
 *    directory-derived category. `deriveCategory` is purely directory-based, so
 *    neither side is assumed authoritative (the file may be misfiled OR the
 *    label wrong); the evidence cites both and asks a human to reconcile either.
 *
 * The declaration is OPT-IN: a missing `category:` key is neutral (never a
 * warning), and a declaration that matches its derived category is silent. The
 * frontmatter value is already trimmed and unquoted by `parseFrontmatter`. An
 * explicitly empty top-level value is retained and classified as invalid, so
 * it cannot collapse into the neutral "missing declaration" state.
 */
function scanDeclaredCategory(graph: DocGraph): DocHygieneItem[] {
  const items: DocHygieneItem[] = [];
  for (const node of graph.nodes) {
    const declared = node.frontmatter['category'];
    if (declared === undefined) continue; // opt-in: no declaration → neutral
    if (!isDocCategory(declared)) {
      items.push({
        path: node.path,
        signal: 'declared-category-invalid',
        origin: 'doc-graph.category',
        category: { declared, derived: node.category },
      });
      continue;
    }
    if (declared !== node.category) {
      items.push({
        path: node.path,
        signal: 'declared-category-mismatch',
        origin: 'doc-graph.category',
        category: { declared, derived: node.category },
      });
    }
  }
  return items;
}

// ── Issue-reference contract (#2711) ────────────────────────────────────────
//
// Two signals gated on the OPT-IN issue-state snapshot (#2710). Both are
// recommend-only and share ONE trust check: the snapshot must be present,
// complete, still usable at the injected `now` (<=24h), and its resolved ref
// set must EXACTLY equal the graph's current `issue-ref` numbers (a subset OR a
// superset mismatch means the snapshot no longer describes exactly this graph,
// so BOTH signals suppress). No `fix` — the pointer needs a human.

/** The frontmatter `issue:` owner grammar the closed-draft-owner signal accepts. */
const DRAFT_ISSUE_OWNER_RE = /^#[1-9]\d*$/;

/** Parse `issue:<n>` (an `issue-ref` edge target) to its positive integer, or null. */
function issueNumberFromEdge(to: string): number | null {
  const raw = to.startsWith('issue:') ? to.slice('issue:'.length) : to;
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * The single shared trust gate for BOTH #2711 signals. Returns the
 * number→state map when the snapshot may be trusted for exactly this graph, or
 * `null` (suppress both) when it is absent, incomplete, stale at `now`, or its
 * ref set does not EXACTLY match the graph's current `issue-ref` numbers. Uses
 * the injected `now` — never `Date.now()` — so the verdict is deterministic.
 */
function issueSnapshotGate(
  graph: DocGraph,
  snapshot: DocIssueSnapshot | null | undefined,
  now: number
): Map<number, DocIssueState> | null {
  if (!snapshot || snapshot.complete !== true) return null;
  if (!isDocIssueSnapshotUsable(snapshot, now)) return null;
  const graphRefs = canonicalRefSet(
    graph.edges
      .filter((edge) => edge.kind === 'issue-ref')
      .map((edge) => issueNumberFromEdge(edge.to))
      .filter((n): n is number => n !== null)
  );
  const snapshotRefs = canonicalRefSet(snapshot.refs);
  if (graphRefs.length !== snapshotRefs.length) return null;
  for (let i = 0; i < graphRefs.length; i += 1) {
    if (graphRefs[i] !== snapshotRefs[i]) return null;
  }
  return docIssueStateByNumber(snapshot);
}

/**
 * Signal (#2711): an `issue-ref` edge to a `#N` the snapshot resolved to an
 * explicit `not-found`. Iterates the graph edges (a body-prose or frontmatter
 * `#N` both qualify — the reference is dead either way); the path comes from the
 * slug→path map the caller already built.
 */
function scanDanglingIssueRefs(
  graph: DocGraph,
  stateByNumber: ReadonlyMap<number, DocIssueState>,
  asOf: string,
  pathBySlug: ReadonlyMap<string, string>
): DocHygieneItem[] {
  const items: DocHygieneItem[] = [];
  for (const edge of graph.edges) {
    if (edge.kind !== 'issue-ref') continue;
    const n = issueNumberFromEdge(edge.to);
    if (n === null) continue;
    if (stateByNumber.get(n) !== 'not-found') continue;
    const fromPath = pathBySlug.get(edge.from) ?? edge.from;
    items.push({
      path: fromPath,
      signal: 'dangling-issue-ref',
      // `target` keeps two distinct dead refs from the SAME doc apart in the
      // item dedup (which keys on signal+path+target); without it the second
      // ref collapses into the first and is silently under-counted.
      target: `#${n}`,
      origin: 'doc-graph.issue-ref',
      issueRef: { number: n, state: 'not-found', asOf },
    });
  }
  return items;
}

/**
 * Signal (#2711): a doc whose frontmatter declares `status: draft` (exact) and
 * owns a `#N` in `issue:` (exact `/^#[1-9]\d*$/`) whose snapshot state is
 * `closed`. Reads frontmatter ONLY — never the edges — so a doc that merely
 * mentions a closed issue in its body prose stays silent. (`closed` also covers
 * a merged PR, which the snapshot normalizes to `closed`.)
 */
function scanClosedDraftOwners(
  graph: DocGraph,
  stateByNumber: ReadonlyMap<number, DocIssueState>,
  asOf: string
): DocHygieneItem[] {
  const items: DocHygieneItem[] = [];
  for (const node of graph.nodes) {
    if (node.frontmatter['status'] !== 'draft') continue;
    const match = DRAFT_ISSUE_OWNER_RE.exec(node.frontmatter['issue'] ?? '');
    if (!match) continue;
    const n = Number(match[0].slice(1));
    if (stateByNumber.get(n) !== 'closed') continue;
    items.push({
      path: node.path,
      signal: 'closed-draft-owner',
      target: `#${n}`,
      origin: 'doc-graph.issue-ref',
      issueRef: { number: n, state: 'closed', asOf },
    });
  }
  return items;
}

/** Normalise a path for comparison: backslashes → slashes, strip a `./` prefix. */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Browser-safe root normalization for an exact graph-to-repo-map join. */
function normRoot(p: string): string {
  const normalized = p.replace(/\\/g, '/');
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
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
 * The doc graph has no source-file oracle, so this uses only the `repoMap`
 * project(s) whose absolute root exactly matches `graph.root`. A map from some
 * other user project cannot prove anything about this graph. The matched
 * inventory must also be complete, non-truncated, and cover the referenced
 * extension so absence is real rather than a coverage gap.
 */
function scanDanglingSrcRefs(
  graph: DocGraph,
  repoMap: RepoMapDataset | null | undefined,
  pathBySlug: ReadonlyMap<string, string>
): DocHygieneItem[] {
  if (!repoMap || repoMap.projects.length === 0) return [];
  // Legacy/uploaded graphs without a root fail closed: there is no safe join.
  if (typeof graph.root !== 'string' || graph.root.length === 0) return [];
  const graphRoot = normRoot(graph.root);
  if (graphRoot.length === 0) return [];
  const projects = repoMap.projects.filter(
    (project) =>
      typeof project.root === 'string' && normRoot(project.root) === graphRoot
  );
  if (projects.length === 0) return [];
  // A partial inventory cannot prove a file is gone. `truncated` covers the
  // established rendered-map guard; fileCount also catches size-bound artifact
  // compaction that can drop structured file rows independently of that flag.
  if (
    projects.some(
      (project) => project.truncated || project.files.length !== project.fileCount
    )
  ) {
    return [];
  }

  const known = new Set<string>();
  const coveredExts = new Set<string>();
  for (const proj of projects) {
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

/**
 * Resolve the SINGLE repo-map project the docs-map wrapper's declared
 * `repository`+`commit` identity matches (#2489), or `null` when the
 * repo-map-backed pair (missing-source / missing-symbol) must suppress.
 * Identity is repository+commit ONLY — never a declared file, never the doc
 * graph root — and both sides are case-folded since they are independently
 * produced lowercase. A missing wrapper identity, zero or multiple candidate
 * projects, or a candidate that is truncated / has an incomplete file list all
 * suppress: there is no safe partial match.
 */
function matchDocsMapProject(
  wrapper: DocsMapArtifact,
  repoMap: RepoMapDataset | null | undefined
): RepoMapProjectJoin | null {
  if (wrapper.repository === null || wrapper.commit === null) return null;
  if (!repoMap) return null;
  const repoLower = wrapper.repository.toLowerCase();
  const commitLower = wrapper.commit.toLowerCase();
  const candidates = repoMap.projects.filter(
    (project) =>
      project.repository !== null &&
      project.generatedAtGitSha !== null &&
      project.repository.toLowerCase() === repoLower &&
      project.generatedAtGitSha.toLowerCase() === commitLower
  );
  if (candidates.length !== 1) return null;
  const project = candidates[0];
  if (project.truncated || project.files.length !== project.fileCount) return null;
  return project;
}

/**
 * Signals 1/2/3/4 (#2489): drift between the STRICTLY declared
 * `docs/docs-map.json` wrapper and its two oracles — the doc graph (document
 * existence + `src-ref` edges) and the identity-matched repo-map project
 * (source-file + symbol existence). Walks ONLY `wrapper.map.documents`; a
 * body-only `src-ref` edge to a path the map never declared is never in scope
 * (one-way direction — the map is the sole source of what to check). The
 * caller guarantees `graph.nodes.length > 0` (empty-graph suppression is
 * handled once, centrally, in `rule()`).
 */
function scanDocsMapDrift(
  wrapper: DocsMapArtifact,
  graph: DocGraph,
  repoMap: RepoMapDataset | null | undefined
): DocHygieneItem[] {
  const items: DocHygieneItem[] = [];

  const nodeByNormPath = new Map<string, DocNode>();
  for (const n of graph.nodes) nodeByNormPath.set(normPath(n.path), n);

  const matchedProject = matchDocsMapProject(wrapper, repoMap);
  type RepoFile = RepoMapProjectJoin['files'][number];
  let referencedSourcesBySlug: Map<string, Set<string>> | undefined;
  let fileByNormPath: Map<string, RepoFile> | undefined;
  let symbolNamesByFile: Map<RepoFile, Set<string>> | undefined;

  const referencedSources = (): Map<string, Set<string>> => {
    if (referencedSourcesBySlug) return referencedSourcesBySlug;
    // perf-index-contract: docs-map-drift-indexes non-querying
    referencedSourcesBySlug = new Map<string, Set<string>>();
    for (const edge of graph.edges) {
      if (edge.kind !== 'src-ref') continue;
      let paths = referencedSourcesBySlug.get(edge.from);
      if (!paths) {
        // perf-index-contract: docs-map-drift-indexes non-querying
        paths = new Set<string>();
        referencedSourcesBySlug.set(edge.from, paths);
      }
      paths.add(
        normPath(edge.to.startsWith('src:') ? edge.to.slice(4) : edge.to)
      );
    }
    return referencedSourcesBySlug;
  };
  const matchedFiles = (): Map<string, RepoFile> => {
    if (fileByNormPath) return fileByNormPath;
    // perf-index-contract: docs-map-drift-indexes non-querying
    fileByNormPath = new Map<string, RepoFile>();
    for (const file of matchedProject?.files ?? []) {
      fileByNormPath.set(normPath(file.path), file);
    }
    return fileByNormPath;
  };
  const symbolNames = (file: RepoFile): Set<string> => {
    // perf-index-contract: docs-map-drift-indexes non-querying
    symbolNamesByFile ??= new Map<RepoFile, Set<string>>();
    let names = symbolNamesByFile.get(file);
    if (!names) {
      // perf-index-contract: docs-map-drift-indexes non-querying
      names = new Set(file.symbols.map((symbol) => symbol.name));
      symbolNamesByFile.set(file, names);
    }
    return names;
  };

  for (const [documentPath, doc] of Object.entries(wrapper.map.documents)) {
    const node = nodeByNormPath.get(normPath(documentPath));
    const docExists = node !== undefined;
    if (!docExists) {
      items.push({
        path: documentPath,
        signal: 'docs-map-missing-document',
        origin: 'docs-map',
      });
    }

    for (const source of doc.sources) {
      // Signal 3: only meaningful once the document itself exists — a missing
      // doc would trivially "fail to reference" every one of its sources.
      if (docExists) {
        const sourceNormPath = normPath(source.path);
        const isReferenced =
          referencedSources().get(node!.slug)?.has(sourceNormPath) ?? false;
        if (!isReferenced) {
          items.push({
            path: documentPath,
            signal: 'docs-map-unreferenced-source',
            target: source.path,
            origin: 'docs-map',
          });
        }
      }

      // Signals 2 + 4: independent of document existence — these are repo-map
      // claims about the source file, not doc-graph claims.
      if (matchedProject) {
        const file = matchedFiles().get(normPath(source.path));
        if (!file) {
          items.push({
            path: documentPath,
            signal: 'docs-map-missing-source',
            target: source.path,
            origin: 'docs-map',
          });
          continue; // no symbol claim about a file that is gone
        }
        for (const symbol of source.symbols) {
          if (!symbolNames(file).has(symbol)) {
            items.push({
              path: documentPath,
              signal: 'docs-map-missing-symbol',
              target: source.path,
              symbol,
              origin: 'docs-map',
            });
          }
        }
      }
    }
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

/**
 * One evidence row for an item. A `stale-declared-freshness` item renders its
 * full auditable verdict — path, authoritative Git date + provenance, the
 * crossed declared threshold, the evaluation `asOf`, and the verdict — and, by
 * design, makes NO claim that the document's content is wrong or currently
 * stale; it reports only that the last Git edit is past a declared threshold.
 */
function evidenceLine(it: DocHygieneItem): string {
  if (it.signal === 'stale-declared-freshness' && it.freshness) {
    const f = it.freshness;
    return (
      `${it.path} — last Git modification ${f.gitDate} (${f.provenance}) is past its ` +
      `declared ${f.thresholdKey} threshold (${f.thresholdRaw}) as of ${f.asOf} → ${f.verdict}`
    );
  }
  if (it.issueRef) {
    // Recomputed live at `now`, so the wording carries an explicit "as of
    // <date>" and never asserts the reference is currently gone — only that the
    // snapshot resolved it so as of that date.
    const r = it.issueRef;
    return `${it.path} -> #${r.number} — ${SIGNAL_LABEL[it.signal]} (as of ${r.asOf})`;
  }
  if (it.category) {
    const { declared, derived } = it.category;
    if (it.signal === 'declared-category-invalid') {
      // Distinct from a mismatch: the token itself is unrecognised, so the fix
      // is to replace it — never "the file is misfiled".
      return (
        `${it.path} — declared category "${declared}" is not a recognized category ` +
        `(expected one of: ${DOC_CATEGORIES.join(', ')})`
      );
    }
    // Neutral: cite the declared value and the location-derived value without
    // asserting which is authoritative — reconcile either side.
    return (
      `${it.path} — declared category "${declared}" but its location implies "${derived}" ` +
      `(reconcile the file's location or its \`category:\` label)`
    );
  }
  if (it.origin === 'docs-map') {
    const target = it.target
      ? ` -> ${it.target}${it.symbol ? ` (symbol ${it.symbol})` : ''}`
      : '';
    return (
      `${it.path}${target} — ${SIGNAL_LABEL[it.signal]} ` +
      `(declared in docs/docs-map.json)`
    );
  }
  return (
    `${it.path}${it.line ? `:${it.line}` : ''}` +
    `${it.target ? ` -> ${it.target}` : ''} — ${SIGNAL_LABEL[it.signal]}`
  );
}

export const detector: Detector = {
  id: 'maintenance.doc-hygiene',
  category: 'maintenance',
  dataDeps: ['docGraph', 'repoMap', 'docHygieneArtifact', 'docsMap', 'docIssueSnapshot'],
  rule(input: RecommendationInput, now: number): Recommendation | null {
    const graph = input.docGraph;
    const artifactItems = scanArtifactFindings(input.docHygieneArtifact);
    // The #2711 issue-reference pair recomputes its "as of" date live from the
    // snapshot; kept in scope for the observation/action/inference wording.
    const snapshot = input.docIssueSnapshot;
    const issueSnapshotAsOf =
      snapshot && Number.isFinite(Date.parse(snapshot.asOf))
        ? isoDate(Date.parse(snapshot.asOf))
        : null;
    let graphItems: DocHygieneItem[] = [];
    if (graph && graph.nodes.length > 0) {
      const pathBySlug = new Map(graph.nodes.map((n) => [n.slug, n.path]));
      const nodeSlugs = new Set(graph.nodes.map((n) => n.slug));
      // ONE shared trust gate for both #2711 signals — computed once. A null
      // gate (absent/incomplete/stale/ref-set-mismatch) suppresses BOTH.
      const stateByNumber = issueSnapshotGate(graph, snapshot, now);
      graphItems = [
        ...scanBrokenLinks(graph, nodeSlugs, pathBySlug),
        ...scanOrphans(graph),
        ...scanDanglingSrcRefs(graph, input.repoMap, pathBySlug),
        ...scanDeclaredFreshness(graph, now),
        ...scanDeclaredCategory(graph),
        ...(stateByNumber && issueSnapshotAsOf
          ? scanDanglingIssueRefs(graph, stateByNumber, issueSnapshotAsOf, pathBySlug)
          : []),
        ...(stateByNumber && issueSnapshotAsOf
          ? scanClosedDraftOwners(graph, stateByNumber, issueSnapshotAsOf)
          : []),
        ...(input.docsMap ? scanDocsMapDrift(input.docsMap, graph, input.repoMap) : []),
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
      'dangling-issue-ref',
      'docs-map-missing-document',
      'docs-map-missing-source',
      'docs-map-missing-symbol',
      'docs-map-unreferenced-source',
      'stale-declared-freshness',
      'declared-category-mismatch',
      'declared-category-invalid',
      'closed-draft-owner',
      'orphan',
    ];
    const breakdown = order
      .filter((s) => counts[s])
      .map((s) => `${counts[s]} ${SIGNAL_LABEL[s]}`)
      .join(', ');

    // Structural breakage and an `error`-level freshness verdict both raise the
    // card to a warning; a `warn` verdict and sprawl stay informational.
    const severity: RecSeverity = items.some(
      (it) => STRUCTURAL.has(it.signal) || it.freshness?.verdict === 'error'
    )
      ? 'warning'
      : 'info';

    // A handful of supporting rows, most severe first: structural breakage,
    // then `error`-level freshness, then everything else.
    const rank = (it: DocHygieneItem): number =>
      STRUCTURAL.has(it.signal) ? 2 : it.freshness?.verdict === 'error' ? 1 : 0;
    const evidenceOrder = (a: DocHygieneItem, b: DocHygieneItem): number =>
      rank(b) - rank(a) ||
      a.path.localeCompare(b.path) ||
      (a.line ?? 0) - (b.line ?? 0);
    const orderedItems = [...items].sort(evidenceOrder);
    // A declared-category claim is only auditable when its path and both values
    // remain visible. Reserve one row for each active category subtype before
    // filling the eight-row cap with the normal severity ordering.
    const selectedItems: DocHygieneItem[] = [];
    const selected = new Set<DocHygieneItem>();
    for (const signal of [
      'declared-category-mismatch',
      'declared-category-invalid',
    ] as const) {
      const representative = orderedItems.find((item) => item.signal === signal);
      if (!representative) continue;
      selectedItems.push(representative);
      selected.add(representative);
    }
    for (const item of orderedItems) {
      if (selectedItems.length >= 8) break;
      if (selected.has(item)) continue;
      selectedItems.push(item);
      selected.add(item);
    }
    const evidence = selectedItems.sort(evidenceOrder).map(evidenceLine);

    const graphItemCount = items.filter((item) => item.origin === 'doc-graph').length;
    const artifactItemCount = items.filter((item) => item.origin === 'lychee.local-links').length;
    const agentsLintItemCount = items.filter(
      (item) => item.origin === 'agents-lint.context-refs',
    ).length;
    const graphDanglingSrcCount = items.filter(
      (item) => item.origin === 'doc-graph' && item.signal === 'dangling-src-ref',
    ).length;
    const freshnessCount = items.filter(
      (item) => item.signal === 'stale-declared-freshness',
    ).length;
    const declaredCategoryMismatchCount = counts['declared-category-mismatch'] ?? 0;
    const declaredCategoryInvalidCount = counts['declared-category-invalid'] ?? 0;
    const declaredCategoryCount =
      declaredCategoryMismatchCount + declaredCategoryInvalidCount;
    // #2489's two docs-map oracles are cited separately: 1+3 read the map's
    // own declarations against the doc graph, 2+4 read them against the
    // identity-matched repo-map project.
    const docsMapGraphCount = items.filter(
      (item) =>
        item.origin === 'docs-map' &&
        (item.signal === 'docs-map-missing-document' ||
          item.signal === 'docs-map-unreferenced-source'),
    ).length;
    const docsMapRepoCount = items.filter(
      (item) =>
        item.origin === 'docs-map' &&
        (item.signal === 'docs-map-missing-source' ||
          item.signal === 'docs-map-missing-symbol'),
    ).length;
    const docsMapCount = docsMapGraphCount + docsMapRepoCount;
    // #2711: the two issue-reference signals share one snapshot oracle.
    const danglingIssueRefCount = counts['dangling-issue-ref'] ?? 0;
    const closedDraftOwnerCount = counts['closed-draft-owner'] ?? 0;
    const issueSnapshotCount = danglingIssueRefCount + closedDraftOwnerCount;
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
        field:
          'docGraph.root + repoMap.projects[root=docGraph.root].files[].path',
        value: graphDanglingSrcCount,
      });
    }
    // Signal 4's oracle is the node's declared frontmatter contract joined to the
    // authoritative Git time (#2707) — cite both the keys and the provenance.
    if (freshnessCount > 0) {
      observations.push({
        claim: `${freshnessCount} document(s) whose authoritative Git modification time is past their own declared freshness threshold`,
        source: 'parse-docs',
        field:
          'docGraph.nodes[].{frontmatter[freshness.warn_after|freshness.error_after], gitMtimeIso, gitMtimeProvenance}',
        value: freshnessCount,
      });
    }
    // #2472: the opt-in `category:` declaration read against the path-derived
    // category — both sides come straight from the parsed doc graph node.
    if (declaredCategoryCount > 0) {
      observations.push({
        claim: `${declaredCategoryCount} document(s) whose opt-in category: declaration is unrecognized or does not match the path-derived category`,
        source: 'parse-docs',
        field: 'docGraph.nodes[].{frontmatter[category], category}',
        value: declaredCategoryCount,
      });
    }
    // #2489 signals 1+3: the declared map itself against the doc graph's
    // document existence and derived src-ref edges.
    if (docsMapGraphCount > 0) {
      observations.push({
        claim: `${docsMapGraphCount} docs/docs-map.json declaration(s) whose document is missing from the doc graph or is not referenced by that document's own src-ref edges`,
        source: 'parse-docs-map',
        field:
          'docsMap.map.{version,documents[<path>].sources} + docGraph.edges[kind=src-ref].{from,to}',
        value: docsMapGraphCount,
      });
    }
    // #2489 signals 2+4: the declared map against the identity-matched
    // repo-map project's file and symbol inventory.
    if (docsMapRepoCount > 0) {
      observations.push({
        claim: `${docsMapRepoCount} docs/docs-map.json declaration(s) whose source file or bound symbol is absent from the identity-matched repo-map project`,
        source: 'parse-repo-map-join',
        field:
          'repoMap.projects[repository=docsMap.repository,generatedAtGitSha=docsMap.commit].files[].{path,symbols[].name}',
        value: docsMapRepoCount,
      });
    }
    // #2711: the opt-in issue-state snapshot resolved a documentation issue
    // reference to a nonexistent issue, or a draft doc's frontmatter owner to a
    // closed issue. Both are gated on an exact ref-set match at `now`; cite the
    // snapshot records plus the graph edge / frontmatter fields.
    if (issueSnapshotCount > 0 && issueSnapshotAsOf) {
      observations.push({
        claim:
          `${issueSnapshotCount} documentation issue reference(s) the opt-in issue-state snapshot resolved to a nonexistent issue or a draft-owned closed issue, as of ${issueSnapshotAsOf}`,
        source: 'doc-issue-snapshot',
        field:
          'docIssueSnapshot.records[].{number,state} + docGraph.edges[kind=issue-ref].to + docGraph.nodes[].frontmatter[status|issue]',
        value: issueSnapshotCount,
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
        `update stale file and npm-script references, and link or retire the orphaned docs.` +
        (freshnessCount > 0
          ? ` For a document past its declared freshness threshold, manually refresh it or intentionally revise its ` +
            `\`freshness.warn_after\`/\`freshness.error_after\` contract.`
          : '') +
        (docsMapCount > 0
          ? ` For a docs-map declaration drift, update the document (or the source/symbol it describes) to match, ` +
            `or correct the stale entry in \`docs/docs-map.json\` itself.`
          : '') +
        (declaredCategoryMismatchCount > 0
          ? ` For a document whose declared \`category:\` does not match its location, either move the file or correct the ` +
            `label.`
          : '') +
        (declaredCategoryInvalidCount > 0
          ? ` For an unrecognized \`category:\` value, replace it with a recognized category.`
          : '') +
        (issueSnapshotCount > 0 && issueSnapshotAsOf
          ? ` For a documentation issue reference the snapshot resolved as nonexistent, or a \`status: draft\` doc that still owns a now-closed issue (as of ${issueSnapshotAsOf}), manually re-verify the reference and update or remove the stale pointer.`
          : ''),
      affected: n,
      // No honest dollar unit — score on minutes to review each flagged item.
      estTimeReclaimedMin: n,
      evidence,
      provenance: {
        observations,
        inference:
          `Each issue is read from the parsed doc graph or a commit-bound adapted host-checker artifact; overlapping missing-link and source-reference facts prefer exact checker line spans, while ` +
          `graph-native source references use the repo-map inventory and adapted source references use the commit-bound host checker, so all ${n} are reproducible — ` +
          `a maintenance pass to keep the repo doc corpus linked and its references live.` +
          (freshnessCount > 0
            ? ` Declared-freshness verdicts compare each document's authoritative Git modification time (provenance \`git\` or a commit-bound \`manifest\`, never the Docker/filesystem mtime) ` +
              `against its own opt-in \`freshness.warn_after\`/\`freshness.error_after\` threshold as of the evaluation time, and never assert the content is wrong or currently stale.`
            : '') +
          (declaredCategoryCount > 0
            ? ` A declared-category item compares each document's opt-in \`category:\` frontmatter against its directory-derived category, citing both sides without asserting which is authoritative — a valid mismatch and an unrecognized value are distinct items with distinct fixes.`
            : '') +
          (issueSnapshotCount > 0 && issueSnapshotAsOf
            ? ` Issue-reference verdicts compare each doc's \`issue-ref\` edge or \`status: draft\` frontmatter owner against the opt-in, freshness-bounded GitHub issue-state snapshot (as of ${issueSnapshotAsOf}), firing only on a present, complete, still-usable snapshot whose resolved ref set exactly matches the graph's; they never assert the reference is currently gone, only that the snapshot resolved it so as of that date.`
            : ''),
      },
    };
  },
};
