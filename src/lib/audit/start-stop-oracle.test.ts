/**
 * Tests for the start/stop-oracle audit (#605 / #743).
 *
 * The judge is injected, so these cover the deterministic opener-feature
 * extraction + risky-feature ranking -> judge-confirm -> single-finding path
 * without the network, plus the judge-failure / judge-reject isolation the
 * no-500 route contract relies on.
 */
import { describe, it, expect } from 'vitest';
import {
  openerFeatures,
  rankRiskyFeatures,
  baselineBadRate,
  runStartStopOracleAudit,
  evidenceCutoff,
  deriveObservedAt,
  DEFAULT_RANK_OPTIONS,
  type StartStopRow,
} from './start-stop-oracle';
import type { JudgeFn } from './judge';

const accept: JudgeFn = async () => ({
  isFinding: true,
  rationale: 'These vague broad-scope openers reliably precede churn.',
  confidence: 'high',
});

const reject: JudgeFn = async () => ({
  isFinding: false,
  rationale: 'The margin over baseline is too thin to trust.',
  confidence: 'low',
});

const boom: JudgeFn = async () => {
  throw new Error('judge network failure');
};

const DAY_MS = 86_400_000;
/** First observation in the fixture: 2026-01-10 (UTC). */
const FIRST_OBSERVED = Date.UTC(2026, 0, 10);
/** Latest observation in the fixture -> the evidence cutoff the audit reports. */
const CUTOFF = '2026-01-19';

/**
 * Build a dataset where the "broad scope" opener trait is strongly predictive of
 * bad outcomes: every broad opener fails, every bounded opener succeeds. Rows are
 * DATED (`observedAt`, epoch ms) — the audit needs a cutoff to say when the
 * correlation was current (#3115). Pass `false` for the undated variant.
 */
function riskyDataset(dated = true): StartStopRow[] {
  const rows: StartStopRow[] = [];
  const at = (offsetDays: number) =>
    dated ? { observedAt: FIRST_OBSERVED + offsetDays * DAY_MS } : {};
  for (let i = 0; i < 5; i++) {
    rows.push({
      sessionId: `broad-${i}`,
      project: 'demo',
      opener: 'Refactor everything in the whole codebase',
      good: false,
      ...at(i),
    });
  }
  for (let i = 0; i < 5; i++) {
    rows.push({
      sessionId: `bounded-${i}`,
      project: 'demo',
      opener: 'Fix the null check in src/auth/login.ts line 42',
      good: true,
      ...at(5 + i),
    });
  }
  return rows;
}

describe('openerFeatures', () => {
  it('buckets opener length', () => {
    expect(openerFeatures('short one').lengthBucket).toBe('short');
    expect(openerFeatures('x'.repeat(120)).lengthBucket).toBe('medium');
    expect(openerFeatures('x'.repeat(250)).lengthBucket).toBe('long');
  });

  it('detects a question vs. a directive', () => {
    expect(openerFeatures('Why is this failing?').isQuestion).toBe(true);
    expect(openerFeatures('Fix this bug').isQuestion).toBe(false);
  });

  it('detects broad scope markers', () => {
    expect(openerFeatures('Refactor everything').broadScope).toBe(true);
    expect(openerFeatures('Rewrite the whole module').broadScope).toBe(true);
    expect(openerFeatures('Update one function').broadScope).toBe(false);
  });

  it('flags vague openers but not ones with a concrete anchor', () => {
    expect(openerFeatures('Just clean up and make it better somehow').isVague).toBe(true);
    // Same vague wording but anchored to a concrete file path -> not vague.
    expect(openerFeatures('Clean up src/util/helpers.ts').isVague).toBe(false);
  });
});

describe('baselineBadRate', () => {
  it('computes the overall bad-outcome rate', () => {
    expect(baselineBadRate(riskyDataset())).toBeCloseTo(0.5);
    expect(baselineBadRate([])).toBe(0);
  });
});

describe('rankRiskyFeatures', () => {
  it('flags a feature value whose bad-rate clears support + margin + floor', () => {
    const risky = rankRiskyFeatures(riskyDataset());
    expect(risky.length).toBeGreaterThan(0);
    const broad = risky.find((r) => r.feature === 'broadScope' && r.value === 'true');
    expect(broad).toBeDefined();
    expect(broad!.badRate).toBe(1);
    expect(broad!.support).toBe(5);
    expect(broad!.exampleSessions.length).toBeGreaterThan(0);
  });

  it('stays silent when there are fewer than minSessions', () => {
    const few = riskyDataset().slice(0, 4);
    expect(rankRiskyFeatures(few)).toEqual([]);
  });

  it('stays silent when no value clears the margin over baseline', () => {
    // Every session bad -> baseline 100%, so no value can be a margin ABOVE it.
    const allBad = riskyDataset().map((r) => ({ ...r, good: false }));
    expect(rankRiskyFeatures(allBad)).toEqual([]);
  });

  it('drops thin groups below minSupport', () => {
    const rows = riskyDataset();
    // One extra unique-trait bad session is below minSupport=3 -> excluded.
    rows.push({ sessionId: 'q1', project: 'demo', opener: 'Why broken?', good: false });
    const risky = rankRiskyFeatures(rows);
    expect(risky.some((r) => r.feature === 'isQuestion' && r.value === 'true')).toBe(false);
  });
});

