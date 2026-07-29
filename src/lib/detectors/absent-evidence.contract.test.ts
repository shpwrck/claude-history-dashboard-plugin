/**
 * Absent evidence must not become a claim — catalog contract (#3423, epic #3422).
 *
 * The recurring defect: an empty query result read as a fact about the world
 * rather than a fact about the data. It was fixed six separate times in the v0.6
 * data-integrity review (#3118, #3119's follow-up round, #3125, two rounds of
 * #3221, #3388), each correct, each local, none preventing the next. This is the
 * mechanism that replaces fixing instances.
 *
 * ## What this found when it was written: nothing
 *
 * Stated plainly because the epic's premise was that a sweep would surface more:
 * all 105 registered detectors already return `null` when their declared
 * `dataDeps` are empty, and none throw. So this is a REGRESSION GUARD, not an
 * inventory — the same standing as the static `data-deps.contract.test.ts`
 * (#2080), which also passes on the day it lands and earns its keep afterwards.
 *
 * A contract that passes trivially is worth nothing without proof it can fail,
 * so the negative control below is load-bearing rather than decorative.
 *
 * ## Why it also covers surfaces outside the catalog
 *
 * The two instances fixed most recently were NOT detectors:
 *
 *  - `digestVerdict` (#3123) returned "your recent agent activity looks
 *    healthy" for an empty finding list, whether the engine had examined
 *    everything or nothing. It is not in `DETECTORS`, so a catalog-only
 *    traversal never reaches it.
 *  - `topPerDomain` (#3123) defaulted a domain with no coverage entry to
 *    `healthy`, rendering an uninstrumented surface as a clean card.
 *
 * A contract scoped strictly to `DETECTORS` would therefore have caught neither
 * of the two most recent instances of the class it exists for. They are pinned
 * here alongside the catalog sweep so the guard matches where the bugs actually
 * occurred, not where the abstraction is tidiest.
 *
 * ## The boundary this deliberately does NOT enforce
 *
 * "No data means no finding" would be wrong as a blanket rule, and the
 * distinction is most of the judgement:
 *
 *  - CONFIGURATION absence is observable. The whole of `~/.claude` is
 *    enumerated, so "you have no CLAUDE.md" or "no hooks are configured" is a
 *    claim about an artifact we fully read. Absence IS the evidence.
 *  - BEHAVIOURAL absence is a sample. Sessions are retained, windowed and
 *    partially ingested, so "you never used this skill" is a claim about what we
 *    happened to observe.
 *
 * No detector currently needs the first exemption, so no opt-out field is added
 * to `Detector` — an unused escape hatch is a liability, and the shape it should
 * take is better decided by the first real case. The failure message tells that
 * author what to do instead of leaving them to guess.
 */
import { describe, it, expect } from 'vitest';
import { DETECTORS } from './index';
import { assembleRecommendationInput } from '../recommendations';
import type { Detector, RecommendationInput } from './types';
import {
  digestVerdict,
  topPerDomain,
  ACTION_DOMAINS,
  type DomainCoverage,
} from '../digest';

/**
 * Every declared `dataDep` present but EMPTY.
 *
 * `assembleRecommendationInput` normalises each declared dependency the caller
 * omitted to an explicit `null` (#2080), so this is precisely the "we looked and
 * there was nothing" input rather than a half-built object.
 */
function emptyInput(): RecommendationInput {
  return assembleRecommendationInput({
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
  });
}

const NOW = Date.UTC(2026, 6, 29);

describe('no detector claims anything from empty evidence (#3423)', () => {
  it.each(DETECTORS.map((d) => [d.id, d] as const))(
    '%s stays silent on empty declared deps',
    (id, detector) => {
      const rec = detector.rule(emptyInput(), NOW);
      expect(
        rec,
        `${id} emitted a finding from an input where every field it declares in ` +
          `dataDeps is empty. Zero observation is a fact about the data, not about ` +
          `the user's setup (#3118/#3422). If this detector's claim genuinely rests ` +
          `on the ABSENCE of a fully-enumerated configuration artifact — "you have ` +
          `no CLAUDE.md" is legitimate, "you never used this skill" is not — then it ` +
          `needs a declared, reviewed exemption rather than a silent pass; add one ` +
          `and say which artifact it enumerates.`
      ).toBeNull();
    }
  );

  it('covers the whole registered catalog, not a subset', () => {
    // Guards against the sweep silently shrinking (e.g. a filtered DETECTORS
    // import) and reporting green over fewer detectors than exist.
    expect(DETECTORS.length).toBeGreaterThan(100);
    expect(new Set(DETECTORS.map((d) => d.id)).size).toBe(DETECTORS.length);
  });

  it('no detector THROWS on empty evidence either', () => {
    // A detector that crashes on an empty corpus fails closed in production
    // (the engine drops it), but it is still reading absent data as if present.
    for (const detector of DETECTORS) {
      expect(() => detector.rule(emptyInput(), NOW), `${detector.id} threw`).not.toThrow();
    }
  });
});

