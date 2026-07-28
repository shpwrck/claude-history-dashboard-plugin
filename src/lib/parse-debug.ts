/**
 * Parser for ~/.claude/debug/*.txt (issue #569, epic #539 persona P7 — Owen).
 *
 * Each file is named `<sessionId>.txt` (UUID, joinable on `sessionId` from
 * sessions/*.json and telemetry/1p_failed_events). A `latest` symlink may also
 * exist; it is skipped (not a .txt file).
 *
 * Three signals are extracted per session:
 *   1. TTFB (p50/p90/max, ms) — wall-clock from
 *         `[API REQUEST] /v1/messages`
 *      to the matching
 *         `Stream started - received first chunk`
 *   2. Retry pressure — max attempt number from
 *         `API error (attempt N/11):`
 *      plus 30s slow-first-byte stall count from
 *         `Slow first byte: no stream chunk ...s after request sent`
 *   3. Fast-mode tax — count of
 *         `Fast mode unavailable: ... Agent SDK`
 *      lines (fires on every API call in SDK/sdk-cli sessions).
 *
 * `isSdkCli` is inferred from the attribution header
 *   `cc_entrypoint=sdk-cli`
 * and from `source=sdk` request lines (both patterns appear in real data).
 *
 * The output `DebugSessionMetrics[]` is kept joinable on `sessionId` so the
 * #572 Agent Report Card can fold reliability metrics into the per-project
 * blended verdict without loading the full log files.
 *
 * This module is SERVER-ONLY (reads from the filesystem). SPA callers receive
 * the pre-computed metrics via the `/api/*` route; do not import node:fs in
 * client-side bundles.
 */


import { basename } from 'node:path';
import {
  DEFAULT_ARTIFACT_MAX_ENTRIES,
  DEFAULT_ARTIFACT_MAX_FILE_BYTES,
  normalizeMaxEntries,
  readDirentsBoundedSync,
  readFileInDirBoundedSync,
  resolveCap,
} from './bounded-fs';

// ---- exported types --------------------------------------------------------

export interface DebugSessionMetrics {
  /** Session UUID — derived from the filename (`<sessionId>.txt`). */
  sessionId: string;
  /**
   * TTFB latency distribution across all API calls in the session (ms).
   * Wall-clock from `[API REQUEST]` to the matching `Stream started` line.
   * 0 when no paired measurements are available (e.g. all retried, no success).
   */
  ttfbP50: number;
  ttfbP90: number;
  ttfbMax: number;
  /** Number of TTFB samples that contributed to the percentiles. */
  ttfbSampleCount: number;
  /**
   * Highest retry-attempt number seen in `API error (attempt N/11)` lines.
   * 0 means no retry storms were detected.
   */
  maxRetryAttempt: number;
  /**
   * Number of `Slow first byte: no stream chunk ...s after request sent` lines.
   * Each fires once per ~30s stall on a pending API request.
   */
  slowFirstByteCount: number;
  /**
   * Number of `Fast mode unavailable: ... Agent SDK` lines.
   * High values (>0) indicate the session ran under the Agent SDK path where
   * fast mode is always disabled, inflating TTFB vs. interactive REPL sessions.
   */
  fastModeLostCount: number;
  /**
   * True when the debug log contains `cc_entrypoint=sdk-cli` in the attribution
   * header or `source=sdk` in API request lines — both indicate an unattended
   * Agent SDK run. Undefined when neither signal is present (older log format).
   */
  isSdkCli?: boolean;
}

export interface ParseDebugDirOptions {
  maxFileBytes?: number;
  maxEntries?: number;
}

// ---- regex patterns --------------------------------------------------------

// Timestamp at the start of every line: ISO-8601 UTC with milliseconds.
const RE_TS = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/;

// API request start (begins a TTFB measurement window).
const RE_REQ = /\[API REQUEST\] \/v1\/messages/;

// First chunk received (closes the TTFB window opened by RE_REQ).
const RE_CHUNK = /Stream started - received first chunk/;

// Retry attempt line: `API error (attempt N/11):`.
const RE_ATTEMPT = /API error \(attempt (\d+)\/\d+\)/;

// Slow-first-byte stall (fires once per ~30s timeout on a pending request).
const RE_SLOW = /Slow first byte: no stream chunk/;

// Fast-mode disabled (fires before each API call in Agent SDK sessions).
const RE_FAST = /Fast mode unavailable/;

// SDK entrypoint detection from the attribution billing header.
const RE_SDK_ENTRYPOINT = /cc_entrypoint=sdk-cli/;

// SDK source on an API REQUEST line (alternative signal).
const RE_SDK_SOURCE = /\[API REQUEST\] \/v1\/messages[^\n]*source=sdk(?:\b|_)/;

