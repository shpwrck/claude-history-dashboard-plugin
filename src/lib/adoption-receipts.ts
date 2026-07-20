import { appendFile, mkdir, open, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  normalizeProofRevalidationStatus,
  type ProofRevalidationStatus,
} from './proof-revalidation';
import { REJECT_REASONS, type RejectReason } from './reject-reason';

export type { ProofRevalidationStatus } from './proof-revalidation';

export interface SurfacedReceipt {
  schemaVersion: '1';
  kind: 'SURFACED';
  ts: string;
  sessionHash: string;
  findingIds: string[];
}

export interface SuppressedReceipt {
  schemaVersion: '1';
  kind: 'SUPPRESSED';
  ts: string;
  findingId: string;
  markerHeading: string;
  contentFingerprint: string;
}

/**
 * A user's explicit reject of a recommendation (#2206, epic #1298). Distinct
 * from the engine-emitted SURFACED->SUPPRESSED adoption lifecycle: this is a
 * button-click reject captured from the #1294 reject signal, carrying its
 * {@link RejectReason}. `active` makes the suppression reversible on an
 * append-only log — an un-reject appends a receipt with `active:false`, and the
 * latest receipt per finding wins (see {@link readRejectedFindingIds}). It is
 * NOT routed through the marker-based `SUPPRESSED`/`suppression-transition` path,
 * which requires a `markerHeading`/`contentFingerprint` a click reject has no way
 * to supply.
 */
export interface RejectedReceipt {
  schemaVersion: '1';
  kind: 'REJECTED';
  ts: string;
  findingId: string;
  reason: RejectReason;
  /** true = rejected (suppress the finding); false = un-rejected (restore it). */
  active: boolean;
}

/** Outcome of a matched-pair efficacy experiment. */
export type ProofVerdict = 'proven' | 'null' | 'refuted';

/** Matched-pair experiment arms. */
export type ProofArm = 'injected' | 'withheld';

/**
 * The efficacy half ADR 0005 deferred (see
 * `docs/v0.4-proof-engine.md`, "The proof receipt"). Sits beside the adoption
 * `SURFACED`/`SUPPRESSED` receipts in the same append-only JSONL: a completed
 * matched-pair experiment serialized into a team-legible, externally-reviewable
 * proof artifact. A `null`-verdict receipt (effect indistinguishable from null)
 * is a first-class, representable outcome — a scientific null, not a missing
 * receipt.
 */
export interface ProofReceipt {
  schemaVersion: '1';
  kind: 'PROOF';
  ts: string;
  /** Identifier of the experiment this receipt records. */
  experimentRef: string;
  /** The commit that predates the batch (locks the analysis plan before data). */
  preRegistrationRef: string;
  /** The waste pattern measured, its detector, and its real-history $/mo (v0.3 accounting). */
  observed: {
    wastePattern: string;
    detectorRef: string;
    observedUsdPerMo: number;
  };
  /** The matched-pair experiment apparatus. */
  experiment: {
    fixtureSetRef: string;
    design: 'matched-pairs';
    arm: ProofArm;
    n: number;
    objectiveGates: string[];
  };
  /** The measured effect and its distributional verdict. */
  result: {
    effectSize: number;
    uncertainty: string;
    perDimensionDeltas: Record<string, number>;
    verdict: ProofVerdict;
  };
  /** Projected reclaim with stated assumptions (the fixtures->history bridge is an extrapolation). */
  projection: {
    reclaimUsdPerMo: number;
    assumptions: string;
  };
  /** The prescription, written team-legibly. */
  rollout: string;
  /** Reference to the external review event (#1078 produces it). */
  externalReviewRef: string;
  /** The model version the batch ran against; every effect is conditional on it. */
  modelVersion: string;
  /** Freshness of the proof against the current model (maintained by re-running the corpus). */
  revalidationStatus: ProofRevalidationStatus;
}

export type AdoptionReceipt =
  | SurfacedReceipt
  | SuppressedReceipt
  | RejectedReceipt
  | ProofReceipt;

