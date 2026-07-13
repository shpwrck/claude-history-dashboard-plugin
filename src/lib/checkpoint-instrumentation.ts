/**
 * checkpoint-instrumentation.ts — human-answer-time instrumentation for the
 * doc-comprehension checkpoint surface (#2323, epic #2262, the #1934 human-tool
 * lever).
 *
 * When the #1934 lever routes an excursion to the HUMAN, the checkpoint surface
 * ({@link ../components/CheckpointDocContext}) shows the retrieved doc
 * neighborhood alongside an AskUserQuestion-style prompt. This module records
 * the *efficacy signal* that lets #2262 earn its own receipt: how long the human
 * took to answer once the neighborhood was on screen, and whether a **late
 * correction** (#1288) followed — i.e. did surfacing the cluster actually make
 * the human answer faster and more correctly?
 *
 * PURE + framework-free. `buildCheckpointAnswerRecord` is a pure function of its
 * arguments — it reads no clock of its own (both timestamps are passed in),
 * touches no filesystem/network, and imports only TYPES from `doc-neighborhood`.
 * It fails **closed** (returns `null`) on malformed input, exactly like
 * `sanitizeAdoptionReceipt` in `adoption-receipts.ts`, so a caller can never
 * persist a half-formed record.
 *
 * Persistence is deliberately OUT of this module. It defines the record shape,
 * the pure builder, and a pluggable {@link CheckpointAnswerSink} so the UI can
 * emit a record without knowing where it lands. An in-memory sink ships for
 * tests and preview; the durable server-side sink (a `/api/...` capture route +
 * append-only JSONL, mirroring the reject-signal path) is tracked as a
 * follow-up so this slice stays reviewable.
 */
import type { DocNeighborhood, NeighborhoodAnchor } from './doc-neighborhood';

// ── Record shape ─────────────────────────────────────────────────────────────

/**
 * Structured provenance for auditability (the "recommendations are auditable
 * claims" contract): every efficacy record cites exactly what the human saw, so
 * a downstream reader can reproduce the measurement rather than trust it.
 */
export interface CheckpointAnswerProvenance {
  /** Where this record's neighborhood came from — the #2263 retrieval. */
  source: 'doc-neighborhood';
  /** The anchor that seeded the neighborhood shown at the checkpoint. */
  anchor: NeighborhoodAnchor;
  /** Slugs actually rendered at the checkpoint (what the human saw), sorted. */
  shownSlugs: string[];
  /** The #1934 ambiguity trigger state of the shown neighborhood. */
  ambiguityTrigger: boolean;
  /**
   * Slugs the UI DEMOTED because they were flagged stale/contradictory
   * (rendered "as of <date>", not as current) — the subset of the shown slugs
   * that are ambiguity sources. Sorted.
   */
  demotedSlugs: string[];
}

/**
 * One human-answer-time record. Sits beside the adoption/proof receipts as a
 * schema-versioned, allowlisted artifact; a `lateCorrection: null` is a
 * first-class "not yet resolved" state, not a missing field.
 */
export interface CheckpointAnswerRecord {
  schemaVersion: '1';
  kind: 'CHECKPOINT_ANSWER';
  /** Stable id for this checkpoint instance. */
  checkpointId: string;
  /** ISO-8601 time the checkpoint (AskUserQuestion) was shown to the human. */
  shownAtIso: string;
  /** ISO-8601 time the human submitted an answer. */
  answeredAtIso: string;
  /**
   * Elapsed milliseconds from shown -> answered. Always `>= 0` — a clock skew
   * that makes `answeredAt` predate `shownAt` is clamped to 0, never negative.
   */
  elapsedMs: number;
  /** The option the human chose (opaque label/id). */
  answer: string;
  /**
   * Whether a late correction (#1288) followed this answer: the human revised
   * within the correction window. `null` = not yet known (the answer is still
   * "open"); `true`/`false` once resolved. Set later via
   * {@link withLateCorrection}.
   */
  lateCorrection: boolean | null;
  /** Structured provenance for auditability. */
  provenance: CheckpointAnswerProvenance;
}

/** A sink the UI emits records into, decoupled from any persistence backend. */
export type CheckpointAnswerSink = (record: CheckpointAnswerRecord) => void;

// ── Builder input ────────────────────────────────────────────────────────────

/** A timestamp accepted as integer epoch-ms, explicit-zone ISO, or a `Date`. */
export type TimeInput = number | string | Date;

export interface BuildCheckpointAnswerInput {
  checkpointId: string;
  /** When the checkpoint was shown (integer epoch-ms / explicit-zone ISO / Date). */
  shownAt: TimeInput;
  /** When the human submitted (integer epoch-ms / explicit-zone ISO / Date). */
  answeredAt: TimeInput;
  /** The chosen option (non-empty). */
  answer: string;
  /** The neighborhood surfaced at the checkpoint; drives provenance. */
  neighborhood: DocNeighborhood;
  /**
   * The slugs actually rendered (default: every node in `neighborhood.nodes`).
   * Pass a narrower set when the UI shows only a top-N slice, so provenance
   * records what the human really saw.
   */
  shownSlugs?: string[];
  /** Initial late-correction state (default `null` = open). */
  lateCorrection?: boolean | null;
}

