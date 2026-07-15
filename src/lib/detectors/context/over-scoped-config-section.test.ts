import { describe, it, expect } from 'vitest';
import type { LiveConfig, LiveSettings } from '../../../types';
import { buildRecommendations } from '../../recommendations';
import type { RecommendationInput } from '../types';
import type { ConfigSection } from '../../parse-config-sections';
import type {
  RepoMapDataset,
  RepoMapFileJoin,
  RepoMapProjectJoin,
} from '../../parse-repo-map-join';
import { parseShadowCalls } from '../../parse-shadow-calls';
import type { ShadowCallAggregate } from '../../parse-shadow-calls';
import { validateRecommendationProvenance } from '../provenance';
import { validateFixSnippet } from '../fix-validity';
import { detector } from './over-scoped-config-section';

const section = (over: Partial<ConfigSection> & { id: string; heading: string }): ConfigSection => ({
  sourceScope: 'AGENTS.md',
  level: 2,
  mtime: null,
  hash: 'hash',
  references: [],
  ...over,
});

const file = (
  path: string,
  configSections: string[]
): RepoMapFileJoin => ({
  path,
  symbols: [],
  imports: [],
  configSections,
  recommendations: [],
});

const project = (
  configSections: ConfigSection[],
  files: RepoMapFileJoin[],
  root = '/repo'
): RepoMapProjectJoin => ({
  root,
  generatedAtGitSha: 'abc123',
  fileCount: files.length,
  truncated: false,
  text: '(map)',
  files,
  configSections,
  configAttribution: [],
});

const dataset = (...projects: RepoMapProjectJoin[]): RepoMapDataset => ({ projects });

const input = (
  repoMap: RepoMapDataset | null | undefined,
  shadowCalls?: ShadowCallAggregate,
  liveConfig: LiveConfig | null = null
): RecommendationInput => ({
  tokenData: [],
  toolData: [],
  sessions: [],
  projects: [],
  permissionRows: [],
  apiErrors: [],
  liveConfig,
  repoMap,
  shadowCalls,
});

const hookSettings = (
  event: string,
  command: string,
  commandPath?: string
): LiveSettings => ({
  hooks: {
    [event]: [
      {
        hooks: [
          {
            type: 'command',
            command,
            ...(commandPath === undefined
              ? {}
              : { referencedPaths: [{ path: commandPath, exists: true }] }),
          },
        ],
      },
    ],
  },
});

const liveConfig = (
  settings: LiveSettings = {},
  projectSettings: Record<string, LiveSettings> = {}
): LiveConfig => ({
  settings,
  projectSettings,
  claudeMd: { global: null, perProject: {} },
  plugins: [],
  mcpServers: [],
  skills: [],
  subagents: [],
  commands: [],
});

const companionSection = (
  event = 'PreToolUse',
  commandPath = 'hooks/workflow-window-guard.mjs',
  sourceScope = 'AGENTS.md'
) =>
  section({
    id: `${sourceScope}#workflow-window-guard`,
    sourceScope,
    heading: 'Workflows must fit the session window',
    references: [
      { kind: 'configKey', target: `hooks.${event}` },
      { kind: 'file', target: commandPath },
    ],
  });

const overScopedRecs = (i: RecommendationInput) =>
  buildRecommendations(i).filter((rec) =>
    rec.id.startsWith('context.over-scoped-config-section')
  );