export type AdoptionReceiptResult =
  | { ok: true; written: true; record: AdoptionReceipt }
  | { ok: true; written: false; disabled: true }
  | { ok: false; status: number; error: string };

export interface AdoptionReceiptOptions {
  now?: () => Date;
  env?: Record<string, string | undefined>;
  shadowCallsDir?: string;
}

export interface AdoptionReceiptReadOptions {
  now?: () => Date;
  maxBytes?: number;
}

export interface AdoptionReceiptStreamResult {
  read: boolean;
  skipped: number;
  records: number;
}

const MAX_ID_LEN = 160;
const MAX_HEADING_LEN = 160;
const MAX_FINGERPRINT_LEN = 128;
const MAX_FINDINGS = 50;
export const ADOPTION_RECEIPT_LINE_MAX_BYTES = 65_536;
const ADOPTION_RECEIPT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_TEXT_LEN = 2000;
const MAX_GATES = 50;
const MAX_DELTA_DIMENSIONS = 50;

const PROOF_VERDICTS: readonly ProofVerdict[] = ['proven', 'null', 'refuted'];
const PROOF_ARMS: readonly ProofArm[] = ['injected', 'withheld'];
function cleanString(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  return trimmed;
}

/** A finite number (rejects NaN/Infinity and non-number values). */
function cleanNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

/** A value present in a small fixed enum, else null. */
function cleanEnum<T extends string>(
  value: unknown,
  allowed: readonly T[]
): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function cleanTimestamp(value: unknown, now: () => Date): string {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return now().toISOString();
}

/** Persisted receipt times fail closed before they participate in ordering. */
function parseUsablePersistedReceiptTime(
  value: unknown,
  referenceTimeMs: number
): number | null {
  if (typeof value !== 'string' || !Number.isFinite(referenceTimeMs)) return null;
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    parsed > referenceTimeMs + ADOPTION_RECEIPT_MAX_FUTURE_SKEW_MS
  ) {
    return null;
  }
  return parsed;
}

