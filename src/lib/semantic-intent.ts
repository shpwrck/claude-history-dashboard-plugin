/**
 * Offline local semantic-intent receipts (#2574, epic #2177).
 *
 * The down-modelling proof loop groups historical calls with coarse transcript
 * heuristics, which cannot separate semantic intents finely enough to test a
 * narrow per-class routing policy. A local classifier (an existing vLLM Semantic
 * Router / mmBERT deployment, reached over loopback) tags already-captured calls
 * and drops **receipts** under `~/.claude/model-evals/semantic-intent/`. This
 * module is the parser for those receipts.
 *
 * Three boundaries define what this file is allowed to be, and each is the
 * reason a whole class of code is absent here:
 *
 *   1. **Contract + parser only.** Like its `model-eval-ingest.ts` sibling, this
 *      repo defines the artifact shape and reads it; it never invokes, spawns,
 *      or configures the classifier, never downloads weights, and never opens a
 *      socket. That is why there is no client, no fetch, and no config here.
 *   2. **Bounded receipts, never prose.** A row carries an evidence reference, a
 *      content hash, a class, a confidence, and provenance — never prompt text.
 *      Content therefore cannot leave the host through this path even in
 *      principle, because it was never in the artifact to begin with.
 *   3. **Refinement, not replacement.** Semantic intent may sharpen the existing
 *      canonical task taxonomy; it must not silently replace it. That is why
 *      `canonicalTaskClass` is a separate, conservative field rather than an
 *      overwrite of the task class a row belongs to.
 *
 * Suppression discipline: malformed, low-confidence, unknown-classifier,
 * taxonomy-mismatched, duplicate, and unjoinable rows resolve to
 * {@link UNKNOWN_INTENT_CLASS} or are dropped with a counted reason — never to an
 * invented class. A summary therefore always states how much evidence it
 * *discarded*, so a caller can tell a thin corpus from a clean one.
 *
 * Dependency-free on purpose: this module is part of the server module graph,
 * which ships zero node_modules (#1013), and it is browser-safe so the same code
 * can type the SPA dataset (where the value is always null).
 */

/** Sentinel for a row whose intent could not be trusted. Never a real class. */
export const UNKNOWN_INTENT_CLASS = 'unknown';

/**
 * Taxonomy versions this build knows how to read. A receipt produced against an
 * unlisted version is suppressed wholesale rather than reinterpreted: class
 * *names* may be reused across taxonomy revisions with different meanings, so a
 * silent best-effort read is exactly how a routing claim ends up scoped to a
 * class that no longer means what it did.
 */
export const SUPPORTED_TAXONOMY_VERSIONS: readonly string[] = ['v1'];

/**
 * Minimum classifier confidence for a row to carry its class. Below it the row
 * is retained (it is still evidence that a call was seen) but its class degrades
 * to `unknown`, so a hedged classification can never scope a recommendation.
 */
export const DEFAULT_MIN_CONFIDENCE = 0.7;

/** Per-artifact row cap. Bounds the join cost and the dataset payload. */
export const MAX_ROWS_PER_ARTIFACT = 5000;
/** Total row cap across all artifacts, applied after per-artifact capping. */
export const MAX_ROWS_TOTAL = 20000;
/** Longest accepted identifier-ish string. Anything longer is malformed, not truncated. */
const MAX_ID_LENGTH = 256;

/** Why a row was discarded or degraded. Counted so a summary is auditable. */
export type SemanticIntentSuppression =
  | 'malformed'
  | 'low-confidence'
  | 'taxonomy-mismatch'
  | 'unknown-classifier'
  | 'duplicate'
  | 'oversized';

export const SUPPRESSION_REASONS: readonly SemanticIntentSuppression[] = [
  'malformed',
  'low-confidence',
  'taxonomy-mismatch',
  'unknown-classifier',
  'duplicate',
  'oversized',
];

