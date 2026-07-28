/**
 * Behavioral tests for safety.deny-rule-never-triggered (#175, rewritten for
 * #3221 / decided on #3383).
 *
 * The detector is PURELY INFORMATIONAL. It reports which `permissions.deny`
 * rules matched no tool call in retained history and stops there — no removal
 * checklist, no config-mutating snippet, no `fix` of any kind. These tests pin
 * that shape, the breadth it buys (destructive guards are reported now that
 * nothing proposes deleting them), the coverage floor, and the asOf/stale
 * hedging.
 *
 * SAFETY NOTE: every command string below is inert text used only as fixture
 * data — `echo`/`printf` for the "commands that ran", and destructive-looking
 * strings only as DENY-RULE literals, which are compared as strings and never
 * executed. Nothing here shells out.
 */
import { describe, it, expect } from 'vitest';
import { detector } from './deny-rule-never-triggered';
import { PROVENANCE_DETECTORS, validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';

const NOW = Date.parse('2026-06-20T00:00:00.000Z');
/** Inside the 14-day freshness window relative to NOW. */
const FRESH_DAY = '2026-06-19';
/** Well outside it — drives the "as of <date>" demotion. */
const STALE_DAY = '2026-04-02';

/** `n` inert Bash calls, all running the same harmless command. */
function bashCalls(
  n: number,
  command = 'echo hello',
  day: string | null = FRESH_DAY
): RecommendationInput['toolData'][number]['calls'] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: day === null ? 'not-a-date' : `${day}T09:0${i % 10}:00.000Z`,
    toolName: 'Bash',
    input: { command },
    toolUseId: `c${i}`,
    isError: false,
    resultBytes: 0,
  })) as unknown as RecommendationInput['toolData'][number]['calls'];
}

/** Bash calls with explicit per-call timestamps — for mixed dated/undated history. */
function callsAt(timestamps: string[]): RecommendationInput['toolData'][number]['calls'] {
  return timestamps.map((timestamp, i) => ({
    timestamp,
    toolName: 'Bash',
    input: { command: 'echo hello' },
    toolUseId: `m${i}`,
    isError: false,
    resultBytes: 0,
  })) as unknown as RecommendationInput['toolData'][number]['calls'];
}

function readCalls(n: number, day = FRESH_DAY): RecommendationInput['toolData'][number]['calls'] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: `${day}T09:0${i % 10}:00.000Z`,
    toolName: 'Read',
    input: { file_path: '/repo/a.ts' },
    toolUseId: `r${i}`,
    isError: false,
    resultBytes: 0,
  })) as unknown as RecommendationInput['toolData'][number]['calls'];
}

