/**
 * Detector: maintenance.memory-hygiene
 *
 * Audits the bounded per-project memory store at the last ingest. It treats the
 * main `MEMORY.md` and fixed-depth `archive/ARCHIVE.md` indexes as one coverage
 * surface. Unresolved wikilinks are intentional forward references, not debt.
 * Absence claims require a complete fact + main-index + archive-index read;
 * directly observed oversize and long-line facts do not.
 *
 * Recommend-only: this detector never deletes or mutates a memory and emits no
 * fix snippet. Issue #2558 (epic #2561).
 */

import type {
  Detector,
  RecommendationInput,
  Recommendation,
  RecObservation,
  RecSeverity,
} from '../types';
import type { ProjectMemoryStore } from '../../parse-memories';

/** Soft UTF-8 byte budget for the hot, auto-injected `MEMORY.md`. */
export const INDEX_SIZE_BUDGET_BYTES = 24_400;

/** Per-line ceiling for one index pointer + hook. */
export const INDEX_LINE_MAX_CHARS = 200;

export type MemoryHygieneSignal =
  | 'oversized-index'
  | 'long-index-line'
  | 'dangling-index-link'
  | 'unindexed-file';

export interface MemoryHygieneItem {
  project: string;
  path: string;
  signal: MemoryHygieneSignal;
  action: string;
}

