import { describe, it, expect } from 'vitest';
import { computeSuppressionTransitions } from './suppression-transition';
import { claudeMdMarksApplied } from './shared';
import type { Detector, Recommendation, RecommendationInput } from './types';
import type { AppliedMarkers } from './types';
import { detector as dangerousBypassDetector } from './safety/dangerous-bypass';
import { detector as toolErrorsDetector } from './reliability/tool-errors';
import type { ToolCall, ToolUsageData } from '../parse-tools';

// ── Fixtures ───────────────────────────────────────────────────────────────
// Synthetic detectors that gate on `claudeMdMarksApplied` exactly like the real
// catalog: when the merged CLAUDE.md text matches their markers the rule returns
// null (suppressed); otherwise it fires. The transition function observes that
// flip only through the public `Detector.rule` contract — so these stand in for
// any of the 12 marker-gated detectors.

const MARKERS_A: AppliedMarkers = {
  headings: [/^##\s+Cache policy\b/i],
  bodyPhrases: ['default 5-minute prompt cache'],
};

const MARKERS_B: AppliedMarkers = {
  headings: [/^##\s+Rate-limit hygiene\b/i],
  bodyPhrases: ['exponential backoff on 429'],
};

function markerGatedDetector(id: string, markers: AppliedMarkers): Detector {
  return {
    id,
    category: 'cost',
    rule(input): Recommendation | null {
      if (claudeMdMarksApplied(input.liveConfig, markers)) return null;
      return {
        id,
        category: 'cost',
        severity: 'warning',
        title: `${id} title`,
        detail: 'd',
        action: 'a',
        fix: {
          target: 'CLAUDE.md',
          label: `${id} fix`,
          note: 'n',
          snippet: 's',
          appliedMarkers: markers,
        },
      };
    },
  };
}

/** A detector that never depends on CLAUDE.md — it fires (or stays silent)
 *  regardless of markers, so it must never produce a transition. */
function alwaysFiringDetector(id: string): Detector {
  return {
    id,
    category: 'workflow',
    rule(): Recommendation {
      return {
        id,
        category: 'workflow',
        severity: 'info',
        title: 't',
        detail: 'd',
        action: 'a',
      };
    },
  };
}

function inputWithClaudeMd(text: string): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: {
      settings: {},
      settingsHealth: null,
      claudeMd: { global: text, perProject: {} },
      plugins: [],
      mcpServers: [],
      skills: [],
      subagents: [],
      commands: [],
    } as unknown as NonNullable<RecommendationInput['liveConfig']>,
  };
}

// CLAUDE.md prose that satisfies MARKERS_A (heading + body phrase).
const CLAUDE_MD_A = [
  '## Cache policy',
  '',
  'Keep the default 5-minute prompt cache for routine work.',
].join('\n');

