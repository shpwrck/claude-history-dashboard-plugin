import { describe, it, expect } from 'vitest';
import { detector } from './discovery-freshness';
import { detector as staleStateAssertion } from './stale-state-assertion';
import { validateRecommendationProvenance } from '../provenance';
import { validateFixSnippet, effectiveFixKind } from '../fix-validity';
import type { RecommendationInput } from '../types';
import type { ToolCall, ToolUsageData } from '../../parse-tools';
import type { LiveConfig } from '../../../types';

const T0 = Date.parse('2026-06-10T00:00:00Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW_FRESH = T0 + 10 * MIN; // within the freshness window → present tense
const NOW_STALE = T0 + 60 * DAY; // well past the 28-day window → demoted

const SHA = 'abc1234567890def';
const ABS = (rel: string) => `/repo/${rel}`;
const TRACKED = ['src/lib/reclaim.ts', 'src/lib/foo.ts', 'src/lib/bar.ts', 'src/lib/baz.ts'];

let seq = 0;
function call(ms: number, toolName: string, input: Record<string, unknown>): ToolCall {
  return {
    timestamp: iso(ms),
    toolName,
    input,
    toolUseId: `t${seq++}`,
    isError: null,
    resultBytes: 0,
  } as unknown as ToolCall;
}
const read = (ms: number, path: string) => call(ms, 'Read', { file_path: path });
const edit = (ms: number, path: string) => call(ms, 'Edit', { file_path: path });
const bash = (ms: number, command: string) => call(ms, 'Bash', { command });
const session = (sessionId: string, calls: ToolCall[]): ToolUsageData => ({ sessionId, calls });

function dataset(
  paths: string[] = TRACKED,
  sha: string | null = SHA
): RecommendationInput['repoMap'] {
  return {
    projects: [
      {
        root: '/repo',
        generatedAtGitSha: sha,
        fileCount: paths.length,
        truncated: false,
        text: '',
        files: paths.map((path) => ({
          path,
          symbols: [],
          imports: [],
          configSections: [],
          recommendations: [],
        })),
        configSections: [],
        configAttribution: [],
      },
    ],
  } as unknown as RecommendationInput['repoMap'];
}

function input(
  toolData?: ToolUsageData[],
  repoMap: RecommendationInput['repoMap'] = dataset(),
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
    repoMap,
  };
}

function liveConfigClaudeMd(global: string): LiveConfig {
  return { claudeMd: { global, perProject: {} } } as unknown as LiveConfig;
}

/** Read a tracked file, a git op moves the tree, then edit it with no re-read. */
function staleChain(id: string, rel = 'src/lib/reclaim.ts'): ToolUsageData {
  return session(id, [read(1000, ABS(rel)), bash(2000, 'git pull --rebase'), edit(3000, ABS(rel))]);
}

describe('reliability.discovery-freshness — guards', () => {
  it('returns null when toolData is absent or empty', () => {
    expect(detector.rule(input(), NOW_FRESH)).toBeNull();
    expect(detector.rule(input([]), NOW_FRESH)).toBeNull();
  });

  it('returns null when repoMap is null (substrate off)', () => {
    const td = [staleChain('a'), staleChain('b'), staleChain('c')];
    expect(detector.rule(input(td, null), NOW_FRESH)).toBeNull();
  });

  it('returns null when repoMap.projects is empty', () => {
    const td = [staleChain('a'), staleChain('b'), staleChain('c')];
    const empty = { projects: [] } as unknown as RecommendationInput['repoMap'];
    expect(detector.rule(input(td, empty), NOW_FRESH)).toBeNull();
  });

  it('returns null when generatedAtGitSha is null (no anchor)', () => {
    const td = [staleChain('a'), staleChain('b'), staleChain('c')];
    expect(detector.rule(input(td, dataset(TRACKED, null)), NOW_FRESH)).toBeNull();
  });

  it('stays silent below the 3-stale floor', () => {
    expect(detector.rule(input([staleChain('a'), staleChain('b')]), NOW_FRESH)).toBeNull();
  });
});

