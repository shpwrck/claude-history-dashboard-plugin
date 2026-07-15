// Wire-level slimming for the per-session tokenData payload (#2107, epic #1474 —
// v0.5.0 perf gate).
//
// `tokenData[].entries[]` and `toolData[].calls[]` are the two heaviest dataset
// fields after `timelines` (#2107 measured them at 37% of dataset.json combined).
// Profiling the per-row shape (scripts/dataset-field-sizes.mjs + ad-hoc) showed
// the safe, value-preserving win is in `tokenData`: a large share of each
// `TokenEntry`'s numeric fields are 0 — `webSearchRequests` / `webFetchRequests`
// are 0 for ~100% of entries, the 1h-cache split and `thinkingTokens` for ~50-65%
// — and a missing numeric reads back as 0, so emitting the `"field":0,` member is
// pure wire overhead (~5 MB on the live corpus).
//
// `toolData.calls[]` is deliberately NOT slimmed. Its weight is in genuinely
// load-bearing per-call fields (commandPreview, distilled input, toolUseId,
// timestamp), none of which is a droppable default or safely derivable:
//   - `commandHead` LOOKS derivable from `commandPreview`, but the head comes
//     from the FULL command while the preview is the leading 200 chars; a long
//     leading env-var assignment (`FOO=<200+ chars> realcmd …`) pushes the real
//     head past the cutoff, so re-deriving differs on 22/42594 live Bash calls —
//     it would silently corrupt bashSubcommandStats / MCP-adoption signals.
//   - `isError` is `false` (not `null`) for ~96% of calls, and the
//     file-reread-after-error detector requires the exact `false` value to spot a
//     fix (`fix.isError !== false`), so `false` is a load-bearing distinct value,
//     not a droppable default. Slimming it would save ~0 anyway.
// So the per-call rows ship verbatim — the Tool-usage view is provably unchanged.
//
// This is a LOSSLESS transform: `slimDataset` drops only zero-valued numeric
// members on the wire, and `rehydrateDataset` restores each to 0 on load, so the
// in-memory shape every consumer (cost attribution, the Cost view, the
// recommendation detectors) sees is byte-for-byte identical to the un-slimmed
// dataset. The server's own recommendation path reads the in-memory
// `assembleDataset()` object, NOT the slimmed wire JSON, so it is unaffected.
//
// `slimDataset` runs once at serialization (dataset-body.ts); `rehydrateDataset`
// runs once at the universal client load seam (App.applyDataset), where it is
// idempotent — re-hydrating an already-full row (sample/upload datasets, which
// never go through the wire slimmer) is a no-op.

// TokenEntry numeric fields the parser ALWAYS emits (present even when 0):
// dropping them on the wire when 0 and restoring them to 0 on load is a true
// inverse of the parser's output shape. `timestamp`/`model` are strings (never a
// meaningful default) so they always stay on the wire. `thinkingTokens` is
// emitted unconditionally by parse-sessions (#1927), so it belongs here.
const ENTRY_ALWAYS_PRESENT_NUMERICS = [
  'inputTokens',
  'outputTokens',
  'cacheCreationTokens',
  'cacheCreation1hTokens',
  'cacheReadTokens',
  'webSearchRequests',
  'webFetchRequests',
  'thinkingTokens',
] as const;

// `toolResultBytes` is CONDITIONALLY emitted by parse-sessions — present only
// when > 0 (`...(toolResultBytes > 0 ? { toolResultBytes } : {})`). So the
// original 0 case is already ABSENT on the wire (nothing to slim) and must stay
// absent on rehydrate — re-adding `toolResultBytes: 0` would diverge from the
// parser's shape (present-0 where the original omits it). It is therefore in the
// slim-drop set (a no-op for the already-absent 0 case, but correct if a future
// path ever emits an explicit 0) but NOT in the rehydrate-restore set.
const ENTRY_DROP_WHEN_ZERO = [
  ...ENTRY_ALWAYS_PRESENT_NUMERICS,
  'toolResultBytes',
] as const;

type AnyRecord = Record<string, unknown>;

const POST_V7_SHADOW_CALL_KEYS = [
  'counted',
  'synthetic',
  'skipped',
  'live',
  'replay',
  'bySourceAxis',
  'byVariation',
  'variationSkipped',
  'variationCellsTruncated',
  'external',
  'truncated',
] as const;

// ---------------------------------------------------------------------------
// Slim (serialize side) — drop zero-valued numeric members. Clones each touched
// row so the caller's in-memory object is never mutated.
// ---------------------------------------------------------------------------

