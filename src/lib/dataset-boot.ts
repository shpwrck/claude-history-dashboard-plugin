// Boot/slice split for the Tier-3 instant-load path (#2443, epic #1852).
//
// Today the server ships the whole assembled dataset (~98 MB parsed on real
// data) as one `/api/dataset.json` monolith, because the isomorphic client is
// written to consume a complete `Dataset`. ADR 0014 Tier 3 (self-hosted server)
// may serve smarter: split the dataset into
//   - a tiny BOOT payload — the small metadata keys verbatim, plus server-
//     computed headline AGGREGATES and per-slice COUNTS — enough to paint the
//     landing shell without the heavy detail; and
//   - one SLICE per heavy per-view key, fetched only when that view is opened.
//
// Pure and dependency-light (SPA-safe) so the same split runs server-side (the
// boot/slice endpoints) and, in the SPA/upload build, client-side over the
// in-browser dataset — the viewer works with zero server either way.

/**
 * Dataset keys deferred to lazy per-view slices — every per-session ARRAY above
 * ~0.1 MB on the measured real dataset (these 18 keys are ~98.3 MB of 98.5 MB;
 * `timelines`/`toolData`/`tokenData`/`toolInventories`/`valueFlow` alone are
 * ~88 MB). Everything else (small metadata + non-array objects like `liveConfig`
 * and `shadowCalls`) stays in the boot payload verbatim. `entries` (raw history)
 * is deferred too — the shell renders from aggregates and the session list pulls
 * its slice. `repoMap` (the repo-map context join, #1650) is a non-array OBJECT
 * that can reach several MB; it feeds only the Context view, so it is deferred
 * and defaults to `null` (not `[]`) when unfetched — see {@link NON_ARRAY_SLICE_KEYS}.
 * `docGraph` is likewise a non-array object and is large enough to defer.
 */
export const HEAVY_SLICE_KEYS = [
  'entries',
  'timelines',
  'toolData',
  'tokenData',
  'toolInventories',
  'valueFlow',
  'taskSuccess',
  'taskSteering',
  'telemetry',
  'promptAnalysis',
  'runtimeEvents',
  'assistantFeatures',
  'deceitSignals',
  'permissionRows',
  'permissionChanges',
  'attribution',
  'workflows',
  'tasks',
  'repoMap',
  'docGraph',
] as const;

export type HeavySliceKey = (typeof HEAVY_SLICE_KEYS)[number];
export type ProgressiveSliceKey = Exclude<HeavySliceKey, 'workflows'>;

/**
 * One validated heavy-slice arrival for targeted client-state backfill.
 * Workflows keep their existing live endpoint owner rather than consuming the
 * independently cached dataset snapshot.
 */
export interface DatasetSlicePatch {
  key: ProgressiveSliceKey;
  value: unknown;
}

/**
 * Heavy keys whose value is a non-array object (or null) rather than an array,
 * so an unfetched slice must default to `null`, not `[]`.
 */
export const NON_ARRAY_SLICE_KEYS = new Set<string>(['repoMap', 'docGraph']);

const HEAVY_SET = new Set<string>(HEAVY_SLICE_KEYS);

/** True if `key` is a valid, sliceable dataset key. */
export function isSliceKey(key: string): key is HeavySliceKey {
  return HEAVY_SET.has(key);
}

/** Server-computed headline numbers the landing shell renders without raw rows. */
export interface DatasetBootAggregates {
  sessions: number;
  events: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  messages: number;
  models: number;
}

/**
 * The three headline counts the masthead renders. On the boot-first path the
 * heavy `entries`/`tokenData` arrays are still empty when the shell paints, so
 * the client shows these server-computed numbers instead of `0` until the
 * slices backfill (#2450). Derived from {@link DatasetBootAggregates} + counts:
 * `sessions`/`entries` from aggregates, `tokenData` from the per-key counts.
 */
export interface DatasetShellCounts {
  sessions: number;
  entries: number;
  tokenData: number;
}

