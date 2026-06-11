// Session-signal descriptor (#524, slice 1).
//
// Single source of truth for the per-session "signals" the ingest pipeline
// parses, JSON-stringifies, content-hashes, persists to `session_blob`, and
// reads back in `assembleDataset()`. Before this descriptor, that list lived
// as three hand-maintained parallel inline sequences in `scripts/ingest.mjs`
// (the parse calls in `ingestOne`, the `content_hash` part array, and the
// per-column read-back in `assembleDataset`). Keeping those three in lockstep
// was load-bearing and fragile — the `content_hash` part ORDER in particular
// must never drift, or every cached row silently invalidates.
//
// Slice 1 is a pure refactor: `ingest.mjs` now DERIVES its parse / stringify /
// hash loops and `assembleDataset`'s read-back from `SESSION_SIGNALS`, with
// byte-identical output (same parser, same args, same `?? empty` defaults,
// same hash-part order, same read-back truthiness). Slice 2 will generate the
// SQLite schema/DDL/upsert from the same `column` metadata; slice 3 will wire
// `RecommendationInput`. Neither is started here.
//
// `title` is intentionally NOT in this list: it is a plain TEXT column (not a
// `_json` blob), is computed before the loop, and the `entries` signal reads
// it via `SignalParseCtx.title`. It still feeds the hash (as the `title` part,
// hashed before the signal loop) and the upsert — but it is not a signal.

/**
 * The inputs every signal's `parse` is given. Mirrors the locals `ingestOne`
 * already had in scope at the point the inline parse calls ran.
 */
export interface SignalParseCtx {
  /** Top-level transcript text concatenated with every subagent transcript. */
  merged: string;
  /** Top-level transcript text only (subagent turns excluded). */
  topText: string;
  /** `${sessionId}.jsonl` — the `name` arg every parser takes. */
  name: string;
  sessionId: string;
  project: string | null;
  /** Custom/derived session title, computed before the signal loop. */
  title: string | null;
}

/**
 * How `assembleDataset()` folds a signal's per-row JSON back into the dataset.
 *
 * - `push-truthy`: parse the column and push the value into `datasetKey` iff
 *   it is truthy. `parseGuard` controls whether the parse itself is guarded by
 *   the column being non-empty (`r.col ? JSON.parse(r.col) : null`) or run
 *   unconditionally (`JSON.parse(r.col)`) — this distinction is preserved
 *   verbatim from the original inline read-back so output stays byte-identical.
 * - `spread`: iterate `JSON.parse(r.col) || []` and push each element into
 *   `datasetKey`.
 * - `special`: bespoke fold (`perm` fan-out, `entries` spread + history union)
 *   handled explicitly by `assembleDataset`.
 */
export type SignalAggregate = 'push-truthy' | 'spread' | 'special';

export interface SessionSignal {
  /** Logical key in the per-row value/json maps `ingestOne` builds. */
  id: string;
  /** SQLite column on `session_blob`, e.g. `'token_json'`. */
  column: string;
  /** Verbatim parser call from `ingestOne`, including its `?? empty` default. */
  parse: (ctx: SignalParseCtx) => unknown;
  /** How `assembleDataset` folds the read-back. */
  aggregate: SignalAggregate;
  /**
   * For `push-truthy`: whether the read-back guards the parse on a non-empty
   * column (`'guarded'`) or parses unconditionally (`'unconditional'`).
   * Undefined for `spread`/`special`.
   */
  parseGuard?: 'guarded' | 'unconditional';
  /** Dataset output array key for `push-truthy` / `spread`. */
  datasetKey?: string;
}

// Parser functions are injected by `ingest.mjs` (it owns the ts-resolver import
// of the `parse-*.ts` modules) so `src/lib/signals` has no import dependency on
// them — avoids an import cycle and keeps this descriptor pure. The shape is the
// set of parsers the inline `ingestOne` called.
export interface SignalParsers {
  parseSessionJsonl: (merged: string, name: string) => unknown;
  parseToolUsage: (merged: string, name: string) => unknown;
  parseSessionTimeline: (merged: string, name: string) => unknown;
  parseApiErrors: (merged: string, name: string) => unknown;
  parsePermissionData: (merged: string, name: string) => unknown;
  parseAgentSettings: (merged: string, name: string) => unknown;
  parseAttribution: (merged: string, name: string) => unknown;
  parseRuntimeEvents: (merged: string, name: string) => unknown;
  parseChurnGeometry: (merged: string, name: string) => unknown;
  parseToolInventory: (merged: string, name: string) => unknown;
  parseAssistantFeatures: (merged: string, name: string) => unknown;
  parseDeceitSignals: (merged: string, name: string) => unknown;
  /** Derives history-style entries from the top-level transcript. */
  deriveEntries: (
    topText: string,
    sessionId: string,
    fallbackProject: string | null,
    title: string | null,
  ) => unknown;
}