describe('context.over-scoped-config-section (#1267)', () => {
  it('emits one advisory recommendation per root section scoped to one subtree', () => {
    const api = section({
      id: 'AGENTS.md#spa-server-boundary',
      heading: 'SPA server boundary',
    });
    const ui = section({
      id: 'CLAUDE.md#session-ui',
      sourceScope: 'CLAUDE.md',
      heading: 'Session UI rules',
    });
    const recs = overScopedRecs(
      input(
        dataset(
          project(
            [api, ui],
            [
              file('src/lib/api-client.ts', [api.id]),
              file('src/lib/api-client.test.ts', [api.id]),
              file('src/components/SessionList.tsx', [ui.id]),
            ]
          )
        )
      )
    );

    expect(recs).toHaveLength(2);
    expect(new Set(recs.map((rec) => rec.id)).size).toBe(2);
    expect(recs.map((rec) => rec.severity)).toEqual(['info', 'info']);

    const apiRec = recs.find((rec) => rec.title.includes('SPA server boundary'))!;
    expect(apiRec.title).toContain('src/lib');
    expect(apiRec.detail).toContain('SPA server boundary');
    expect(apiRec.detail).toContain('src/lib');
    expect(apiRec.action).toContain('paths: ["src/lib/**"]');
    expect(apiRec.evidence?.[0]).toContain('AGENTS.md#spa-server-boundary');
    expect(apiRec.fix?.target).toBe('CLAUDE.md');
    expect(apiRec.fix?.fixKind).toBe('illustrative');
    expect(apiRec.fix?.snippet).toContain('paths: ["src/lib/**"]');
    expect(apiRec.fix?.snippet).toContain('.claude/rules/spa-server-boundary.md');
    expect(apiRec.savingsAttribution?.tier).toBe('tier-0-estimate');
    expect(validateRecommendationProvenance(apiRec)).toEqual([]);
  });

  it('keeps the compatibility rule path on the base detector id', () => {
    const api = section({
      id: 'AGENTS.md#spa-server-boundary',
      heading: 'SPA server boundary',
    });
    const rec = detector.rule(
      input(
        dataset(project([api], [file('src/lib/api-client.ts', [api.id])])),
        undefined,
        liveConfig()
      ),
      0
    );

    expect(rec?.id).toBe('context.over-scoped-config-section');
    expect(rec?.action).toContain('.claude/rules/spa-server-boundary.md');
    expect(rec?.severity).toBe('info');
    expect(rec?.savingsAttribution?.tier).toBe('tier-0-estimate');
    expect(rec?.provenance?.observations.some((o) => o.source === 'liveConfig')).toBe(
      true
    );
  });

  it('suppresses an exact global event-and-command companion', () => {
    const guard = companionSection(
      'PreToolUse',
      'hooks/workflow-window-guard.mjs',
      'CLAUDE.md'
    );
    const detectorInput = input(
      dataset(
        project(
          [guard],
          [file('hooks/workflow-window-guard.mjs', [guard.id])],
          '/home/alice/.claude'
        )
      ),
      undefined,
      liveConfig(
        hookSettings(
          'PreToolUse',
          'node "$HOME/.claude/hooks/workflow-window-guard.mjs"',
          '$HOME/.claude/hooks/workflow-window-guard.mjs'
        )
      )
    );
    const recs = overScopedRecs(detectorInput);

    expect(recs).toHaveLength(0);
    expect(detector.rule(detectorInput, 0)).toBeNull();
  });

  it('preserves shell expansion provenance for symbolic hook paths', () => {
    const guard = companionSection('PreToolUse', 'hooks/foo.mjs', 'CLAUDE.md');
    const repoMap = dataset(
      project(
        [guard],
        [file('hooks/foo.mjs', [guard.id])],
        '/home/alice/.claude'
      )
    );
    const expandableCommands = [
      'node "$HOME/.claude/hooks/foo.mjs"',
      'node "${HOME}"/.claude/hooks/foo.mjs',
      'node "$HOME"/.claude/hooks/foo.mjs',
      'node ~/.claude/hooks/foo.mjs',
    ];
    const literalCommands = [
      "node '$HOME/.claude/hooks/foo.mjs'",
      'node \\$HOME/.claude/hooks/foo.mjs',
      'node "\\$HOME/.claude/hooks/foo.mjs"',
      'node "$""HOME/.claude/hooks/foo.mjs"',
      'node "~/.claude/hooks/foo.mjs"',
      "node '~/.claude/hooks/foo.mjs'",
      'node \\~/.claude/hooks/foo.mjs',
    ];

    for (const command of expandableCommands) {
      expect(
        overScopedRecs(
          input(repoMap, undefined, liveConfig(hookSettings('PreToolUse', command)))
        ),
        command
      ).toHaveLength(0);
    }
    for (const command of literalCommands) {
      expect(
        overScopedRecs(
          input(repoMap, undefined, liveConfig(hookSettings('PreToolUse', command)))
        ),
        command
      ).toHaveLength(1);
    }
  });

  it('expands tilde only at the lexical start of direct, env, and guarded words', () => {
    const guard = companionSection('PreToolUse', 'hooks/foo.mjs', 'CLAUDE.md');
    const repoMap = dataset(
      project(
        [guard],
        [file('hooks/foo.mjs', [guard.id])],
        '/home/alice/.claude'
      )
    );
    const commandForms = (path: string) => [
      'node ' + path,
      'env node ' + path,
      '[ -f ' + path + ' ] || exit 0; bash ' + path,
    ];

    for (const path of [
      '""~/.claude/hooks/foo.mjs',
      "''~/.claude/hooks/foo.mjs",
    ]) {
      for (const command of commandForms(path)) {
        expect(
          overScopedRecs(
            input(repoMap, undefined, liveConfig(hookSettings('PreToolUse', command)))
          ),
          command
        ).toHaveLength(1);
      }
    }

    for (const command of commandForms('~/.claude/hooks/foo.mjs')) {
      expect(
        overScopedRecs(
          input(repoMap, undefined, liveConfig(hookSettings('PreToolUse', command)))
        ),
        command
      ).toHaveLength(0);
    }
  });

  it('does not treat retained POSIX backslashes as path separators', () => {
    const guard = companionSection('PreToolUse', 'hooks/foo.mjs', 'CLAUDE.md');
    const repoMap = dataset(
      project(
        [guard],
        [file('hooks/foo.mjs', [guard.id])],
        '/home/alice/.claude'
      )
    );
    const commandForms = (path: string) => [
      'node ' + path,
      'env node ' + path,
      '[ -f ' + path + ' ] || exit 0; bash ' + path,
    ];

    for (const path of [
      '"$HOME\\/.claude/hooks/foo.mjs"',
      '"/home/alice\\/.claude/hooks/foo.mjs"',
    ]) {
      for (const command of commandForms(path)) {
        expect(
          overScopedRecs(
            input(repoMap, undefined, liveConfig(hookSettings('PreToolUse', command)))
          ),
          command
        ).toHaveLength(1);
      }
    }

    for (const path of [
      '"$HOME/.claude/hooks/foo.mjs"',
      '"/home/alice/.claude/hooks/foo.mjs"',
    ]) {
      for (const command of commandForms(path)) {
        expect(
          overScopedRecs(
            input(repoMap, undefined, liveConfig(hookSettings('PreToolUse', command)))
          ),
          command
        ).toHaveLength(0);
      }
    }
  });

  it('does not expand a quoted project-root variable in direct or guarded hooks', () => {
    const guard = companionSection(
      'PostToolUse',
      '.claude/hooks/project-guard.sh',
      '/repo/AGENTS.md'
    );
    const repoMap = dataset(
      project(
        [guard],
        [file('.claude/hooks/project-guard.sh', [guard.id])]
      )
    );
    const direct =
      "node '$CLAUDE_PROJECT_DIR/.claude/hooks/project-guard.sh'";
    const guarded =
      "[ -f '$CLAUDE_PROJECT_DIR/.claude/hooks/project-guard.sh' ] || exit 0; bash '$CLAUDE_PROJECT_DIR/.claude/hooks/project-guard.sh'";

    for (const command of [direct, guarded]) {
      expect(
        overScopedRecs(
          input(
            repoMap,
            undefined,
            liveConfig({}, { '/repo': hookSettings('PostToolUse', command) })
          )
        ),
        command
      ).toHaveLength(1);
    }
  });

  it('aliases an absolute global hook command to the global CLAUDE.md companion', () => {
    const guard = companionSection(
      'PreToolUse',
      'hooks/foo.mjs',
      'CLAUDE.md'
    );
    const recs = overScopedRecs(
      input(
        dataset(
          project(
            [guard],
            [file('hooks/foo.mjs', [guard.id])],
            '/home/alice/.claude'
          )
        ),
        undefined,
        liveConfig(hookSettings('PreToolUse', 'node /home/alice/.claude/hooks/foo.mjs'))
      )
    );

    expect(recs).toHaveLength(0);
  });

  it('does not infer a home alias for an absolute path without a concrete root', () => {
    const guard = companionSection('PreToolUse', 'hooks/foo.mjs', 'CLAUDE.md');
    const recs = overScopedRecs(
      input(
        dataset(project([guard], [file('hooks/foo.mjs', [guard.id])])),
        undefined,
        liveConfig(hookSettings('PreToolUse', 'node /repo/.claude/hooks/foo.mjs'))
      )
    );

    expect(recs).toHaveLength(1);
  });

  it('does not alias a different absolute home when the global root is concrete', () => {
    const guard = companionSection(
      'PreToolUse',
      'hooks/foo.mjs',
      '/home/alice/.claude/CLAUDE.md'
    );
    const recs = overScopedRecs(
      input(
        dataset(
          project(
            [guard],
            [file('hooks/foo.mjs', [guard.id])],
            '/home/alice/.claude'
          )
        ),
        undefined,
        liveConfig(hookSettings('PreToolUse', 'node /home/bob/.claude/hooks/foo.mjs'))
      )
    );

    expect(recs).toHaveLength(1);
  });

  it('uses concrete global-root evidence across a multi-root dataset', () => {
    const guard = companionSection('PreToolUse', 'hooks/foo.mjs', 'CLAUDE.md');
    const repoMap = dataset(
      project([guard], [file('hooks/foo.mjs', [guard.id])]),
      project([], [], '/home/alice/.claude')
    );

    const exact = overScopedRecs(
      input(
        repoMap,
        undefined,
        liveConfig(hookSettings('PreToolUse', 'node /home/alice/.claude/hooks/foo.mjs'))
      )
    );
    const otherTree = overScopedRecs(
      input(
        repoMap,
        undefined,
        liveConfig(hookSettings('PreToolUse', 'node /srv/other/.claude/hooks/foo.mjs'))
      )
    );

    expect(exact).toHaveLength(0);
    expect(otherTree).toHaveLength(1);
  });

  it('preserves a quoted global hook path containing spaces', () => {
    const guard = companionSection('PreToolUse', 'hooks/foo.mjs', 'CLAUDE.md');
    const repoMap = dataset(
      project(
        [guard],
        [file('hooks/foo.mjs', [guard.id])],
        '/Users/Alice Smith/.claude'
      )
    );
    const exact = overScopedRecs(
      input(
        repoMap,
        undefined,
        liveConfig(
          hookSettings(
            'PreToolUse',
            'node "/Users/Alice Smith/.claude/hooks/foo.mjs"'
          )
        )
      )
    );
    const malformed = overScopedRecs(
      input(
        repoMap,
        undefined,
        liveConfig(
          hookSettings(
            'PreToolUse',
            'node "/Users/Alice Smith/.claude/hooks/foo.mjs'
          )
        )
      )
    );
    const multiCommand = overScopedRecs(
      input(
        repoMap,
        undefined,
        liveConfig(
          hookSettings(
            'PreToolUse',
            'node "/Users/Alice Smith/.claude/hooks/foo.mjs"\necho extra'
          )
        )
      )
    );

    expect(exact).toHaveLength(0);
    expect(malformed).toHaveLength(1);
    expect(multiCommand).toHaveLength(1);
  });

  it('compares drive-letter hook paths case-insensitively without aliasing another script', () => {
    const guard = companionSection(
      'PreToolUse',
      'hooks/foo.mjs',
      'C:\\Users\\Alice\\.claude\\CLAUDE.md'
    );
    const repoMap = dataset(
      project(
        [guard],
        [file('hooks/foo.mjs', [guard.id])],
        'C:\\Users\\Alice\\.claude'
      )
    );
    const exactCommands = [
      'node "c:\\users\\alice\\.CLAUDE\\hooks\\FOO.MJS"',
      'env node "C:\\USERS\\ALICE\\.claude\\HOOKS\\foo.mjs"',
      '[ -f "c:\\users\\alice\\.claude\\hooks\\foo.mjs" ] || exit 0; bash "C:\\USERS\\ALICE\\.CLAUDE\\HOOKS\\FOO.MJS"',
      'node "$HOME/.CLAUDE/HOOKS/FOO.MJS"',
    ];

    for (const command of exactCommands) {
      expect(
        overScopedRecs(
          input(repoMap, undefined, liveConfig(hookSettings('PreToolUse', command)))
        ),
        command
      ).toHaveLength(0);
    }

    const retainedBackslashCommands = [
      'node "c:\\users\\alice\\/.claude\\hooks\\foo.mjs"',
      'env node "C:\\USERS\\ALICE\\/.CLAUDE\\HOOKS\\FOO.MJS"',
      '[ -f "c:\\users\\alice\\/.claude\\hooks\\foo.mjs" ] || exit 0; bash "C:\\USERS\\ALICE\\/.CLAUDE\\HOOKS\\FOO.MJS"',
    ];
    for (const command of retainedBackslashCommands) {
      expect(
        overScopedRecs(
          input(repoMap, undefined, liveConfig(hookSettings('PreToolUse', command)))
        ),
        command
      ).toHaveLength(1);
    }

    expect(
      overScopedRecs(
        input(
          repoMap,
          undefined,
          liveConfig(
            hookSettings(
              'PreToolUse',
              'node "c:\\users\\alice\\.claude\\hooks\\other.mjs"'
            )
          )
        )
      )
    ).toHaveLength(1);
  });

  it('matches a hooks wildcard only to an exact script companion', () => {
    const wildcardGuard = companionSection('*', 'hooks/foo.mjs', 'CLAUDE.md');
    const unrelatedWildcard = companionSection(
      'PreToolUse',
      'hooks/foo.mjs',
      'CLAUDE.md'
    );
    unrelatedWildcard.references[0] = {
      kind: 'configKey',
      target: 'permissions.*',
    };
    const exact = overScopedRecs(
      input(
        dataset(
          project(
            [wildcardGuard],
            [file('hooks/foo.mjs', [wildcardGuard.id])],
            '/home/alice/.claude'
          )
        ),
        undefined,
        liveConfig(hookSettings('PostToolUse', 'node $HOME/.claude/hooks/foo.mjs'))
      )
    );
    const unrelated = overScopedRecs(
      input(
        dataset(
          project(
            [unrelatedWildcard],
            [file('hooks/foo.mjs', [unrelatedWildcard.id])],
            '/home/alice/.claude'
          )
        ),
        undefined,
        liveConfig(hookSettings('PreToolUse', 'node $HOME/.claude/hooks/foo.mjs'))
      )
    );

    expect(exact).toHaveLength(0);
    expect(unrelated).toHaveLength(1);
  });

  it('skips a valueless interpreter option before the companion script', () => {
    const guard = companionSection(
      'PreToolUse',
      'hooks/foo.mjs',
      'CLAUDE.md'
    );
    const recs = overScopedRecs(
      input(
        dataset(project([guard], [file('hooks/foo.mjs', [guard.id])])),
        undefined,
        liveConfig(
          hookSettings(
            'PreToolUse',
            'node --no-warnings "$HOME/.claude/hooks/foo.mjs"'
          )
        )
      )
    );

    expect(recs).toHaveLength(0);
  });

  it('recognizes the repository pinned guarded-script registration', () => {
    const guard = companionSection(
      'PostToolUse',
      '.claude/hooks/publish-claude.sh',
      '/repo/AGENTS.md'
    );
    const command =
      '[ -f "$CLAUDE_PROJECT_DIR/.claude/hooks/publish-claude.sh" ] || exit 0; bash "$CLAUDE_PROJECT_DIR/.claude/hooks/publish-claude.sh"';
    const recs = overScopedRecs(
      input(
        dataset(
          project(
            [guard],
            [file('.claude/hooks/publish-claude.sh', [guard.id])]
          )
        ),
        undefined,
        liveConfig({}, { '/repo': hookSettings('PostToolUse', command) })
      )
    );

    expect(recs).toHaveLength(0);
  });

  it('recognizes the absolute duplicate of the global CLAUDE.md source', () => {
    const guard = companionSection(
      'PreToolUse',
      'hooks/workflow-window-guard.mjs',
      '/home/alice/.claude/CLAUDE.md'
    );
    const recs = overScopedRecs(
      input(
        dataset(
          project(
            [guard],
            [file('hooks/workflow-window-guard.mjs', [guard.id])],
            '/home/alice/.claude'
          )
        ),
        undefined,
        liveConfig(
          hookSettings(
            'PreToolUse',
            'node "$HOME/.claude/hooks/workflow-window-guard.mjs"'
          )
        )
      )
    );

    expect(recs).toHaveLength(0);
  });

  it('does not double-prefix an already global-relative file reference', () => {
    const guard = companionSection(
      'PreToolUse',
      '.claude/hooks/workflow-window-guard.mjs',
      'CLAUDE.md'
    );
    const recs = overScopedRecs(
      input(
        dataset(
          project(
            [guard],
            [file('.claude/hooks/workflow-window-guard.mjs', [guard.id])]
          )
        ),
        undefined,
        liveConfig(
          hookSettings(
            'PreToolUse',
            'node "$HOME/.claude/hooks/workflow-window-guard.mjs"'
          )
        )
      )
    );

    expect(recs).toHaveLength(0);
  });

  it('suppresses a global project-relative command omitted from ingest annotations', () => {
    const guard = companionSection(
      'PreToolUse',
      'hooks/workflow-window-guard.mjs',
      'CLAUDE.md'
    );
    const recs = overScopedRecs(
      input(
        dataset(
          project(
            [guard],
            [file('hooks/workflow-window-guard.mjs', [guard.id])]
          )
        ),
        undefined,
        liveConfig(
          hookSettings(
            'PreToolUse',
            'node "$CLAUDE_PROJECT_DIR/hooks/workflow-window-guard.mjs"'
          )
        )
      )
    );

    expect(recs).toHaveLength(0);
  });

  it('matches a bare global reference only to an absolute command under its root', () => {
    const guard = companionSection(
      'PreToolUse',
      'hooks/workflow-window-guard.mjs',
      'CLAUDE.md'
    );
    const repoMap = dataset(
      project(
        [guard],
        [file('hooks/workflow-window-guard.mjs', [guard.id])]
      )
    );
    const exact = overScopedRecs(
      input(
        repoMap,
        undefined,
        liveConfig(
          hookSettings(
            'PreToolUse',
            'node /repo/hooks/workflow-window-guard.mjs'
          )
        )
      )
    );
    const siblingPrefix = overScopedRecs(
      input(
        repoMap,
        undefined,
        liveConfig(
          hookSettings(
            'PreToolUse',
            'node /repo-other/hooks/workflow-window-guard.mjs'
          )
        )
      )
    );

    expect(exact).toHaveLength(0);
    expect(siblingPrefix).toHaveLength(1);
  });

  it('suppresses an exact same-project companion with normalized project identity', () => {
    const guard = companionSection(
      'PostToolUse',
      '.claude/hooks/project-guard.sh',
      '/repo/AGENTS.md'
    );
    const recs = overScopedRecs(
      input(
        dataset(
          project(
            [guard],
            [file('.claude/hooks/project-guard.sh', [guard.id])]
          )
        ),
        undefined,
        liveConfig({}, {
          '/repo/': hookSettings(
            'PostToolUse',
            '${CLAUDE_PROJECT_DIR}/.claude/hooks/project-guard.sh',
            '${CLAUDE_PROJECT_DIR}/.claude/hooks/project-guard.sh'
          ),
        })
      )
    );

    expect(recs).toHaveLength(0);
  });

  it('does not suppress a basename collision or an event mismatch', () => {
    const guard = companionSection(
      'PreToolUse',
      'hooks/workflow-window-guard.mjs',
      'CLAUDE.md'
    );
    const repoMap = dataset(
      project(
        [guard],
        [file('hooks/workflow-window-guard.mjs', [guard.id])],
        '/home/alice/.claude'
      )
    );

    const wrongPath = overScopedRecs(
      input(
        repoMap,
        undefined,
        liveConfig(
          hookSettings(
            'PreToolUse',
            'node "$HOME/other/workflow-window-guard.mjs"',
            '$HOME/other/workflow-window-guard.mjs'
          )
        )
      )
    );
    const wrongEvent = overScopedRecs(
      input(
        repoMap,
        undefined,
        liveConfig(
          hookSettings(
            'PostToolUse',
            'node "$HOME/.claude/hooks/workflow-window-guard.mjs"',
            '$HOME/.claude/hooks/workflow-window-guard.mjs'
          )
        )
      )
    );

    expect(wrongPath).toHaveLength(1);
    expect(wrongEvent).toHaveLength(1);
  });

  it('does not collapse absolute paths from different user homes', () => {
    const guard = companionSection(
      'PreToolUse',
      'hooks/workflow-window-guard.mjs',
      '/home/alice/repo/AGENTS.md'
    );
    const recs = overScopedRecs(
      input(
        dataset(
          project(
            [guard],
            [file('hooks/workflow-window-guard.mjs', [guard.id])],
            '/home/alice/repo'
          )
        ),
        undefined,
        liveConfig(
          hookSettings(
            'PreToolUse',
            'node /home/bob/repo/hooks/workflow-window-guard.mjs',
            '/home/bob/repo/hooks/workflow-window-guard.mjs'
          )
        )
      )
    );

    expect(recs).toHaveLength(1);
  });

  it('does not apply project hook settings from a different root', () => {
    const guard = companionSection(
      'PreToolUse',
      'hooks/workflow-window-guard.mjs',
      '/repo/AGENTS.md'
    );
    const recs = overScopedRecs(
      input(
        dataset(
          project(
            [guard],
            [file('hooks/workflow-window-guard.mjs', [guard.id])]
          )
        ),
        undefined,
        liveConfig({}, {
          '/repo-other': hookSettings(
            'PreToolUse',
            '$CLAUDE_PROJECT_DIR/hooks/workflow-window-guard.mjs',
            '$CLAUDE_PROJECT_DIR/hooks/workflow-window-guard.mjs'
          ),
        })
      )
    );

    expect(recs).toHaveLength(1);
  });

  it('derives command identity from the command rather than stale annotations', () => {
    const guard = companionSection(
      'PreToolUse',
      'hooks/workflow-window-guard.mjs',
      'CLAUDE.md'
    );
    const repoMap = dataset(
      project(
        [guard],
        [file('hooks/workflow-window-guard.mjs', [guard.id])],
        '/home/alice/.claude'
      )
    );

    const injectedMatch = overScopedRecs(
      input(
        repoMap,
        undefined,
        liveConfig(
          hookSettings(
            'PreToolUse',
            'echo opaque',
            '$HOME/.claude/hooks/workflow-window-guard.mjs'
          )
        )
      )
    );
    const staleMismatch = overScopedRecs(
      input(
        repoMap,
        undefined,
        liveConfig(
          hookSettings(
            'PreToolUse',
            'node "$HOME/.claude/hooks/workflow-window-guard.mjs"',
            '$HOME/other/stale.mjs'
          )
        )
      )
    );

    expect(injectedMatch).toHaveLength(1);
    expect(staleMismatch).toHaveLength(0);
  });

  it('fails open for malformed hook data and non-command hook types', () => {
    const guard = companionSection();
    const malformed = {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              null,
              {
                type: 'command',
                command: 'echo opaque',
                referencedPaths: [null, { path: 42 }],
              },
              {
                type: 'prompt',
                command: '$CLAUDE_PROJECT_DIR/hooks/workflow-window-guard.mjs',
              },
            ],
          },
        ],
      },
    } as unknown as LiveSettings;

    const recs = overScopedRecs(
      input(
        dataset(
          project(
            [guard],
            [file('hooks/workflow-window-guard.mjs', [guard.id])]
          )
        ),
        undefined,
        liveConfig(malformed)
      )
    );

    expect(recs).toHaveLength(1);
  });

  it('does not treat a redirect target as hook command identity', () => {
    const guard = companionSection(
      'PreToolUse',
      'hooks/workflow-window-guard.mjs',
      'CLAUDE.md'
    );
    const recs = overScopedRecs(
      input(
        dataset(
          project(
            [guard],
            [file('hooks/workflow-window-guard.mjs', [guard.id])]
          )
        ),
        undefined,
        liveConfig(
          hookSettings(
            'PreToolUse',
            'echo diagnostic > /repo/hooks/workflow-window-guard.mjs'
          )
        )
      )
    );

    expect(recs).toHaveLength(1);
  });

  it('does not treat test or wrapper arguments as hook command identity', () => {
    const guard = companionSection(
      'PreToolUse',
      'hooks/workflow-window-guard.mjs',
      'CLAUDE.md'
    );
    const repoMap = dataset(
      project(
        [guard],
        [file('hooks/workflow-window-guard.mjs', [guard.id])]
      )
    );
    const commands = [
      'test -f $CLAUDE_PROJECT_DIR/hooks/workflow-window-guard.mjs',
      'node $CLAUDE_PROJECT_DIR/hooks/wrapper.mjs --config $CLAUDE_PROJECT_DIR/hooks/workflow-window-guard.mjs',
      'node --require $HOME/.claude/hooks/workflow-window-guard.mjs $CLAUDE_PROJECT_DIR/hooks/wrapper.mjs',
      '[ -f "$CLAUDE_PROJECT_DIR/hooks/workflow-window-guard.mjs" ] || exit 0; bash "$CLAUDE_PROJECT_DIR/hooks/other.mjs"',
    ];

    for (const command of commands) {
      const recs = overScopedRecs(
        input(
          repoMap,
          undefined,
          liveConfig(hookSettings('PreToolUse', command))
        )
      );
      expect(recs, command).toHaveLength(1);
    }
  });

  it('skips leading environment assignments before matching the hook command', () => {
    const globalGuard = companionSection(
      'PreToolUse',
      'hooks/workflow-window-guard.mjs',
      'CLAUDE.md'
    );
    const globalRecs = overScopedRecs(
      input(
        dataset(
          project(
            [globalGuard],
            [file('hooks/workflow-window-guard.mjs', [globalGuard.id])],
            '/home/alice/.claude'
          )
        ),
        undefined,
        liveConfig(
          hookSettings(
            'PreToolUse',
            'NODE_OPTIONS=--no-warnings TRACE=1 node "$HOME/.claude/hooks/workflow-window-guard.mjs"'
          )
        )
      )
    );

    const projectGuard = companionSection(
      'PostToolUse',
      '.claude/hooks/project-guard.sh',
      '/repo/AGENTS.md'
    );
    const projectRecs = overScopedRecs(
      input(
        dataset(
          project(
            [projectGuard],
            [file('.claude/hooks/project-guard.sh', [projectGuard.id])]
          )
        ),
        undefined,
        liveConfig(
          {},
          {
            '/repo': hookSettings(
              'PostToolUse',
              'FOO=1 "$CLAUDE_PROJECT_DIR/.claude/hooks/project-guard.sh"'
            ),
          }
        )
      )
    );

    expect(globalRecs).toHaveLength(0);
    expect(projectRecs).toHaveLength(0);
  });

  it('unwraps direct env commands but rejects ambiguous env options', () => {
    const guard = companionSection(
      'PreToolUse',
      'hooks/workflow-window-guard.mjs',
      'CLAUDE.md'
    );
    const repoMap = dataset(
      project(
        [guard],
        [file('hooks/workflow-window-guard.mjs', [guard.id])],
        '/home/alice/.claude'
      )
    );
    const directCommands = [
      'env NODE_OPTIONS=--no-warnings node $HOME/.claude/hooks/workflow-window-guard.mjs',
      '/usr/bin/env node "$HOME/.claude/hooks/workflow-window-guard.mjs"',
    ];

    for (const command of directCommands) {
      expect(
        overScopedRecs(
          input(repoMap, undefined, liveConfig(hookSettings('PreToolUse', command)))
        ),
        command
      ).toHaveLength(0);
    }
    expect(
      overScopedRecs(
        input(
          repoMap,
          undefined,
          liveConfig(
            hookSettings(
              'PreToolUse',
              'env -S "node $HOME/.claude/hooks/workflow-window-guard.mjs"'
            )
          )
        )
      )
    ).toHaveLength(1);
  });

  it('does not treat a path inside an environment assignment as command identity', () => {
    const guard = companionSection(
      'PreToolUse',
      'hooks/workflow-window-guard.mjs',
      'CLAUDE.md'
    );
    const repoMap = dataset(
      project(
        [guard],
        [file('hooks/workflow-window-guard.mjs', [guard.id])],
        '/home/alice/.claude'
      )
    );
    const commands = [
      'HOOK=$HOME/.claude/hooks/workflow-window-guard.mjs echo opaque',
      'FOO=1;echo "$HOME/.claude/hooks/workflow-window-guard.mjs"',
      'FOO=1&&echo "$HOME/.claude/hooks/workflow-window-guard.mjs"',
    ];

    for (const command of commands) {
      const recs = overScopedRecs(
        input(
          repoMap,
          undefined,
          liveConfig(hookSettings('PreToolUse', command))
        )
      );
      expect(recs, command).toHaveLength(1);
    }
  });

  it('preserves unprovable legacy hooks and cites the current-config guard', () => {
    const guard = companionSection();
    const config = liveConfig({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: 'node $HOOK_HOME/workflow-window-guard.mjs',
              },
            ],
          },
        ],
      },
    });
    const recs = overScopedRecs(
      input(
        dataset(
          project(
            [guard],
            [file('hooks/workflow-window-guard.mjs', [guard.id])]
          )
        ),
        undefined,
        config
      )
    );

    expect(recs).toHaveLength(1);
    expect(
      recs[0].provenance?.observations.some(
        (observation) =>
          observation.source === 'liveConfig' &&
          observation.claim.includes('Stale-state guard')
      )
    ).toBe(true);
    expect(validateFixSnippet(recs[0].fix!)).toEqual([]);
    expect(validateRecommendationProvenance(recs[0])).toEqual([]);
  });

  it('filters companions before colliding rule topics are disambiguated', () => {
    const suppressed = companionSection(
      'PreToolUse',
      'hooks/workflow-window-guard.mjs',
      'CLAUDE.md'
    );
    suppressed.heading = 'Build/Deploy';
    const surviving = section({
      id: 'CLAUDE.md#build-deploy',
      sourceScope: 'CLAUDE.md',
      heading: 'Build Deploy',
    });
    const recs = overScopedRecs(
      input(
        dataset(
          project(
            [suppressed, surviving],
            [
              file('hooks/workflow-window-guard.mjs', [suppressed.id]),
              file('src/lib/api-client.ts', [surviving.id]),
            ],
            '/home/alice/.claude'
          )
        ),
        undefined,
        liveConfig(
          hookSettings(
            'PreToolUse',
            'node $HOME/.claude/hooks/workflow-window-guard.mjs',
            '$HOME/.claude/hooks/workflow-window-guard.mjs'
          )
        )
      )
    );

    expect(recs).toHaveLength(1);
    expect(recs[0].title).toContain('Build Deploy');
    expect(recs[0].action).toContain('.claude/rules/build-deploy.md');
    expect(recs[0].action).not.toContain('build-deploy-2.md');
  });

  it('disambiguates colliding rulePath values in root document order', () => {
    const slash = section({
      id: 'AGENTS.md#builddeploy',
      heading: 'Build/Deploy',
    });
    const spaced = section({
      id: 'AGENTS.md#build-deploy',
      heading: 'Build Deploy',
    });
    const recs = overScopedRecs(
      input(
        dataset(
          project(
            [slash, spaced],
            [
              file('src/lib/a.ts', [slash.id]),
              file('src/lib/b.ts', [spaced.id]),
            ]
          )
        )
      )
    );

    expect(recs).toHaveLength(2);
    const slashRec = recs.find((rec) => rec.title.includes('Build/Deploy'))!;
    const spacedRec = recs.find((rec) => rec.title.includes('Build Deploy'))!;

    expect(slashRec.action).toContain('.claude/rules/build-deploy.md');
    expect(slashRec.fix?.snippet).toContain('.claude/rules/build-deploy.md');
    expect(spacedRec.action).toContain('.claude/rules/build-deploy-2.md');
    expect(spacedRec.fix?.snippet).toContain('.claude/rules/build-deploy-2.md');
  });

  it('does not fire for a genuinely cross-cutting root section', () => {
    const crossCutting = section({
      id: 'AGENTS.md#shared-discipline',
      heading: 'Shared discipline',
    });
    const recs = overScopedRecs(
      input(
        dataset(
          project(
            [crossCutting],
            [
              file('src/lib/api-client.ts', [crossCutting.id]),
              file('src/components/Recommendations.tsx', [crossCutting.id]),
            ]
          )
        )
      )
    );

    expect(recs).toHaveLength(0);
  });

  it('does not fire for an already path-scoped rule section', () => {
    const scoped = section({
      id: '.claude/rules/api.md#api-client',
      sourceScope: '.claude/rules/api.md',
      heading: 'API client',
    });
    const recs = overScopedRecs(
      input(dataset(project([scoped], [file('src/lib/api-client.ts', [scoped.id])])))
    );

    expect(recs).toHaveLength(0);
  });

  it('emits nothing without a repo map or without governed files', () => {
    const lonely = section({
      id: 'AGENTS.md#lonely',
      heading: 'Lonely root section',
    });

    expect(detector.rule(input(null), 0)).toBeNull();
    expect(detector.rule(input(dataset(project([lonely], []))), 0)).toBeNull();
  });
});

