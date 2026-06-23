import { describe, it, expect } from 'vitest';
import { detector } from './stale-state-assertion';
import { validateRecommendationProvenance } from '../provenance';
import { validateFixSnippet, effectiveFixKind } from '../fix-validity';
import type { RecommendationInput } from '../types';
import type { ToolCall, ToolUsageData } from '../../parse-tools';
import type { LiveConfig } from '../../../types';

const T0 = Date.parse('2026-06-10T00:00:00Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const MIN = 60_000;

let seq = 0;
function bash(ms: number, command: string): ToolCall {
  return {
    timestamp: iso(ms),
    toolName: 'Bash',
    input: { command },
    toolUseId: `t${seq++}`,
    isError: null,
    resultBytes: 0,
  };
}
function session(sessionId: string, calls: ToolCall[]): ToolUsageData {
  return { sessionId, calls };
}

function input(
  toolData?: ToolUsageData[],
  liveConfig: LiveConfig | null = null
): RecommendationInput {
  return {
    tokenData: [],
    toolData: toolData ?? [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig,
  };
}

function liveConfigClaudeMd(global: string): LiveConfig {
  return { claudeMd: { global, perProject: {} } } as unknown as LiveConfig;
}

/** One session whose single command is an un-fetched integration-branch read. */
function staleSession(id: string): ToolUsageData {
  return session(id, [bash(1000, 'git log origin/master --oneline -5')]);
}

describe('reliability.stale-state-assertion — guards', () => {
  it('returns null when toolData is absent or empty', () => {
    expect(detector.rule(input(), 0)).toBeNull();
    expect(detector.rule(input([]), 0)).toBeNull();
  });

  it('stays silent below the 3-stale floor', () => {
    expect(detector.rule(input([staleSession('a'), staleSession('b')]), 0)).toBeNull();
  });
});

describe('reliability.stale-state-assertion — fires', () => {
  it('emits a reliability rec when integration-branch reads run un-fetched', () => {
    const rec = detector.rule(
      input([staleSession('a'), staleSession('b'), staleSession('c')]),
      0
    );
    expect(rec).not.toBeNull();
    expect(rec?.id).toBe('reliability.stale-state-assertion');
    expect(rec?.category).toBe('reliability');
    expect(rec?.affected).toBe(3);
    expect(rec?.severity).toBe('info'); // 1 per session → below the warning floor
    expect(rec?.view).toBe('tools');
    expect(rec?.evidence?.[0]).toContain('git log origin/master');
  });

  it('escalates to warning when one session repeats the pattern', () => {
    const heavy = session('h', [
      bash(1000, 'git log origin/master'),
      bash(2000, 'git show master:package.json'),
      bash(3000, 'git diff origin/main'),
      bash(4000, 'git branch --contains abc123'),
    ]);
    const rec = detector.rule(input([heavy]), 0);
    expect(rec?.affected).toBe(4);
    expect(rec?.severity).toBe('warning');
  });
});

describe('reliability.stale-state-assertion — fetch coverage', () => {
  it('does NOT count reads preceded by an in-window fetch', () => {
    const covered = session('cov', [
      bash(0, 'git fetch origin'),
      bash(5 * MIN, 'git log origin/master'),
      bash(6 * MIN, 'git show master'),
      bash(7 * MIN, 'git diff origin/main'),
    ]);
    // On its own this session contributes zero stale reads → nothing fires.
    expect(detector.rule(input([covered]), 0)).toBeNull();
    // Alongside three genuinely-stale sessions, affected stays 3 (covered adds 0).
    const rec = detector.rule(
      input([staleSession('a'), staleSession('b'), staleSession('c'), covered]),
      0
    );
    expect(rec?.affected).toBe(3);
  });

  it('treats a self-fetching compound command as covered', () => {
    const compound = session('cmp', [
      bash(0, 'git fetch && git log origin/master'),
      bash(MIN, 'git fetch origin && git show master'),
      bash(2 * MIN, 'cd repo && git fetch && git diff origin/main'),
    ]);
    expect(detector.rule(input([compound]), 0)).toBeNull();
  });

  it('counts reads once the fetch is older than the 30-minute window', () => {
    const stale = session('win', [
      bash(0, 'git fetch origin'),
      bash(35 * MIN, 'git log origin/master'),
      bash(40 * MIN, 'git show master'),
      bash(45 * MIN, 'git diff origin/main'),
    ]);
    const rec = detector.rule(input([stale]), 0);
    expect(rec?.affected).toBe(3); // all three are >30m past the fetch
  });
});

describe('reliability.stale-state-assertion — false-positive guards', () => {
  it('excludes gh reads — gh queries the remote live, never stale', () => {
    const ghOnly = session('gh', [
      bash(1000, 'gh pr view 123'),
      bash(2000, 'gh pr list --state merged'),
      bash(3000, 'gh pr checks 456'),
    ]);
    expect(detector.rule(input([ghOnly]), 0)).toBeNull();
  });

  it('excludes ref-less git reads (no integration ref ⇒ not staleness-sensitive)', () => {
    const refless = session('rl', [
      bash(1000, 'git log --oneline -5'),
      bash(2000, 'git status'),
      bash(3000, 'git diff --stat'),
    ]);
    expect(detector.rule(input([refless]), 0)).toBeNull();
  });

  it('scopes --contains to `git branch` — `git log/tag --contains` are ref-less', () => {
    const contains = session('ct', [
      bash(1000, 'git log --contains abc123'),
      bash(2000, 'git tag --contains def456'),
      bash(3000, 'git log --all --contains 789abc'),
    ]);
    expect(detector.rule(input([contains]), 0)).toBeNull();
    // …but `git branch --contains` IS a landing check and is flagged.
    const branchContains = session('bc', [
      bash(1000, 'git branch --contains abc123'),
      bash(2000, 'git branch -r --contains def456'),
      bash(3000, 'git branch --contains 789abc'),
    ]);
    expect(detector.rule(input([branchContains]), 0)?.affected).toBe(3);
  });

  it('does not treat the word "fetch" inside a path/flag as a freshening fetch', () => {
    // `git log -- scripts/fetch-data.ts` is neither a read (no integration ref)
    // nor a fetch, so the three un-fetched master reads after it still flag.
    const pathFetch = session('pf', [
      bash(1000, 'git log -- scripts/fetch-data.ts'),
      bash(2000, 'git log origin/master'),
      bash(3000, 'git show master'),
      bash(4000, 'git diff origin/main'),
    ]);
    expect(detector.rule(input([pathFetch]), 0)?.affected).toBe(3);
  });
});

describe('reliability.stale-state-assertion — auditability', () => {
  const fired = () =>
    detector.rule(
      input([staleSession('a'), staleSession('b'), staleSession('c')]),
      0
    )!;

  it('carries valid provenance citing parse-tools', () => {
    const rec = fired();
    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.provenance!.observations[0].source).toBe('parse-tools');
    expect(rec.provenance!.observations[0].field).toContain('input.command');
    expect(rec.provenance!.inference).toBeTruthy();
  });

  it('ships a copy-paste-safe (validated) fix snippet', () => {
    const rec = fired();
    expect(rec.fix).toBeDefined();
    expect(effectiveFixKind(rec.fix!)).toBe('validated');
    expect(validateFixSnippet(rec.fix!)).toEqual([]);
  });

  it('self-suppresses once the fetch-before-claim rule is in CLAUDE.md', () => {
    const rec = fired();
    const lc = liveConfigClaudeMd(rec.fix!.snippet);
    expect(
      detector.rule(
        input([staleSession('a'), staleSession('b'), staleSession('c')], lc),
        0
      )
    ).toBeNull();
  });
});
