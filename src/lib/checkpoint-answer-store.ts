/**
 * Durable, server-only store for checkpoint answer-time records (#2519).
 *
 * The browser-safe builder lives in checkpoint-instrumentation.ts. This module
 * owns the filesystem boundary: sanitize again, append one allowlisted JSONL
 * row, and aggregate immutable first-seen evidence plus monotonic correction
 * state for each checkpoint instance. It imports only Node builtins plus types,
 * so it stays outside the SPA bundle.
 */
import { appendFile, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type {
  CheckpointAnswerProvenance,
  CheckpointAnswerRecord,
} from './checkpoint-instrumentation';
import type { NeighborhoodAnchor } from './doc-neighborhood';

const MAX_ID_LEN = 256;
const MAX_ANSWER_LEN = 256;
const MAX_SLUG_LEN = 1_024;
const MAX_SHOWN_SLUGS = 200;
const MAX_PROVENANCE_SAMPLES = 20;
export const CHECKPOINT_ANSWER_LINE_MAX_BYTES = 65_536;
/** Browser and server clocks may differ slightly; farther-future rows are refused. */
export const CHECKPOINT_ANSWER_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
/** A small backwards wall-clock adjustment is clamped; larger reversals are refused. */
export const CHECKPOINT_ANSWER_REVERSE_CLOCK_SKEW_MS = 60 * 1_000;
/** A blocking human checkpoint may remain open for at most one day. */
export const CHECKPOINT_ANSWER_MAX_DURATION_MS = 24 * 60 * 60 * 1_000;
/** A successful efficacy read is exact; larger logs fail closed for rotation. */
export const CHECKPOINT_ANSWER_READ_MAX_BYTES = 16 * 1024 * 1024;
export const CHECKPOINT_ANSWER_READ_MAX_ROWS = 50_000;
export const CHECKPOINT_ANSWER_READ_MAX_LOGICAL_ANSWERS = 20_000;

export interface CheckpointAnswerReadLimits {
  maxBytes: number;
  maxRows: number;
  maxLogicalAnswers: number;
}

interface CheckpointAnswerChunkStream extends AsyncIterable<unknown> {
  destroy?: () => void;
}

interface CheckpointAnswerSnapshot {
  size: number;
  createStream: () => CheckpointAnswerChunkStream;
  close: () => Promise<void>;
}

export interface CheckpointAnswerReadOptions {
  limits?: Partial<CheckpointAnswerReadLimits>;
  /** Stable validation clock for one snapshot; injectable for boundary tests. */
  nowMs?: number;
  /** Test seam for injected open/metadata/midstream failures. */
  openSnapshot?: (file: string) => Promise<CheckpointAnswerSnapshot | null>;
}

export interface CheckpointAnswerReadProvenance {
  source: 'checkpoint-answer-log';
  complete: true;
  truncated: false;
  bytesRead: number;
  rowsScanned: number;
  recordsRead: number;
  recordsSkipped: number;
  logicalAnswers: number;
  limits: CheckpointAnswerReadLimits;
}

export interface CheckpointAnswerIncompleteProvenance {
  source: 'checkpoint-answer-log';
  complete: false;
  truncated: true;
  reason: 'max-bytes' | 'max-rows' | 'max-logical-answers';
  limit: number;
  observed: number;
  bytesRead: number;
  rowsScanned: number;
  recordsRead: number;
  recordsSkipped: number;
  logicalAnswers: number;
}

export class CheckpointAnswerReadBudgetError extends Error {
  readonly code = 'CHECKPOINT_ANSWER_READ_BUDGET_EXCEEDED';
  readonly provenance: CheckpointAnswerIncompleteProvenance;

  constructor(provenance: CheckpointAnswerIncompleteProvenance) {
    super(
      `Checkpoint answer read budget exceeded: ${provenance.reason} ` +
      `${provenance.observed} > ${provenance.limit}`
    );
    this.name = 'CheckpointAnswerReadBudgetError';
    this.provenance = provenance;
  }
}

export type CheckpointAnswerWriteResult =
  | { ok: true; written: true; record: CheckpointAnswerRecord }
  | { ok: false; status: number; error: string };

export interface CheckpointAnswerSummary {
  answerCount: number;
  medianElapsedMs: number | null;
  /** Rate among explicitly resolved true/false rows; null while none resolved. */
  resolvedLateCorrectionRate: number | null;
  /** Conservative true/all lower bound while null rows remain open. */
  observedLateCorrectionRateLowerBound: number | null;
  correctedCount: number;
  resolvedCorrectionCount: number;
  unresolvedCorrectionCount: number;
}

export interface CheckpointAnswerIndex {
  /** First immutable payload plus monotonic correction state per instance. */
  records: CheckpointAnswerRecord[];
  /** Malformed/oversized JSONL rows ignored by the reader. */
  skipped: number;
  /** All valid append rows before instance de-duplication. */
  recordCount: number;
  summary: CheckpointAnswerSummary;
  read: CheckpointAnswerReadProvenance;
}

export interface CheckpointAnswerProvenanceSample {
  checkpointId: string;
  shownAtIso: string;
  answeredAtIso: string;
  provenance: CheckpointAnswerProvenance;
}

export interface CheckpointAnswerEfficacy {
  schemaVersion: '1';
  kind: 'CHECKPOINT_ANSWER_EFFICACY';
  summary: CheckpointAnswerSummary;
  cohorts: {
    ambiguityTriggered: CheckpointAnswerSummary;
    ambiguityClear: CheckpointAnswerSummary;
  };
  window: {
    startedAtIso: string | null;
    endedAtIso: string | null;
  };
  provenance: {
    source: 'checkpoint-answer-log';
    complete: true;
    truncated: false;
    bytesRead: number;
    rowsScanned: number;
    recordsRead: number;
    recordsSkipped: number;
    logicalAnswers: number;
    limits: CheckpointAnswerReadLimits;
    samples: CheckpointAnswerProvenanceSample[];
  };
}

function cleanString(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLen ? trimmed : null;
}

interface CanonicalInstant {
  iso: string;
  epochMs: number;
}

const CANONICAL_BUILDER_ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function cleanCanonicalIso(value: unknown): CanonicalInstant | null {
  if (typeof value !== 'string') return null;
  if (!CANONICAL_BUILDER_ISO_PATTERN.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  // Date.parse normalizes impossible calendar dates on some runtimes (for
  // example Feb 30). Exact round-trip equality accepts only builder output.
  return new Date(parsed).toISOString() === value
    ? { iso: value, epochMs: parsed }
    : null;
}

function cleanAnchor(value: unknown): NeighborhoodAnchor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'file') {
    const path = cleanString(raw.path, MAX_SLUG_LEN);
    return path ? { kind: 'file', path } : null;
  }
  if (raw.kind === 'doc') {
    const slug = cleanString(raw.slug, MAX_SLUG_LEN);
    return slug ? { kind: 'doc', slug } : null;
  }
  if (raw.kind === 'issue') {
    return Number.isSafeInteger(raw.issue) && Number(raw.issue) > 0
      ? { kind: 'issue', issue: Number(raw.issue) }
      : null;
  }
  return null;
}