export function sanitizeAdoptionReceipt(
  input: unknown,
  now: () => Date = () => new Date()
): AdoptionReceipt | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const ts = cleanTimestamp(raw.ts, now);

  if (raw.kind === 'SURFACED') {
    const sessionHash = cleanString(raw.sessionHash, MAX_ID_LEN);
    const findingIds = Array.isArray(raw.findingIds)
      ? raw.findingIds
          .map((id) => cleanString(id, MAX_ID_LEN))
          .filter((id): id is string => id !== null)
          .slice(0, MAX_FINDINGS)
      : [];
    if (!sessionHash || findingIds.length === 0) return null;
    return {
      schemaVersion: '1',
      kind: 'SURFACED',
      ts,
      sessionHash,
      findingIds,
    };
  }

  if (raw.kind === 'SUPPRESSED') {
    const findingId = cleanString(raw.findingId, MAX_ID_LEN);
    const markerHeading = cleanString(raw.markerHeading, MAX_HEADING_LEN);
    const contentFingerprint = cleanString(
      raw.contentFingerprint,
      MAX_FINGERPRINT_LEN
    );
    if (!findingId || !markerHeading || !contentFingerprint) return null;
    return {
      schemaVersion: '1',
      kind: 'SUPPRESSED',
      ts,
      findingId,
      markerHeading,
      contentFingerprint,
    };
  }

  if (raw.kind === 'REJECTED') {
    const findingId = cleanString(raw.findingId, MAX_ID_LEN);
    const reason = cleanEnum(raw.reason, REJECT_REASONS);
    if (!findingId || !reason) return null;
    // Default missing/non-boolean `active` to true: a plain reject is the common
    // case; only an explicit `active:false` records an un-reject.
    const active = raw.active === false ? false : true;
    return { schemaVersion: '1', kind: 'REJECTED', ts, findingId, reason, active };
  }

  if (raw.kind === 'PROOF') {
    const experimentRef = cleanString(raw.experimentRef, MAX_ID_LEN);
    const preRegistrationRef = cleanString(raw.preRegistrationRef, MAX_ID_LEN);
    const rollout = cleanString(raw.rollout, MAX_TEXT_LEN);
    const externalReviewRef = cleanString(raw.externalReviewRef, MAX_ID_LEN);
    const modelVersion = cleanString(raw.modelVersion, MAX_ID_LEN);
    const revalidationStatus = normalizeProofRevalidationStatus(raw.revalidationStatus);
    if (
      !experimentRef ||
      !preRegistrationRef ||
      !rollout ||
      !externalReviewRef ||
      !modelVersion ||
      !revalidationStatus
    ) {
      return null;
    }

    const observedRaw =
      raw.observed && typeof raw.observed === 'object' && !Array.isArray(raw.observed)
        ? (raw.observed as Record<string, unknown>)
        : null;
    const wastePattern = cleanString(observedRaw?.wastePattern, MAX_TEXT_LEN);
    const detectorRef = cleanString(observedRaw?.detectorRef, MAX_ID_LEN);
    const observedUsdPerMo = cleanNumber(observedRaw?.observedUsdPerMo);
    if (!wastePattern || !detectorRef || observedUsdPerMo === null) return null;

    const experimentRaw =
      raw.experiment &&
      typeof raw.experiment === 'object' &&
      !Array.isArray(raw.experiment)
        ? (raw.experiment as Record<string, unknown>)
        : null;
    const fixtureSetRef = cleanString(experimentRaw?.fixtureSetRef, MAX_ID_LEN);
    const arm = cleanEnum(experimentRaw?.arm, PROOF_ARMS);
    const n = cleanNumber(experimentRaw?.n);
    const objectiveGates = Array.isArray(experimentRaw?.objectiveGates)
      ? experimentRaw.objectiveGates
          .map((g) => cleanString(g, MAX_TEXT_LEN))
          .filter((g): g is string => g !== null)
          .slice(0, MAX_GATES)
      : [];
    if (
      experimentRaw?.design !== 'matched-pairs' ||
      !fixtureSetRef ||
      !arm ||
      n === null
    ) {
      return null;
    }

    const resultRaw =
      raw.result && typeof raw.result === 'object' && !Array.isArray(raw.result)
        ? (raw.result as Record<string, unknown>)
        : null;
    const effectSize = cleanNumber(resultRaw?.effectSize);
    const resultUncertainty = cleanString(resultRaw?.uncertainty, MAX_TEXT_LEN);
    const verdict = cleanEnum(resultRaw?.verdict, PROOF_VERDICTS);
    const perDimensionDeltas: Record<string, number> = {};
    if (
      resultRaw?.perDimensionDeltas &&
      typeof resultRaw.perDimensionDeltas === 'object' &&
      !Array.isArray(resultRaw.perDimensionDeltas)
    ) {
      for (const [key, value] of Object.entries(
        resultRaw.perDimensionDeltas as Record<string, unknown>
      ).slice(0, MAX_DELTA_DIMENSIONS)) {
        const dim = cleanString(key, MAX_ID_LEN);
        const delta = cleanNumber(value);
        if (dim && delta !== null) perDimensionDeltas[dim] = delta;
      }
    }
    if (effectSize === null || !resultUncertainty || !verdict) return null;

    const projectionRaw =
      raw.projection &&
      typeof raw.projection === 'object' &&
      !Array.isArray(raw.projection)
        ? (raw.projection as Record<string, unknown>)
        : null;
    const reclaimUsdPerMo = cleanNumber(projectionRaw?.reclaimUsdPerMo);
    const assumptions = cleanString(projectionRaw?.assumptions, MAX_TEXT_LEN);
    if (reclaimUsdPerMo === null || !assumptions) return null;

    return {
      schemaVersion: '1',
      kind: 'PROOF',
      ts,
      experimentRef,
      preRegistrationRef,
      observed: { wastePattern, detectorRef, observedUsdPerMo },
      experiment: {
        fixtureSetRef,
        design: 'matched-pairs',
        arm,
        n,
        objectiveGates,
      },
      result: { effectSize, uncertainty: resultUncertainty, perDimensionDeltas, verdict },
      projection: { reclaimUsdPerMo, assumptions },
      rollout,
      externalReviewRef,
      modelVersion,
      revalidationStatus,
    };
  }

  return null;
}