describe('computeSuppressionTransitions (#576 — engine-loop FIRING→SUPPRESSED emit)', () => {
  it('fires exactly one SUPPRESSED transition for a previously-surfaced finding that flips', async () => {
    const detectors = [markerGatedDetector('cost.a', MARKERS_A)];
    const input = inputWithClaudeMd(CLAUDE_MD_A);

    const result = await computeSuppressionTransitions(
      input,
      {
        surfacedFindingIds: ['cost.a'],
        suppressedFindingIds: [],
      },
      detectors,
      1_700_000_000_000
    );

    expect(result.transitions).toHaveLength(1);
    expect(result.organic).toHaveLength(0);
    const t = result.transitions[0];
    expect(t.kind).toBe('SUPPRESSED');
    expect(t.findingId).toBe('cost.a');
    // Heading text is stripped of its leading `#`s and resolved from the actual
    // matched CLAUDE.md heading line.
    expect(t.markerHeading).toBe('Cache policy');
    // Fingerprint is a digest of the prose, never the raw body.
    expect(t.contentFingerprint).toMatch(/^(sha256|fnv1a):[0-9a-f]+$/);
    expect(t.contentFingerprint).not.toContain('Cache policy');
  });

  it('is idempotent on re-run: a finding with a prior SUPPRESSED receipt emits nothing', async () => {
    const detectors = [markerGatedDetector('cost.a', MARKERS_A)];
    const input = inputWithClaudeMd(CLAUDE_MD_A);

    const result = await computeSuppressionTransitions(
      input,
      {
        surfacedFindingIds: ['cost.a'],
        suppressedFindingIds: ['cost.a'], // already emitted once
      },
      detectors
    );

    expect(result.transitions).toHaveLength(0);
    expect(result.organic).toHaveLength(0);
  });

  it('excludes the organic case: marker-suppressed but never surfaced ⇒ not attributed', async () => {
    const detectors = [markerGatedDetector('cost.a', MARKERS_A)];
    const input = inputWithClaudeMd(CLAUDE_MD_A);

    const result = await computeSuppressionTransitions(
      input,
      {
        surfacedFindingIds: [], // no prior SURFACED entry
        suppressedFindingIds: [],
      },
      detectors
    );

    expect(result.transitions).toHaveLength(0);
    expect(result.organic).toHaveLength(1);
    expect(result.organic[0].findingId).toBe('cost.a');
  });

  it('does not emit for a still-firing finding (markers absent)', async () => {
    const detectors = [markerGatedDetector('cost.a', MARKERS_A)];
    // CLAUDE.md does NOT satisfy MARKERS_A, so the detector still fires.
    const input = inputWithClaudeMd('## Unrelated\n\nnothing to see');

    const result = await computeSuppressionTransitions(
      input,
      { surfacedFindingIds: ['cost.a'], suppressedFindingIds: [] },
      detectors
    );

    expect(result.transitions).toHaveLength(0);
    expect(result.organic).toHaveLength(0);
  });

  it('ignores findings whose null is not caused by CLAUDE.md markers', async () => {
    // alwaysFiring never returns null and never depends on markers; a detector
    // that is null in BOTH runs (not shown here) is likewise not a marker flip.
    const detectors = [alwaysFiringDetector('workflow.x')];
    const input = inputWithClaudeMd(CLAUDE_MD_A);

    const result = await computeSuppressionTransitions(
      input,
      { surfacedFindingIds: ['workflow.x'], suppressedFindingIds: [] },
      detectors
    );

    expect(result.transitions).toHaveLength(0);
    expect(result.organic).toHaveLength(0);
  });

  it('handles multiple detectors, emitting one transition per attributed flip', async () => {
    const detectors = [
      markerGatedDetector('cost.a', MARKERS_A),
      markerGatedDetector('reliability.b', MARKERS_B),
    ];
    // Only MARKERS_A is satisfied, so only cost.a flips; reliability.b still fires.
    const input = inputWithClaudeMd(CLAUDE_MD_A);

    const result = await computeSuppressionTransitions(
      input,
      {
        surfacedFindingIds: ['cost.a', 'reliability.b'],
        suppressedFindingIds: [],
      },
      detectors
    );

    expect(result.transitions.map((t) => t.findingId)).toEqual(['cost.a']);
  });

  it('compares multi-emit detectors by finding id instead of detector truthiness', async () => {
    const mainId = 'workflow.main';
    const companionId = 'workflow.companion';
    const emit = (detectorInput: RecommendationInput): Recommendation[] => {
      const companion: Recommendation = {
        id: companionId,
        category: 'workflow',
        severity: 'info',
        title: 'Companion finding',
        detail: 'd',
        action: 'a',
      };
      if (claudeMdMarksApplied(detectorInput.liveConfig, MARKERS_A)) {
        return [companion];
      }
      return [
        {
          id: mainId,
          category: 'workflow',
          severity: 'info',
          title: 'Main finding',
          detail: 'd',
          action: 'a',
          fix: {
            target: 'CLAUDE.md',
            label: 'Main fix',
            note: 'n',
            snippet: 's',
            appliedMarkers: MARKERS_A,
          },
        },
        companion,
      ];
    };
    const multiEmitDetector: Detector = {
      id: mainId,
      category: 'workflow',
      rule(detectorInput): Recommendation | null {
        return emit(detectorInput)[0] ?? null;
      },
      emitAll: emit,
    };

    const result = await computeSuppressionTransitions(
      inputWithClaudeMd(CLAUDE_MD_A),
      {
        surfacedFindingIds: [mainId, companionId],
        suppressedFindingIds: [],
      },
      [multiEmitDetector]
    );

    expect(result.transitions.map((transition) => transition.findingId)).toEqual([
      mainId,
    ]);
    expect(result.organic).toEqual([]);
  });

  it('treats a null liveConfig as "no markers" — never flips', async () => {
    const detectors = [markerGatedDetector('cost.a', MARKERS_A)];
    const input: RecommendationInput = {
      tokenData: [],
      toolData: [],
      sessions: [],
      projects: [],
      permissionRows: [],
      apiErrors: [],
      liveConfig: null,
    };

    const result = await computeSuppressionTransitions(
      input,
      { surfacedFindingIds: ['cost.a'], suppressedFindingIds: [] },
      detectors
    );

    expect(result.transitions).toHaveLength(0);
    expect(result.organic).toHaveLength(0);
  });
});