function input(opts: {
  deny?: unknown[];
  calls?: RecommendationInput['toolData'][number]['calls'];
}): RecommendationInput {
  return {
    tokenData: [],
    toolData: opts.calls ? [{ sessionId: 's1', calls: opts.calls }] : [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig:
      opts.deny === undefined
        ? null
        : ({
            settings: { permissions: { deny: opts.deny } },
          } as unknown as RecommendationInput['liveConfig']),
  };
}

/** Every string this recommendation puts in front of a user. */
function surfaceText(rec: NonNullable<ReturnType<typeof detector.rule>>): string {
  return [rec.title, rec.detail, rec.action, ...(rec.evidence ?? [])].join('\n');
}

describe('safety.deny-rule-never-triggered — informational shape (#3221/#3383)', () => {
  it('emits NO fix at all: no removal checklist, no config-mutating snippet', () => {
    const rec = detector.rule(
      input({ deny: ['Bash(printf hi:*)'], calls: bashCalls(24) }),
      NOW
    );
    expect(rec).not.toBeNull();
    // The whole point: no `fix` means no implicit `fixKind: 'validated'` and no
    // copy-paste surface for advice this detector does not give (#3221).
    expect(rec!.fix).toBeUndefined();
  });

  it('never tells the user the rules are unnecessary or safe to remove', () => {
    const rec = detector.rule(
      input({ deny: ['Bash(printf hi:*)'], calls: bashCalls(24) }),
      NOW
    )!;
    const text = surfaceText(rec).toLowerCase();
    for (const phrase of [
      'prune',
      'delete',
      'remove these',
      'remove them',
      'clutter',
      'dead entries',
      'no longer relevant',
    ]) {
      expect(text, `surface copy must not say "${phrase}"`).not.toContain(phrase);
    }
    // "unnecessary" and "remove" may appear ONLY inside the disclaimers that
    // negate them — never as the finding's own claim.
    expect(rec.detail).toMatch(/not evidence that any of them is unnecessary/i);
    expect(rec.action).toMatch(/does not judge whether a rule is safe to remove/i);
    // …and it states plainly that a silent guard may simply be working.
    expect(rec.detail).toMatch(/guard that never fires may simply be working/i);
  });

  it('reports a destructive guard without suggesting its removal', () => {
    // These strings are deny-rule LITERALS compared as text; nothing executes.
    const deny = ['Bash(terraform destroy:*)', 'Bash(env rm -rf /:*)'];
    const rec = detector.rule(input({ deny, calls: bashCalls(24) }), NOW)!;

    expect(rec.evidence).toEqual(deny);
    expect(rec.affected).toBe(2);
    expect(rec.fix).toBeUndefined();
    expect(surfaceText(rec).toLowerCase()).not.toContain('delete');
  });
});

describe('safety.deny-rule-never-triggered — breadth restored', () => {
  // Rules the pre-#3221 detector withheld: the old `isDangerousDenyRule`
  // denylist dropped `rm`/`curl`/`sudo`/`git push --force`/`npm publish`
  // guards, and the #3376 positive classifier additionally dropped everything
  // it could not recognise as read-only (`Bash(npm test:*)`,
  // `Bash(yarn install:*)`) plus every bare-tool capability deny (`WebFetch`).
  const PREVIOUSLY_WITHHELD = [
    'Bash(rm -rf:*)',
    'Bash(curl:*)',
    'Bash(sudo:*)',
    'Bash(git push --force:*)',
    'Bash(npm publish:*)',
    'Bash(terraform destroy:*)',
    'Bash(kubectl delete:*)',
    'Bash(npm test:*)',
    'Bash(yarn install:*)',
    'WebFetch',
  ];

  it('reports every never-matched rule the old classifiers withheld', () => {
    const rec = detector.rule(
      input({ deny: PREVIOUSLY_WITHHELD, calls: bashCalls(24) }),
      NOW
    );
    expect(rec).not.toBeNull();
    expect(rec!.evidence).toEqual(PREVIOUSLY_WITHHELD);
    expect(rec!.affected).toBe(PREVIOUSLY_WITHHELD.length);
  });

  it('still excludes a rule the matcher cannot evaluate, and discloses the exclusion', () => {
    // `permRuleMatchesCall` returns null for a non-Bash rule with a specifier:
    // an EVIDENCE limit, not a safety judgement — so it is counted, not listed.
    const rec = detector.rule(
      input({ deny: ['Bash(printf hi:*)', 'Read(./secrets/**)'], calls: bashCalls(24) }),
      NOW
    )!;
    expect(rec.evidence).toEqual(['Bash(printf hi:*)']);
    expect(rec.detail).toContain('1 further rule(s) carry a non-Bash specifier');
  });

  it('does not list a rule that DID match a retained call', () => {
    const rec = detector.rule(
      input({
        deny: ['Bash(echo:*)', 'Bash(printf hi:*)'],
        calls: bashCalls(24, 'echo hello'),
      }),
      NOW
    )!;
    expect(rec.evidence).toEqual(['Bash(printf hi:*)']);
  });

  it('stays silent when every deny rule matched something', () => {
    expect(
      detector.rule(input({ deny: ['Bash(echo:*)'], calls: bashCalls(24, 'echo hi') }), NOW)
    ).toBeNull();
  });

  it('stays silent with no deny rules configured', () => {
    expect(detector.rule(input({ deny: [], calls: bashCalls(24) }), NOW)).toBeNull();
    expect(detector.rule(input({ calls: bashCalls(24) }), NOW)).toBeNull();
  });
});

describe('safety.deny-rule-never-triggered — coverage floor', () => {
  it('suppresses on thin history rather than claiming every rule never fired', () => {
    for (const n of [0, 1, 19]) {
      expect(
        detector.rule(input({ deny: ['Bash(printf hi:*)'], calls: bashCalls(n) }), NOW),
        `${n} retained call(s) is below the floor`
      ).toBeNull();
    }
  });

  it('fires at the floor exactly', () => {
    expect(
      detector.rule(input({ deny: ['Bash(printf hi:*)'], calls: bashCalls(20) }), NOW)
    ).not.toBeNull();
  });

  it('counts every retained tool call, not just Bash ones', () => {
    // The floor is about ingest health — is there history at all — because the
    // detector now judges bare-tool rules for any tool, not only Bash rules.
    const rec = detector.rule(
      input({ deny: ['WebFetch'], calls: readCalls(22) }),
      NOW
    );
    expect(rec).not.toBeNull();
    expect(rec!.evidence).toEqual(['WebFetch']);
    // …and the Bash share is disclosed so a reader can weigh a Bash rule's evidence.
    expect(rec!.detail).toContain('22 retained tool call(s) (0 Bash)');
  });
});

describe('safety.deny-rule-never-triggered — asOf / stale hedging', () => {
  it('carries the newest retained call day as asOf and is not stale inside the window', () => {
    const rec = detector.rule(
      input({ deny: ['Bash(printf hi:*)'], calls: bashCalls(24, 'echo hello', FRESH_DAY) }),
      NOW
    )!;
    expect(rec.provenance?.asOf).toBe(FRESH_DAY);
    expect(rec.provenance?.stale).toBe(false);
    expect(rec.detail).toContain('in your retained history');
    expect(rec.detail).not.toContain('as of');
  });

  it('demotes a historical window to "as of <date>" rather than present tense', () => {
    const rec = detector.rule(
      input({ deny: ['Bash(printf hi:*)'], calls: bashCalls(24, 'echo hello', STALE_DAY) }),
      NOW
    )!;
    expect(rec.provenance?.asOf).toBe(STALE_DAY);
    expect(rec.provenance?.stale).toBe(true);
    expect(rec.detail).toContain(`as of ${STALE_DAY}, in retained history`);
    expect(validateRecommendationProvenance(rec)).toEqual([]);
  });

  it('omits asOf/stale entirely when no timestamp is readable', () => {
    const rec = detector.rule(
      input({ deny: ['Bash(printf hi:*)'], calls: bashCalls(24, 'echo hello', null) }),
      NOW
    )!;
    expect(rec.provenance?.asOf).toBeUndefined();
    expect(rec.provenance?.stale).toBeUndefined();
    expect(rec.detail).toContain(
      '24 retained tool call(s) (24 Bash) across 1 session(s); none of them carry a readable timestamp, so this window cannot be dated'
    );
    // stale=true without an asOf is a contract violation; absent/absent is fine.
    expect(validateRecommendationProvenance(rec)).toEqual([]);
  });
});

describe('safety.deny-rule-never-triggered — partially-dated history fails closed', () => {
  const deny = ['Bash(printf hi:*)'];

  it('asserts no window when a single call among many is undated', () => {
    // 23 dated + 1 undated. The count and the span used to come from different
    // sets of calls, so this reported "24 calls spanning <range>" over 23.
    const rec = detector.rule(
      input({
        deny,
        calls: callsAt([
          ...Array.from({ length: 23 }, (_, i) => `${FRESH_DAY}T09:${String(i).padStart(2, '0')}:00.000Z`),
          '',
        ]),
      }),
      NOW
    )!;
    expect(rec.detail).not.toMatch(/spanning/);
    expect(rec.detail).toContain(
      '24 retained tool call(s) (24 Bash) across 1 session(s); 1 of them carry no readable timestamp, so this window cannot be dated'
    );
    expect(rec.provenance?.asOf).toBeUndefined();
    expect(rec.provenance?.stale).toBeUndefined();
    expect(validateRecommendationProvenance(rec)).toEqual([]);
  });

  it('cannot be marked fresh on the strength of one dated call', () => {
    // The reported hazard: 23 undated calls carry no date at all, so a lone
    // fresh call must not date — let alone freshen — the whole window.
    const rec = detector.rule(
      input({
        deny,
        calls: callsAt([...Array.from({ length: 23 }, () => ''), `${FRESH_DAY}T09:00:00.000Z`]),
      }),
      NOW
    )!;
    expect(rec.provenance?.asOf).toBeUndefined();
    expect(rec.provenance?.stale).toBeUndefined();
    expect(rec.detail).not.toContain(FRESH_DAY);
  });

  it('keeps the count and the span on one basis: both or neither', () => {
    // Wholly dated ⇒ a span, and it covers exactly the calls counted beside it.
    const dated = detector.rule(
      input({
        deny,
        calls: callsAt(
          Array.from({ length: 24 }, (_, i) =>
            i === 0 ? `${STALE_DAY}T09:00:00.000Z` : `${FRESH_DAY}T09:00:00.000Z`
          )
        ),
      }),
      NOW
    )!;
    expect(dated.detail).toContain(
      `24 retained tool call(s) (24 Bash) across 1 session(s), spanning ${STALE_DAY} to ${FRESH_DAY}`
    );
    expect(dated.provenance?.asOf).toBe(FRESH_DAY);
    // The provenance observation is built from the same derivation as the detail.
    expect(dated.provenance?.observations[2].claim).toContain(
      `spanning ${STALE_DAY} to ${FRESH_DAY}`
    );
    expect(dated.provenance?.observations[2].value).toBe(24);
  });

  it('treats a permissively-parseable non-RFC3339 timestamp as undated', () => {
    // `Date.parse('2026')` succeeds; `rfc3339TimestampMs('2026')` does not. A
    // loose parse here would quietly re-admit the guess the guard declines.
    expect(Number.isFinite(Date.parse('2026'))).toBe(true);
    const rec = detector.rule(
      input({ deny, calls: callsAt(Array.from({ length: 24 }, () => '2026')) }),
      NOW
    )!;
    expect(rec.provenance?.asOf).toBeUndefined();
    expect(rec.detail).toContain('none of them carry a readable timestamp');
  });

  it('still counts undated calls toward the coverage floor', () => {
    // The floor's subject is matching, which needs no timestamp — so undated
    // history is still evidence, and only the DATED claims are withheld.
    expect(
      detector.rule(input({ deny, calls: bashCalls(20, 'echo hello', null) }), NOW)
    ).not.toBeNull();
    expect(
      detector.rule(input({ deny, calls: bashCalls(19, 'echo hello', null) }), NOW)
    ).toBeNull();
  });
});

describe('safety.deny-rule-never-triggered — provenance', () => {
  it('is on the provenance allowlist', () => {
    expect(PROVENANCE_DETECTORS).toContain('safety.deny-rule-never-triggered');
  });

  it('cites the settings array and the tool-call coverage, inference kept separate', () => {
    const rec = detector.rule(
      input({ deny: ['Bash(terraform destroy:*)', 'Read(./secrets/**)'], calls: bashCalls(24) }),
      NOW
    )!;
    expect(validateRecommendationProvenance(rec)).toEqual([]);

    const p = rec.provenance!;
    expect(p.observations.map((o) => o.source)).toEqual([
      'liveConfig',
      'parse-tools',
      'parse-tools',
    ]);
    expect(p.observations[0].field).toBe('settings.permissions.deny');
    expect(p.observations[0].value).toBe(2);
    expect(p.observations[2].value).toBe(24);
    // The inference must not smuggle back the claim the detector dropped.
    expect(p.inference).toMatch(/not that they are unused, unnecessary, or safe to remove/i);
  });
});