function cleanSlugList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_SHOWN_SLUGS) return null;
  const cleaned = value.map((item) => cleanString(item, MAX_SLUG_LEN));
  if (cleaned.some((item) => item === null)) return null;
  return [...new Set(cleaned as string[])].sort();
}

function cleanProvenance(value: unknown): CheckpointAnswerProvenance | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const anchor = cleanAnchor(raw.anchor);
  const shownSlugs = cleanSlugList(raw.shownSlugs);
  const demotedSlugs = cleanSlugList(raw.demotedSlugs);
  if (
    raw.source !== 'doc-neighborhood'
    || !anchor
    || !shownSlugs
    || !demotedSlugs
    || typeof raw.ambiguityTrigger !== 'boolean'
  ) return null;
  const shown = new Set(shownSlugs);
  if (demotedSlugs.some((slug) => !shown.has(slug))) return null;
  return {
    source: 'doc-neighborhood',
    anchor,
    shownSlugs,
    ambiguityTrigger: raw.ambiguityTrigger,
    demotedSlugs,
  };
}

/** Fail-closed, allowlist-only normalization used by both write and read. */
export function sanitizeCheckpointAnswer(
  input: unknown,
  nowMs = Date.now()
): CheckpointAnswerRecord | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== '1' || raw.kind !== 'CHECKPOINT_ANSWER') return null;
  const checkpointId = cleanString(raw.checkpointId, MAX_ID_LEN);
  const answer = cleanString(raw.answer, MAX_ANSWER_LEN);
  const shownAt = cleanCanonicalIso(raw.shownAtIso);
  const answeredAt = cleanCanonicalIso(raw.answeredAtIso);
  const provenance = cleanProvenance(raw.provenance);
  if (
    !checkpointId
    || !answer
    || !shownAt
    || !answeredAt
    || !provenance
    || !Number.isSafeInteger(nowMs)
  ) {
    return null;
  }
  if (
    raw.lateCorrection !== null
    && raw.lateCorrection !== true
    && raw.lateCorrection !== false
  ) return null;
  if (
    shownAt.epochMs > nowMs + CHECKPOINT_ANSWER_FUTURE_CLOCK_SKEW_MS
    || answeredAt.epochMs > nowMs + CHECKPOINT_ANSWER_FUTURE_CLOCK_SKEW_MS
  ) {
    return null;
  }
  const rawElapsedMs = answeredAt.epochMs - shownAt.epochMs;
  if (
    rawElapsedMs < -CHECKPOINT_ANSWER_REVERSE_CLOCK_SKEW_MS
    || rawElapsedMs > CHECKPOINT_ANSWER_MAX_DURATION_MS
  ) {
    return null;
  }
  const elapsedMs = Math.max(0, rawElapsedMs);
  return {
    schemaVersion: '1',
    kind: 'CHECKPOINT_ANSWER',
    checkpointId,
    shownAtIso: shownAt.iso,
    answeredAtIso: answeredAt.iso,
    elapsedMs,
    answer,
    lateCorrection: raw.lateCorrection,
    provenance,
  };
}