/** One classified call, reduced to bounded evidence. */
export interface SemanticIntentRow {
  /**
   * Stable reference to the captured call this row classifies — the same
   * `promptHash` the shadow-calls ledger and replay corpus key on, so a row
   * joins to existing evidence without needing any new identity scheme.
   */
  evidenceRef: string;
  /** SHA-256 of the classified content. Identity only; the content itself is never carried. */
  contentSha256: string;
  /** Normalized intent class, or {@link UNKNOWN_INTENT_CLASS} when suppressed. */
  intentClass: string;
  /** Classifier confidence in [0,1]. */
  confidence: number;
  /**
   * Conservative projection into the EXISTING canonical task taxonomy, or null
   * when the classifier offered none. Deliberately separate from `intentClass`:
   * semantic intent refines the canonical taxonomy, it does not replace it.
   */
  canonicalTaskClass: string | null;
  /** ISO timestamp the classification was produced. */
  classifiedAt: string;
}

/** Identity of the classifier that produced a receipt. */
export interface SemanticIntentClassifier {
  id: string;
  revision: string;
}

/** The deterministic summary the dataset carries. */
export interface SemanticIntentSummary {
  schemaVersion: 1;
  kind: 'semantic-intent-summary';
  /** Artifacts that survived the header check. */
  artifactCount: number;
  /** Artifacts rejected wholesale (bad header / unsupported taxonomy). */
  rejectedArtifactCount: number;
  /** Rows retained, including those degraded to `unknown`. */
  rowCount: number;
  /** Retained rows whose class is trusted (i.e. not `unknown`). */
  classifiedRowCount: number;
  /** Distinct classifiers seen, sorted by `id` then `revision`. */
  classifiers: SemanticIntentClassifier[];
  /** Taxonomy versions seen, sorted. */
  taxonomyVersions: string[];
  /** Per-class retained counts, sorted by count desc then class asc. `unknown` included. */
  classCounts: { intentClass: string; count: number }[];
  /** Rows keyed by `evidenceRef`, sorted by `evidenceRef` asc. */
  rows: SemanticIntentRow[];
  /** Every reason key present (0+), so a caller can audit what was discarded. */
  suppressed: Record<SemanticIntentSuppression, number>;
  /** Newest `classifiedAt` date (YYYY-MM-DD) across retained rows; null when empty. */
  asOf: string | null;
}

function boundedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ID_LENGTH) return null;
  return trimmed;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * An intent class name must look like a taxonomy key, not free text. Rejecting
 * anything else is what keeps prompt prose from reaching the dataset through a
 * field that is nominally a label.
 */
function intentClassName(value: unknown): string | null {
  const s = boundedString(value);
  if (!s || s.length > 64) return null;
  return /^[a-z0-9][a-z0-9._-]*$/.test(s) ? s : null;
}

/**
 * Validate one raw row against the bounded contract.
 *
 * Returns the row plus the reason it was degraded, if any. A structurally bad
 * row is `null` (dropped); a structurally fine but untrustworthy row is retained
 * with `intentClass: 'unknown'`, because "we saw this call and could not classify
 * it" is a materially different fact from "we never saw it" — and conflating them
 * would let a low-confidence corpus masquerade as a small clean one.
 */
export function sanitizeSemanticIntentRow(
  raw: unknown,
  minConfidence: number = DEFAULT_MIN_CONFIDENCE
): { row: SemanticIntentRow; suppression: SemanticIntentSuppression | null } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const evidenceRef = boundedString(r.evidenceRef);
  if (!evidenceRef) return null;
  if (!isSha256(r.contentSha256)) return null;
  const classifiedAt = isoDate(r.classifiedAt);
  if (!classifiedAt) return null;

  const confidence = typeof r.confidence === 'number' && Number.isFinite(r.confidence)
    ? r.confidence
    : null;
  if (confidence === null || confidence < 0 || confidence > 1) return null;

  const intentClass = intentClassName(r.intentClass);
  if (!intentClass) return null;

  // `canonicalTaskClass` is optional; a malformed one is dropped to null rather
  // than sinking the row, since the row's own intent evidence is still usable.
  const canonicalTaskClass =
    r.canonicalTaskClass == null ? null : intentClassName(r.canonicalTaskClass);

  const trusted = confidence >= minConfidence && intentClass !== UNKNOWN_INTENT_CLASS;
  return {
    row: {
      evidenceRef,
      contentSha256: r.contentSha256,
      intentClass: trusted ? intentClass : UNKNOWN_INTENT_CLASS,
      confidence,
      canonicalTaskClass: trusted ? canonicalTaskClass : null,
      classifiedAt,
    },
    suppression: trusted ? null : 'low-confidence',
  };
}

