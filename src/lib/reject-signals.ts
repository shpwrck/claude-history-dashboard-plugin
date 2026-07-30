import { appendFile, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { REJECT_REASONS, type RejectReason } from './reject-reason';

// Re-export the node-free vocabulary so server-side callers can keep importing it
// from here; the browser UI imports it directly from './reject-reason'.
export { REJECT_REASONS, type RejectReason } from './reject-reason';

/**
 * Recommendation reject signal (#1294, epic #1298).
 *
 * The capture primitive for the rec feedback loop: when a user dismisses a
 * recommendation, this records *why* — `dismiss` (not now), `wrong` (I disagree
 * with the claim), or `not-relevant` (does not apply to me) — so the engine can
 * later learn from rejection instead of guessing from silence. CAPTURE ONLY:
 * the suppression list and the judge gold-set export are separate slices of the
 * epic that consume this append-only log; this module just writes it.
 *
 * It deliberately mirrors the shape of `adoption-receipts.ts` (append-only JSONL,
 * fail-closed allowlist sanitize on write, sanitize again on read) but stays a
 * separate, cohesive log: a reject is an explicit *user* signal, distinct from
 * the engine-emitted SURFACED/SUPPRESSED/PROOF adoption lifecycle. Imports only
 * node builtins, so the zero-node_modules server runtime can `await import` it.
 */

export interface RejectSignal {
  schemaVersion: '1';
  kind: 'REJECT';
  ts: string;
  /** The recommendation id (`Recommendation.id`, e.g. `cost.cache-1h-waste`). */
  findingId: string;
  reason: RejectReason;
}

export type RejectSignalResult =
  | { ok: true; written: true; record: RejectSignal }
  | { ok: false; status: number; error: string };

export interface RejectSignalOptions {
  now?: () => Date;
}

const MAX_ID_LEN = 160;
export const REJECT_SIGNAL_LINE_MAX_BYTES = 16_384;

/**
 * Total bytes of the log a single read may pull into memory (#3167).
 *
 * `REJECT_SIGNAL_LINE_MAX_BYTES` bounds each LINE, which says nothing about the
 * file: this log is append-only and never compacted, so its size is a function
 * of how long the dashboard has been in use. A per-line cap on a 500 MB file
 * still reads 500 MB.
 *
 * 1 MiB holds roughly ten thousand records — far more than any suppression or
 * gold-set window needs — while making the read cost independent of the log's
 * age. Because the log is append-only, the useful window is the TAIL, so an
 * over-budget file is read from the end rather than truncated at the start:
 * bounding the read by taking the OLDEST bytes would return exactly the records
 * that no longer matter.
 */
export const REJECT_SIGNAL_READ_MAX_BYTES = 1_048_576;

/**
 * Records a single read may retain (#3167).
 *
 * The byte budget already bounds this transitively, but only via a "smallest
 * possible record" argument that a future schema change would silently
 * invalidate. An explicit record ceiling keeps the retained-memory bound true
 * regardless of record size.
 */
export const REJECT_SIGNAL_MAX_RECORDS = 5_000;

export interface ReadRejectSignalsOptions {
  /** Override the total-byte budget for this read. */
  maxBytes?: number;
  /** Override the retained-record budget for this read. */
  maxRecords?: number;
  /**
   * Called when a budget actually WINDOWED the result (#3167).
   *
   * Without this the bound is silent: a windowed read returns a short list that
   * is indistinguishable from a genuinely short log, so a consumer computing
   * suppression or a gold set over "every reject" would be reasoning about the
   * newest 5,000 while believing it had them all. `totalBytes` is the file's
   * real size, so the caller can see how much was left behind.
   */
  onTruncated?: (info: {
    totalBytes: number;
    bytesRead: number;
    recordsReturned: number;
    /** True when the RECORD ceiling dropped records inside the byte window. */
    recordCapped: boolean;
  }) => void;
}

/**
 * Resolve a budget, falling back to the declared default on ANY invalid input.
 *
 * A budget derived with `Math.max(0, Math.floor(value))` becomes `NaN` for
 * unusable input, and every comparison against `NaN` is `false` — so `size >
 * NaN` would read the WHOLE file and `retained > NaN` would trim nothing, while
 * the code still looked like it was enforcing a budget. That silent fail-open is
 * the same defect that made two other gates in this repo green-but-inert
 * (#3076, #3452). An unusable value restores the default; it never widens it.
 */
function resolveReadBudget(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function cleanString(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  return trimmed;
}

function cleanReason(value: unknown): RejectReason | null {
  return typeof value === 'string' &&
    (REJECT_REASONS as readonly string[]).includes(value)
    ? (value as RejectReason)
    : null;
}

function cleanTimestamp(value: unknown, now: () => Date): string {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return now().toISOString();
}

/**
 * Fail-closed allowlist: returns a normalized `RejectSignal` or `null`. Only the
 * four allowlisted fields survive; an unknown reason, a missing/oversized
 * findingId, or a non-object body yields `null` (never a partial record).
 */
export function sanitizeRejectSignal(
  input: unknown,
  now: () => Date = () => new Date()
): RejectSignal | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const findingId = cleanString(raw.findingId, MAX_ID_LEN);
  const reason = cleanReason(raw.reason);
  if (!findingId || !reason) return null;
  return {
    schemaVersion: '1',
    kind: 'REJECT',
    ts: cleanTimestamp(raw.ts, now),
    findingId,
    reason,
  };
}

/** Append one reject signal to the JSONL log, creating the dir if needed. */
export async function appendRejectSignal(
  file: string,
  input: unknown,
  opts: RejectSignalOptions = {}
): Promise<RejectSignalResult> {
  const record = sanitizeRejectSignal(input, opts.now);
  if (!record) {
    return {
      ok: false,
      status: 400,
      error: `Body must be a reject signal with a findingId and a reason of ${REJECT_REASONS.join('/')}`,
    };
  }
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    const e = err as { message?: string };
    return { ok: false, status: 500, error: `Failed to append reject signal: ${e.message}` };
  }
  return { ok: true, written: true, record };
}