// ---- helpers ---------------------------------------------------------------

/**
 * Compute a percentile from a pre-sorted ascending array.
 * Returns 0 for an empty array.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

// ---- per-file parser -------------------------------------------------------

/**
 * Parse a single debug log text and return the metrics.
 * Designed to be robust against partial/truncated files:
 * - A pending request with no matching chunk is discarded (window left open).
 * - Malformed timestamp lines are skipped; the rest of the file is processed.
 * - An empty or whitespace-only file yields all-zero metrics.
 */
export function parseDebugLog(
  text: string,
  sessionId: string
): DebugSessionMetrics {
  const ttfbs: number[] = [];
  let pendingReqTs: number | null = null;
  let maxRetryAttempt = 0;
  let slowFirstByteCount = 0;
  let fastModeLostCount = 0;
  let isSdkCli: boolean | undefined = undefined;

  for (const line of text.split('\n')) {
    if (!line) continue;

    // Extract timestamp (ms since epoch).
    const tsMatch = RE_TS.exec(line);
    const t = tsMatch ? Date.parse(tsMatch[1]) : NaN;

    // SDK detection — check attribution header and source= on request lines.
    if (!isSdkCli) {
      if (RE_SDK_ENTRYPOINT.test(line) || RE_SDK_SOURCE.test(line)) {
        isSdkCli = true;
      }
    }

    // Open a new TTFB measurement window on each API request line.
    if (RE_REQ.test(line)) {
      pendingReqTs = isNaN(t) ? null : t;
      continue;
    }

    // Close the window on the first-chunk line.
    if (RE_CHUNK.test(line)) {
      if (pendingReqTs !== null && !isNaN(t)) {
        const delta = t - pendingReqTs;
        // Guard against clock skew or out-of-order lines producing negatives.
        if (delta >= 0) ttfbs.push(delta);
      }
      // Reset window whether or not we recorded a sample.
      pendingReqTs = null;
      continue;
    }

    // Retry attempt.
    const attemptMatch = RE_ATTEMPT.exec(line);
    if (attemptMatch) {
      const n = parseInt(attemptMatch[1], 10);
      if (!isNaN(n)) maxRetryAttempt = Math.max(maxRetryAttempt, n);
      continue;
    }

    // Slow-first-byte stall.
    if (RE_SLOW.test(line)) {
      slowFirstByteCount++;
      continue;
    }

    // Fast-mode disabled.
    if (RE_FAST.test(line)) {
      fastModeLostCount++;
    }
  }

  // Compute percentiles on sorted array.
  ttfbs.sort((a, b) => a - b);
  const ttfbP50 = percentile(ttfbs, 0.5);
  const ttfbP90 = percentile(ttfbs, 0.9);
  const ttfbMax = ttfbs.length > 0 ? ttfbs[ttfbs.length - 1] : 0;

  return {
    sessionId,
    ttfbP50,
    ttfbP90,
    ttfbMax,
    ttfbSampleCount: ttfbs.length,
    maxRetryAttempt,
    slowFirstByteCount,
    fastModeLostCount,
    isSdkCli,
  };
}

// ---- directory scanner -----------------------------------------------------

/**
 * Read all `*.txt` files from `dir` (which should be `~/.claude/debug/`),
 * parse each as a debug log, and return one `DebugSessionMetrics` per file.
 *
 * File name format: `<sessionId>.txt`. The UUID (minus the `.txt` extension)
 * becomes `sessionId` for joining against sessions/telemetry data in the
 * #572 Report Card.
 *
 * Tolerates:
 * - Missing directory (returns []).
 * - Unreadable/malformed files (skipped with console.warn).
 * - Symlinks like `latest` (excluded because they lack the `.txt` extension).
 */
export function parseDebugDir(
  dir: string,
  opts: ParseDebugDirOptions = {}
): DebugSessionMetrics[] {
  const maxEntries = normalizeMaxEntries(opts.maxEntries, DEFAULT_ARTIFACT_MAX_ENTRIES);
  const entries = readDirentsBoundedSync(dir, maxEntries).map((entry) => entry.name);
  const maxFileBytes = resolveCap(opts.maxFileBytes, DEFAULT_ARTIFACT_MAX_FILE_BYTES);

  const results: DebugSessionMetrics[] = [];
  for (const filename of entries) {
    if (!filename.endsWith('.txt')) continue;
    const sessionId = basename(filename, '.txt');
    // Refuses symlinks and anything over the byte budget (#3378).
    const read = readFileInDirBoundedSync(dir, filename, maxFileBytes);
    if (!read) continue;
    results.push(parseDebugLog(read.text, sessionId));
  }
  return results;
}