describe('deriveObservedAt (#3392 P2)', () => {
  // `Session.endTime` is folded from PROMPT-HISTORY entries, so it marks the last
  // human prompt. A session that keeps working after that prompt — an overnight
  // tool run — has transcript events, tokens, and tool calls after it, and the
  // outcome the audit reasons over comes from those. The evidence must not
  // outrun the cutoff that names it.
  const LAST_PROMPT = Date.parse('2026-07-01T23:40:00.000Z');
  const LAST_EVENT = Date.parse('2026-07-02T05:15:00.000Z');

  it('takes the transcript end when the session ran past its last prompt', () => {
    const observed = deriveObservedAt(
      [{ sessionId: 'overnight', endTime: LAST_PROMPT }],
      [
        {
          sessionId: 'overnight',
          startTime: '2026-07-01T22:00:00.000Z',
          endTime: '2026-07-02T05:15:00.000Z',
        },
      ]
    );
    expect(observed.get('overnight')).toBe(LAST_EVENT);
    // Not the prompt mark — that would date the cutoff a day early.
    expect(observed.get('overnight')).toBeGreaterThan(LAST_PROMPT);
  });

  it('dates the emitted cutoff by the later event, not the last prompt', async () => {
    // The signal is carried by a session that ran past midnight UTC: the finding
    // must say 2026-07-02, the day the evidence actually ends.
    const observed = deriveObservedAt(
      [{ sessionId: 'broad-4', endTime: LAST_PROMPT }],
      [
        {
          sessionId: 'broad-4',
          startTime: '2026-07-01T22:00:00.000Z',
          endTime: '2026-07-02T05:15:00.000Z',
        },
      ]
    );
    const rows: StartStopRow[] = riskyDataset().map((r) =>
      r.sessionId === 'broad-4'
        ? { ...r, observedAt: observed.get('broad-4') }
        : { ...r, observedAt: LAST_PROMPT - DAY_MS }
    );
    const findings = await runStartStopOracleAudit(rows, accept);
    expect(findings).toHaveLength(1);
    expect(findings[0].evidenceRefs).toContain('as-of:2026-07-02');
    expect(findings[0].summary.startsWith('As of 2026-07-02:')).toBe(true);
  });

  it('keeps a session datable when only one source has a timestamp', () => {
    // Prompt history but no timeline row...
    expect(
      deriveObservedAt([{ sessionId: 'a', endTime: LAST_PROMPT }], []).get('a')
    ).toBe(LAST_PROMPT);
    // ...and a timeline row for a session with no prompt-history entry.
    expect(
      deriveObservedAt(
        [],
        [{ sessionId: 'b', endTime: '2026-07-02T05:15:00.000Z' }]
      ).get('b')
    ).toBe(LAST_EVENT);
    // startTime is used only when endTime is unusable.
    expect(
      deriveObservedAt(
        [],
        [{ sessionId: 'c', startTime: '2026-07-02T05:15:00.000Z' }]
      ).get('c')
    ).toBe(LAST_EVENT);
  });

  it('ignores unusable timestamps rather than dating a session wrongly', () => {
    const observed = deriveObservedAt(
      [
        { sessionId: 'zero', endTime: 0 },
        { sessionId: 'missing' },
        { sessionId: 'nan', endTime: Number.NaN },
      ],
      [{ sessionId: 'bad-iso', startTime: 'not-a-date', endTime: 'nope' }]
    );
    expect(observed.size).toBe(0);
  });
});