/**
 * The canonical read-side parse loop shared by every consumer of the append-only
 * adoption-receipt JSONL. Split the raw text on newlines, bound each line before
 * JSON.parse, require a stable usable persisted timestamp, run each parsed value
 * through the same fail-closed allowlist (`sanitizeAdoptionReceipt`), and drop
 * the nulls — so the read path can never drift from the write path's allowlist.
 *
 * Returns the surviving receipts in file order; blank lines and any line that
 * fails to parse or sanitize are silently skipped. `skipped` counts every line
 * that had content but did not yield a receipt, for callers that report it.
 */
export function parseAdoptionReceiptLines(
  raw: string,
  now: () => Date = () => new Date()
): { receipts: AdoptionReceipt[]; skipped: number } {
  const receipts: AdoptionReceipt[] = [];
  let skipped = 0;
  const scanNow = oncePerReceiptScanClock(now);
  for (const line of raw.split('\n')) {
    const record = parseAdoptionReceiptLine(line, scanNow);
    if (record === undefined) continue;
    if (record === null) {
      skipped += 1;
      continue;
    }
    receipts.push(record);
  }
  return { receipts, skipped };
}

/** Capture a single ordering boundary lazily and reuse it for a whole replay. */
function oncePerReceiptScanClock(now: () => Date): () => Date {
  let attempted = false;
  let readAt: Date | undefined;
  return () => {
    if (!attempted) {
      attempted = true;
      readAt = now();
    }
    if (!readAt) throw new Error('Receipt replay clock did not return a Date');
    return readAt;
  };
}

function parseAdoptionReceiptLine(
  line: string,
  now: () => Date
): AdoptionReceipt | null | undefined {
  if (Buffer.byteLength(line, 'utf8') > ADOPTION_RECEIPT_LINE_MAX_BYTES) {
    return null;
  }
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  // Writes may omit `ts` and are stamped by `sanitizeAdoptionReceipt`, but a
  // persisted line must already carry a usable time. Re-stamping malformed
  // history on every replay would make that record perpetually newest and could
  // reopen a terminal lifecycle forever. Bound future skew for the same reason.
  let readAt: Date;
  try {
    readAt = now();
  } catch {
    return null;
  }
  const readAtMs = readAt.getTime();
  const rawTimestamp =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).ts
      : undefined;
  if (parseUsablePersistedReceiptTime(rawTimestamp, readAtMs) === null) {
    return null;
  }
  return sanitizeAdoptionReceipt(parsed, () => readAt);
}

/**
 * Read the append-only receipt log from `file` and return the canonical parsed,
 * sanitized receipts. When `maxBytes` is positive, only a complete-line tail
 * window is parsed so admin replays can bound memory on long-running logs.
 * Without a byte cap, the file is scanned in bounded chunks and over-limit
 * lines are discarded as they stream. A missing/unreadable file is an empty
 * result (no throw), so a first-ever run doesn't error.
 */
export async function readAdoptionReceipts(
  file: string,
  nowOrOptions:
    | (() => Date)
    | AdoptionReceiptReadOptions
    | undefined = () => new Date(),
  options: AdoptionReceiptReadOptions = {}
): Promise<{ receipts: AdoptionReceipt[]; skipped: number }> {
  const readOptions =
    typeof nowOrOptions === 'function' ? options : nowOrOptions ?? {};
  const now =
    typeof nowOrOptions === 'function'
      ? nowOrOptions
      : readOptions.now ?? (() => new Date());
  const maxBytes =
    typeof nowOrOptions === 'function' ? options.maxBytes : readOptions.maxBytes;
  const cap = normalizePositiveByteCap(maxBytes);
  if (cap > 0) {
    let raw: string;
    try {
      raw = await readAdoptionReceiptTailText(file, cap);
    } catch {
      return { receipts: [], skipped: 0 };
    }
    return parseAdoptionReceiptLines(raw, now);
  }

  const receipts: AdoptionReceipt[] = [];
  const result = await streamAdoptionReceipts(file, now, (record) => {
    receipts.push(record);
  });
  if (!result.read) {
    return { receipts: [], skipped: 0 };
  }
  return { receipts, skipped: result.skipped };
}

