// Dataset response body construction (#2070, epic #1474 — v0.5.0 perf gate).
//
// /api/dataset.json serializes the full (~128 MB) assembled dataset. The old
// buildDatasetCache stringified it TWICE per build — once for the served body
// (with `generatedAt`) and once for the ETag (a `generatedAt`-stripped `stable`
// view) — and each `JSON.stringify` of an object this size is a multi-second
// SYNCHRONOUS event-loop stall.
//
// This builds BOTH from ONE serialization: serialize the stable view (the
// dataset minus the volatile `generatedAt`) once, hash exactly those bytes for
// the ETag, then splice `generatedAt` back into the served body by string
// concatenation — never a second full stringify. Pure and dependency-light
// (only safeJsonStringify) so it is unit-testable and SPA-safe.

import { safeJsonStringify } from './json-safe';
import { slimDataset } from './dataset-slim';

export interface DatasetBody {
  /** The full served JSON body, including `generatedAt`. */
  json: string;
  /**
   * Serialization of the dataset WITHOUT `generatedAt` — the stable bytes the
   * ETag must hash, so the ETag changes iff the data changes and never on a
   * `generatedAt`-only rebuild.
   */
  stableJson: string;
}

/**
 * Build the served dataset body and the stable bytes for its ETag from a single
 * serialization. `generatedAt` is reattached to the body by splicing it in
 * after the opening brace — never a second full stringify of the dataset.
 *
 * The body is semantically identical to the old `safeJsonStringify(dataset)`
 * (lone surrogates scrubbed for strict parsers, #1104); only the key ORDER may
 * differ (`generatedAt` is emitted first), which is immaterial to every
 * consumer (JSON.parse, the disk cache round-trip, and the ETag — which now
 * hashes the stable bytes directly).
 */
export function buildDatasetBody(dataset: unknown): DatasetBody {
  // Slim the heavy per-session tokenData rows (#2107): drop zero-valued
  // TokenEntry numeric members from the WIRE bytes only (toolData is left
  // verbatim — see dataset-slim.ts for why). slimDataset shallow-clones only the
  // tokenData array, so the caller's in-memory dataset (which the server's
  // recommendation path reads) is untouched; the client restores every dropped
  // zero via rehydrateDataset on load. Lossless and value-preserving.
  const record = (slimDataset(dataset) ?? {}) as Record<string, unknown>;
  const { generatedAt, ...stable } = record;
  // The one full serialization. safeJsonStringify scrubs lone surrogates so the
  // export stays valid for strict (non-JS) parsers, exactly as before (#1104).
  const stableJson = safeJsonStringify(stable);
  // `generatedAt` is an ISO timestamp string (no lone surrogates), so a plain
  // JSON.stringify of just that value is sufficient and avoids re-scrubbing the
  // whole dataset.
  const generatedAtMember = `"generatedAt":${JSON.stringify(generatedAt ?? null)}`;
  // safeJsonStringify of an object is always an object literal: "{}" or "{...}".
  const json =
    stableJson.length <= 2
      ? `{${generatedAtMember}}`
      : `{${generatedAtMember},${stableJson.slice(1)}`;
  return { json, stableJson };
}