/**
 * Parse raw JSONL text into sanitized reject signals, dropping blank/oversized/
 * unparseable/non-allowlisted lines — so the read path can never drift from the
 * write path's allowlist. Shared by the read helper and the suppression/gold-set
 * slices that build on this log.
 */
export function parseRejectSignalLines(
  raw: string,
  now: () => Date = () => new Date(),
  maxRecords: number = REJECT_SIGNAL_MAX_RECORDS
): RejectSignal[] {
  // Same fail-open hazard as the read budget: an unusable ceiling must restore
  // the default, because `retained > NaN` is false and would trim nothing.
  const limit = resolveReadBudget(maxRecords, REJECT_SIGNAL_MAX_RECORDS);
  if (limit === 0) return [];
  const signals: RejectSignal[] = [];
  // Rolling head index rather than `shift()`: keeping the LAST `limit` records
  // with `shift()` would be O(records) per line. `head` advances instead, and the
  // array is compacted only when the dead prefix has itself grown to `limit`, so
  // retention peaks at 2*limit and the amortized cost stays O(1) per record.
  let head = 0;

  // Walked with indexOf/slice instead of `raw.split('\n')`. `split` materializes
  // one string per line for the WHOLE input at once and holds them all live
  // simultaneously; this keeps exactly one line alive at a time.
  let cursor = 0;
  while (cursor <= raw.length) {
    let end = raw.indexOf('\n', cursor);
    if (end === -1) end = raw.length;
    const trimmed = raw.slice(cursor, end).trim();
    cursor = end + 1;
    if (!trimmed) continue;
    if (Buffer.byteLength(trimmed, 'utf8') > REJECT_SIGNAL_LINE_MAX_BYTES) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = sanitizeRejectSignal(parsed, now);
    if (!record) continue;
    signals.push(record);
    if (signals.length - head > limit) {
      head++;
      if (head >= limit) {
        signals.splice(0, head);
        head = 0;
      }
    }
  }
  return head > 0 ? signals.slice(head) : signals;
}