function normalizePositiveByteCap(maxBytes?: number): number {
  if (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes)) return 0;
  return Math.max(0, Math.floor(maxBytes));
}

async function readAdoptionReceiptTailText(
  file: string,
  cap: number
): Promise<string> {
  const info = await stat(file);
  if (!info.isFile() || info.size <= 0) return '';

  const bytesToRead = Math.min(info.size, cap);
  const start = info.size - bytesToRead;
  const buffer = Buffer.alloc(bytesToRead);
  const handle = await open(file, 'r');
  try {
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, start);
    let raw = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const firstNewline = raw.indexOf('\n');
      raw = firstNewline === -1 ? '' : raw.slice(firstNewline + 1);
    }
    return raw;
  } finally {
    await handle.close();
  }
}

export async function streamAdoptionReceipts(
  file: string,
  now: () => Date,
  onRecord: (record: AdoptionReceipt) => void | Promise<void>
): Promise<AdoptionReceiptStreamResult> {
  let skipped = 0;
  let records = 0;
  let pending = '';
  let droppingLongLine = false;
  const input = createReadStream(file, {
    encoding: 'utf8',
    highWaterMark: ADOPTION_RECEIPT_LINE_MAX_BYTES,
  });
  const scanNow = oncePerReceiptScanClock(now);

  async function processLine(line: string): Promise<void> {
    const record = parseAdoptionReceiptLine(line, scanNow);
    if (record === undefined) return;
    if (record === null) {
      skipped += 1;
      return;
    }
    await onRecord(record);
    records += 1;
  }

  try {
    for await (const chunk of input) {
      let text = String(chunk);
      while (text.length > 0) {
        const newlineIndex = text.indexOf('\n');
        const lineEnded = newlineIndex !== -1;
        const segment = lineEnded ? text.slice(0, newlineIndex) : text;
        text = lineEnded ? text.slice(newlineIndex + 1) : '';

        if (droppingLongLine) {
          if (lineEnded) {
            skipped += 1;
            droppingLongLine = false;
          }
          continue;
        }

        pending += segment;
        if (
          Buffer.byteLength(pending, 'utf8') >
          ADOPTION_RECEIPT_LINE_MAX_BYTES
        ) {
          pending = '';
          if (lineEnded) skipped += 1;
          else droppingLongLine = true;
          continue;
        }

        if (lineEnded) {
          await processLine(pending);
          pending = '';
        }
      }
    }

    if (droppingLongLine) {
      skipped += 1;
    } else if (pending) {
      await processLine(pending);
    }
  } catch {
    return { read: false, skipped: 0, records: 0 };
  } finally {
    input.destroy();
  }

  return { read: true, skipped, records };
}

export function adoptionWritesDisabled(
  opts: AdoptionReceiptOptions = {}
): boolean {
  const env = opts.env ?? process.env;
  if (env.SHADOW_CALLS_OFF === '1') return true;
  const shadowCallsDir =
    opts.shadowCallsDir ?? join(homedir(), '.claude', 'shadow-calls');
  return existsSync(join(shadowCallsDir, 'OFF'));
}

export async function appendAdoptionReceipt(
  file: string,
  input: unknown,
  opts: AdoptionReceiptOptions = {}
): Promise<AdoptionReceiptResult> {
  if (adoptionWritesDisabled(opts)) {
    return { ok: true, written: false, disabled: true };
  }
  const record = sanitizeAdoptionReceipt(input, opts.now);
  if (!record) {
    return {
      ok: false,
      status: 400,
      error:
        'Body must be a SURFACED, SUPPRESSED, REJECTED, or PROOF adoption receipt with required allowlisted fields',
    };
  }

  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    const e = err as { message?: string };
    return {
      ok: false,
      status: 500,
      error: `Failed to append adoption receipt: ${e.message}`,
    };
  }

  return { ok: true, written: true, record };
}