describe('the contract can actually fail (negative control)', () => {
  // Without this, a green suite proves nothing: every assertion above would
  // pass just as happily against a check that never looks at anything.
  const claimsFromNothing: Detector = {
    id: 'test.claims-from-nothing',
    category: 'workflow',
    dataDeps: ['tokenData'],
    rule(input) {
      // The defect in miniature: no sessions observed, therefore the user must
      // not be doing the thing.
      if (input.tokenData.length === 0) {
        return {
          id: 'test.claims-from-nothing',
          category: 'workflow',
          severity: 'warning',
          title: 'You never ran anything',
          detail: 'No sessions found, so you are not using the tool.',
          action: 'Use it.',
          view: 'sessions',
        };
      }
      return null;
    },
  };

  it('detects a detector that emits from an empty corpus', () => {
    expect(claimsFromNothing.rule(emptyInput(), NOW)).not.toBeNull();
  });

  it('and the real catalog does not contain that shape', () => {
    const emitters = DETECTORS.filter((d) => d.rule(emptyInput(), NOW) !== null).map(
      (d) => d.id
    );
    expect(emitters).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Thin evidence: present, but too little to support a comparative claim (#3424).
// ---------------------------------------------------------------------------

/**
 * A genuinely thin corpus: ONE session, ONE day old, one tool call.
 *
 * The sibling case to the empty input above. Empty is easy — there is nothing to
 * reason from. Thin is where the mistake actually gets made: there IS data, so a
 * detector runs, and any claim shaped as a rate, a proportion, or a cohort is
 * being computed from a sample of one.
 */
function thinInput(): RecommendationInput {
  const ts = new Date(NOW - 86_400_000).toISOString();
  return assembleRecommendationInput({
    tokenData: [
      {
        sessionId: 's1',
        entrypoint: 'cli',
        project: '/repo/a',
        totalInputTokens: 500_000,
        totalOutputTokens: 100_000,
        entries: [
          {
            timestamp: ts,
            model: 'claude-opus-4-8',
            inputTokens: 500_000,
            outputTokens: 100_000,
            cacheCreationTokens: 200_000,
            cacheCreation1hTokens: 200_000,
            cacheReadTokens: 50_000,
            webSearchRequests: 1,
            webFetchRequests: 0,
          },
        ],
        compactionEvents: [],
      },
    ] as unknown as RecommendationInput['tokenData'],
    toolData: [
      {
        sessionId: 's1',
        calls: [
          {
            timestamp: ts,
            toolName: 'Bash',
            input: { command: 'npm test' },
            toolUseId: 'u1',
            isError: false,
            resultBytes: 100,
          },
        ],
      },
    ] as unknown as RecommendationInput['toolData'],
    sessions: [
      { sessionId: 's1', project: '/repo/a', startTime: NOW - 86_400_000 },
    ] as unknown as RecommendationInput['sessions'],
    projects: [],
    permissionRows: [],
    apiErrors: [],
  });
}

describe('no detector makes a FLEET claim from a one-session corpus (#3424)', () => {
  /**
   * Measured, not assumed: exactly three detectors fire on this input, and the
   * list is asserted so a new one cannot join silently.
   *
   * The two that remain are ACCOUNTING claims — counts and costs of what was
   * actually observed, true at any corpus size:
   *  - `cost.cache-1h-waste` measures the rate premium paid on tokens that were
   *    really written (and books nothing, per #3192);
   *  - `context.over-window` counts the observed sessions that passed 200K.
   *
   * `context.compaction-hot-sessions` was the third and is now suppressed: its
   * percent arm read one hot session out of one as "100% of the fleet" and
   * announced "Multiple sessions at high compaction risk" about a single
   * session (#3424).
   */
  it('only accounting claims survive a one-session corpus', () => {
    const fired = DETECTORS.filter((d) => d.rule(thinInput(), NOW) !== null).map((d) => d.id);
    expect(fired.sort()).toEqual(['context.over-window', 'cost.cache-1h-waste']);
  });

  it('no surviving finding claims a fleet proportion', () => {
    for (const detector of DETECTORS) {
      const rec = detector.rule(thinInput(), NOW);
      if (!rec) continue;
      // A "% of the fleet" or "N of M sessions" phrasing computed from one
      // session is the shape this guards against.
      expect(
        `${rec.title} ${rec.detail}`,
        `${detector.id} described a fleet proportion from a single-session corpus`
      ).not.toMatch(/% of the fleet/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Claim-producing surfaces OUTSIDE the detector catalog.
//
// Both of these are real, recently-fixed instances of the class (#3123). A
// catalog-only contract would not reach either, which is why they are pinned
// here rather than left to the modules' own suites alone.
// ---------------------------------------------------------------------------

describe('non-detector claim surfaces (#3123)', () => {
  it('digestVerdict does not call an unanalysed surface healthy', () => {
    const verdict = digestVerdict([], []);
    expect(verdict.tone).toBe('unknown');
    expect(verdict.text).not.toMatch(/looks healthy/i);
  });

  it('digestVerdict still reports healthy when coverage says we looked', () => {
    const full: DomainCoverage[] = ACTION_DOMAINS.map((domain) => ({
      domain,
      status: 'PROVE' as const,
    }));
    expect(digestVerdict([], full).tone).toBe('ok');
  });

  it('topPerDomain treats an uninstrumented domain as a blind spot', () => {
    const findings = topPerDomain([], []);
    expect(findings.length).toBe(ACTION_DOMAINS.length);
    expect(findings.every((f) => f.coverage === 'blind-spot')).toBe(true);
  });
});