function slimTokenEntry(entry: AnyRecord): AnyRecord {
  const out: AnyRecord = {};
  for (const key of Object.keys(entry)) {
    const value = entry[key];
    // Omit a numeric field whose value is exactly 0 (its restored default).
    if (
      (ENTRY_DROP_WHEN_ZERO as readonly string[]).includes(key) &&
      value === 0
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function slimTokenRow(row: AnyRecord): AnyRecord {
  const entries = row.entries;
  if (!Array.isArray(entries)) return row;
  return {
    ...row,
    entries: entries.map((e) =>
      e && typeof e === 'object' ? slimTokenEntry(e as AnyRecord) : e
    ),
  };
}

/**
 * Return a shallow clone of `dataset` whose `tokenData` rows have had their
 * zero-valued per-entry numeric members dropped. Every other top-level field
 * (including `toolData`) is passed through by reference, untouched. The input
 * object is not mutated.
 */
export function slimDataset(dataset: unknown): unknown {
  if (!dataset || typeof dataset !== 'object') return dataset;
  const record = dataset as AnyRecord;
  if (!Array.isArray(record.tokenData)) return dataset;
  return {
    ...record,
    tokenData: record.tokenData.map((row) =>
      row && typeof row === 'object' ? slimTokenRow(row as AnyRecord) : row
    ),
  };
}

// ---------------------------------------------------------------------------
// Rehydrate (load side) — restore each dropped numeric to 0. Idempotent for
// already-full rows (a present non-zero value is left as-is). Mutates the
// freshly-parsed entries in place to avoid a second full clone of the ~73k-row
// payload; the parsed JSON is owned by this seam and not shared.
// ---------------------------------------------------------------------------

function rehydrateTokenEntry(entry: AnyRecord): void {
  // Only restore the always-present numerics to 0 — NOT toolResultBytes, which
  // the parser omits when 0, so leaving it absent matches the original shape.
  for (const key of ENTRY_ALWAYS_PRESENT_NUMERICS) {
    if (entry[key] === undefined) entry[key] = 0;
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function sumLegacyAxisCounts(
  byAxis: unknown[]
): { live: number; replay: number } | null {
  let live = 0;
  let replay = 0;
  for (const axis of byAxis) {
    if (!axis || typeof axis !== 'object' || Array.isArray(axis)) return null;
    const axisRecord = axis as AnyRecord;
    const axisLive = axisRecord.live;
    const axisReplay = axisRecord.replay;
    const axisSamples = axisRecord.samples;
    if (
      !isNonNegativeSafeInteger(axisLive) ||
      !isNonNegativeSafeInteger(axisReplay) ||
      !isNonNegativeSafeInteger(axisSamples)
    ) {
      return null;
    }
    const samples = axisLive + axisReplay;
    if (!Number.isSafeInteger(samples) || samples !== axisSamples) return null;
    live += axisLive;
    replay += axisReplay;
    if (!Number.isSafeInteger(live) || !Number.isSafeInteger(replay)) return null;
  }
  return { live, replay };
}

/**
 * Browser caches written before shadow-call aggregate v8 carry only the old
 * counted total plus per-axis live/replay counts. Normalize that legacy shape
 * once at the universal cache-load seam so downstream consumers never need a
 * component-specific fallback (#2379).
 */
function rehydrateLegacyShadowCalls(record: AnyRecord): void {
  const value = record.shadowCalls;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const aggregate = value as AnyRecord;

  // A valid v7 aggregate predates every explicit disposition/source/variation
  // field. Any one of those keys makes this current-like or ambiguous, so leave
  // it byte-for-byte unchanged instead of overwriting a partial newer shape.
  if (
    POST_V7_SHADOW_CALL_KEYS.some((key) =>
      Object.prototype.hasOwnProperty.call(aggregate, key)
    )
  ) {
    return;
  }
  if (
    !isNonNegativeSafeInteger(aggregate.total) ||
    !Array.isArray(aggregate.byAxis)
  ) {
    return;
  }

  const axisCounts = sumLegacyAxisCounts(aggregate.byAxis);
  if (axisCounts === null) return;
  const { live, replay } = axisCounts;
  const counted = live + replay;
  if (
    !Number.isSafeInteger(counted) ||
    counted !== aggregate.total
  ) {
    return;
  }

  aggregate.counted = counted;
  aggregate.synthetic = 0;
  aggregate.skipped = 0;
  aggregate.live = live;
  aggregate.replay = replay;
}

/**
 * Restore the zero-valued numeric members `slimDataset` dropped, in place, on a
 * freshly-parsed dataset. Idempotent: entries that still carry the field (sample
 * / upload datasets, never slimmed) are left untouched. Returns the same object.
 */
export function rehydrateDataset<T>(dataset: T): T {
  if (!dataset || typeof dataset !== 'object') return dataset;
  const record = dataset as AnyRecord;
  rehydrateLegacyShadowCalls(record);
  if (Array.isArray(record.tokenData)) {
    for (const row of record.tokenData) {
      const entries = (row as AnyRecord)?.entries;
      if (Array.isArray(entries)) {
        for (const e of entries) {
          if (e && typeof e === 'object') rehydrateTokenEntry(e as AnyRecord);
        }
      }
    }
  }
  return dataset;
}