export interface DatasetBoot {
  /**
   * Dataset content version (the ingest contentHash). Slices carry the same
   * value in an `X-Dataset-Version` header; a client that fetches a slice whose
   * version disagrees with its boot knows the corpus changed mid-load and can
   * refetch, so boot + lazily-fetched slices are never silently mixed across a
   * content change. Attached by the server; absent on the SPA/in-browser split.
   */
  version?: string;
  /** All non-heavy dataset keys, verbatim (liveConfig, sources, sessionRegistry …). */
  meta: Record<string, unknown>;
  /** Headline aggregates computed from the heavy keys before they were dropped. */
  aggregates: DatasetBootAggregates;
  /** Per-heavy-key row counts, so nav badges render without shipping the arrays. */
  counts: Record<string, number>;
  /** Which keys are available as lazy slices (present + non-empty). */
  sliceKeys: string[];
}

export interface DatasetSplit {
  boot: DatasetBoot;
  slices: Record<string, unknown>;
}

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function computeAggregates(dataset: Record<string, unknown>): DatasetBootAggregates {
  const tokenData = Array.isArray(dataset.tokenData) ? dataset.tokenData : [];
  const entries = Array.isArray(dataset.entries) ? dataset.entries : [];
  let inputTokens = 0;
  let outputTokens = 0;
  let thinkingTokens = 0;
  let cacheReadTokens = 0;
  let messages = 0;
  const models = new Set<string>();
  for (const row of tokenData as Array<Record<string, unknown>>) {
    inputTokens += n(row.totalInputTokens);
    outputTokens += n(row.totalOutputTokens);
    thinkingTokens += n(row.totalThinkingTokens);
    cacheReadTokens += n(row.totalCacheReadTokens);
    messages += n(row.messageCount);
    if (typeof row.model === 'string' && row.model) models.add(row.model);
  }
  // Session count must match the masthead's `groupBySessions(entries)` — one per
  // distinct sessionId in history — NOT `tokenData.length`. A history-only session
  // (unioned into entries with no transcript) or a transcript that yields entries
  // but no usage-bearing token row appears in the session list but not in
  // `tokenData`, so counting token rows under-reports the total and the boot shell
  // would show a lower session count until the heavy `entries` slice loads (#2443).
  const sessionIds = new Set<string>();
  for (const entry of entries as Array<Record<string, unknown>>) {
    const id = entry.sessionId;
    if (typeof id === 'string' && id) sessionIds.add(id);
  }
  return {
    sessions: sessionIds.size,
    events: entries.length,
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens,
    messages,
    models: models.size,
  };
}

/**
 * Partition an assembled dataset into a tiny boot payload + per-heavy-key slices.
 * `boot.meta` ∪ `slices` reconstitute the original dataset key-for-key; the
 * aggregates/counts are additive summaries the client uses to paint the shell.
 */
export function splitDataset(dataset: unknown): DatasetSplit {
  const record = (dataset ?? {}) as Record<string, unknown>;
  const meta: Record<string, unknown> = {};
  const slices: Record<string, unknown> = {};
  const counts: Record<string, number> = {};
  const sliceKeys: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (HEAVY_SET.has(key)) {
      slices[key] = value;
      const count = Array.isArray(value) ? value.length : value == null ? 0 : 1;
      counts[key] = count;
      if (count > 0) sliceKeys.push(key);
    } else {
      meta[key] = value;
    }
  }
  return {
    boot: { meta, aggregates: computeAggregates(record), counts, sliceKeys },
    slices,
  };
}

/**
 * Rebuild the full dataset object from a boot payload's `meta` and the fetched
 * slices — the inverse of {@link splitDataset}. Missing slices default to `[]`
 * (their view simply has no rows yet), so a partially-hydrated dataset is always
 * a valid `Dataset` shape.
 */
export function mergeDataset(
  meta: Record<string, unknown>,
  slices: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...meta };
  for (const key of HEAVY_SLICE_KEYS) {
    if (key in slices) out[key] = slices[key];
    else if (!(key in out)) out[key] = NON_ARRAY_SLICE_KEYS.has(key) ? null : [];
  }
  return out;
}