export async function appendCheckpointAnswer(
  file: string,
  input: unknown
): Promise<CheckpointAnswerWriteResult> {
  const record = sanitizeCheckpointAnswer(input);
  if (!record) {
    return {
      ok: false,
      status: 400,
      error: 'Body must be a valid CHECKPOINT_ANSWER record with allowlisted provenance',
    };
  }
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line, 'utf8') > CHECKPOINT_ANSWER_LINE_MAX_BYTES) {
    return { ok: false, status: 400, error: 'Checkpoint answer record is too large' };
  }
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, line, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 500, error: `Failed to append checkpoint answer: ${message}` };
  }
  return { ok: true, written: true, record };
}

function parseLine(
  line: string,
  nowMs = Date.now()
): CheckpointAnswerRecord | null | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  if (Buffer.byteLength(trimmed, 'utf8') > CHECKPOINT_ANSWER_LINE_MAX_BYTES) {
    return null;
  }
  try {
    return sanitizeCheckpointAnswer(JSON.parse(trimmed), nowMs);
  } catch {
    return null;
  }
}

export function parseCheckpointAnswerLines(raw: string): {
  records: CheckpointAnswerRecord[];
  skipped: number;
} {
  const records: CheckpointAnswerRecord[] = [];
  let skipped = 0;
  const nowMs = Date.now();
  for (const line of raw.split('\n')) {
    const record = parseLine(line, nowMs);
    if (record === undefined) continue;
    if (record === null) skipped += 1;
    else records.push(record);
  }
  return { records, skipped };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(records: CheckpointAnswerRecord[]): CheckpointAnswerSummary {
  const correctedCount = records.filter((record) => record.lateCorrection === true).length;
  const resolvedCorrectionCount = records.filter(
    (record) => record.lateCorrection !== null
  ).length;
  return {
    answerCount: records.length,
    medianElapsedMs: median(records.map((record) => record.elapsedMs)),
    resolvedLateCorrectionRate:
      resolvedCorrectionCount === 0 ? null : correctedCount / resolvedCorrectionCount,
    observedLateCorrectionRateLowerBound:
      records.length === 0 ? null : correctedCount / records.length,
    correctedCount,
    resolvedCorrectionCount,
    unresolvedCorrectionCount: records.length - resolvedCorrectionCount,
  };
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function resolveReadLimits(
  limits: Partial<CheckpointAnswerReadLimits> | undefined
): CheckpointAnswerReadLimits {
  return {
    maxBytes: positiveLimit(limits?.maxBytes, CHECKPOINT_ANSWER_READ_MAX_BYTES),
    maxRows: positiveLimit(limits?.maxRows, CHECKPOINT_ANSWER_READ_MAX_ROWS),
    maxLogicalAnswers: positiveLimit(
      limits?.maxLogicalAnswers,
      CHECKPOINT_ANSWER_READ_MAX_LOGICAL_ANSWERS
    ),
  };
}

function isErrorCode(error: unknown, code: string): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === code
  );
}

