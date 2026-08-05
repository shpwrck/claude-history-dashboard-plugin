/**
 * Tests for prompt-regime segmentation (#3405).
 *
 * Fixture versions are real values observed in the local corpus on both sides of
 * the boundary bracket: `2.1.217` (last version whose sessions all predate the
 * 2026-07-24 announcement), `2.1.218` (straddles it), `2.1.220` (first version
 * whose sessions all postdate it).
 */
import { describe, it, expect } from 'vitest';
import {
  BASE_PROMPT_REGIME,
  INDETERMINATE_PROMPT_REGIME,
  PROMPT_REGIME_BOUNDARIES,
  UNKNOWN_PROMPT_REGIME,
  compareCliVersions,
  parseCliVersion,
  promptRegimeForSession,
  promptRegimeForVersion,
  promptRegimeLabel,
  summarizePromptRegimes,
} from './prompt-regime';

const CLAUDE_5 = 'claude-5-short';

describe('parseCliVersion', () => {
  it('parses dotted-numeric versions into comparable segments', () => {
    expect(parseCliVersion('2.1.220')).toEqual([2, 1, 220]);
    expect(parseCliVersion('2.1')).toEqual([2, 1]);
  });

  it('ignores a pre-release suffix so unreleased builds still sort', () => {
    expect(parseCliVersion('2.1.220-beta.1')).toEqual([2, 1, 220]);
    expect(parseCliVersion('v2.1.218')).toEqual([2, 1, 218]);
  });

  it('returns null when there is no leading numeric segment', () => {
    expect(parseCliVersion(undefined)).toBeNull();
    expect(parseCliVersion('')).toBeNull();
    expect(parseCliVersion('nightly')).toBeNull();
    expect(parseCliVersion(null)).toBeNull();
  });
});

describe('compareCliVersions', () => {
  it('compares segment-wise, not lexically', () => {
    // The lexical trap: "2.1.9" > "2.1.220" as strings.
    expect(compareCliVersions('2.1.9', '2.1.220')).toBeLessThan(0);
    expect(compareCliVersions('2.1.220', '2.1.218')).toBeGreaterThan(0);
    expect(compareCliVersions('2.1.220', '2.1.220')).toBe(0);
  });

  it('treats missing segments as zero', () => {
    expect(compareCliVersions('2.1', '2.1.0')).toBe(0);
    expect(compareCliVersions('2.1', '2.1.1')).toBeLessThan(0);
  });

  it('sorts unparseable versions last', () => {
    expect(compareCliVersions('nightly', '2.1.220')).toBeGreaterThan(0);
    expect(compareCliVersions('2.1.220', 'nightly')).toBeLessThan(0);
    expect(compareCliVersions('nightly', undefined)).toBe(0);
  });
});

describe('promptRegimeForVersion', () => {
  it('derives the pre-cut regime for versions at or below the lower edge', () => {
    expect(promptRegimeForVersion('2.1.217')).toBe(BASE_PROMPT_REGIME);
    expect(promptRegimeForVersion('2.1.212')).toBe(BASE_PROMPT_REGIME);
    // A stale CLI still running long after the announcement keeps its old
    // prompt — this is exactly why the key is version, not wall-clock date.
    expect(promptRegimeForVersion('2.1.177')).toBe(BASE_PROMPT_REGIME);
  });

  it('derives the Claude 5 short-prompt regime at or above the upper edge', () => {
    expect(promptRegimeForVersion('2.1.220')).toBe(CLAUDE_5);
    expect(promptRegimeForVersion('2.1.221')).toBe(CLAUDE_5);
    expect(promptRegimeForVersion('2.2.0')).toBe(CLAUDE_5);
    expect(promptRegimeForVersion('3.0.0')).toBe(CLAUDE_5);
  });

  it('derives indeterminate strictly inside the unresolved bracket', () => {
    // 2.1.218's sessions straddle the announcement, so it cannot be placed.
    expect(promptRegimeForVersion('2.1.218')).toBe(INDETERMINATE_PROMPT_REGIME);
    expect(promptRegimeForVersion('2.1.219')).toBe(INDETERMINATE_PROMPT_REGIME);
  });

  it('derives unknown when the version is absent or unparseable', () => {
    expect(promptRegimeForVersion(undefined)).toBe(UNKNOWN_PROMPT_REGIME);
    expect(promptRegimeForVersion('')).toBe(UNKNOWN_PROMPT_REGIME);
    expect(promptRegimeForVersion('nightly')).toBe(UNKNOWN_PROMPT_REGIME);
  });
});