interface ArtifactHeader {
  taxonomyVersion: string;
  classifier: SemanticIntentClassifier;
  rows: unknown[];
}

/**
 * Validate an artifact's header. A bad or unsupported header rejects the WHOLE
 * artifact: its rows cannot be attributed to a known taxonomy or classifier, and
 * a row whose provenance is unknown is not evidence.
 */
function readArtifactHeader(
  raw: unknown,
  supportedTaxonomies: readonly string[]
): { header: ArtifactHeader } | { reject: SemanticIntentSuppression } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { reject: 'malformed' };
  const a = raw as Record<string, unknown>;
  if (a.kind !== 'semantic-intent-receipts') return { reject: 'malformed' };
  if (a.schemaVersion !== 1) return { reject: 'malformed' };

  const taxonomyVersion = boundedString(a.taxonomyVersion);
  if (!taxonomyVersion) return { reject: 'malformed' };
  if (!supportedTaxonomies.includes(taxonomyVersion)) return { reject: 'taxonomy-mismatch' };

  const c = a.classifier;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return { reject: 'unknown-classifier' };
  const id = boundedString((c as Record<string, unknown>).id);
  const revision = boundedString((c as Record<string, unknown>).revision);
  if (!id || !revision) return { reject: 'unknown-classifier' };

  if (!Array.isArray(a.rows)) return { reject: 'malformed' };
  return { header: { taxonomyVersion, classifier: { id, revision }, rows: a.rows } };
}

/**
 * Fold semantic-intent receipt artifacts into one deterministic summary.
 *
 * Determinism (acceptance): for a given artifact list the output is byte-stable —
 * every list is totally ordered, so no insertion order leaks into the dataset.
 *
 * @param rawArtifacts untrusted on-disk artifacts; non-conforming ones are dropped.
 * @param options.minConfidence override the trust floor (tests / a tuned deployment).
 * @param options.supportedTaxonomyVersions override the accepted taxonomy set.
 */
