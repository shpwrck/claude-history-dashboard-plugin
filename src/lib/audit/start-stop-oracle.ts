/**
 * Tier-3 audit: start/stop oracle (#605 / #743).
 *
 * From a session's OPENER (the first user message, captured by
 * `parse-sessions.parseSessionJsonl` as `tokenData.opener`) predict "don't start
 * this" / "stop early": learn which coarse opener TRAITS correlate with bad
 * outcomes, so a reader can look at a fresh opener and know it carries a
 * historically risky signature.
 *
 * Deterministic core (pure, unit-tested without the judge):
 *   - {@link openerFeatures} derives a small, FIXED, EXPLAINABLE feature set from
 *     one opener string. Every feature is a coarse boolean/bucket a human can read
 *     off the prompt (length bucket, vague vs. concrete, question vs. directive,
 *     broad-scope markers). We deliberately keep the set tiny so each feature
 *     value has enough sessions behind it to mean something.
 *   - {@link rankRiskyFeatures} groups sessions by feature value, computes the
 *     bad-outcome RATE per value, and keeps only values that (a) clear a minimum
 *     support count (so a thin group can't drive a claim) AND (b) sit a real
 *     margin above the population's baseline bad-rate. Ranked worst-first.
 *
 * Judge step ({@link runStartStopOracleAudit}): route the candidate
 * feature -> outcome evidence (rate, support, baseline, example sessions) through
 * the judge to confirm it is a genuine "don't-start / stop-early" signal vs.
 * noise, then emit ONE summary finding (domain 'workflow') describing the
 * predictive opener traits and the historical evidence behind the call. The judge
 * call is isolated in try/catch. Insufficient data (too few sessions, or no
 * feature value clears support + margin) -> return [] — no spurious claim.
 *
 * SERVER-ONLY (runs behind /api/audit.json with the rest of the harness).
 */
import type { AuditFinding, AuditConfidence } from './types';
import type { JudgeFn } from './judge';

/**
 * One per-session observation: the opener text joined to its good/bad outcome
 * (`good` from `parse-timeline-success.computeSessionOutcomes`).
 */
export interface StartStopRow {
  sessionId: string;
  project: string;
  /** The session opener (first user message, already truncated to ~200 chars). */
  opener: string;
  /** True = good outcome; false = bad. Drives the bad-outcome rate per feature. */
  good: boolean;
}

/**
 * The FIXED opener feature set. Each key is one coarse, human-readable trait of
 * the opener; the value is the level it took on for a given session. Keep this
 * small — every level needs support behind it to be worth a claim.
 */
export interface OpenerFeatures {
  /** Coarse opener length: 'short' (<60), 'medium' (60..199), 'long' (>=200). */
  lengthBucket: 'short' | 'medium' | 'long';
  /** Opener is phrased as a question (ends with '?') rather than a directive. */
  isQuestion: boolean;
  /**
   * Opener names a BROAD scope: "everything" / "all" / "entire" / "whole" /
   * "refactor" / "rewrite" / "redo" — the openers that historically sprawl.
   */
  broadScope: boolean;
  /**
   * Opener is VAGUE: open-ended wording ("somehow", "figure out", "look into",
   * "clean up", "improve", "fix the issues", "make it better") with no concrete
   * anchor (no file path, code token, error string, or quoted snippet).
   */
  isVague: boolean;
}

/** The feature keys, in a stable order, for iterating the fixed set. */
export type FeatureKey = keyof OpenerFeatures;
export const FEATURE_KEYS: readonly FeatureKey[] = [
  'lengthBucket',
  'isQuestion',
  'broadScope',
  'isVague',
];

/** Human-readable description of each feature value, for the finding evidence. */
const FEATURE_LABELS: Record<FeatureKey, (v: string) => string> = {
  lengthBucket: (v) => `opener length = ${v}`,
  isQuestion: (v) => (v === 'true' ? 'opener is a question' : 'opener is a directive'),
  broadScope: (v) =>
    v === 'true' ? 'opener names a broad scope' : 'opener has a bounded scope',
  isVague: (v) => (v === 'true' ? 'opener is vague / open-ended' : 'opener is concrete'),
};

const BROAD_SCOPE_RE =
  /\b(everything|all|entire|whole|refactor|rewrite|redo|overhaul)\b/i;
const VAGUE_RE =
  /\b(somehow|figure out|look into|clean up|cleanup|improve|make it better|better|fix the issues|fix issues|sort out|deal with)\b/i;