/**
 * The prior-receipt index the suppression-transition diff (#576) needs: which
 * finding ids have ever had a `SURFACED` entry (eligible to be coached) and
 * which are currently terminally `SUPPRESSED` (so a re-run stays idempotent
 * until a later surface starts a new lifecycle).
 *
 * Streams the append-only log through the shared receipt-line parser and
 * The terminal state is chosen by receipt timestamp, with append order breaking
 * equal timestamps. A delayed older record therefore cannot reopen newer state.
 * A missing file is simply an empty index, so a first-ever run doesn't error.
 */
export async function readAdoptionReceiptIndex(file: string): Promise<{
  surfacedFindingIds: Set<string>;
  suppressedFindingIds: Set<string>;
}> {
  const surfacedFindingIds = new Set<string>();
  const latestLifecycleEvent = new Map<
    string,
    { kind: 'SURFACED' | 'SUPPRESSED'; timestamp: number; ordinal: number }
  >();
  let ordinal = 0;
  const result = await streamAdoptionReceipts(
    file,
    () => new Date(),
    (record) => {
      const eventOrdinal = ordinal;
      ordinal += 1;
      const timestamp = Date.parse(record.ts);
      const recordLatest = (
        findingId: string,
        kind: 'SURFACED' | 'SUPPRESSED'
      ): void => {
        const previous = latestLifecycleEvent.get(findingId);
        if (
          !previous ||
          timestamp > previous.timestamp ||
          (timestamp === previous.timestamp && eventOrdinal > previous.ordinal)
        ) {
          latestLifecycleEvent.set(findingId, {
            kind,
            timestamp,
            ordinal: eventOrdinal,
          });
        }
      };
      if (record.kind === 'SURFACED') {
        for (const id of record.findingIds) {
          surfacedFindingIds.add(id);
          recordLatest(id, 'SURFACED');
        }
      } else if (record.kind === 'SUPPRESSED') {
        // A PROOF receipt (#1074) is neither surfaced- nor suppressed-indexed.
        recordLatest(record.findingId, 'SUPPRESSED');
      }
    }
  );
  const suppressedFindingIds = new Set<string>();
  for (const [findingId, event] of latestLifecycleEvent) {
    if (event.kind === 'SUPPRESSED') suppressedFindingIds.add(findingId);
  }
  if (!result.read) {
    surfacedFindingIds.clear();
    suppressedFindingIds.clear();
  }
  return { surfacedFindingIds, suppressedFindingIds };
}

/**
 * The rejected-finding index the engine's reject-suppression query (#2206, epic
 * #1298) reads: the set of finding ids the user has explicitly rejected and NOT
 * since un-rejected. Streams the shared append-only log through the same parser;
 * per finding the latest `REJECTED` receipt by ts decides — `active:true`
 * suppresses the finding, `active:false` (an un-reject) restores it. A missing
 * file is an empty set (no throw), so a first-ever run doesn't error.
 *
 * Deliberately SEPARATE from {@link readAdoptionReceiptIndex}: that index feeds
 * the CLAUDE.md-marker `suppression-transition` diff (#576) and keeps its
 * surfaced/suppressed shape. A `REJECTED` receipt is neither surfaced- nor
 * suppressed-indexed, so the transition path stays untouched.
 */
export async function readRejectedFindingIds(file: string): Promise<Set<string>> {
  const latest = new Map<string, RejectedReceipt>();
  const result = await streamAdoptionReceipts(file, () => new Date(), (record) => {
    if (record.kind === 'REJECTED') {
      const prev = latest.get(record.findingId);
      if (!prev || record.ts >= prev.ts) latest.set(record.findingId, record);
    }
  });
  const rejected = new Set<string>();
  if (!result.read) return rejected;
  for (const [findingId, receipt] of latest) {
    if (receipt.active) rejected.add(findingId);
  }
  return rejected;
}
