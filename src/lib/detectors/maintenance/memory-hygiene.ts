/**
 * Detector: maintenance.memory-hygiene
 *
 * Agents persist durable facts under `~/.claude/projects/<slug>/memory/*.md`,
 * with a per-project `MEMORY.md` index the harness auto-injects at SessionStart.
 * That store decays like any other: the index outgrows its soft budget, lines
 * sprawl, pointers dangle, files go unindexed, and `[[wikilinks]]` reference
 * memories that were never written. A bloated or broken index degrades every
 * session's context inject, so keeping the store lean is real upkeep — the
 * entirely-manual version of this audit (issue #1779) took a fan-out of agents
 * plus human judgment to prune an over-limit index.
 *
 * This detector implements the FIVE deterministic signals from #1779 — the ones
 * that are near-certain from the parsed store alone, no heuristics:
 *
 *   1. oversized-index     — `MEMORY.md` over the ~24.4KB soft budget.
 *   2. long-index-line     — a single index pointer line over ~200 chars.
 *   3. dangling-index-link — an index line points to a `file.md` not on disk.
 *   4. unindexed-file      — a memory file on disk with no `MEMORY.md` pointer.
 *   5. dangling-wikilink   — a `[[name]]` body reference with no matching memory.
 *
 * The heuristic signals from the issue (superseded / duplicate-pair / decayed
 * project-state — its #6-8) are a SEPARATE lower-confidence follow-on, not this
 * slice. Recommend-only: the output is advisory and never deletes or mutates a
 * memory; the human (or an agent) acts, mirroring the manual pass.
 *
 * Reads `input.memoryStores` (the per-project store + index built by
 * `buildMemoryStores` in `parse-memories.ts`, the #1965 foundation). When that
 * is absent/empty — the SPA/upload dataset, or no memory dirs — the detector
 * stays silent. The finding is current filesystem state, not a time-derived
 * trend, so it carries structured `provenance` (observations citing the parsed
 * store) but needs no `asOf`/staleness demotion.
 *
 * Issue: #1779 (epic #1910 — new behaviour & cost detectors)
 */

import type {
  Detector,
  RecommendationInput,
  Recommendation,
  RecObservation,
  RecSeverity,
} from '../types';
import type { ProjectMemoryStore } from '../../parse-memories';

/**
 * `MEMORY.md` soft byte budget — the harness already warns when the auto-injected
 * index grows past roughly this size, so an over-budget index is a near-certain
 * "tighten me" signal. Byte length (UTF-8), not character count, matches what the
 * harness measures.
 */
export const INDEX_SIZE_BUDGET_BYTES = 24_400;

/**
 * Per-line ceiling for an index pointer. The memory contract documents one
 * one-line link per memory (`- [Title](file.md) — hook`); a line past this is
 * sprawling and should be trimmed back to a hook.
 */
export const INDEX_LINE_MAX_CHARS = 200;

/** The five deterministic hygiene signals this slice emits. */
export type MemoryHygieneSignal =
  | 'oversized-index'
  | 'long-index-line'
  | 'dangling-index-link'
  | 'unindexed-file'
  | 'dangling-wikilink';

/** One flagged hygiene item: which memory/index, which signal, what to do. */
export interface MemoryHygieneItem {
  /** The `~/.claude/projects/<slug>` directory name. */
  project: string;
  /** Display path, e.g. `<slug>/MEMORY.md` or `<slug>/foo.md`. */
  path: string;
  signal: MemoryHygieneSignal;
  /** Recommend-only suggested action (never an auto-delete). */
  action: string;
}

/** Short label per signal for evidence rows. */
const SIGNAL_LABEL: Record<MemoryHygieneSignal, string> = {
  'oversized-index': 'index over size budget',
  'long-index-line': 'index line too long',
  'dangling-index-link': 'index link points to a missing file',
  'unindexed-file': 'memory file missing from the index',
  'dangling-wikilink': 'wikilink to a non-existent memory',
};

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)}KB`;

/** UTF-8 byte length, portable across browser / Node (no `Buffer`). */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/**
 * Distinct `[[name]]` targets referenced in a memory body. The contract keys a
 * wikilink on the other memory's `name:` slug, so we take the part before any
 * `|alias` / `#section` decoration and de-duplicate within the body.
 */