/**
 * Build the signal list bound to a concrete set of parsers. The ORDER of this
 * array is the `content_hash` part order — it MUST keep the original inline
 * order in `ingestOne` (token, tool, timeline, apiErrors, perm, agents,
 * entries, attribution, runtime, inventory, assistantFeatures); new signals
 * (deceitSignals #685, churnGeometry #597) are APPENDED so existing parts
 * never shift. Do not reorder the existing entries.
 */
export function makeSessionSignals(p: SignalParsers): SessionSignal[] {
  return [
    {
      id: 'token',
      column: 'token_json',
      parse: (c) => p.parseSessionJsonl(c.merged, c.name),
      aggregate: 'push-truthy',
      parseGuard: 'unconditional',
      datasetKey: 'tokenData',
    },
    {
      id: 'tool',
      column: 'tool_json',
      parse: (c) => p.parseToolUsage(c.merged, c.name),
      aggregate: 'push-truthy',
      parseGuard: 'unconditional',
      datasetKey: 'toolData',
    },
    {
      id: 'timeline',
      column: 'timeline_json',
      parse: (c) => p.parseSessionTimeline(c.merged, c.name),
      aggregate: 'push-truthy',
      parseGuard: 'unconditional',
      datasetKey: 'timelines',
    },
    {
      id: 'apiErrors',
      column: 'apierrors_json',
      parse: (c) => p.parseApiErrors(c.merged, c.name) ?? [],
      aggregate: 'spread',
      datasetKey: 'apiErrors',
    },
    {
      id: 'perm',
      column: 'perm_json',
      parse: (c) =>
        p.parsePermissionData(c.merged, c.name) ?? {
          perModeEntries: [],
          changes: [],
        },
      aggregate: 'special',
    },
    {
      id: 'agents',
      column: 'agents_json',
      parse: (c) => p.parseAgentSettings(c.merged, c.name) ?? [],
      aggregate: 'spread',
      datasetKey: 'agentSettings',
    },
    {
      id: 'entries',
      column: 'entries_json',
      parse: (c) => p.deriveEntries(c.topText, c.sessionId, c.project, c.title),
      aggregate: 'special',
    },
    {
      id: 'attribution',
      column: 'attribution_json',
      parse: (c) => p.parseAttribution(c.merged, c.name) ?? null,
      aggregate: 'push-truthy',
      parseGuard: 'guarded',
      datasetKey: 'attribution',
    },
    {
      id: 'runtime',
      column: 'runtime_json',
      parse: (c) => p.parseRuntimeEvents(c.merged, c.name) ?? null,
      aggregate: 'push-truthy',
      parseGuard: 'guarded',
      datasetKey: 'runtimeEvents',
    },
    {
      id: 'inventory',
      column: 'inventory_json',
      parse: (c) => p.parseToolInventory(c.merged, c.name),
      aggregate: 'push-truthy',
      parseGuard: 'guarded',
      datasetKey: 'toolInventories',
    },
    {
      id: 'assistantFeatures',
      column: 'assistant_features_json',
      parse: (c) => p.parseAssistantFeatures(c.merged, c.name),
      aggregate: 'push-truthy',
      parseGuard: 'guarded',
      datasetKey: 'assistantFeatures',
    },
    {
      // Model-deceit signal (#685, epic #683). Appended at the END so the
      // content_hash part order of the pre-existing signals is unchanged — only
      // new rows gain a part, which re-hashes once on next ingest (additive).
      id: 'deceitSignals',
      column: 'deceit_signals_json',
      parse: (c) => p.parseDeceitSignals(c.merged, c.name),
      aggregate: 'push-truthy',
      parseGuard: 'guarded',
      datasetKey: 'deceitSignals',
    },
    {
      // Line-level edit geometry from toolUseResult.structuredPatch (#597).
      // Appended so the existing content_hash part order stays stable.
      id: 'churnGeometry',
      column: 'churn_geometry_json',
      parse: (c) => p.parseChurnGeometry(c.merged, c.name) ?? null,
      aggregate: 'push-truthy',
      parseGuard: 'guarded',
      datasetKey: 'churnGeometry',
    },
  ];
}