describe('reliability.discovery-freshness — fires', () => {
  it('fires at 3 read→tree-move→edit chains on repo-mapped paths', () => {
    const rec = detector.rule(
      input([staleChain('a'), staleChain('b'), staleChain('c')]),
      NOW_FRESH
    );
    expect(rec).not.toBeNull();
    expect(rec?.id).toBe('reliability.discovery-freshness');
    expect(rec?.category).toBe('reliability');
    expect(rec?.affected).toBe(3);
    expect(rec?.severity).toBe('info');
    expect(rec?.view).toBe('tools');
    expect(rec?.claimClass).toBe('causal');
    expect(rec?.proofTier).toBe('observational');
    expect(rec?.action).toContain('re-read');
    expect(rec!.evidence![0]).toContain('moved the tree');
    // a causal/observational hypothesis carries no dollar claim
    expect(rec?.estSavingsUsd).toBeUndefined();
  });

  it('escalates info→warning when one session repeats the pattern', () => {
    const heavy = session('heavy', [
      read(1000, ABS('src/lib/reclaim.ts')),
      read(1100, ABS('src/lib/foo.ts')),
      read(1200, ABS('src/lib/bar.ts')),
      read(1300, ABS('src/lib/baz.ts')),
      bash(2000, 'git pull'),
      edit(3000, ABS('src/lib/reclaim.ts')),
      edit(3100, ABS('src/lib/foo.ts')),
      edit(3200, ABS('src/lib/bar.ts')),
      edit(3300, ABS('src/lib/baz.ts')),
    ]);
    const rec = detector.rule(input([heavy]), NOW_FRESH);
    expect(rec?.affected).toBe(4);
    expect(rec?.severity).toBe('warning');
  });

  it('recognises other tree-movers (checkout / rebase / stash / restore)', () => {
    const chain = (id: string, cmd: string) =>
      session(id, [read(1000, ABS('src/lib/reclaim.ts')), bash(2000, cmd), edit(3000, ABS('src/lib/reclaim.ts'))]);
    const rec = detector.rule(
      input([
        chain('a', 'git checkout main'),
        chain('b', 'git rebase origin/master'),
        chain('c', 'git stash pop'),
        chain('d', 'git restore src/lib/reclaim.ts'),
      ]),
      NOW_FRESH
    );
    expect(rec?.affected).toBe(4);
  });
});

describe('reliability.discovery-freshness — false-positive guards', () => {
  it('does NOT flag a plain read→edit with no intervening tree-move', () => {
    const plain = (id: string) =>
      session(id, [read(1000, ABS('src/lib/reclaim.ts')), edit(3000, ABS('src/lib/reclaim.ts'))]);
    expect(detector.rule(input([plain('a'), plain('b'), plain('c')]), NOW_FRESH)).toBeNull();
  });

  it('does NOT count a read of a non-repo-mapped path', () => {
    const chain = (id: string) =>
      session(id, [read(1000, ABS('scratch/untracked.ts')), bash(2000, 'git pull'), edit(3000, ABS('scratch/untracked.ts'))]);
    expect(detector.rule(input([chain('a'), chain('b'), chain('c')]), NOW_FRESH)).toBeNull();
  });

  it('does NOT count a read with no subsequent edit', () => {
    const chain = (id: string) => session(id, [read(1000, ABS('src/lib/reclaim.ts')), bash(2000, 'git pull')]);
    expect(detector.rule(input([chain('a'), chain('b'), chain('c')]), NOW_FRESH)).toBeNull();
  });

  it('stays silent when a re-Read intervenes after the tree move', () => {
    const reread = (id: string) =>
      session(id, [
        read(1000, ABS('src/lib/reclaim.ts')),
        bash(2000, 'git pull'),
        read(2500, ABS('src/lib/reclaim.ts')), // refreshes before the edit
        edit(3000, ABS('src/lib/reclaim.ts')),
      ]);
    expect(detector.rule(input([reread('a'), reread('b'), reread('c')]), NOW_FRESH)).toBeNull();
  });

  it('excludes Bash/git reads entirely (a git-ref read never contributes)', () => {
    const bashOnly = (id: string) => session(id, [bash(1000, 'git log origin/master --oneline -5')]);
    expect(detector.rule(input([bashOnly('a'), bashOnly('b'), bashOnly('c')]), NOW_FRESH)).toBeNull();
  });
});