describe('runStartStopOracleAudit', () => {
  it('emits one workflow finding when the judge confirms', async () => {
    const findings = await runStartStopOracleAudit(riskyDataset(), accept);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe('start-stop-oracle:risky-openers');
    expect(findings[0].domain).toBe('workflow');
    expect(findings[0].confidence).toBe('high');
    expect(findings[0].judgeRationale).toContain('churn');
    expect(findings[0].evidenceRefs.some((r) => r.startsWith('opener-trait:'))).toBe(true);
    expect(findings[0].evidenceRefs.some((r) => r.startsWith('session:'))).toBe(true);
  });

  it('dates the claim "As of <cutoff>" instead of asserting current state (#3115)', async () => {
    let prompt = '';
    const capturing: JudgeFn = async ({ user }) => {
      prompt = user;
      return { isFinding: true, rationale: '', confidence: 'medium' };
    };
    const findings = await runStartStopOracleAudit(riskyDataset(), capturing);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    // The cutoff is the LATEST observation in the sample, as an exact date.
    expect(f.evidenceRefs).toContain(`as-of:${CUTOFF}`);
    expect(f.summary.startsWith(`As of ${CUTOFF}:`)).toBe(true);
    // Past tense about the evidence, and the actionable read is explicitly
    // conditioned on re-checking newer work rather than asserted as current.
    expect(f.summary).toContain('ended badly more often');
    expect(f.summary).not.toMatch(/historically end badly/);
    expect(f.summary).toMatch(
      /historical correlation, not a reading of current behaviour/
    );
    expect(f.summary).toContain(`re-check it against work since ${CUTOFF}`);
    // The judge is told the window too, so its prose cannot present the
    // correlation as current.
    expect(prompt).toContain(`sessions observed up to ${CUTOFF}`);
    // With no judge rationale, the deterministic fallback is dated as well.
    expect(f.judgeRationale.startsWith(`As of ${CUTOFF},`)).toBe(true);
  });

  it('computes the signal and the sample count from the DATED rows only (#3392 P1)', async () => {
    // 10 dated rows + 4 undated ones. The undated rows are broad-scope failures
    // whose dates are unknown — they may well be NEWER than the cutoff. They must
    // not be ranked, must not move the baseline, must not appear as evidence, and
    // must not be counted in a sentence that says "observed up to <cutoff>".
    const rows: StartStopRow[] = [
      ...riskyDataset(),
      ...Array.from({ length: 4 }, (_, i) => ({
        sessionId: `undated-${i}`,
        project: 'demo',
        opener: 'Refactor everything in the whole codebase',
        good: false,
      })),
    ];
    // Still >= MIN_DATED_FRACTION dated, so the dataset itself is usable.
    expect(evidenceCutoff(rows)).toBe(CUTOFF);

    let prompt = '';
    const capturing: JudgeFn = async ({ user }) => {
      prompt = user;
      return { isFinding: true, rationale: 'ok', confidence: 'medium' };
    };
    const findings = await runStartStopOracleAudit(rows, capturing);
    expect(findings).toHaveLength(1);
    const f = findings[0];

    // The reported sample is the DATED subset (10), not all 14 rows.
    expect(f.summary).toContain('across 10 dated session(s)');
    expect(f.summary).not.toContain('14');
    expect(prompt).toContain('across 10 dated session(s)');

    // The baseline is the dated subset's 50%, not the ~64% the undated failures
    // would have produced.
    expect(f.evidenceRefs).toContain('baseline:bad-rate=50%');

    // Support counts and example sessions come only from dated rows: the broad
    // trait is backed by the 5 dated broad rows, not 9.
    const broad = f.evidenceRefs.find((r) =>
      r.startsWith('opener-trait:broadScope=true')
    );
    expect(broad).toContain('n=5');
    expect(f.evidenceRefs.some((r) => r.includes('undated-'))).toBe(false);
  });

  it('suppresses the finding when the dataset carries no trustworthy cutoff (#3115)', async () => {
    let called = false;
    const spy: JudgeFn = async () => {
      called = true;
      return { isFinding: true, rationale: 'x', confidence: 'high' };
    };
    // Same rows, same risky signal — but undated. Rather than emit advice whose
    // evidence window is unknowable, the audit stays silent (and never pays for
    // a judge call).
    expect(await runStartStopOracleAudit(riskyDataset(false), spy)).toEqual([]);
    expect(called).toBe(false);

    // A mostly-undated dataset is no better: one dated row cannot date the rest.
    const mostlyUndated = riskyDataset(false);
    mostlyUndated[0] = { ...mostlyUndated[0], observedAt: FIRST_OBSERVED };
    expect(await runStartStopOracleAudit(mostlyUndated, spy)).toEqual([]);
    expect(called).toBe(false);
  });

  it('exposes the cutoff deterministically', () => {
    expect(evidenceCutoff(riskyDataset())).toBe(CUTOFF);
    expect(evidenceCutoff(riskyDataset(false))).toBeNull();
    // A zero / non-finite timestamp is not a date.
    expect(
      evidenceCutoff(
        riskyDataset().map((r) => ({ ...r, observedAt: 0 }))
      )
    ).toBeNull();
  });

  it('returns [] when the judge rejects the signal as noise', async () => {
    expect(await runStartStopOracleAudit(riskyDataset(), reject)).toEqual([]);
  });

  it('still emits the deterministic finding (low confidence) on judge failure', async () => {
    const findings = await runStartStopOracleAudit(riskyDataset(), boom);
    expect(findings).toHaveLength(1);
    expect(findings[0].confidence).toBe('low');
    // Dated even on the fallback path — a judge outage must not turn the claim
    // back into an undated present-tense one (#3115).
    expect(findings[0].judgeRationale).toContain(
      `As of ${CUTOFF}, judge interpretation was unavailable`
    );
  });

  it('returns [] on insufficient data without calling the judge', async () => {
    let called = false;
    const spy: JudgeFn = async () => {
      called = true;
      return { isFinding: true, rationale: '', confidence: 'high' };
    };
    const out = await runStartStopOracleAudit(riskyDataset().slice(0, 4), spy);
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it('respects DEFAULT_RANK_OPTIONS shape', () => {
    expect(DEFAULT_RANK_OPTIONS.minSupport).toBeGreaterThan(0);
  });
});