async function openCheckpointAnswerSnapshot(
  file: string
): Promise<CheckpointAnswerSnapshot | null> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return null;
    throw error;
  }

  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw Object.assign(
        new Error(`Checkpoint answer log is not a regular file: ${file}`),
        { code: 'CHECKPOINT_ANSWER_LOG_NOT_FILE' }
      );
    }
    const size = Number(metadata.size);
    return {
      size,
      createStream: () => handle.createReadStream({
        start: 0,
        end: Math.max(0, size - 1),
        autoClose: false,
        highWaterMark: CHECKPOINT_ANSWER_LINE_MAX_BYTES,
      }),
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function readProvenance(
  limits: CheckpointAnswerReadLimits,
  bytesRead: number,
  rowsScanned: number,
  recordsRead: number,
  recordsSkipped: number,
  logicalAnswers: number
): CheckpointAnswerReadProvenance {
  return {
    source: 'checkpoint-answer-log',
    complete: true,
    truncated: false,
    bytesRead,
    rowsScanned,
    recordsRead,
    recordsSkipped,
    logicalAnswers,
    limits,
  };
}

function emptyIndex(limits: CheckpointAnswerReadLimits): CheckpointAnswerIndex {
  return {
    records: [],
    skipped: 0,
    recordCount: 0,
    summary: summarize([]),
    read: readProvenance(limits, 0, 0, 0, 0, 0),
  };
}

/**
 * Read one exact, bounded snapshot of the append-only log. A successful result
 * covers the whole captured prefix; budget and I/O failures never become a
 * partial efficacy claim.
 */
export async function readCheckpointAnswerIndex(
  file: string,
  options: CheckpointAnswerReadOptions = {}
): Promise<CheckpointAnswerIndex> {
  const limits = resolveReadLimits(options.limits);
  const snapshot = await (options.openSnapshot ?? openCheckpointAnswerSnapshot)(file);
  if (!snapshot) return emptyIndex(limits);

  const latest = new Map<string, CheckpointAnswerRecord>();
  const validationNowMs = Number.isSafeInteger(options.nowMs)
    ? Number(options.nowMs)
    : Date.now();
  let skipped = 0;
  let recordCount = 0;
  let rowsScanned = 0;
  let bytesRead = 0;
  let pending = '';
  let droppingLongLine = false;

  const budgetError = (
    reason: CheckpointAnswerIncompleteProvenance['reason'],
    limit: number,
    observed: number
  ): CheckpointAnswerReadBudgetError => new CheckpointAnswerReadBudgetError({
    source: 'checkpoint-answer-log',
    complete: false,
    truncated: true,
    reason,
    limit,
    observed,
    bytesRead,
    rowsScanned,
    recordsRead: recordCount,
    recordsSkipped: skipped,
    logicalAnswers: latest.size,
  });

  function beginRow(): void {
    rowsScanned += 1;
    if (rowsScanned > limits.maxRows) {
      throw budgetError('max-rows', limits.maxRows, rowsScanned);
    }
  }

  function accept(line: string): void {
    const record = parseLine(line, validationNowMs);
    if (record === undefined) return;
    if (record === null) {
      skipped += 1;
      return;
    }
    recordCount += 1;
    const key = `${record.checkpointId}\u0000${record.shownAtIso}`;
    const previous = latest.get(key);
    if (!previous && latest.size >= limits.maxLogicalAnswers) {
      throw budgetError(
        'max-logical-answers',
        limits.maxLogicalAnswers,
        latest.size + 1
      );
    }
    // Correction state is monotonic: a retried initial/null event cannot erase
    // an already-recorded resolution, and a true correction cannot become false.
    const lateCorrection = previous?.lateCorrection === true
      ? true
      : record.lateCorrection ?? previous?.lateCorrection ?? null;
    // The first row owns all immutable evidence. Later rows for the same key may
    // only advance correction state; they cannot rewrite answer/timing/cohort or
    // provenance fields that feed efficacy statistics.
    latest.set(key, previous
      ? { ...previous, lateCorrection }
      : { ...record, lateCorrection });
  }

  if (!Number.isSafeInteger(snapshot.size) || snapshot.size < 0) {
    await snapshot.close();
    throw Object.assign(new Error('Checkpoint answer snapshot has an invalid size'), {
      code: 'CHECKPOINT_ANSWER_SNAPSHOT_INVALID',
      size: snapshot.size,
    });
  }
  if (snapshot.size > limits.maxBytes) {
    const error = budgetError('max-bytes', limits.maxBytes, snapshot.size);
    await snapshot.close();
    throw error;
  }
  if (snapshot.size === 0) {
    await snapshot.close();
    return emptyIndex(limits);
  }

  let input: CheckpointAnswerChunkStream;
  try {
    input = snapshot.createStream();
  } catch (error) {
    await snapshot.close();
    throw error;
  }
  const decoder = new StringDecoder('utf8');
  try {
    for await (const chunk of input) {
      const raw = Buffer.isBuffer(chunk)
        ? chunk
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk)
          : Buffer.from(String(chunk), 'utf8');
      bytesRead += raw.byteLength;
      if (bytesRead > limits.maxBytes) {
        throw budgetError('max-bytes', limits.maxBytes, bytesRead);
      }
      let text = decoder.write(raw);
      while (text.length > 0) {
        const newline = text.indexOf('\n');
        const ended = newline !== -1;
        const segment = ended ? text.slice(0, newline) : text;
        text = ended ? text.slice(newline + 1) : '';
        if (droppingLongLine) {
          if (ended) {
            beginRow();
            skipped += 1;
            droppingLongLine = false;
          }
          continue;
        }
        pending += segment;
        if (Buffer.byteLength(pending, 'utf8') > CHECKPOINT_ANSWER_LINE_MAX_BYTES) {
          pending = '';
          if (ended) {
            beginRow();
            skipped += 1;
          }
          else droppingLongLine = true;
          continue;
        }
        if (ended) {
          beginRow();
          accept(pending);
          pending = '';
        }
      }
    }
    pending += decoder.end();
    if (bytesRead !== snapshot.size) {
      throw Object.assign(
        new Error(
          `Checkpoint answer snapshot ended early: read ${bytesRead} of ${snapshot.size} bytes`
        ),
        {
          code: 'CHECKPOINT_ANSWER_SNAPSHOT_INCOMPLETE',
          expectedBytes: snapshot.size,
          bytesRead,
        }
      );
    }
    if (droppingLongLine) {
      beginRow();
      skipped += 1;
    } else if (pending) {
      beginRow();
      accept(pending);
    }
  } finally {
    try {
      input.destroy?.();
    } finally {
      await snapshot.close();
    }
  }

  const records = [...latest.values()];
  return {
    records,
    skipped,
    recordCount,
    summary: summarize(records),
    read: readProvenance(
      limits,
      bytesRead,
      rowsScanned,
      recordCount,
      skipped,
      records.length
    ),
  };
}