describe('reliability.discovery-freshness — Codex-review hardening (#2335)', () => {
  const twoRepos = () =>
    ({
      projects: [
        {
          root: '/repoA',
          generatedAtGitSha: 'aaa111',
          fileCount: 1,
          truncated: false,
          text: '',
          files: [{ path: 'a.ts', symbols: [], imports: [], configSections: [], recommendations: [] }],
          configSections: [],
          configAttribution: [],
        },
        {
          root: '/repoB',
          generatedAtGitSha: 'bbb222',
          fileCount: 1,
          truncated: false,
          text: '',
          files: [{ path: 'b.ts', symbols: [], imports: [], configSections: [], recommendations: [] }],
          configSections: [],
          configAttribution: [],
        },
      ],
    }) as unknown as RecommendationInput['repoMap'];

  it('does NOT invalidate a read when a git op targets a DIFFERENT repo (-C)', () => {
    // repoA read+edit; the only tree-move is `git -C /repoB pull` → repoA stays fresh.
    const chain = (id: string) =>
      session(id, [read(1000, '/repoA/a.ts'), bash(2000, 'git -C /repoB pull'), edit(3000, '/repoA/a.ts')]);
    expect(detector.rule(input([chain('a'), chain('b'), chain('c')], twoRepos()), NOW_FRESH)).toBeNull();
    // …but a cwd-relative `git pull` cannot be attributed, so it conservatively invalidates.
    const bare = (id: string) =>
      session(id, [read(1000, '/repoA/a.ts'), bash(2000, 'git pull'), edit(3000, '/repoA/a.ts')]);
    expect(detector.rule(input([bare('a'), bare('b'), bare('c')], twoRepos()), NOW_FRESH)?.affected).toBe(3);
  });

  it('does NOT advance the epoch on read-only / index-only git variants', () => {
    const chain = (id: string, cmd: string) =>
      session(id, [read(1000, ABS('src/lib/reclaim.ts')), bash(2000, cmd), edit(3000, ABS('src/lib/reclaim.ts'))]);
    // stash list, soft reset, staged-only restore leave the working tree untouched.
    expect(
      detector.rule(
        input([
          chain('a', 'git stash list'),
          chain('b', 'git reset --soft HEAD~1'),
          chain('c', 'git restore --staged src/lib/reclaim.ts'),
        ]),
        NOW_FRESH
      )
    ).toBeNull();
    // …but their mutating siblings DO advance the epoch.
    expect(
      detector.rule(
        input([
          chain('a', 'git reset --hard HEAD~1'),
          chain('b', 'git stash pop'),
          chain('c', 'git restore src/lib/reclaim.ts'),
        ]),
        NOW_FRESH
      )?.affected
    ).toBe(3);
  });

  it('does NOT split quoted shell text as commands (git verb in a commit message)', () => {
    const chain = (id: string) =>
      session(id, [
        read(1000, ABS('src/lib/reclaim.ts')),
        bash(2000, 'git commit -m "note; git checkout main"'),
        edit(3000, ABS('src/lib/reclaim.ts')),
      ]);
    expect(detector.rule(input([chain('a'), chain('b'), chain('c')]), NOW_FRESH)).toBeNull();
  });

  it('does NOT treat branch creation (checkout -b / switch -c, no start point) as a tree move', () => {
    const chain = (id: string, cmd: string) =>
      session(id, [read(1000, ABS('src/lib/reclaim.ts')), bash(2000, cmd), edit(3000, ABS('src/lib/reclaim.ts'))]);
    expect(
      detector.rule(
        input([
          chain('a', 'git checkout -b feature'),
          chain('b', 'git switch -c wip'),
          chain('c', 'git checkout -b hotfix'),
        ]),
        NOW_FRESH
      )
    ).toBeNull();
    // …but `checkout -b <name> <start-point>` DOES move the working tree.
    expect(
      detector.rule(
        input([
          chain('a', 'git checkout -b feature origin/main'),
          chain('b', 'git checkout -b x origin/main'),
          chain('c', 'git checkout -b y origin/main'),
        ]),
        NOW_FRESH
      )?.affected
    ).toBe(3);
  });

  it('honors a `cd <dir>` anchor when attributing a bare git mover', () => {
    const chain = (id: string) =>
      session(id, [read(1000, '/repoA/a.ts'), bash(2000, 'cd /repoB && git pull'), edit(3000, '/repoA/a.ts')]);
    expect(detector.rule(input([chain('a'), chain('b'), chain('c')], twoRepos()), NOW_FRESH)).toBeNull();
  });

  it('matches global options before the subcommand (`git -c x=y pull`)', () => {
    const chain = (id: string) =>
      session(id, [
        read(1000, ABS('src/lib/reclaim.ts')),
        bash(2000, 'git -c protocol.version=2 pull'),
        edit(3000, ABS('src/lib/reclaim.ts')),
      ]);
    expect(detector.rule(input([chain('a'), chain('b'), chain('c')]), NOW_FRESH)?.affected).toBe(3);
  });

  it('picks the nearest root for a nested `-C` target', () => {
    const nested = {
      projects: [
        {
          root: '/repo',
          generatedAtGitSha: 'p',
          fileCount: 1,
          truncated: false,
          text: '',
          files: [{ path: 'top.ts', symbols: [], imports: [], configSections: [], recommendations: [] }],
          configSections: [],
          configAttribution: [],
        },
        {
          root: '/repo/sub',
          generatedAtGitSha: 's',
          fileCount: 1,
          truncated: false,
          text: '',
          files: [{ path: 'x.ts', symbols: [], imports: [], configSections: [], recommendations: [] }],
          configSections: [],
          configAttribution: [],
        },
      ],
    } as unknown as RecommendationInput['repoMap'];
    const chain = (id: string) =>
      session(id, [read(1000, '/repo/sub/x.ts'), bash(2000, 'git -C /repo/sub pull'), edit(3000, '/repo/sub/x.ts')]);
    expect(detector.rule(input([chain('a'), chain('b'), chain('c')], nested), NOW_FRESH)?.affected).toBe(3);
  });

  it('matches a repo-relative tool path against the map keys', () => {
    const chain = (id: string) =>
      session(id, [read(1000, 'src/lib/reclaim.ts'), bash(2000, 'git pull'), edit(3000, 'src/lib/reclaim.ts')]);
    expect(detector.rule(input([chain('a'), chain('b'), chain('c')]), NOW_FRESH)?.affected).toBe(3);
  });
});

