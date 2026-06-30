import { appendFile, mkdir, readFile } from 'node:fs/promises';
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
  now: () => Date = () => new Date()
): RejectSignal[] {
  const signals: RejectSignal[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (Buffer.byteLength(trimmed, 'utf8') > REJECT_SIGNAL_LINE_MAX_BYTES) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = sanitizeRejectSignal(parsed, now);
    if (record) signals.push(record);
  }
  return signals;
}

/**
 * Read the append-only reject-signal log. A missing/unreadable file is an empty
 * result (no throw), so a first-ever run does not error.
 */
export async function readRejectSignals(
  file: string,
  now: () => Date = () => new Date()
): Promise<RejectSignal[]> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  return parseRejectSignalLines(raw, now);
}
