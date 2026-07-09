import { describe, it, expect } from 'vitest';
import { detector } from './cwd-drift-execution';
import { validateRecommendationProvenance } from '../provenance';
import { validateFixSnippet, effectiveFixKind } from '../fix-validity';
import type { RecommendationInput } from '../types';
import type { ToolCall, ToolUsageData } from '../../parse-tools';
import type { LiveConfig } from '../../../types';

let seq = 0;
function bash(command: string): ToolCall {
  return {
    timestamp: '2026-06-10T00:00:00Z',
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

/** LiveConfig with a controllable cwd-anchor-guard PreToolUse hook present. */
function liveConfigWithGuard(guardConfigured: boolean): LiveConfig {
  return {
    settings: guardConfigured
      ? {
          hooks: {
            PreToolUse: [
              { matcher: 'Bash', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/cwd-anchor-guard.mjs' }] },
            ],
          },
        }
      : { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/some-other-guard.mjs' }] }] } },
  } as unknown as LiveConfig;
}

/** One session whose single command is an unanchored git/gh op. */
function driftSession(id: string, command = 'git log origin/master --oneline -5'): ToolUsageData {
  return session(id, [bash(command)]);
}

describe('reliability.cwd-drift-execution — guards', () => {
  it('returns null when toolData is absent or empty', () => {
    expect(detector.rule(input(), 0)).toBeNull();
    expect(detector.rule(input([]), 0)).toBeNull();
  });

  it('stays silent below the 3-op floor', () => {
    expect(detector.rule(input([driftSession('a'), driftSession('b')]), 0)).toBeNull();
  });

  it('ignores a session with no Bash calls', () => {
    const noBash = session('x', [
      { ...bash('git status'), toolName: 'Read', input: { file_path: 'a.ts' } },
    ]);
    expect(detector.rule(input([noBash]), 0)).toBeNull();
  });
});

describe('reliability.cwd-drift-execution — firing', () => {
  it('fires at the 3-op floor across sessions', () => {
    const rec = detector.rule(
      input([driftSession('a'), driftSession('b'), driftSession('c')]),
      0
    );
    expect(rec).not.toBeNull();
    expect(rec!.id).toBe('reliability.cwd-drift-execution');
    expect(rec!.category).toBe('reliability');
    expect(rec!.affected).toBe(3);
    expect(rec!.severity).toBe('info');
  });

  it('counts both git and gh unanchored ops', () => {
    const rec = detector.rule(
      input([
        driftSession('a', 'git push'),
        driftSession('b', 'gh pr view 42'),
        driftSession('c', 'gh issue list'),
      ]),
      0
    );
    expect(rec!.affected).toBe(3);
  });

  it('escalates to warning when one session has >= 10 unanchored ops', () => {
    const many = session(
      'hot',
      Array.from({ length: 10 }, () => bash('git status'))
    );
    const rec = detector.rule(input([many]), 0);
    expect(rec!.severity).toBe('warning');
    expect(rec!.affected).toBe(10);
  });
});

describe('reliability.cwd-drift-execution — anchoring excludes ops', () => {
  it('does not count `git -C <dir>` (per-op anchor)', () => {
    const anchored = session('a', [
      bash('git -C /repo log origin/master'),
      bash('git -C /repo status'),
      bash('git -C /repo push'),
    ]);
    expect(detector.rule(input([anchored]), 0)).toBeNull();
  });

  it('does not count a `cd <dir> && git ...` compound (cd carries forward)', () => {
    const anchored = session('a', [
      bash('cd /repo && git log origin/master'),
      bash('cd /repo && git status && git push'),
      bash('cd /repo && gh pr view'),
    ]);
    expect(detector.rule(input([anchored]), 0)).toBeNull();
  });

  it('does not count `gh -R owner/repo` / `GH_REPO=` (explicit repo)', () => {
    const anchored = session('a', [
      bash('gh -R o/r pr view 1'),
      bash('gh --repo o/r issue list'),
      bash('GH_REPO=o/r gh pr list'),
    ]);
    expect(detector.rule(input([anchored]), 0)).toBeNull();
  });
});

describe('reliability.cwd-drift-execution — server dataset (commandPreview)', () => {
  // The server strips raw `input.command` and ships a redacted `commandPreview`.
  // The detector must read it via the `input.command ?? commandPreview` fallback.
  function previewCall(preview: string): ToolCall {
    return {
      timestamp: '2026-06-10T00:00:00Z',
      toolName: 'Bash',
      input: {},
      toolUseId: `p${seq++}`,
      isError: false,
      resultBytes: 0,
      commandPreview: preview,
    } as ToolCall;
  }

  it('counts unanchored git/gh from commandPreview when input.command is stripped', () => {
    const rec = detector.rule(
      input([
        session('a', [previewCall('gh issue view 161')]),
        session('b', [previewCall('git status 2>&1 && git diff --stat')]),
        session('c', [previewCall('git push -u origin feature/x')]),
      ]),
      0
    );
    expect(rec).not.toBeNull();
    // session b has two unanchored git segments (status, diff) → 4 total.
    expect(rec!.affected).toBe(4);
  });

  it('still honours anchors carried in the preview head', () => {
    const rec = detector.rule(
      input([
        session('a', [previewCall('git -C /repo status')]),
        session('b', [previewCall('cd /repo && git push')]),
        session('c', [previewCall('gh -R o/r pr view 1')]),
      ]),
      0
    );
    expect(rec).toBeNull();
  });
});

describe('reliability.cwd-drift-execution — scoping', () => {
  it('excludes build families (npm/npx/vite/vitest/podman)', () => {
    const builds = session('a', [
      bash('npm run build'),
      bash('npx vite build'),
      bash('vitest run'),
      bash('podman compose up -d'),
    ]);
    expect(detector.rule(input([builds]), 0)).toBeNull();
  });

  it('does not flag git/gh mentioned inside quoted argument text', () => {
    // A commit message / PR body that merely mentions an unanchored command is
    // data, not a flagged command — segmentation is quote-aware.
    const quoted = session('a', [
      bash('git -C /r commit -m "remember to git push and gh pr view next time"'),
      bash('git -C /r commit -m "do not run git status here"'),
      bash('git -C /r commit -m "avoid bare gh pr merge"'),
    ]);
    expect(detector.rule(input([quoted]), 0)).toBeNull();
  });

  it('does not flag git/gh inside a heredoc body', () => {
    const heredoc = session('a', [
      bash("gh -R o/r pr create --body-file - <<'EOF'\ngit push\ngh pr merge\ngit status\nEOF"),
      bash("gh -R o/r pr create --body-file - <<'EOF'\ngit log origin/master\nEOF"),
      bash("gh -R o/r pr create --body-file - <<'EOF'\ngit commit\nEOF"),
    ]);
    expect(detector.rule(input([heredoc]), 0)).toBeNull();
  });

  it('ignores non-git/gh commands (echo, grep mentioning git)', () => {
    const benign = session('a', [
      bash('echo "git push"'),
      bash('grep -r "git log" .'),
      bash('ls -la'),
    ]);
    expect(detector.rule(input([benign]), 0)).toBeNull();
  });
});

describe('reliability.cwd-drift-execution — suppression', () => {
  const threeDrift = () => [driftSession('a'), driftSession('b'), driftSession('c')];

  it('is suppressed when CLAUDE.md already carries the anchoring rule', () => {
    const md =
      '## Anchor repo commands to the project directory\n\n' +
      'An unanchored git/gh command run from a drifted cwd ' +
      'silently targets the wrong repository.';
    const rec = detector.rule(input(threeDrift(), liveConfigClaudeMd(md)), 0);
    expect(rec).toBeNull();
  });

  it('is suppressed by a semantically-equivalent user-authored anchoring rule (#2013)', () => {
    // Different heading + wording from the canned snippet (real AGENTS.md form):
    // "Worktrees & Branches" + "anchor EVERY git and gh command" + "WRONG repository".
    const md =
      '## Worktrees & Branches\n\n' +
      'Never rely on the ambient shell cwd — anchor EVERY `git` and `gh` command on ' +
      'the first attempt, because an unanchored command may silently read or write ' +
      'the WRONG repository.';
    const rec = detector.rule(input(threeDrift(), liveConfigClaudeMd(md)), 0);
    expect(rec).toBeNull();
  });

  it('does NOT suppress on a passing mention of "anchor" without the wrong-repo phrase (conservative)', () => {
    // Bias is toward NOT suppressing a real finding: "anchor" alone is insufficient.
    const md =
      '## Worktrees & Branches\n\n' +
      'Use git worktrees to anchor a feature branch in its own directory.';
    const rec = detector.rule(input(threeDrift(), liveConfigClaudeMd(md)), 0);
    expect(rec).not.toBeNull();
    expect(rec!.severity).toBe('info'); // still present-tense (no guard hook either)
  });
});

// ── Hook-aware historical demotion (#2013, mirroring hook-errors #1102) ──────
describe('reliability.cwd-drift-execution — historical demotion', () => {
  const threeDrift = () => [driftSession('a'), driftSession('b'), driftSession('c')];

  it('demotes to info + historical wording when a cwd-anchor-guard hook is configured now', () => {
    const rec = detector.rule(input(threeDrift(), liveConfigWithGuard(true)), 0);
    expect(rec).not.toBeNull();
    expect(rec!.severity).toBe('info');
    expect(rec!.title).toContain('configured now');
    expect(rec!.detail).toContain('historical');
    expect(rec!.detail).toContain('now configured');
    // The present-tense claim is gone.
    expect(rec!.detail).not.toContain('silently targets the wrong repository');
  });

  it('demotes a would-be WARNING (>=10 in one session) to info when the guard is configured', () => {
    const many = session('hot', Array.from({ length: 10 }, () => bash('git status')));
    const rec = detector.rule(input([many], liveConfigWithGuard(true)), 0);
    expect(rec!.severity).toBe('info');
    expect(rec!.title).toContain('configured now');
  });

  it('keeps present-tense WARNING when history is hot but NO guard hook is configured', () => {
    const many = session('hot', Array.from({ length: 10 }, () => bash('git status')));
    const rec = detector.rule(input([many], liveConfigWithGuard(false)), 0);
    expect(rec!.severity).toBe('warning');
    expect(rec!.title).toBe('git/gh commands run unanchored to the project directory');
    expect(rec!.detail).toContain('silently targets the wrong repository');
  });

  it('keeps present-tense (info) when readable config has NO guard hook and NO CLAUDE.md marker', () => {
    const rec = detector.rule(input(threeDrift(), liveConfigWithGuard(false)), 0);
    expect(rec!.severity).toBe('info');
    expect(rec!.title).toBe('git/gh commands run unanchored to the project directory');
    expect(rec!.detail).toContain('silently targets the wrong repository');
  });

  it('keeps present-tense WARNING/info when liveConfig is null (can-not-tell)', () => {
    const rec = detector.rule(input(threeDrift(), null), 0);
    expect(rec!.severity).toBe('info');
    expect(rec!.title).toBe('git/gh commands run unanchored to the project directory');
    expect(rec!.detail).toContain('silently targets the wrong repository');
  });

  it('cites the cwd-anchor guard observation in provenance', () => {
    const rec = detector.rule(input(threeDrift(), liveConfigWithGuard(true)), 0)!;
    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.provenance!.observations.map((o) => o.source)).toEqual(
      expect.arrayContaining(['parse-tools', 'settings.json'])
    );
    expect(
      rec.provenance!.observations.some((o) => o.field === 'hooks.PreToolUse')
    ).toBe(true);
  });
});

describe('reliability.cwd-drift-execution — evidence ordering', () => {
  function driftN(id: string, n: number): ToolUsageData {
    return session(id, Array.from({ length: n }, () => bash('git status')));
  }

  it('caps evidence at the top 5 sessions by count, earlier session winning ties', () => {
    // Six drifting sessions: one hot session (3 ops) arrives mid-stream among
    // five sessions tied at 2 ops. The streaming top-K insert must reproduce
    // the old stable sort-desc-by-count: hot first, then the tied sessions in
    // their original toolData order, with the sixth (tied) session cut.
    const rec = detector.rule(
      input([
        driftN('sess-aaa', 2),
        driftN('sess-bbb', 2),
        driftN('sess-hot', 3),
        driftN('sess-ccc', 2),
        driftN('sess-ddd', 2),
        driftN('sess-eee', 2),
      ]),
      0
    );
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(13);
    expect(rec!.evidence).toHaveLength(5);
    expect(rec!.evidence!.map((line) => line.split(':')[0])).toEqual([
      'sess-hot',
      'sess-aaa',
      'sess-bbb',
      'sess-ccc',
      'sess-ddd',
    ]);
  });
});

describe('reliability.cwd-drift-execution — contract', () => {
  const rec = detector.rule(
    input([driftSession('a'), driftSession('b'), driftSession('c')]),
    0
  )!;

  it('carries valid provenance with cited observations', () => {
    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.provenance!.observations.length).toBeGreaterThan(0);
    expect(rec.provenance!.observations[0].source).toBe('parse-tools');
  });

  it('ships a copy-paste-safe validated fix snippet', () => {
    expect(effectiveFixKind(rec.fix!)).toBe('validated');
    expect(validateFixSnippet(rec.fix!)).toEqual([]);
    expect(rec.fix!.target).toBe('CLAUDE.md');
  });

  it('emits structured evidence rows', () => {
    expect(rec.evidence!.length).toBeGreaterThan(0);
    expect(rec.evidence![0]).toContain('unanchored');
  });
});