function extractWikilinkTargets(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(WIKILINK_RE)) {
    const name = m[1].split(/[|#]/)[0].trim();
    if (name) out.add(name);
  }
  return [...out];
}

/** Scan one project's store for all five deterministic signals. */
function scanStore(store: ProjectMemoryStore): MemoryHygieneItem[] {
  const items: MemoryHygieneItem[] = [];
  const slug = store.project;
  const hasIndex = store.indexRaw !== '';
  const fileSet = new Set(store.memories.map((m) => m.file));
  const nameSet = new Set(store.memories.map((m) => m.name));
  const indexedFiles = new Set(store.index.map((e) => e.file));

  // 1. oversized index
  if (hasIndex) {
    const bytes = byteLength(store.indexRaw);
    if (bytes > INDEX_SIZE_BUDGET_BYTES) {
      items.push({
        project: slug,
        path: `${slug}/MEMORY.md`,
        signal: 'oversized-index',
        action: `Trim the index — ${kb(bytes)} is over the ~${kb(
          INDEX_SIZE_BUDGET_BYTES
        )} soft budget; remove dead entries and shorten verbose hooks.`,
      });
    }
  }

  // 2. long index line
  for (const entry of store.index) {
    if (entry.raw.length > INDEX_LINE_MAX_CHARS) {
      items.push({
        project: slug,
        path: `${slug}/MEMORY.md`,
        signal: 'long-index-line',
        action: `Shorten the index line for "${entry.title}" (${entry.raw.length} chars > ${INDEX_LINE_MAX_CHARS}) to a single hook.`,
      });
    }
  }

  // 3. dangling index link
  for (const entry of store.index) {
    if (!fileSet.has(entry.file)) {
      items.push({
        project: slug,
        path: `${slug}/${entry.file}`,
        signal: 'dangling-index-link',
        action: `Index points to "${entry.file}", which is not on disk — fix the link or drop the entry.`,
      });
    }
  }

  // 4. unindexed file. Only meaningful once the index has at least one PARSED
  // pointer: a `MEMORY.md` that is non-empty but holds only prose/headings (no
  // `- [Title](file.md)` lines) yields `indexRaw !== ''` yet `index === []`, and
  // flagging every file against an empty pointer set would be a false positive.
  if (hasIndex && store.index.length > 0) {
    for (const mem of store.memories) {
      if (!indexedFiles.has(mem.file)) {
        items.push({
          project: slug,
          path: `${slug}/${mem.file}`,
          signal: 'unindexed-file',
          action: `Memory "${mem.file}" has no MEMORY.md pointer — add an index line or remove the file.`,
        });
      }
    }
  }

  // 5. dangling wikilink
  for (const mem of store.memories) {
    for (const target of extractWikilinkTargets(mem.body)) {
      if (!nameSet.has(target)) {
        items.push({
          project: slug,
          path: `${slug}/${mem.file}`,
          signal: 'dangling-wikilink',
          action: `"${mem.file}" links [[${target}]], but no memory has that name — write that memory or fix the typo.`,
        });
      }
    }
  }

  return items;
}

/** Signals that are structural breakage (broken/oversized index), not just sprawl. */
const STRUCTURAL: ReadonlySet<MemoryHygieneSignal> = new Set([
  'oversized-index',
  'dangling-index-link',
]);

export const detector: Detector = {
  id: 'maintenance.memory-hygiene',
  category: 'maintenance',
  dataDeps: ['memoryStores'],
  rule(input: RecommendationInput): Recommendation | null {
    const stores = input.memoryStores;
    if (!stores || stores.length === 0) return null;

    const items = stores.flatMap(scanStore);
    if (items.length === 0) return null;

    // Per-signal counts drive the breakdown and the observations.
    const counts = {} as Record<MemoryHygieneSignal, number>;
    for (const it of items) counts[it.signal] = (counts[it.signal] ?? 0) + 1;

    const order: MemoryHygieneSignal[] = [
      'oversized-index',
      'dangling-index-link',
      'unindexed-file',
      'long-index-line',
      'dangling-wikilink',
    ];
    const breakdown = order
      .filter((s) => counts[s])
      .map((s) => `${counts[s]} ${SIGNAL_LABEL[s]}`)
      .join(', ');

    const severity: RecSeverity = items.some((it) => STRUCTURAL.has(it.signal))
      ? 'warning'
      : 'info';

    // A handful of supporting rows lead with the structural breakage.
    const evidence = [...items]
      .sort(
        (a, b) =>
          Number(STRUCTURAL.has(b.signal)) - Number(STRUCTURAL.has(a.signal))
      )
      .slice(0, 8)
      .map((it) => `${it.path} — ${SIGNAL_LABEL[it.signal]}`);

    const observations: RecObservation[] = [
      {
        claim: `${items.length} deterministic memory-hygiene issue(s) across ${stores.length} project memory store(s): ${breakdown}`,
        source: 'parse-memories',
        field: 'memoryStores[] (buildMemoryStores: memories[].file/name/body + index[].file/raw + indexRaw)',
        value: items.length,
      },
    ];

    const n = items.length;
    return {
      id: 'maintenance.memory-hygiene',
      category: 'maintenance',
      severity,
      title: `Memory store needs cleanup: ${n} hygiene issue${n === 1 ? '' : 's'}`,
      detail:
        `Your agent memory store has ${n} deterministic hygiene issue${n === 1 ? '' : 's'} — ${breakdown}. ` +
        `The MEMORY.md index is auto-injected at SessionStart, so a bloated or broken index degrades every session's context.`,
      action:
        `Review the flagged memories and index lines (recommend-only — nothing is deleted for you): trim the index back ` +
        `under its budget, fix or drop dangling pointers, index the orphaned files, and resolve broken wikilinks.`,
      affected: n,
      // No honest dollar unit — score on minutes to review each flagged item.
      estTimeReclaimedMin: n,
      evidence,
      view: 'memories',
      provenance: {
        observations,
        inference:
          `Each issue is read directly from the parsed memory store/index, so all ${n} are reproducible from disk — ` +
          `a maintenance pass to keep the auto-injected memory context lean and correct.`,
      },
    };
  },
};