/** A concrete anchor: a file path, dotted token, code-ish identifier, or quote. */
const CONCRETE_RE = /([./][\w./-]+|\w+\(\)|`[^`]+`|"[^"]+"|#\d+|\b\w+\.\w+\b)/;

/**
 * Derive the fixed opener feature set from one opener string. PURE and
 * deterministic — unit-tested without the judge. Every feature is a coarse trait
 * a human can verify by eye, so the resulting finding stays explainable.
 */
export function openerFeatures(opener: string): OpenerFeatures {
  const text = opener.trim();
  const len = text.length;
  const lengthBucket: OpenerFeatures['lengthBucket'] =
    len < 60 ? 'short' : len < 200 ? 'medium' : 'long';
  const isQuestion = /\?\s*$/.test(text);
  const broadScope = BROAD_SCOPE_RE.test(text);
  // Vague = open-ended wording AND no concrete anchor to ground it.
  const isVague = VAGUE_RE.test(text) && !CONCRETE_RE.test(text);
  return { lengthBucket, isQuestion, broadScope, isVague };
}

/** One feature value whose bad-outcome rate is notably elevated. */
export interface RiskyFeature {
  feature: FeatureKey;
  /** The level (stringified) of the feature, e.g. 'long' or 'true'. */
  value: string;
  /** Human-readable label for the level (from FEATURE_LABELS). */
  label: string;
  /** Sessions whose opener took this feature value (the support). */
  support: number;
  /** Bad outcomes among those sessions. */
  bad: number;
  /** bad / support — the bad-outcome rate for this feature value. */
  badRate: number;
  /** Example session ids carrying this risky value (capped, for evidence). */
  exampleSessions: string[];
}

export interface RankOptions {
  /**
   * The whole dataset must clear this many sessions (with openers) before we
   * make any claim — a handful of sessions can't establish a base rate.
   */
  minSessions: number;
  /**
   * A feature VALUE must have at least this many sessions behind it to be
   * eligible — a value seen twice can't drive a "don't-start" claim.
   */
  minSupport: number;
  /**
   * The value's bad-rate must exceed the population baseline by at least this
   * absolute margin (e.g. 0.2 = 20 points worse) to count as elevated. Keeps
   * noise that merely tracks the baseline out of the finding.
   */
  minMarginOverBaseline: number;
  /**
   * A floor on the absolute bad-rate too: even a big margin over a tiny baseline
   * isn't worth flagging if the value's own bad-rate is low.
   */
  minBadRate: number;
  /** Cap on how many risky features to surface (worst-first). */
  topN: number;
  /** Cap on example session ids carried per risky feature. */
  exampleCap: number;
}

export const DEFAULT_RANK_OPTIONS: RankOptions = {
  minSessions: 8,
  minSupport: 3,
  minMarginOverBaseline: 0.2,
  minBadRate: 0.5,
  topN: 5,
  exampleCap: 5,
};

/** The dataset's overall bad-outcome rate (the baseline to beat). */
export function baselineBadRate(rows: StartStopRow[]): number {
  if (rows.length === 0) return 0;
  const bad = rows.reduce((n, r) => n + (r.good ? 0 : 1), 0);
  return bad / rows.length;
}

/**
 * Group sessions by every feature value, compute the bad-outcome rate per value,
 * and keep only values that clear support, sit a real margin above the
 * population baseline, and clear an absolute bad-rate floor. PURE and
 * deterministic — unit-tested without the judge.
 *
 * Returns [] when there are fewer than `minSessions` sessions (no base rate to
 * trust) or when no feature value clears the bars (no honest signal). Ranked
 * worst-first (highest bad-rate, then highest support, then stable by label).
 */
export function rankRiskyFeatures(
  rows: StartStopRow[],
  options: RankOptions = DEFAULT_RANK_OPTIONS
): RiskyFeature[] {
  const { minSessions, minSupport, minMarginOverBaseline, minBadRate, topN, exampleCap } =
    options;
  if (rows.length < minSessions) return [];

  const baseline = baselineBadRate(rows);

  // Tally support / bad / examples per (feature, value).
  interface Cell {
    feature: FeatureKey;
    value: string;
    support: number;
    bad: number;
    examples: string[];
  }
  const cells = new Map<string, Cell>();
  for (const row of rows) {
    const feats = openerFeatures(row.opener);
    for (const key of FEATURE_KEYS) {
      const value = String(feats[key]);
      const cellKey = `${key}=${value}`;
      let cell = cells.get(cellKey);
      if (!cell) {
        cell = { feature: key, value, support: 0, bad: 0, examples: [] };
        cells.set(cellKey, cell);
      }
      cell.support += 1;
      if (!row.good) {
        cell.bad += 1;
        if (cell.examples.length < exampleCap) cell.examples.push(row.sessionId);
      }
    }
  }

  const risky: RiskyFeature[] = [];
  for (const cell of cells.values()) {
    if (cell.support < minSupport) continue;
    const badRate = cell.bad / cell.support;
    if (badRate < minBadRate) continue;
    if (badRate - baseline < minMarginOverBaseline) continue;
    risky.push({
      feature: cell.feature,
      value: cell.value,
      label: FEATURE_LABELS[cell.feature](cell.value),
      support: cell.support,
      bad: cell.bad,
      badRate,
      exampleSessions: cell.examples,
    });
  }

  return risky
    .sort(
      (a, b) =>
        b.badRate - a.badRate ||
        b.support - a.support ||
        a.label.localeCompare(b.label)
    )
    .slice(0, topN);
}

/** Format a 0..1 rate as a percent string, e.g. 0.6667 -> "67%". */
function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** Render one risky feature as a compact, judge-readable line. */
function riskyLine(r: RiskyFeature, baseline: number): string {
  return (
    `${r.label}: ${pct(r.badRate)} bad outcome over ${r.support} session(s) ` +
    `(${r.bad} bad), vs. ${pct(baseline)} baseline`
  );
}

/**
 * Run the start/stop-oracle audit. Rank the risky opener features, then route
 * the candidate evidence through the judge to confirm it is a real predictive
 * signal (vs. noise that merely tracks the baseline), and emit ONE summary
 * finding describing which opener traits predict trouble plus the historical
 * evidence.
 *
 * The single judge call is isolated in try/catch: on judge failure we STILL emit
 * the deterministic ranking (low confidence) rather than dropping the finding —
 * the deterministic evidence stands on its own. Returns [] when there is no
 * candidate at all (insufficient data / nothing clears the bars), so a calm or
 * sparse history makes no claim. NEVER throws.
 */
export async function runStartStopOracleAudit(
  rows: StartStopRow[],
  judge: JudgeFn,
  options: RankOptions = DEFAULT_RANK_OPTIONS
): Promise<AuditFinding[]> {
  const risky = rankRiskyFeatures(rows, options);
  // No candidate -> no honest "don't-start" signal to report.
  if (risky.length === 0) return [];

  const baseline = baselineBadRate(rows);
  const lines = risky.map((r) => riskyLine(r, baseline)).join('\n');
  const traits = risky.map((r) => r.label).join('; ');

  // The judge confirms the signal is real and not baseline noise; isolate it so
  // a transient failure still yields the deterministic ranking (low confidence).
  let rationale = '';
  let confidence: AuditConfidence = 'low';
  let confirmed = true;
  try {
    const verdict = await judge({
      system:
        'You audit a coding agent\'s session history to build a START/STOP ORACLE. ' +
        'You are given OPENER TRAITS (coarse features of the first user message of a ' +
        'session) whose historical BAD-OUTCOME RATE is elevated versus the overall ' +
        'baseline bad-rate. Decide whether these traits are a GENUINE predictive ' +
        'signal — opener signatures that reliably precede churn or abandonment, so a ' +
        'user seeing such an opener should hesitate to start or plan to stop early — ' +
        'versus NOISE that merely tracks the baseline or rests on too few sessions. ' +
        'Be honest and cautious: a small margin over baseline, or a value seen only a ' +
        'few times, is weak. Reply ONLY with JSON: ' +
        '{"isFinding": boolean, "rationale": string, "confidence": "low"|"medium"|"high"}. ' +
        'isFinding = true means a genuine don\'t-start / stop-early signal.',
      user:
        `Baseline bad-outcome rate across ${rows.length} session(s) with an opener: ` +
        `${pct(baseline)}.\nElevated opener traits (worst first):\n${lines}\n\n` +
        'Are these opener traits a genuine don\'t-start / stop-early signal, or ' +
        'baseline noise?',
    });
    confirmed = verdict.isFinding;
    if (verdict.rationale) rationale = verdict.rationale;
    confidence = verdict.confidence;
  } catch {
    // Judge unavailable: emit the deterministic ranking as-is. `confidence`
    // stays at its cautious 'low' default and `confirmed` stays true so the
    // deterministic ranking still surfaces.
    rationale =
      'Judge interpretation was unavailable; reporting the deterministic ranking ' +
      'of opener traits whose historical bad-outcome rate exceeds the baseline.';
  }

  // If the judge actively rejected the signal as noise, do not assert a finding.
  if (!confirmed) return [];

  const evidenceRefs = [
    `baseline:bad-rate=${pct(baseline)}`,
    ...risky.map((r) => `opener-trait:${r.feature}=${r.value} bad-rate=${pct(r.badRate)} n=${r.support}`),
    ...risky.flatMap((r) => r.exampleSessions.map((id) => `session:${id}`)),
  ];

  return [
    {
      id: 'start-stop-oracle:risky-openers',
      domain: 'workflow',
      summary:
        `Start/stop oracle: openers with these traits historically end badly more ` +
        `often than the ${pct(baseline)} baseline -> ${traits}. Treat a new opener ` +
        `matching them as a don't-start / stop-early signal.`,
      evidenceRefs,
      judgeRationale:
        rationale ||
        `Opener traits (${traits}) carry an elevated bad-outcome rate vs. the ` +
          `${pct(baseline)} baseline across ${rows.length} sessions.`,
      confidence,
    },
  ];
}
