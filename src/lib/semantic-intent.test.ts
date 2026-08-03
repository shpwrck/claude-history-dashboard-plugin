/**
 * Tests for the offline semantic-intent receipt parser (#2574).
 *
 * Weighted toward the ways this parser could LIE — inventing a class from thin
 * evidence, letting prompt prose through a label field, reading a receipt from a
 * taxonomy whose class names mean something else, or silently picking a winner
 * between two disagreeing classifications — rather than toward the happy path.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_CONFIDENCE,
  MAX_ROWS_PER_ARTIFACT,
  SUPPORTED_TAXONOMY_VERSIONS,
  UNKNOWN_INTENT_CLASS,
  ingestSemanticIntent,
  intentForEvidenceRef,
  sanitizeSemanticIntentRow,
} from './semantic-intent';

const SHA = 'a'.repeat(64);
const sha = (n: number) => String(n).padStart(64, '0');

const row = (over: Record<string, unknown> = {}) => ({
  evidenceRef: 'prompt-hash-1',
  contentSha256: SHA,
  intentClass: 'code-search',
  confidence: 0.95,
  canonicalTaskClass: 'search',
  classifiedAt: '2026-07-01T10:00:00.000Z',
  ...over,
});

const artifact = (rows: unknown[], over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: 'semantic-intent-receipts',
  taxonomyVersion: 'v1',
  classifier: { id: 'mmbert-intent', revision: 'r7' },
  rows,
  ...over,
});

describe('sanitizeSemanticIntentRow', () => {
  it('accepts a well-formed row', () => {
    const out = sanitizeSemanticIntentRow(row());
    expect(out?.suppression).toBeNull();
    expect(out?.row.intentClass).toBe('code-search');
    expect(out?.row.canonicalTaskClass).toBe('search');
  });

  it.each([
    ['a non-object', 'not-an-object'],
    ['a missing evidence reference', row({ evidenceRef: '' })],
    ['a non-SHA-256 content hash', row({ contentSha256: 'deadbeef' })],
    ['an unparseable timestamp', row({ classifiedAt: 'last tuesday' })],
    ['a confidence outside [0,1]', row({ confidence: 1.4 })],
    ['a non-numeric confidence', row({ confidence: 'high' })],
    ['a missing class', row({ intentClass: null })],
  ])('drops %s', (_label, raw) => {
    expect(sanitizeSemanticIntentRow(raw)).toBeNull();
  });

  it('rejects a class name that is really free text, so prose cannot ride in on a label field', () => {
    expect(sanitizeSemanticIntentRow(row({ intentClass: 'find the bug in src/foo.ts please' }))).toBeNull();
    expect(sanitizeSemanticIntentRow(row({ intentClass: 'A'.repeat(200) }))).toBeNull();
  });

  it('degrades a low-confidence row to unknown instead of dropping it', () => {
    // "seen but unclassifiable" is a different fact from "never seen"; conflating
    // them would let a hedged corpus look like a small clean one.
    const out = sanitizeSemanticIntentRow(row({ confidence: DEFAULT_MIN_CONFIDENCE - 0.01 }));
    expect(out?.row.intentClass).toBe(UNKNOWN_INTENT_CLASS);
    expect(out?.suppression).toBe('low-confidence');
  });

  it('keeps the SCOPE on a degraded row so it stays countable', () => {
    // Only the class claim degrades. Nulling the scope too would drop the row
    // out of consumers' joins, making a hedged corpus look confident — the
    // denominator has to include the rows the classifier was unsure about.
    const out = sanitizeSemanticIntentRow(row({ confidence: 0.1 }));
    expect(out?.row.intentClass).toBe(UNKNOWN_INTENT_CLASS);
    expect(out?.row.canonicalTaskClass).toBe('search');
  });

  it('keeps the row but nulls a malformed canonical task class', () => {
    const out = sanitizeSemanticIntentRow(row({ canonicalTaskClass: 'not a class name' }));
    expect(out?.row.intentClass).toBe('code-search');
    expect(out?.row.canonicalTaskClass).toBeNull();
  });
});

describe('ingestSemanticIntent', () => {
  it('summarizes a clean corpus', () => {
    const s = ingestSemanticIntent([
      artifact([
        row({ evidenceRef: 'h1', contentSha256: sha(1) }),
        row({ evidenceRef: 'h2', contentSha256: sha(2), intentClass: 'bug-fix', canonicalTaskClass: 'debug' }),
      ]),
    ]);
    expect(s.artifactCount).toBe(1);
    expect(s.rowCount).toBe(2);
    expect(s.classifiedRowCount).toBe(2);
    expect(s.classifiers).toEqual([{ id: 'mmbert-intent', revision: 'r7' }]);
    expect(s.taxonomyVersions).toEqual(['v1']);
    expect(s.asOf).toBe('2026-07-01');
    expect(Object.values(s.suppressed).every((n) => n === 0)).toBe(true);
  });

  it('is byte-stable regardless of input order', () => {
    const a = row({ evidenceRef: 'zz', contentSha256: sha(1) });
    const b = row({ evidenceRef: 'aa', contentSha256: sha(2), intentClass: 'bug-fix' });
    expect(JSON.stringify(ingestSemanticIntent([artifact([a, b])])))
      .toBe(JSON.stringify(ingestSemanticIntent([artifact([b, a])])));
  });

  it('selects same-verdict duplicate provenance byte-stably', () => {
    const earlier = row({
      evidenceRef: 'same-ref',
      confidence: 0.95,
      classifiedAt: '2026-07-01T10:00:00.000Z',
    });
    const later = row({
      evidenceRef: 'same-ref',
      confidence: 0.85,
      classifiedAt: '2026-07-02T10:00:00.000Z',
    });

    const forward = ingestSemanticIntent([artifact([earlier]), artifact([later])]);
    const reversed = ingestSemanticIntent([artifact([later]), artifact([earlier])]);

    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
    expect(forward.rows[0].confidence).toBe(0.85);
    expect(forward.rows[0].classifiedAt).toBe('2026-07-02T10:00:00.000Z');
    expect(forward.asOf).toBe('2026-07-02');
  });

  it('rejects a whole artifact whose taxonomy version is unsupported', () => {
    // Class names may be reused across taxonomy revisions with different
    // meanings, so a best-effort read is exactly how a claim ends up scoped to a
    // class that no longer means what it did.
    const s = ingestSemanticIntent([artifact([row()], { taxonomyVersion: 'v99' })]);
    expect(s.artifactCount).toBe(0);
    expect(s.rejectedArtifactCount).toBe(1);
    expect(s.rowCount).toBe(0);
    expect(s.suppressed['taxonomy-mismatch']).toBe(1);
  });

  it('rejects a whole artifact with no usable classifier identity', () => {
    for (const bad of [{ classifier: null }, { classifier: { id: 'x' } }, { classifier: {} }]) {
      const s = ingestSemanticIntent([artifact([row()], bad)]);
      expect(s.rejectedArtifactCount).toBe(1);
      expect(s.suppressed['unknown-classifier']).toBe(1);
      expect(s.rowCount).toBe(0);
    }
  });

  it.each([
    ['a non-object artifact', 'nope'],
    ['a wrong kind', artifact([row()], { kind: 'model-eval-result' })],
    ['an unknown schema version', artifact([row()], { schemaVersion: 2 })],
    ['a non-array rows field', artifact([], { rows: {} })],
  ])('rejects %s wholesale', (_label, raw) => {
    const s = ingestSemanticIntent([raw]);
    expect(s.rejectedArtifactCount).toBe(1);
    expect(s.suppressed.malformed).toBe(1);
  });

  it('counts malformed rows without sinking their artifact', () => {
    const s = ingestSemanticIntent([artifact([row({ evidenceRef: 'ok' }), 'garbage', { nope: true }])]);
    expect(s.artifactCount).toBe(1);
    expect(s.rowCount).toBe(1);
    expect(s.suppressed.malformed).toBe(2);
  });

  it('suppresses BOTH sides of a disagreeing duplicate rather than picking a winner', () => {
    // Choosing newest-wins or highest-confidence-wins would invent a tie-break
    // for the VERDICT. The retained provenance row still has a documented total
    // order so every persisted field is byte-stable when input order reverses.
    const earlier = row({
      evidenceRef: 'dup',
      contentSha256: sha(1),
      intentClass: 'code-search',
      confidence: 0.95,
      canonicalTaskClass: 'search',
      classifiedAt: '2026-07-01T10:00:00.000Z',
    });
    const later = row({
      evidenceRef: 'dup',
      contentSha256: sha(2),
      intentClass: 'bug-fix',
      confidence: 0.85,
      canonicalTaskClass: 'debug',
      classifiedAt: '2026-07-02T10:00:00.000Z',
    });
    const s = ingestSemanticIntent([artifact([earlier, later])]);
    const reversed = ingestSemanticIntent([artifact([later, earlier])]);

    expect(JSON.stringify(s)).toBe(JSON.stringify(reversed));
    expect(s.rowCount).toBe(1);
    expect(s.rows[0].intentClass).toBe(UNKNOWN_INTENT_CLASS);
    expect(s.rows[0].canonicalTaskClass).toBeNull();
    expect(s.rows[0].contentSha256).toBe(sha(2));
    expect(s.rows[0].confidence).toBe(0.85);
    expect(s.rows[0].classifiedAt).toBe('2026-07-02T10:00:00.000Z');
    expect(s.asOf).toBe('2026-07-02');
    expect(s.classifiedRowCount).toBe(0);
    expect(s.suppressed.duplicate).toBe(1);
  });

  it('treats an identical re-emission as a duplicate, not a conflict', () => {
    // The producer running twice is not a disagreement.
    const s = ingestSemanticIntent([artifact([row({ evidenceRef: 'same' }), row({ evidenceRef: 'same' })])]);
    expect(s.rowCount).toBe(1);
    expect(s.rows[0].intentClass).toBe('code-search');
    expect(s.classifiedRowCount).toBe(1);
    expect(s.suppressed.duplicate).toBe(1);
  });

  it('caps an oversized artifact and reports how much it dropped', () => {
    const rows = Array.from({ length: MAX_ROWS_PER_ARTIFACT + 25 }, (_, i) =>
      row({ evidenceRef: `h${i}`, contentSha256: sha(i) })
    );
    const s = ingestSemanticIntent([artifact(rows)]);
    expect(s.rowCount).toBe(MAX_ROWS_PER_ARTIFACT);
    expect(s.suppressed.oversized).toBe(25);
  });

  it('reports a low-confidence corpus as retained-but-unclassified, not as absent', () => {
    const s = ingestSemanticIntent([
      artifact([
        row({ evidenceRef: 'h1', confidence: 0.4 }),
        row({ evidenceRef: 'h2', confidence: 0.3 }),
      ]),
    ]);
    expect(s.rowCount).toBe(2);
    expect(s.classifiedRowCount).toBe(0);
    expect(s.suppressed['low-confidence']).toBe(2);
    expect(s.classCounts).toEqual([{ intentClass: UNKNOWN_INTENT_CLASS, count: 2 }]);
  });

  it('honours an overridden confidence floor', () => {
    const rows = [row({ evidenceRef: 'h1', confidence: 0.55 })];
    expect(ingestSemanticIntent([artifact(rows)]).classifiedRowCount).toBe(0);
    expect(ingestSemanticIntent([artifact(rows)], { minConfidence: 0.5 }).classifiedRowCount).toBe(1);
  });

  it('stamps asOf from the newest retained row, never the clock', () => {
    const s = ingestSemanticIntent([
      artifact([
        row({ evidenceRef: 'old', classifiedAt: '2026-01-02T00:00:00.000Z' }),
        row({ evidenceRef: 'new', contentSha256: sha(2), classifiedAt: '2026-03-04T00:00:00.000Z' }),
      ]),
    ]);
    expect(s.asOf).toBe('2026-03-04');
  });

  it('produces an honest empty summary when the classifier produced nothing', () => {
    // The unreachable-classifier case: the runner emits no artifact at all.
    const s = ingestSemanticIntent([]);
    expect(s.artifactCount).toBe(0);
    expect(s.rowCount).toBe(0);
    expect(s.asOf).toBeNull();
    expect(s.classifiers).toEqual([]);
    expect(Object.values(s.suppressed).every((n) => n === 0)).toBe(true);
  });

  it('merges multiple artifacts and their classifier identities', () => {
    const s = ingestSemanticIntent([
      artifact([row({ evidenceRef: 'h1', contentSha256: sha(1) })]),
      artifact([row({ evidenceRef: 'h2', contentSha256: sha(2) })], {
        classifier: { id: 'vllm-semantic-router', revision: 'r2' },
      }),
    ]);
    expect(s.artifactCount).toBe(2);
    expect(s.rowCount).toBe(2);
    expect(s.classifiers.map((c) => c.id)).toEqual(['mmbert-intent', 'vllm-semantic-router']);
  });

  it('declares the taxonomy versions it supports', () => {
    expect(SUPPORTED_TAXONOMY_VERSIONS).toContain('v1');
  });
});

describe('intentForEvidenceRef', () => {
  const summary = ingestSemanticIntent([
    artifact([
      row({ evidenceRef: 'known', contentSha256: sha(1) }),
      row({ evidenceRef: 'hedged', contentSha256: sha(2), confidence: 0.2 }),
    ]),
  ]);

  it('returns the row for a trusted reference', () => {
    expect(intentForEvidenceRef(summary, 'known')?.intentClass).toBe('code-search');
  });

  it('returns null for an unjoinable reference', () => {
    expect(intentForEvidenceRef(summary, 'never-seen')).toBeNull();
  });

  it('returns null for a row that degraded to unknown', () => {
    // A consumer must never be able to scope a claim to the ABSENCE of evidence.
    expect(intentForEvidenceRef(summary, 'hedged')).toBeNull();
  });

  it('returns null when the flag is off and there is no summary at all', () => {
    expect(intentForEvidenceRef(null, 'known')).toBeNull();
    expect(intentForEvidenceRef(undefined, 'known')).toBeNull();
  });
});