// ── #1783: hook findings flip via the adopt-block receipt ───────────────────
// reliability.tool-errors still uses its adoption receipt. Dangerous-bypass no
// longer does (#2642): only current structural settings coverage can suppress a
// newly observed dangerous pattern, so an old prose receipt must leave it firing.
describe('computeSuppressionTransitions with real settings/hook detectors (#1783)', () => {
  const tc = (toolName: string, isError: boolean, i: number): ToolCall => ({
    timestamp: `2026-06-12T10:00:0${i}.000Z`,
    toolName,
    input: toolName === 'Bash' ? { command: 'rm -rf ~' } : {},
    toolUseId: `tool-${toolName}-${i}`,
    isError: isError ? true : null,
    resultBytes: 0,
  });

  // One bypass session running a destructive command (fires dangerous-bypass) and
  // one session whose Edit calls fail 2/5 (fires tool-errors).
  const toolData: ToolUsageData[] = [
    { sessionId: 'bypass-1', calls: [tc('Bash', false, 0)] },
    {
      sessionId: 'errors-1',
      calls: Array.from({ length: 5 }, (_, i) => tc('Edit', i < 2, i)),
    },
  ];
  const permissionRows = [{ sessionId: 'bypass-1', mode: 'bypassPermissions' }];

  // Both findings adopted under the one shared section, each with its own id.
  const ADOPT_BLOCK_BOTH = [
    '## Claude Coach Adopted Recommendations',
    '',
    '### Dangerous commands ran under bypassed permissions (`safety.dangerous-bypass`)',
    '',
    'Adopted: 2026-06-12T10:00:00.000Z',
    '',
    '### Tools with high error rates (`reliability.tool-errors`)',
    '',
    'Adopted: 2026-06-12T10:00:00.000Z',
  ].join('\n');

  function realInput(claudeMd: string): RecommendationInput {
    return {
      tokenData: [],
      toolData,
      sessions: [],
      projects: [],
      permissionRows: permissionRows as unknown as RecommendationInput['permissionRows'],
      apiErrors: [],
      liveConfig: {
        settings: {},
        settingsHealth: null,
        claudeMd: { global: claudeMd, perProject: {} },
        plugins: [],
        mcpServers: [],
        skills: [],
        subagents: [],
        commands: [],
      } as unknown as NonNullable<RecommendationInput['liveConfig']>,
    };
  }

  const detectors = [dangerousBypassDetector, toolErrorsDetector];

  it('suppresses the hook finding but leaves dangerous-bypass structurally uncovered', async () => {
    const result = await computeSuppressionTransitions(
      realInput(ADOPT_BLOCK_BOTH),
      {
        surfacedFindingIds: ['safety.dangerous-bypass', 'reliability.tool-errors'],
        suppressedFindingIds: [],
      },
      detectors,
      1_700_000_000_000
    );

    expect(result.transitions.map((t) => t.findingId)).toEqual([
      'reliability.tool-errors',
    ]);
    for (const t of result.transitions) {
      expect(t.kind).toBe('SUPPRESSED');
      expect(t.markerHeading).toBe('Claude Coach Adopted Recommendations');
      expect(t.contentFingerprint).toMatch(/^(sha256|fnv1a):[0-9a-f]+$/);
    }
    expect(
      dangerousBypassDetector.rule(
        realInput(ADOPT_BLOCK_BOTH),
        1_700_000_000_000
      )?.id
    ).toBe('safety.dangerous-bypass');
  });

  it('does not flip when the adopt block is absent (both still firing)', async () => {
    const result = await computeSuppressionTransitions(
      realInput('## Unrelated\n\nnothing adopted here'),
      {
        surfacedFindingIds: ['safety.dangerous-bypass', 'reliability.tool-errors'],
        suppressedFindingIds: [],
      },
      detectors
    );

    expect(result.transitions).toHaveLength(0);
    expect(result.organic).toHaveLength(0);
  });
});
