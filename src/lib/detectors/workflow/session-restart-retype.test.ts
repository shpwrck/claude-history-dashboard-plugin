import { describe, expect, it } from 'vitest';
import { detector } from './session-restart-retype';
import { buildRecommendations } from '../../recommendations';
import { validateRecommendationProvenance } from '../provenance';
import { effectiveFixKind, validateFixSnippet } from '../fix-validity';
import type { RecommendationInput } from '../types';
import type { LiveConfig, Session, SessionTokenData } from '../../../types';

const NOW = Date.parse('2026-07-11T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// Two near-identical, long, human openers for the SAME task (Jaccard well above
// the 0.5 floor) — the canonical retype pair.
const OPENER_A =
  'Continue implementing the OAuth login flow for the dashboard and wire up the session cookie and the redirect handler and cover it with tests';
const OPENER_B =
  'Continue implementing the OAuth login flow for the dashboard and wire up the session cookie and the redirect handler and finish the tests';

// Two long, same-project but SUBSTANTIVELY DIFFERENT openers (near-zero overlap).
const OPENER_C =
  'Refactor the billing invoice generator to support multiple currencies and rounding edge cases across regions';
const OPENER_D =
  'Write end to end Playwright coverage for the onboarding wizard including the email verification and welcome screens';

interface TokOpts {
  project?: string;
  entrypoint?: string;
  tsMs?: number;
}

function tok(sessionId: string, opener: string, opts: TokOpts = {}): SessionTokenData {
  const { project = '/repo/app', entrypoint = 'cli', tsMs = NOW } = opts;
  return {
    sessionId,
    project,
    entrypoint,
    opener,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    model: 'claude-opus-4-8',
    messageCount: 1,
    entries: [
      {
        timestamp: iso(tsMs),
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
        webSearchRequests: 0,
        webFetchRequests: 0,
        model: 'claude-opus-4-8',
      },
    ],
    compactionEvents: [],
    hasUnknownModel: false,
  } as unknown as SessionTokenData;
}

function sess(sessionId: string, project: string, startTime: number): Session {
  return { sessionId, project, startTime } as unknown as Session;
}

function input(over: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    ...over,
  };
}

// A CLAUDE.md that already carries the resume-instead-of-retype note.
const APPLIED_CLAUDE_MD =
  '## Resume prior sessions instead of re-typing\n\n' +
  'When you pick up work you already started in an earlier session, resume the ' +
  'prior session instead of re-explaining the task from scratch.';

function liveConfigWith(md: string): LiveConfig {
  return { claudeMd: { global: md, perProject: {} } } as unknown as LiveConfig;
}