// ── Small pure helpers ───────────────────────────────────────────────────────

const MIN_CANONICAL_EPOCH_MS = -62_167_219_200_000; // 0000-01-01T00:00:00.000Z
const MAX_CANONICAL_EPOCH_MS = 253_402_300_799_999; // 9999-12-31T23:59:59.999Z
const EXPLICIT_ZONE_ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseExplicitZoneIso(value: string): number | null {
  const match = value.match(EXPLICIT_ZONE_ISO_PATTERN);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8];
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 59
  ) {
    return null;
  }
  if (zone !== 'Z') {
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 23 || zoneMinute > 59) return null;
  }
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Parse a {@link TimeInput} to canonical four-digit-year epoch-ms. */
function toEpochMs(v: TimeInput): number | null {
  let timestamp: number | null = null;
  if (v instanceof Date) {
    timestamp = v.getTime();
  } else if (typeof v === 'number') {
    timestamp = v;
  } else if (typeof v === 'string') {
    timestamp = parseExplicitZoneIso(v);
  }
  if (
    !Number.isSafeInteger(timestamp)
    || Number(timestamp) < MIN_CANONICAL_EPOCH_MS
    || Number(timestamp) > MAX_CANONICAL_EPOCH_MS
  ) {
    return null;
  }
  return Number(timestamp);
}

function nonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

// ── Builder ──────────────────────────────────────────────────────────────────

/**
 * Build a validated {@link CheckpointAnswerRecord} from the checkpoint's timing
 * and the neighborhood the human saw. Returns `null` (fail-closed) when a
 * required field is missing/blank or a timestamp is unparseable, so a malformed
 * record can never reach a sink.
 *
 * `elapsedMs` is `max(0, answered - shown)`. Provenance is derived from the
 * neighborhood: `shownSlugs` defaults to every rendered node; `demotedSlugs` is
 * the intersection of the shown slugs with `neighborhood.ambiguitySources`
 * (the stale/contradictory nodes the UI demotes to "as of <date>").
 */
export function buildCheckpointAnswerRecord(
  input: BuildCheckpointAnswerInput
): CheckpointAnswerRecord | null {
  const checkpointId = nonEmptyString(input.checkpointId);
  const answer = nonEmptyString(input.answer);
  if (!checkpointId || !answer) return null;
  if (!input.neighborhood || !Array.isArray(input.neighborhood.nodes)) return null;

  const shownMs = toEpochMs(input.shownAt);
  const answeredMs = toEpochMs(input.answeredAt);
  if (shownMs === null || answeredMs === null) return null;

  const elapsedMs = Math.max(0, answeredMs - shownMs);

  const allShown =
    input.shownSlugs && input.shownSlugs.length > 0
      ? input.shownSlugs
      : input.neighborhood.nodes.map((n) => n.slug);
  // De-dupe + sort so two orderings of the same shown set produce one record.
  const shownSlugs = [...new Set(allShown.filter((s): s is string => typeof s === 'string' && s.length > 0))].sort();

  const sourceSet = new Set(input.neighborhood.ambiguitySources ?? []);
  const demotedSlugs = shownSlugs.filter((s) => sourceSet.has(s));

  const lateCorrection =
    input.lateCorrection === true || input.lateCorrection === false
      ? input.lateCorrection
      : null;

  return {
    schemaVersion: '1',
    kind: 'CHECKPOINT_ANSWER',
    checkpointId,
    shownAtIso: new Date(shownMs).toISOString(),
    answeredAtIso: new Date(answeredMs).toISOString(),
    elapsedMs,
    answer,
    lateCorrection,
    provenance: {
      source: 'doc-neighborhood',
      anchor: input.neighborhood.anchor,
      shownSlugs,
      ambiguityTrigger: !!input.neighborhood.ambiguityTrigger,
      demotedSlugs,
    },
  };
}

/**
 * Return a copy of `record` with its late-correction (#1288) state resolved —
 * used when a correction (or its absence, once the window closes) is observed
 * after the answer was recorded. Pure: never mutates the input.
 */
export function withLateCorrection(
  record: CheckpointAnswerRecord,
  lateCorrection: boolean
): CheckpointAnswerRecord {
  return { ...record, lateCorrection };
}

// ── In-memory sink (tests + preview; durable sink is a follow-up) ────────────

export interface InMemoryCheckpointSink {
  sink: CheckpointAnswerSink;
  records: CheckpointAnswerRecord[];
}

/**
 * A trivial collecting sink. The UI can emit into it and read `records` back;
 * the durable server-side sink (capture route + append-only JSONL) is tracked
 * separately so this surface can ship and be exercised without a backend.
 */
export function createInMemoryCheckpointSink(): InMemoryCheckpointSink {
  const records: CheckpointAnswerRecord[] = [];
  return {
    records,
    sink: (record) => {
      records.push(record);
    },
  };
}