describe('promptRegimeForSession', () => {
  it('derives the regime from any shape carrying a version', () => {
    expect(promptRegimeForSession({ version: '2.1.212' })).toBe(BASE_PROMPT_REGIME);
    expect(promptRegimeForSession({ version: '2.1.220' })).toBe(CLAUDE_5);
    expect(promptRegimeForSession({})).toBe(UNKNOWN_PROMPT_REGIME);
    expect(promptRegimeForSession(undefined)).toBe(UNKNOWN_PROMPT_REGIME);
  });
});

describe('summarizePromptRegimes', () => {
  it('reports a single regime as poolable', () => {
    const span = summarizePromptRegimes(['2.1.212', '2.1.214', '2.1.217']);
    expect(span.regimes).toEqual([BASE_PROMPT_REGIME]);
    expect(span.spansBoundary).toBe(false);
    expect(span.confounded).toBe(false);
    expect(span.knownCount).toBe(3);
  });

  it('flags a window that crosses the cut as confounded', () => {
    const span = summarizePromptRegimes(['2.1.212', '2.1.220']);
    expect(span.regimes).toEqual([BASE_PROMPT_REGIME, CLAUDE_5]);
    expect(span.spansBoundary).toBe(true);
    expect(span.confounded).toBe(true);
  });

  it('flags an indeterminate session as confounded even without a crossing', () => {
    const span = summarizePromptRegimes(['2.1.218', '2.1.218']);
    expect(span.regimes).toEqual([]);
    expect(span.spansBoundary).toBe(false);
    expect(span.hasIndeterminate).toBe(true);
    expect(span.confounded).toBe(true);
  });

  it('counts versionless sessions without marking the window confounded', () => {
    // History-derived sessions predate transcript parsing and carry no version.
    // Treating absence as a conflict would confound every window.
    const span = summarizePromptRegimes([undefined, undefined, '2.1.212']);
    expect(span.unknownCount).toBe(2);
    expect(span.knownCount).toBe(1);
    expect(span.confounded).toBe(false);
  });

  it('is empty and unconfounded for no sessions at all', () => {
    const span = summarizePromptRegimes([]);
    expect(span.regimes).toEqual([]);
    expect(span.confounded).toBe(false);
    expect(span.knownCount).toBe(0);
  });

  it('orders resolved regimes by the boundary table, not by input order', () => {
    const span = summarizePromptRegimes(['2.1.221', '2.1.204']);
    expect(span.regimes).toEqual([BASE_PROMPT_REGIME, CLAUDE_5]);
  });
});

describe('PROMPT_REGIME_BOUNDARIES', () => {
  it('is ordered ascending and chains each regime to the one it supersedes', () => {
    let previousId = BASE_PROMPT_REGIME;
    let previousUpper: string | undefined;
    for (const boundary of PROMPT_REGIME_BOUNDARIES) {
      expect(boundary.supersedes).toBe(previousId);
      // The bracket must be a real range: lower edge strictly below upper edge.
      expect(compareCliVersions(boundary.lastKnownBefore, boundary.firstKnownAfter)).toBeLessThan(0);
      if (previousUpper !== undefined) {
        expect(compareCliVersions(previousUpper, boundary.lastKnownBefore)).toBeLessThan(0);
      }
      // Every boundary must document how it was established (#3405 acceptance).
      expect(boundary.determination.length).toBeGreaterThan(0);
      expect(boundary.reference).toMatch(/^https?:\/\//);
      expect(boundary.announcedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      previousId = boundary.id;
      previousUpper = boundary.firstKnownAfter;
    }
  });

  it('records the empirically bracketed Claude 5 boundary', () => {
    const boundary = PROMPT_REGIME_BOUNDARIES.find((b) => b.id === CLAUDE_5);
    expect(boundary).toBeDefined();
    expect(boundary?.lastKnownBefore).toBe('2.1.217');
    expect(boundary?.firstKnownAfter).toBe('2.1.220');
    expect(boundary?.announcedAt).toBe('2026-07-24');
  });
});

describe('promptRegimeLabel', () => {
  it('labels every derivable regime id', () => {
    expect(promptRegimeLabel(BASE_PROMPT_REGIME)).toMatch(/pre-Claude-5/);
    expect(promptRegimeLabel(CLAUDE_5)).toMatch(/80%/);
    expect(promptRegimeLabel(INDETERMINATE_PROMPT_REGIME)).toMatch(/unresolved/);
    expect(promptRegimeLabel(UNKNOWN_PROMPT_REGIME)).toMatch(/unknown/);
  });
});