describe('workflow.session-restart-retype', () => {
  it('fires on two same-project sessions with near-identical long openers', () => {
    const rec = detector.rule(
      input({
        tokenData: [
          tok('sess-alpha', OPENER_A, { tsMs: NOW - DAY }),
          tok('sess-bravo', OPENER_B, { tsMs: NOW }),
        ],
      }),
      NOW
    );
    expect(rec).not.toBeNull();
    expect(rec?.id).toBe('workflow.session-restart-retype');
    expect(rec?.category).toBe('workflow');
    expect(rec?.claimClass).toBe('accounting');
    expect(rec?.proofTier).toBe('accounting');
    expect(rec?.affected).toBe(2);
    expect(rec?.evidence?.length).toBeGreaterThan(0);
    // Evidence leads with a short session id so per-project attribution can index it.
    expect(rec?.evidence?.[0]).toMatch(/sess-al.*&.*sess-br/);
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
    // Not stale on fresh timestamps.
    expect(rec?.detail).not.toMatch(/^As of /);
    expect(rec?.provenance?.stale).toBeUndefined();
  });

  it('is registered and surfaces through buildRecommendations', () => {
    const recs = buildRecommendations(
      input({
        tokenData: [
          tok('sess-alpha', OPENER_A, { tsMs: NOW - DAY }),
          tok('sess-bravo', OPENER_B, { tsMs: NOW }),
        ],
      }),
      NOW
    );
    expect(recs.some((r) => r.id === 'workflow.session-restart-retype')).toBe(true);
  });

  it('resolves session timestamps from the history Session start time', () => {
    // No entry timestamps on tokenData; the Session.startTime path must drive the window.
    const bare = (sessionId: string, opener: string): SessionTokenData =>
      ({
        ...tok(sessionId, opener),
        entries: [],
      }) as unknown as SessionTokenData;
    const rec = detector.rule(
      input({
        tokenData: [bare('sess-alpha', OPENER_A), bare('sess-bravo', OPENER_B)],
        sessions: [
          sess('sess-alpha', '/repo/app', NOW - DAY),
          sess('sess-bravo', '/repo/app', NOW),
        ],
      }),
      NOW
    );
    expect(rec).not.toBeNull();
  });

  it('is silent for short openers ("hi"/"continue")', () => {
    const rec = detector.rule(
      input({
        tokenData: [
          tok('sess-alpha', 'hi'),
          tok('sess-bravo', 'continue please'),
        ],
      }),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('is silent for near-duplicate openers in DIFFERENT projects', () => {
    const rec = detector.rule(
      input({
        tokenData: [
          tok('sess-alpha', OPENER_A, { project: '/repo/app' }),
          tok('sess-bravo', OPENER_B, { project: '/repo/other' }),
        ],
      }),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('is silent for unattended (sdk-*) entrypoint sessions', () => {
    const rec = detector.rule(
      input({
        tokenData: [
          tok('sess-alpha', OPENER_A, { entrypoint: 'sdk-cli' }),
          tok('sess-bravo', OPENER_B, { entrypoint: 'sdk-cli' }),
        ],
      }),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('is silent when the same session id appears twice (history parts collapse)', () => {
    const rec = detector.rule(
      input({
        // Two token rows for the SAME sessionId (e.g. multiple history.d parts) —
        // must collapse to one distinct session and never pair with itself.
        tokenData: [
          tok('sess-alpha', OPENER_A, { tsMs: NOW - DAY }),
          tok('sess-alpha', OPENER_B, { tsMs: NOW }),
        ],
      }),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('is suppressed when CLAUDE.md already carries the resume note', () => {
    const rec = detector.rule(
      input({
        tokenData: [
          tok('sess-alpha', OPENER_A, { tsMs: NOW - DAY }),
          tok('sess-bravo', OPENER_B, { tsMs: NOW }),
        ],
        liveConfig: liveConfigWith(APPLIED_CLAUDE_MD),
      }),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('demotes to "as of <date>" when the newest cluster is stale', () => {
    const oldTs = NOW - 60 * DAY;
    const rec = detector.rule(
      input({
        tokenData: [
          tok('sess-alpha', OPENER_A, { tsMs: oldTs - DAY }),
          tok('sess-bravo', OPENER_B, { tsMs: oldTs }),
        ],
      }),
      NOW
    );
    expect(rec).not.toBeNull();
    expect(rec?.detail).toMatch(/^As of \d{4}-\d{2}-\d{2},/);
    expect(rec?.provenance?.stale).toBe(true);
    expect(rec?.provenance?.asOf).toBeDefined();
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('declares a non-validated (illustrative) CLAUDE.md fix', () => {
    const rec = detector.rule(
      input({
        tokenData: [
          tok('sess-alpha', OPENER_A, { tsMs: NOW - DAY }),
          tok('sess-bravo', OPENER_B, { tsMs: NOW }),
        ],
      }),
      NOW
    );
    expect(rec?.fix).toBeDefined();
    expect(rec?.fix?.target).toBe('CLAUDE.md');
    expect(effectiveFixKind(rec!.fix!)).toBe('illustrative');
    // Non-validated fixes are never policed for portability, and this one carries
    // no non-portable reference either.
    expect(validateFixSnippet(rec!.fix!)).toEqual([]);
    // The pasted snippet must contain the exact self-suppression body phrase.
    expect(rec!.fix!.snippet.toLowerCase()).toContain(
      'resume the prior session instead of re-explaining the task'
    );
  });

  it('does not flag deliberate slash-command reuse below the floor', () => {
    // Two sessions that open with the SAME slash-command invocation — a reusable
    // template by design, not a re-explained task. Even though identical, they are
    // excluded (slash-command-led openers sit below the gate).
    const cmd = '/burn-epic the release and keep going until every eligible sub-issue is done';
    const rec = detector.rule(
      input({
        tokenData: [
          tok('sess-alpha', cmd, { tsMs: NOW - DAY }),
          tok('sess-bravo', cmd, { tsMs: NOW }),
        ],
      }),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('does not flag long same-project openers about different tasks', () => {
    const rec = detector.rule(
      input({
        tokenData: [
          tok('sess-alpha', OPENER_C, { tsMs: NOW - DAY }),
          tok('sess-bravo', OPENER_D, { tsMs: NOW }),
        ],
      }),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('does not pair near-duplicate openers outside the 7-day window', () => {
    const rec = detector.rule(
      input({
        tokenData: [
          tok('sess-alpha', OPENER_A, { tsMs: NOW - 30 * DAY }),
          tok('sess-bravo', OPENER_B, { tsMs: NOW }),
        ],
      }),
      NOW
    );
    expect(rec).toBeNull();
  });
});