/**
 * Bounded, provenance-carrying efficacy view for the #2262 query. The raw log
 * never leaves the store: only aggregates and at most 20 reproducibility
 * samples are returned. `lateCorrection:null` remains explicitly unresolved.
 */
export async function readCheckpointAnswerEfficacy(
  file: string,
  options: CheckpointAnswerReadOptions = {}
): Promise<CheckpointAnswerEfficacy> {
  const index = await readCheckpointAnswerIndex(file, options);
  const ambiguityTriggered = index.records.filter(
    (record) => record.provenance.ambiguityTrigger
  );
  const ambiguityClear = index.records.filter(
    (record) => !record.provenance.ambiguityTrigger
  );
  let startedAtIso: string | null = null;
  let endedAtIso: string | null = null;
  for (const record of index.records) {
    if (startedAtIso === null || record.shownAtIso < startedAtIso) {
      startedAtIso = record.shownAtIso;
    }
    if (endedAtIso === null || record.answeredAtIso > endedAtIso) {
      endedAtIso = record.answeredAtIso;
    }
  }
  return {
    schemaVersion: '1',
    kind: 'CHECKPOINT_ANSWER_EFFICACY',
    summary: index.summary,
    cohorts: {
      ambiguityTriggered: summarize(ambiguityTriggered),
      ambiguityClear: summarize(ambiguityClear),
    },
    window: {
      startedAtIso,
      endedAtIso,
    },
    provenance: {
      ...index.read,
      samples: index.records.slice(-MAX_PROVENANCE_SAMPLES).map((record) => ({
        checkpointId: record.checkpointId,
        shownAtIso: record.shownAtIso,
        answeredAtIso: record.answeredAtIso,
        provenance: record.provenance,
      })),
    },
  };
}