/**
 * {@link parseRejectSignalLines}, also reporting whether the record ceiling
 * dropped anything — so a caller can tell a capped result from a short log.
 */
export function parseRejectSignalLinesDetailed(
  raw: string,
  now: () => Date = () => new Date(),
  maxRecords: number = REJECT_SIGNAL_MAX_RECORDS
): { signals: RejectSignal[]; recordCapped: boolean } {
  const limit = resolveReadBudget(maxRecords, REJECT_SIGNAL_MAX_RECORDS);
  // Parse with one extra slot: if the result overflows the real ceiling, the
  // ceiling was binding. Counting this way needs no second pass over the text.
  const probed = parseRejectSignalLines(raw, now, limit + 1);
  const recordCapped = probed.length > limit;
  return {
    signals: recordCapped ? probed.slice(probed.length - limit) : probed,
    recordCapped,
  };
}

/**
 * Read the append-only reject-signal log. A missing/unreadable file is an empty
 * result (no throw), so a first-ever run does not error.
 *
 * Bounded on BOTH axes (#3167): at most `maxBytes` are pulled off disk and at
 * most `maxRecords` are retained, so the cost of a read no longer scales with
 * how long the log has been accumulating. A file within the byte budget is read
 * whole and behaves exactly as before; only an over-budget file is windowed, and
 * then to its TAIL, because an append-only log's newest records are the ones
 * suppression and the gold set actually want.
 */
export async function readRejectSignals(
  file: string,
  now: () => Date = () => new Date(),
  opts: ReadRejectSignalsOptions = {}
): Promise<RejectSignal[]> {
  const maxBytes = resolveReadBudget(opts.maxBytes, REJECT_SIGNAL_READ_MAX_BYTES);
  const maxRecords = resolveReadBudget(opts.maxRecords, REJECT_SIGNAL_MAX_RECORDS);
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    return [];
  }
  try {
    const { size } = await handle.stat();
    // Read only the tail window. `start > 0` means the file was over budget.
    const start = size > maxBytes ? size - maxBytes : 0;
    const length = size - start;
    if (length <= 0) {
      if (size > 0) {
        opts.onTruncated?.({
          totalBytes: size,
          bytesRead: 0,
          recordsReturned: 0,
          recordCapped: false,
        });
      }
      return [];
    }
    const buf = Buffer.allocUnsafe(length);
    // Loop until the window is filled or EOF. A single `read` is NOT guaranteed
    // to return everything asked for — short reads are permitted by the API and
    // do occur on some filesystems. Trusting one call would parse only the OLDER
    // prefix of the window and silently drop the NEWEST signals, which is the
    // exact opposite of the tail semantics this function promises; worse, for an
    // under-budget file `start` is 0, so nothing would report the loss and the
    // short result would be indistinguishable from a complete one.
    let bytesRead = 0;
    while (bytesRead < length) {
      const { bytesRead: got } = await handle.read(
        buf,
        bytesRead,
        length - bytesRead,
        start + bytesRead
      );
      if (got <= 0) break; // EOF — the file shrank since the stat.
      bytesRead += got;
    }
    let raw = buf.toString('utf8', 0, bytesRead);
    if (start > 0) {
      // The window almost certainly opens mid-record. Drop everything before the
      // first newline: that fragment is not a whole line, and a truncated UTF-8
      // sequence at the seam dies with it rather than becoming a bogus record.
      const firstNewline = raw.indexOf('\n');
      raw = firstNewline === -1 ? '' : raw.slice(firstNewline + 1);
    }
    const { signals, recordCapped } = parseRejectSignalLinesDetailed(
      raw,
      now,
      maxRecords
    );
    // EOF before the stat-sized window was filled is truncation too. This can
    // happen when the append-only file is replaced or truncated concurrently;
    // without the check an incomplete result (including an empty one) looks
    // identical to a complete short log.
    if (start > 0 || recordCapped || bytesRead < length) {
      opts.onTruncated?.({
        totalBytes: size,
        bytesRead,
        recordsReturned: signals.length,
        recordCapped,
      });
    }
    return signals;
  } catch {
    return [];
  } finally {
    await handle.close().catch(() => {});
  }
}
