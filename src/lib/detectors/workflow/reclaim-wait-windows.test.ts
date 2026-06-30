import { describe, it, expect } from 'vitest';
import { detector } from './reclaim-wait-windows';
import { validateRecommendationProvenance } from '../provenance';
import { validateFixSnippet } from '../fix-validity';
import { classifyWaitClass } from '../../parse-timeline';
import type { RecommendationInput } from '../types';
import type { SessionTimeline, TimelineEntry, WaitClass } from '../../parse-timeline';

const T0 = Date.parse('2026-06-10T00:00:00Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const MIN = 60_000;

function timeline(sessionId: string, entries: TimelineEntry[]): SessionTimeline {
  return {
    sessionId,
    startTime: entries[0]?.timestamp ?? iso(0),
    endTime: entries[entries.length - 1]?.timestamp ?? iso(0),
    entries,
  };
}

function input(timelines?: SessionTimeline[]): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    timelines,
  };
}

/** One passive-wait stall of a given class: wait-end, then a human prompt `gapMin` later. */
function classedStall(sessionId: string, waitClass: WaitClass, gapMin: number): SessionTimeline {
  return timeline(sessionId, [
    { timestamp: iso(0), kind: 'user', summary: 'go' },
    { timestamp: iso(1000), kind: 'assistant', summary: "I'll wait and report back.", waitLanguage: true, waitClass },
    { timestamp: iso(1000 + gapMin * MIN), kind: 'user', summary: 'status?' },
  ]);
}

describe('classifyWaitClass (#1880)', () => {
  it.each([
    ["I'll wait for CI to finish and report back.", 'ci'],
    ["I'll report once the pr checks pass.", 'ci'],
    ["I'll wait for the deploy to come up and let you know.", 'deploy'],
    ["I'll monitor the rollout and circle back.", 'deploy'],
    ["I'll wait for the git push to land.", 'push'],
    ["I'll report when the merge goes through.", 'push'],
    ["I'll wait until it is fully deployed and report back.", 'deploy'],
    // A bare prose "the merge"/"pushing" with no git-domain tail stays generic.
    ["I'll wait. The merge conflict in foo.ts is already resolved.", 'generic'],
    ["I'll wait while pushing the analysis through the model.", 'generic'],
    ["I'll wait for the remote queue to drain.", 'remote-queue'],
    ["I'll let you know when the background worker returns.", 'remote-queue'],
    ["I'll keep an eye on the watcher and report.", 'watcher'],
    ["I'll wait and report back.", 'generic'],
  ] as [string, WaitClass][])('classifies %j as %s', (text, expected) => {
    expect(classifyWaitClass(text)).toBe(expected);
  });

  it('is first-match by footprint specificity: a "wait for CI then merge" reads as ci', () => {
    expect(classifyWaitClass("I'll wait for CI then merge the PR.")).toBe('ci');
  });

  it('defaults empty text to generic', () => {
    expect(classifyWaitClass('')).toBe('generic');
  });
});

describe('workflow.reclaim-wait-windows — guards', () => {
  it('returns null when timelines are absent or empty', () => {
    expect(detector.rule(input(), 0)).toBeNull();
    expect(detector.rule(input([]), 0)).toBeNull();
  });

  it('stays silent below the 3-stall floor', () => {
    expect(detector.rule(input([classedStall('a', 'ci', 2), classedStall('b', 'ci', 2)]), 0)).toBeNull();
  });

  it('declares its reuse of the passive-wait-stall collector', () => {
    expect(detector.dependsOn).toContain('reliability.passive-wait-stall');
  });
});