describe('reliability.discovery-freshness — stale-data demotion', () => {
  it('demotes present-tense wording to "as of <date>" when the activity is old', () => {
    const rec = detector.rule(
      input([staleChain('a'), staleChain('b'), staleChain('c')]),
      NOW_STALE
    );
    expect(rec).not.toBeNull();
    expect(rec?.provenance?.stale).toBe(true);
    expect(rec?.provenance?.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rec?.detail.startsWith(`As of ${rec?.provenance?.asOf}, `)).toBe(true);
    expect(rec?.title).toContain('historical');
    expect(rec?.severity).toBe('info');
  });

  it('keeps present-tense wording when the activity is recent', () => {
    const rec = detector.rule(
      input([staleChain('a'), staleChain('b'), staleChain('c')]),
      NOW_FRESH
    );
    expect(rec?.provenance?.stale).toBe(false);
    expect(rec?.detail.startsWith('As of ')).toBe(false);
  });
});

describe('reliability.discovery-freshness — auditability', () => {
  const fired = () =>
    detector.rule(input([staleChain('a'), staleChain('b'), staleChain('c')]), NOW_FRESH)!;

  it('carries valid provenance citing parse-tools', () => {
    const rec = fired();
    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.provenance!.observations[0].source).toBe('parse-tools');
    expect(rec.provenance!.inference).toBeTruthy();
  });

  it('ships an illustrative (non-validated) fix snippet', () => {
    const rec = fired();
    expect(rec.fix).toBeDefined();
    expect(effectiveFixKind(rec.fix!)).toBe('illustrative');
    expect(validateFixSnippet(rec.fix!)).toEqual([]);
    // the appliedMarkers body phrase appears verbatim in the snippet
    expect(rec.fix!.snippet).toContain('re-read the target after the ref moves before acting');
  });

  it('self-suppresses once the read-freshness rule is in CLAUDE.md', () => {
    const rec = fired();
    const lc = liveConfigClaudeMd(rec.fix!.snippet);
    expect(
      detector.rule(input([staleChain('a'), staleChain('b'), staleChain('c')], dataset(), lc), NOW_FRESH)
    ).toBeNull();
  });
});

describe('reliability.discovery-freshness — partition with #1871 (no double-fire)', () => {
  it('never both fires on the same events (disjoint on toolName)', () => {
    // Bash-only git-ref reads → #1871 fires, discovery-freshness silent.
    const bashOnly = (id: string) => session(id, [bash(1000, 'git log origin/master --oneline -5')]);
    const refInput = input([bashOnly('x'), bashOnly('y'), bashOnly('z')]);
    expect(staleStateAssertion.rule(refInput, NOW_FRESH)).not.toBeNull();
    expect(detector.rule(refInput, NOW_FRESH)).toBeNull();

    // read→tree-move→edit chains → discovery-freshness fires, #1871 silent
    // (a `git pull` is a fetch, not an un-fetched integration-ref read).
    const chainInput = input([staleChain('a'), staleChain('b'), staleChain('c')]);
    expect(detector.rule(chainInput, NOW_FRESH)).not.toBeNull();
    expect(staleStateAssertion.rule(chainInput, NOW_FRESH)).toBeNull();
  });
});