describe('context.over-scoped-config-section — adherence-gated graduation (#1270)', () => {
  /** One config-scoping ledger line; omit `adherence` to drop the judged dimension. */
  const scopingLine = (
    winner: 'main' | 'shadow' | 'tie',
    adherence?: number,
    mode: 'live' | 'replay' = 'live'
  ): string =>
    JSON.stringify({
      mode,
      axis: 'config-scoping',
      judge: { winner, ...(adherence === undefined ? {} : { adherenceRegressions: adherence }) },
    });

  const ledger = (...lines: string[]) => parseShadowCalls(lines.join('\n'));

  const overScopedInput = (shadowCalls?: ShadowCallAggregate): RecommendationInput => {
    const api = section({
      id: 'AGENTS.md#spa-server-boundary',
      heading: 'SPA server boundary',
    });
    return input(
      dataset(project([api], [file('src/lib/api-client.ts', [api.id])])),
      shadowCalls
    );
  };

  const rec = (shadowCalls?: ShadowCallAggregate) => {
    const found = overScopedRecs(overScopedInput(shadowCalls));
    expect(found).toHaveLength(1);
    return found[0];
  };

  /** 6 samples, 5 shadow wins / 1 main — clears MIN_SAMPLES, MIN_DECIDED, 60% win rate. */
  const winningLines = (adherence: () => number | undefined) => [
    scopingLine('shadow', adherence()),
    scopingLine('shadow', adherence()),
    scopingLine('shadow', adherence()),
    scopingLine('shadow', adherence()),
    scopingLine('shadow', adherence(), 'replay'),
    scopingLine('main', adherence()),
  ];

  it('does not let winning config-scoping evidence resurrect an active companion', () => {
    const guard = companionSection(
      'PreToolUse',
      'hooks/workflow-window-guard.mjs',
      'CLAUDE.md'
    );
    const detectorInput = input(
      dataset(
        project(
          [guard],
          [file('hooks/workflow-window-guard.mjs', [guard.id])],
          '/home/alice/.claude'
        )
      ),
      ledger(...winningLines(() => 0)),
      liveConfig(
        hookSettings(
          'PreToolUse',
          'node ${HOME}/.claude/hooks/workflow-window-guard.mjs',
          '${HOME}/.claude/hooks/workflow-window-guard.mjs'
        )
      )
    );

    expect(overScopedRecs(detectorInput)).toHaveLength(0);
    expect(detector.rule(detectorInput, 0)).toBeNull();
  });

  it('graduates to recommended / tier-1-before-after when thresholds clear with ZERO regression', () => {
    const graduated = rec(ledger(...winningLines(() => 0)));
    expect(graduated.savingsAttribution?.tier).toBe('tier-1-before-after');
    expect(graduated.savingsAttribution?.confidence).toBe('high');
    expect(graduated.severity).toBe('warning');
    expect(graduated.detail).toMatch(/zero adherence regressions/i);
    expect(graduated.evidence?.some((e) => e.includes('config-scoping axis'))).toBe(true);
    expect(validateRecommendationProvenance(graduated)).toEqual([]);
  });

  it('stays advisory when thresholds clear but ANY adherence regression exists (hard gate)', () => {
    // Identical cost/speed win, but one judged record dropped a rule.
    let i = 0;
    const blocked = rec(ledger(...winningLines(() => (i++ === 1 ? 1 : 0))));
    expect(blocked.savingsAttribution?.tier).toBe('tier-0-estimate');
    expect(blocked.savingsAttribution?.confidence).toBe('medium');
    expect(blocked.severity).toBe('info');
    expect(blocked.detail).not.toMatch(/proved/i);
  });

  it('stays advisory below the evidence thresholds, even with zero regressions', () => {
    // Only 2 samples (< MIN_SAMPLES) — a clean adherence record cannot rescue thin evidence.
    const thin = rec(ledger(scopingLine('shadow', 0), scopingLine('shadow', 0)));
    expect(thin.savingsAttribution?.tier).toBe('tier-0-estimate');
    expect(thin.severity).toBe('info');
  });

  it('fails closed when adherence data is absent or partial', () => {
    // Same winning verdicts but NO adherence dimension on any record.
    const absent = rec(ledger(...winningLines(() => undefined)));
    expect(absent.savingsAttribution?.tier).toBe('tier-0-estimate');
    expect(absent.severity).toBe('info');

    // Partial coverage: one judged record missing the dimension blocks certification.
    let i = 0;
    const partial = rec(ledger(...winningLines(() => (i++ === 2 ? undefined : 0))));
    expect(partial.savingsAttribution?.tier).toBe('tier-0-estimate');
    expect(partial.severity).toBe('info');
  });

  it('ignores wins on OTHER axes — only config-scoping evidence graduates this rec', () => {
    const otherAxis = parseShadowCalls(
      Array.from({ length: 6 }, () =>
        JSON.stringify({ mode: 'live', axis: 'model', judge: { winner: 'shadow', adherenceRegressions: 0 } })
      ).join('\n')
    );
    const unaffected = rec(otherAxis);
    expect(unaffected.savingsAttribution?.tier).toBe('tier-0-estimate');
    expect(unaffected.severity).toBe('info');
  });

  it('stays advisory with no shadow-calls data at all', () => {
    const noData = rec(undefined);
    expect(noData.savingsAttribution?.tier).toBe('tier-0-estimate');
    expect(noData.severity).toBe('info');
  });
});