const SIGNAL_LABEL: Record<MemoryHygieneSignal, string> = {
  'oversized-index': 'index over size budget',
  'long-index-line': 'index line too long',
  'dangling-index-link': 'index link points to a missing file',
  'unindexed-file': 'memory file missing from the index',
};

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)}KB`;

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

const PROVENANCE_STORE_SAMPLE_MAX = 8;

function projectLabel(project: string): string {
  const head = project.slice(0, 80).replace(/\s/g, ' ');
  return project.length > 80 ? `${head.slice(0, 77)}...` : head;
}

function storeSample(
  stores: ProjectMemoryStore[],
  row: (store: ProjectMemoryStore) => string
): string {
  const sampled = stores.slice(0, PROVENANCE_STORE_SAMPLE_MAX);
  return `sampled=${sampled.length}/${stores.length}[${sampled
    .map((store) => `${projectLabel(store.project)}:${row(store)}`)
    .join(';')}]`;
}

function coveragePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase() === 'archive/archive.md'
    ? 'archive/ARCHIVE.md'
    : path;
}

function scanStore(store: ProjectMemoryStore): MemoryHygieneItem[] {
  const items: MemoryHygieneItem[] = [];
  const slug = store.project;
  const mainPresent = store.indexPresent ?? store.indexRaw !== '';
  const archivePresent =
    store.archiveIndexPresent ?? store.archiveIndexRaw !== '';
  const surfaces = [
    {
      path: 'MEMORY.md',
      entries: store.index,
      raw: store.indexRaw,
      present: mainPresent,
    },
    {
      path: 'archive/ARCHIVE.md',
      entries: store.archiveIndex,
      raw: store.archiveIndexRaw,
      present: archivePresent,
    },
  ];

  // The size/line budgets belong to the hot MEMORY.md that is injected every
  // session. The archive index is cold coverage and must not inherit hot-index
  // debt thresholds. These main-index facts remain valid if another component
  // was incomplete because their bytes were directly observed.
  const mainIndex = surfaces[0];
  if (mainIndex.present) {
    const bytes = byteLength(mainIndex.raw);
    if (bytes > INDEX_SIZE_BUDGET_BYTES) {
      items.push({
        project: slug,
        path: `${slug}/${mainIndex.path}`,
        signal: 'oversized-index',
        action: `Trim MEMORY.md — ${kb(bytes)} is over the ~${kb(
          INDEX_SIZE_BUDGET_BYTES
        )} soft budget; remove dead entries and shorten verbose hooks.`,
      });
    }
  }
  for (const entry of mainIndex.entries) {
    if (entry.raw.length > INDEX_LINE_MAX_CHARS) {
      items.push({
        project: slug,
        path: `${slug}/${mainIndex.path}`,
        signal: 'long-index-line',
        action: `Shorten the MEMORY.md line for "${entry.title}" (${entry.raw.length} chars > ${INDEX_LINE_MAX_CHARS}) to a single hook.`,
      });
    }
  }

  const complete =
    store.readCompleteness?.facts === true &&
    store.readCompleteness.mainIndex === true &&
    store.readCompleteness.archiveIndex === true;
  if (!complete) return items;

  const allEntries = surfaces.flatMap((surface) => surface.entries);
  const fileSet = new Set(store.memories.map((memory) => memory.file));
  const validTargets = new Set(fileSet);
  if (archivePresent) validTargets.add('archive/ARCHIVE.md');

  for (const entry of allEntries) {
    if (!validTargets.has(coveragePath(entry.file))) {
      items.push({
        project: slug,
        path: `${slug}/${entry.file}`,
        signal: 'dangling-index-link',
        action: `An index points to "${entry.file}", which was not observed in the bounded memory read — fix the link or drop the entry.`,
      });
    }
  }

  // A complete read makes the union authoritative even when one/both indexes
  // are absent, empty, or prose-only; otherwise an empty union hides all facts.
  const indexedFiles = new Set(
    allEntries.map((entry) => coveragePath(entry.file))
  );
  for (const memory of store.memories) {
    if (!indexedFiles.has(coveragePath(memory.file))) {
      items.push({
        project: slug,
        path: `${slug}/${memory.file}`,
        signal: 'unindexed-file',
        action: `Memory "${memory.file}" is in neither MEMORY.md nor archive/ARCHIVE.md — add an index line or remove the file.`,
      });
    }
  }

  return items;
}

const STRUCTURAL: ReadonlySet<MemoryHygieneSignal> = new Set([
  'oversized-index',
  'dangling-index-link',
]);

export const detector: Detector = {
  id: 'maintenance.memory-hygiene',
  category: 'maintenance',
  dataDeps: ['memoryStores'],
  rule(input: RecommendationInput, now: number): Recommendation | null {
    const stores = input.memoryStores;
    if (!stores || stores.length === 0) return null;

    const items = stores.flatMap(scanStore);
    if (items.length === 0) return null;

    const counts = {} as Record<MemoryHygieneSignal, number>;
    for (const item of items) {
      counts[item.signal] = (counts[item.signal] ?? 0) + 1;
    }
    const order: MemoryHygieneSignal[] = [
      'oversized-index',
      'dangling-index-link',
      'unindexed-file',
      'long-index-line',
    ];
    const breakdown = order
      .filter((signal) => counts[signal])
      .map((signal) => `${counts[signal]} ${SIGNAL_LABEL[signal]}`)
      .join(', ');

    const severity: RecSeverity = items.some((item) =>
      STRUCTURAL.has(item.signal)
    )
      ? 'warning'
      : 'info';
    const evidence = [...items]
      .sort(
        (a, b) =>
          Number(STRUCTURAL.has(b.signal)) -
          Number(STRUCTURAL.has(a.signal))
      )
      .slice(0, 8)
      .map((item) => `${item.path} — ${SIGNAL_LABEL[item.signal]}`);

    const observations: RecObservation[] = [
      {
        claim: `${items.length} deterministic memory-hygiene issue(s) across ${stores.length} project memory store(s): ${breakdown}`,
        source: 'parse-memories',
        field: 'memoryStores[] (facts + union of main/archive indexes)',
        value: items.length,
      },
      {
        claim: 'Main memory indexes were inspected with explicit read completeness',
        source: 'parse-memories',
        field: 'memoryStores[].index (MEMORY.md)',
        value:
          `stores=${stores.length},present=${stores.filter((store) => store.indexPresent ?? store.indexRaw !== '').length},` +
          `complete=${stores.filter((store) => store.readCompleteness?.mainIndex === true).length};` +
          storeSample(
            stores,
            (store) =>
              `present=${store.indexPresent ?? store.indexRaw !== ''},complete=${store.readCompleteness?.mainIndex === true},entries=${store.index.length}`
          ),
      },
      {
        claim: 'Archive memory indexes were inspected with explicit read completeness',
        source: 'parse-memories',
        field: 'memoryStores[].archiveIndex (archive/ARCHIVE.md)',
        value:
          `stores=${stores.length},present=${stores.filter((store) => store.archiveIndexPresent ?? store.archiveIndexRaw !== '').length},` +
          `complete=${stores.filter((store) => store.readCompleteness?.archiveIndex === true).length};` +
          storeSample(
            stores,
            (store) =>
              `present=${store.archiveIndexPresent ?? store.archiveIndexRaw !== ''},complete=${store.readCompleteness?.archiveIndex === true},entries=${store.archiveIndex.length}`
          ),
      },
      {
        claim: 'Absence-based claims use only complete bounded reads',
        source: 'parse-memories',
        field: 'memoryStores[].readCompleteness',
        value:
          `stores=${stores.length},fullyComplete=${stores.filter(
            (store) =>
              store.readCompleteness?.facts === true &&
              store.readCompleteness.mainIndex === true &&
              store.readCompleteness.archiveIndex === true
          ).length};` +
          storeSample(
            stores,
            (store) =>
              `facts=${store.readCompleteness?.facts === true},main=${store.readCompleteness?.mainIndex === true},archive=${store.readCompleteness?.archiveIndex === true}`
          ),
      },
    ];

    const n = items.length;
    const asOf = new Date(now).toISOString().slice(0, 10);
    return {
      id: 'maintenance.memory-hygiene',
      category: 'maintenance',
      severity,
      title: `Memory store needs cleanup: ${n} hygiene issue${n === 1 ? '' : 's'}`,
      detail:
        `At the last memory ingest (${asOf}), your agent memory store had ${n} deterministic hygiene issue${n === 1 ? '' : 's'} — ${breakdown}. ` +
        `MEMORY.md is auto-injected at SessionStart, so keep that hot index lean and both indexes internally consistent.`,
      action:
        `Review the flagged memories and index lines (recommend-only — nothing is deleted for you): trim MEMORY.md back ` +
        `under its budget, fix or drop dangling pointers, and index orphaned files in MEMORY.md or archive/ARCHIVE.md.`,
      affected: n,
      estTimeReclaimedMin: n,
      evidence,
      view: 'memories',
      provenance: {
        observations,
        inference:
          `Each issue is reproduced from observed index bytes or complete bounded fact/index reads at the last memory ingest — ` +
          `a maintenance pass keeps the auto-injected context lean without treating intentional forward references as debt.`,
        asOf,
      },
    };
  },
};