describe('workflow.reclaim-wait-windows — fires + emits the ruleset', () => {
  it('emits a workflow rec grouping stalls into wait classes', () => {
    const rec = detector.rule(
      input([
        classedStall('a', 'ci', 16),
        classedStall('b', 'ci', 6),
        classedStall('c', 'deploy', 7),
        classedStall('d', 'push', 3),
      ]),
      0
    );
    expect(rec).not.toBeNull();
    expect(rec?.id).toBe('workflow.reclaim-wait-windows');
    expect(rec?.category).toBe('workflow');
    expect(rec?.affected).toBe(4);
    expect(rec?.view).toBe('timeline');
    // The ruleset names each observed class; CI leads (most reclaimable time).
    expect(rec?.evidence?.[0]).toContain('CI / PR checks');
    expect(rec?.evidence?.some((e) => e.includes('deploy'))).toBe(true);
    expect(rec?.evidence?.some((e) => e.includes('push'))).toBe(true);
  });

  it('ranks the ruleset by reclaimable time — the biggest bucket leads detail/evidence', () => {
    const rec = detector.rule(
      input([
        // deploy: one 20-min stall (most total idle); ci: two short stalls.
        classedStall('a', 'deploy', 20),
        classedStall('b', 'ci', 2),
        classedStall('c', 'ci', 2),
      ]),
      0
    );
    expect(rec?.evidence?.[0]).toContain('deploy / rollout');
    expect(rec?.detail).toContain('deploy / rollout');
  });

  it('weights severity by silence gap — warning with a >5min stall, info otherwise', () => {
    const allShort = detector.rule(
      input([classedStall('a', 'ci', 1), classedStall('b', 'ci', 2), classedStall('c', 'deploy', 3)]),
      0
    );
    expect(allShort?.severity).toBe('info');

    const oneLong = detector.rule(
      input([classedStall('a', 'ci', 1), classedStall('b', 'ci', 2), classedStall('c', 'deploy', 16)]),
      0
    );
    expect(oneLong?.severity).toBe('warning');
    expect(oneLong?.estTimeReclaimedMin).toBe(19); // 1 + 2 + 16
  });

  it('falls back to the generic class when no per-class signal was parsed', () => {
    const rec = detector.rule(
      input([classedStall('a', 'generic', 6), classedStall('b', 'generic', 7), classedStall('c', 'generic', 8)]),
      0
    );
    expect(rec?.evidence?.[0]).toContain('generic wait');
  });

  it('treats a legacy waitLanguage stall with NO waitClass field as generic (pre-#1880 dataset)', () => {
    // A timeline parsed before the waitClass field existed: waitLanguage set, no
    // waitClass. collectSessionStalls coalesces the missing field to 'generic'.
    const legacyStall = (sessionId: string, gapMin: number): SessionTimeline =>
      timeline(sessionId, [
        { timestamp: iso(0), kind: 'user', summary: 'go' },
        { timestamp: iso(1000), kind: 'assistant', summary: "I'll wait.", waitLanguage: true },
        { timestamp: iso(1000 + gapMin * MIN), kind: 'user', summary: 'status?' },
      ]);
    const rec = detector.rule(input([legacyStall('a', 6), legacyStall('b', 7), legacyStall('c', 8)]), 0);
    expect(rec?.affected).toBe(3);
    expect(rec?.evidence?.[0]).toContain('generic wait');
    expect(rec?.provenance?.observations.some((o) => o.field === 'entries[].waitClass')).toBe(true);
  });
});

describe('workflow.reclaim-wait-windows — auditability', () => {
  it('carries auditable provenance citing parse-timeline waitClass, one observation per class', () => {
    const rec = detector.rule(
      input([classedStall('a', 'ci', 16), classedStall('b', 'deploy', 7), classedStall('c', 'push', 3)]),
      0
    )!;
    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.provenance!.observations[0].source).toBe('parse-timeline');
    // One summary observation + one per class.
    const classFields = rec.provenance!.observations.filter((o) => o.field === 'entries[].waitClass');
    expect(classFields.length).toBe(3);
    expect(rec.claimClass).toBe('accounting');
    expect(rec.proofTier).toBe('accounting');
  });

  it('ships a suggest-only fix that documents the non-interference filter, marked illustrative', () => {
    const rec = detector.rule(
      input([classedStall('a', 'ci', 16), classedStall('b', 'deploy', 7), classedStall('c', 'push', 3)]),
      0
    )!;
    expect(rec.fix?.target).toBe('CLAUDE.md');
    expect(rec.fix?.fixKind).toBe('illustrative');
    // The non-interference filter is documented in the snippet.
    expect(rec.fix?.snippet).toMatch(/worktree/i);
    expect(rec.fix?.snippet).toMatch(/disjoint/i);
    expect(rec.fix?.snippet).toMatch(/capacity/i);
    expect(rec.fix?.snippet).toMatch(/suggest only/i);
    // The non-portable references are allowed because the fix is illustrative.
    expect(validateFixSnippet(rec.fix!)).toEqual([]);
    // Suggest-only: the action requires a human greenlight, never autonomous spend.
    expect(rec.action).toMatch(/suggest-only/i);
    expect(rec.action).toMatch(/greenlight/i);
    expect(rec.action).toMatch(/nothing auto-executes/i);
  });
});