export function ingestSemanticIntent(
  rawArtifacts: readonly unknown[],
  {
    minConfidence = DEFAULT_MIN_CONFIDENCE,
    supportedTaxonomyVersions = SUPPORTED_TAXONOMY_VERSIONS,
  }: { minConfidence?: number; supportedTaxonomyVersions?: readonly string[] } = {}
): SemanticIntentSummary {
  const suppressed = Object.fromEntries(
    SUPPRESSION_REASONS.map((k) => [k, 0])
  ) as Record<SemanticIntentSuppression, number>;

  const classifiers = new Map<string, SemanticIntentClassifier>();
  const taxonomyVersions = new Set<string>();
  // Keyed by evidenceRef: one call has one intent. A second row for the same
  // reference is ambiguous, and picking a winner (newest? highest confidence?)
  // would be inventing a tie-break the classifier never expressed — so BOTH are
  // suppressed to `unknown` instead.
  const byRef = new Map<string, { row: SemanticIntentRow; conflicted: boolean }>();

  let artifactCount = 0;
  let rejectedArtifactCount = 0;
  let totalRows = 0;

  for (const raw of rawArtifacts) {
    const parsed = readArtifactHeader(raw, supportedTaxonomyVersions);
    if ('reject' in parsed) {
      rejectedArtifactCount += 1;
      suppressed[parsed.reject] += 1;
      continue;
    }
    const { header } = parsed;
    artifactCount += 1;
    taxonomyVersions.add(header.taxonomyVersion);
    const key = `${header.classifier.id} ${header.classifier.revision}`;
    if (!classifiers.has(key)) classifiers.set(key, header.classifier);

    if (header.rows.length > MAX_ROWS_PER_ARTIFACT) {
      suppressed.oversized += header.rows.length - MAX_ROWS_PER_ARTIFACT;
    }
    for (const rawRow of header.rows.slice(0, MAX_ROWS_PER_ARTIFACT)) {
      if (totalRows >= MAX_ROWS_TOTAL) {
        suppressed.oversized += 1;
        continue;
      }
      const sanitized = sanitizeSemanticIntentRow(rawRow, minConfidence);
      if (!sanitized) {
        suppressed.malformed += 1;
        continue;
      }
      if (sanitized.suppression) suppressed[sanitized.suppression] += 1;

      const existing = byRef.get(sanitized.row.evidenceRef);
      if (existing) {
        // Two receipts for one call. Only a genuine disagreement is ambiguous;
        // a byte-identical re-emission of the same classification is just the
        // producer running twice and must not be punished as a conflict.
        const sameVerdict =
          existing.row.contentSha256 === sanitized.row.contentSha256 &&
          existing.row.intentClass === sanitized.row.intentClass &&
          existing.row.canonicalTaskClass === sanitized.row.canonicalTaskClass;
        suppressed.duplicate += 1;
        if (!sameVerdict) {
          existing.conflicted = true;
          existing.row = {
            ...existing.row,
            intentClass: UNKNOWN_INTENT_CLASS,
            canonicalTaskClass: null,
          };
        }
        continue;
      }
      byRef.set(sanitized.row.evidenceRef, { row: sanitized.row, conflicted: false });
      totalRows += 1;
    }
  }

  const rows = [...byRef.values()]
    .map((e) => e.row)
    .sort((a, b) => (a.evidenceRef < b.evidenceRef ? -1 : a.evidenceRef > b.evidenceRef ? 1 : 0));

  const counts = new Map<string, number>();
  let classifiedRowCount = 0;
  let asOf: string | null = null;
  for (const row of rows) {
    counts.set(row.intentClass, (counts.get(row.intentClass) ?? 0) + 1);
    if (row.intentClass !== UNKNOWN_INTENT_CLASS) classifiedRowCount += 1;
    const date = row.classifiedAt.slice(0, 10);
    if (asOf === null || date > asOf) asOf = date;
  }

  return {
    schemaVersion: 1,
    kind: 'semantic-intent-summary',
    artifactCount,
    rejectedArtifactCount,
    rowCount: rows.length,
    classifiedRowCount,
    classifiers: [...classifiers.values()].sort(
      (a, b) =>
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
        (a.revision < b.revision ? -1 : a.revision > b.revision ? 1 : 0)
    ),
    taxonomyVersions: [...taxonomyVersions].sort(),
    classCounts: [...counts.entries()]
      .map(([intentClass, count]) => ({ intentClass, count }))
      .sort(
        (a, b) =>
          b.count - a.count ||
          (a.intentClass < b.intentClass ? -1 : a.intentClass > b.intentClass ? 1 : 0)
      ),
    rows,
    suppressed,
    asOf,
  };
}

/**
 * Look up the trusted intent for a captured call, or null.
 *
 * The join point for consumers (#2647). Returns null for an unjoinable or
 * `unknown` reference, so a caller cannot accidentally scope a claim to the
 * absence of evidence.
 */
export function intentForEvidenceRef(
  summary: SemanticIntentSummary | null | undefined,
  evidenceRef: string
): SemanticIntentRow | null {
  if (!summary) return null;
  const row = summary.rows.find((r) => r.evidenceRef === evidenceRef);
  if (!row || row.intentClass === UNKNOWN_INTENT_CLASS) return null;
  return row;
}
