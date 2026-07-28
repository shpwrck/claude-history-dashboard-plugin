import { describe, expect, it } from 'vitest';
import { detector } from './dangerous-bypass';
import { detector as denyRuleNeverTriggered } from './deny-rule-never-triggered';
import { validateFixSnippet } from '../fix-validity';
import { validateRecommendationProvenance } from '../provenance';
import { DANGEROUS_ASK_RULES, DANGEROUS_DENY_RULES } from '../shared';
import type { Recommendation, RecommendationInput } from '../types';
import type { LiveConfig, SessionTokenData } from '../../../types';
import type { ToolCall, ToolUsageData } from '../../parse-tools';

const NOW = Date.parse('2026-07-14T12:00:00.000Z');
const DEFAULT_TS = '2026-07-13T10:00:00.000Z';

function bashSession(
  sessionId: string,
  commands: string[],
  timestamps: string[] = []
): ToolUsageData {
  const calls: ToolCall[] = commands.map((command, index) => ({
    timestamp: timestamps[index] ?? DEFAULT_TS,
    toolName: 'Bash',
    input: { command },
    toolUseId: `${sessionId}-tool-${index}`,
    isError: null,
    resultBytes: 0,
  }));
  return { sessionId, calls };
}

function strippedDangerousSession(
  matchingRules: unknown,
  fragment = 'rm -rfv ~'
): ToolUsageData {
  return {
    sessionId: 'session-1',
    calls: [
      {
        timestamp: DEFAULT_TS,
        toolName: 'Bash',
        input: {},
        toolUseId: 'session-1-tool-0',
        isError: null,
        resultBytes: 0,
        commandPreview: 'rm -rf ~',
        commandDangerousPattern: 'rm -rf',
        commandDangerousCertainty: 'high',
        commandDangerousFragment: fragment,
        ...(matchingRules !== undefined
          ? { commandDangerousRuleMatches: matchingRules }
          : {}),
      } as ToolCall,
    ],
  };
}

function tokenSession(sessionId: string, entrypoint: string): SessionTokenData {
  return {
    sessionId,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    model: 'claude-sonnet-4-5',
    messageCount: 1,
    entries: [],
    compactionEvents: [],
    hasUnknownModel: false,
    entrypoint,
    serviceTier: null,
  } as unknown as SessionTokenData;
}

function liveConfig(
  permissions: NonNullable<LiveConfig['settings']>['permissions'] = {},
  settingsHealth?: LiveConfig['settingsHealth']
): LiveConfig {
  return {
    settings: { permissions },
    ...(settingsHealth !== undefined ? { settingsHealth } : {}),
    claudeMd: { global: null, perProject: {} },
    plugins: [],
    mcpServers: [],
    skills: [],
    subagents: [],
    commands: [],
  } as unknown as LiveConfig;
}

function liveConfigClaudeMd(global: string): LiveConfig {
  return {
    ...liveConfig(),
    claudeMd: { global, perProject: {} },
  };
}

const ADOPT_BLOCK_BYPASS = [
  '## Claude Coach Adopted Recommendations',
  '',
  '### Dangerous commands ran under bypassed permissions (`safety.dangerous-bypass`)',
  '',
  'Adopted: 2026-06-12T10:00:00.000Z',
  '',
  '{ "permissions": { "deny": ["Bash(rm -rf:*)"] } }',
].join('\n');

function input(overrides: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    ...overrides,
  };
}

function bypassInput(
  toolData: ToolUsageData[],
  permissions: NonNullable<LiveConfig['settings']>['permissions'] = {}
): RecommendationInput {
  return input({
    toolData,
    permissionRows: toolData.map(({ sessionId }) => ({
      sessionId,
      mode: 'bypassPermissions',
    })),
    liveConfig: liveConfig(permissions),
  });
}

function fixRules(rec: Recommendation, bucket: 'ask' | 'deny'): string[] {
  const parsed = JSON.parse(rec.fix?.snippet ?? '{}') as {
    permissions?: { ask?: string[]; deny?: string[] };
  };
  return parsed.permissions?.[bucket] ?? [];
}

describe('safety.dangerous-bypass observed-pattern coverage', () => {
  it('flags a high-certainty command under bypass with only its mapped deny rules', () => {
    const rec = detector.rule(
      bypassInput([bashSession('session-1', ['rm -rf ~'])]),
      NOW
    );

    expect(rec).toMatchObject({
      id: 'safety.dangerous-bypass',
      category: 'safety',
      severity: 'critical',
      affected: 1,
      view: 'permissions',
      claimClass: 'accounting',
      proofTier: 'accounting',
      fix: {
        target: 'settings.json',
        label: 'Add missing observed-pattern deny rules',
        fixKind: 'manual',
      },
    });
    expect(fixRules(rec!, 'deny')).toEqual(['Bash(rm -rf:*)']);
    expect(rec?.fix?.snippet).not.toContain('Bash(curl:*)');
    expect(rec?.fix?.note).toContain('~/.claude/settings.json');
    expect(rec?.evidence?.[0]).toContain('rm -rf');
  });

  it('suppresses after the emitted deny rules are applied to user settings', () => {
    const toolData = [bashSession('session-1', ['git reset --hard HEAD'])];
    const first = detector.rule(bypassInput(toolData), NOW)!;
    const applied = fixRules(first, 'deny');

    expect(applied).toEqual(['Bash(git reset --hard:*)']);
    expect(
      detector.rule(bypassInput(toolData, { deny: applied }), NOW)
    ).toBeNull();
  });

  it('suppresses rm when its observed variant is denied, regardless of unrelated aliases', () => {
    const rec = detector.rule(
      bypassInput([bashSession('session-1', ['rm -rf ~'])], {
        deny: ['Bash(rm -rf:*)'],
      }),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('suppresses a stripped exact invocation only from persisted prefix truth', () => {
    const rec = detector.rule(
      bypassInput(
        [strippedDangerousSession(['Bash(rm -rf:*)'], 'rm -rf ~')],
        { deny: ['Bash(rm -rf:*)'] }
      ),
      NOW
    );
    expect(rec).toBeNull();
  });

  it.each([
    ['no persisted field', undefined],
    ['unknown persisted rule', ['Bash(unknown:*)']],
    [
      'impossible persisted aliases',
      ['Bash(rm -rf:*)', 'Bash(rm -fr:*)'],
    ],
    [
      'duplicate persisted aliases',
      ['Bash(rm -rf:*)', 'Bash(rm -rf:*)'],
    ],
    ['malformed persisted value', 'Bash(rm -rf:*)'],
  ])(
    'keeps stripped evidence visible without claiming a non-match when prefix truth has %s',
    (_label, matchingRules) => {
      const rec = detector.rule(
        bypassInput([strippedDangerousSession(matchingRules)], {
          deny: ['Bash(rm -rf:*)'],
        }),
        NOW
      )!;

      expect(rec.id).toBe('safety.dangerous-bypass');
      expect(rec.fix).toBeUndefined();
      expect(rec.detail).toContain(
        'Permission-prefix truth was unavailable for: rm -rf'
      );
      expect(rec.detail).not.toContain(
        'No canonical mapped prefix rule matched the observed Bash invocation'
      );
      expect(rec.provenance?.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field:
              'toolData[].calls[].input.command or commandDangerousRuleMatches',
            value: 'rm -rf',
          }),
        ])
      );
    }
  );

  it('keeps a proven stripped non-match distinct from unavailable prefix truth', () => {
    const rec = detector.rule(
      bypassInput([strippedDangerousSession([])], {
        deny: ['Bash(rm -rf:*)'],
      }),
      NOW
    )!;

    expect(rec.id).toBe('safety.dangerous-bypass');
    expect(rec.fix).toBeUndefined();
    expect(rec.detail).toContain(
      'No canonical mapped prefix rule matched the observed Bash invocation for: rm -rf'
    );
    expect(rec.detail).not.toContain('Permission-prefix truth was unavailable');
    expect(rec.provenance?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field:
            'toolData[].calls[].input.command or commandDangerousRuleMatches / DANGEROUS_PATTERN_RULES',
          value: 'rm -rf',
        }),
      ])
    );
  });

  it('does not suppress when known rules are covered but another record has unknown prefix truth', () => {
    const rec = detector.rule(
      bypassInput(
        [
          bashSession('session-known', ['rm -rf ~']),
          strippedDangerousSession(undefined),
        ],
        { deny: ['Bash(rm -rf:*)'] }
      ),
      NOW
    )!;

    expect(rec.id).toBe('safety.dangerous-bypass');
    expect(rec.fix).toBeUndefined();
    expect(rec.detail).toContain('Permission-prefix truth was unavailable for: rm -rf');
    expect(rec.detail).toContain('cover 1 of 1 relevant mapped deny rule(s)');
  });

  it('suppresses unknown stripped prefix truth when a whole-tool Bash deny proves coverage', () => {
    expect(
      detector.rule(
        bypassInput([strippedDangerousSession(undefined)], {
          deny: ['Bash'],
        }),
        NOW
      )
    ).toBeNull();
  });

  it.each([
    { ask: ['Bash'] },
    { allow: ['Bash'] },
  ])(
    'does not treat non-deny whole-tool settings as bypass coverage: %j',
    (permissions) => {
      const rec = detector.rule(
        bypassInput([strippedDangerousSession(undefined)], permissions),
        NOW
      )!;

      expect(rec.id).toBe('safety.dangerous-bypass');
      expect(rec.detail).toContain(
        'Permission-prefix truth was unavailable for: rm -rf'
      );
    }
  );

  it('limits a mixed fix to known matches and calls out unknown persisted truth', () => {
    const rec = detector.rule(
      bypassInput([
        bashSession('session-known', ['git reset --hard HEAD']),
        strippedDangerousSession(undefined),
      ]),
      NOW
    )!;

    expect(fixRules(rec, 'deny')).toEqual(['Bash(git reset --hard:*)']);
    expect(rec.fix?.note).toContain(
      'Permission-prefix truth is unavailable for rm -rf'
    );
    expect(rec.fix?.snippet).not.toContain('Bash(rm -rf:*)');
  });

  it.each(['rm -rfv ~', 'rm -Rfv ~', 'cd /tmp && rm -rf ~'])(
    'does not suppress an uncovered raw invocation behind canonical settings: %s',
    (command) => {
      const rec = detector.rule(
        bypassInput([bashSession('session-1', [command])], {
          deny: ['Bash(rm -rf:*)', 'Bash(rm -fr:*)'],
        }),
        NOW
      )!;

      expect(rec.id).toBe('safety.dangerous-bypass');
      expect(rec.fix).toBeUndefined();
      expect(rec.detail).toContain(
        'No canonical mapped prefix rule matched the observed Bash invocation for: rm -rf'
      );
      expect(rec.provenance?.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field:
              'toolData[].calls[].input.command or commandDangerousRuleMatches / DANGEROUS_PATTERN_RULES',
            value: 'rm -rf',
          }),
        ])
      );
    }
  );

  it.each(['rm -rfv ~', 'rm -Rfv ~', 'cd /tmp && rm -rf ~'])(
    'suppresses a non-prefixable bypass invocation behind a whole-tool Bash deny: %s',
    (command) => {
      expect(
        detector.rule(
          bypassInput([bashSession('session-1', [command])], {
            deny: ['Bash'],
          }),
          NOW
        )
      ).toBeNull();
    }
  );

  it.each([{ ask: ['Bash'] }, { allow: ['Bash'] }])(
    'does not treat non-deny whole-tool settings as bypass coverage for a proven non-match: %j',
    (permissions) => {
      const rec = detector.rule(
        bypassInput(
          [bashSession('session-1', ['cd /tmp && rm -rf ~'])],
          permissions
        ),
        NOW
      )!;

      expect(rec.id).toBe('safety.dangerous-bypass');
      expect(rec.fix).toBeUndefined();
    }
  );

  it('emits only the uncovered observed alias and notes the covered observed alias', () => {
    const rec = detector.rule(
      bypassInput([bashSession('session-1', ['rm -rf ~', 'rm -fr /'])], {
        deny: ['Bash(rm -rf:*)'],
      }),
      NOW
    )!;

    expect(fixRules(rec, 'deny')).toEqual(['Bash(rm -fr:*)']);
    expect(rec.fix?.note).toContain(
      'Current settings already cover: Bash(rm -rf:*)'
    );
    expect(rec.detail).toContain('cover 1 of 2 relevant mapped deny rule(s)');
  });

  it.each([
    ['rm -fr ~', 'Bash(rm -fr:*)', 'Bash(rm -rf:*)'],
    ['git push -f origin main', 'Bash(git push -f:*)', 'Bash(git push --force:*)'],
  ])(
    'derives the protection from the observed executable alias in %s',
    (command, expected, sibling) => {
      const rec = detector.rule(
        bypassInput([bashSession('session-1', [command])]),
        NOW
      )!;

      expect(fixRules(rec, 'deny')).toEqual([expected]);
      expect(rec.fix?.snippet).not.toContain(sibling);
    }
  );

  it.each([
    ['Bash(rm:*)'],
    ['Bash'],
  ])('counts the broader deny rule %s as coverage', (denyRule) => {
    expect(
      detector.rule(
        bypassInput([bashSession('session-1', ['rm -rf ~'])], {
          deny: [denyRule],
        }),
        NOW
      )
    ).toBeNull();
  });

  it('emits only the uncovered pattern when another observed pattern is fully covered', () => {
    const rec = detector.rule(
      bypassInput(
        [bashSession('session-1', ['rm -rf ~', 'git reset --hard HEAD'])],
        { deny: ['Bash(rm -rf:*)', 'Bash(rm -fr:*)'] }
      ),
      NOW
    )!;

    expect(fixRules(rec, 'deny')).toEqual(['Bash(git reset --hard:*)']);
    expect(rec.fix?.snippet).not.toContain('Bash(rm -rf:*)');
    expect(rec.fix?.snippet).not.toContain('Bash(rm -fr:*)');
  });

  it('does not treat ask or allow as coverage for bypassed commands', () => {
    for (const permissions of [
      { ask: ['Bash(rm -rf:*)', 'Bash(rm -fr:*)'] },
      { allow: ['Bash(rm -rf:*)', 'Bash(rm -fr:*)'] },
    ]) {
      const rec = detector.rule(
        bypassInput([bashSession('session-1', ['rm -rf ~'])], permissions),
        NOW
      )!;
      expect(fixRules(rec, 'deny')).toEqual(['Bash(rm -rf:*)']);
    }
  });

  it('dedupes rules across repeated contributing patterns', () => {
    const rec = detector.rule(
      bypassInput([
        bashSession('session-1', ['git push --force origin main']),
        bashSession('session-2', ['git push -f origin other']),
      ]),
      NOW
    )!;
    expect(fixRules(rec, 'deny')).toEqual([
      'Bash(git push --force:*)',
      'Bash(git push -f:*)',
    ]);
  });

  it('does not flag scoped/reversible rm -rf commands (#2011)', () => {
    for (const scoped of ['rm -rf ./.worktrees/feature-x', 'rm -rf /tmp/y']) {
      expect(
        detector.rule(
          bypassInput([bashSession('session-1', [scoped])]),
          NOW
        ),
        scoped
      ).toBeNull();
    }
  });

  it('still flags an unguarded variable-expansion rm -rf as critical (#2011)', () => {
    const rec = detector.rule(
      bypassInput([bashSession('session-1', ['rm -rf "$UNSET"'])]),
      NOW
    );
    expect(rec).toMatchObject({
      id: 'safety.dangerous-bypass',
      severity: 'critical',
    });
  });
});

describe('safety.dangerous-commands warning coverage', () => {
  it('emits the warning branch outside bypass mode', () => {
    const rec = detector.rule(
      input({
        toolData: [bashSession('session-1', ['git reset --hard HEAD~1'])],
        liveConfig: liveConfig(),
      }),
      NOW
    );

    expect(rec).toMatchObject({
      id: 'safety.dangerous-commands',
      category: 'safety',
      severity: 'warning',
      affected: 1,
      fix: {
        target: 'settings.json',
        label: 'Confirm missing observed dangerous patterns',
        fixKind: 'manual',
      },
    });
    expect(fixRules(rec!, 'ask')).toEqual(['Bash(git reset --hard:*)']);
  });

  it('treats ask or stronger deny as coverage', () => {
    const toolData = [bashSession('session-1', ['rm -rf ~'])];
    for (const permissions of [
      { ask: ['Bash(rm -rf:*)'] },
      { deny: ['Bash(rm -rf:*)'] },
      { ask: ['Bash(rm:*)'] },
      { deny: ['Bash'] },
    ]) {
      expect(
        detector.rule(input({ toolData, liveConfig: liveConfig(permissions) }), NOW)
      ).toBeNull();
    }
  });

  it.each([
    { ask: ['Bash'] },
    { deny: ['Bash'] },
  ])(
    'treats whole-tool %j as coverage for unknown stripped warning truth',
    (permissions) => {
      expect(
        detector.rule(
          input({
            toolData: [strippedDangerousSession(undefined)],
            liveConfig: liveConfig(permissions),
          }),
          NOW
        )
      ).toBeNull();
    }
  );

  it('does not treat whole-tool allow as warning coverage for unknown truth', () => {
    const rec = detector.rule(
      input({
        toolData: [strippedDangerousSession(undefined)],
        liveConfig: liveConfig({ allow: ['Bash'] }),
      }),
      NOW
    )!;

    expect(rec.id).toBe('safety.dangerous-commands');
    expect(rec.detail).toContain(
      'Permission-prefix truth was unavailable for: rm -rf'
    );
  });

  it.each([{ ask: ['Bash'] }, { deny: ['Bash'] }])(
    'treats whole-tool %j as warning coverage for a proven non-match',
    (permissions) => {
      expect(
        detector.rule(
          input({
            toolData: [
              bashSession('session-1', ['cd /tmp && rm -rf ~']),
            ],
            liveConfig: liveConfig(permissions),
          }),
          NOW
        )
      ).toBeNull();
    }
  );

  it('does not treat whole-tool allow as warning coverage for a proven non-match', () => {
    const rec = detector.rule(
      input({
        toolData: [bashSession('session-1', ['cd /tmp && rm -rf ~'])],
        liveConfig: liveConfig({ allow: ['Bash'] }),
      }),
      NOW
    )!;

    expect(rec.id).toBe('safety.dangerous-commands');
    expect(rec.fix).toBeUndefined();
  });

  it('emits only the missing ask rule when warning coverage is partial', () => {
    const rec = detector.rule(
      input({
        toolData: [bashSession('session-1', ['rm -rf ~', 'rm -fr /'])],
        liveConfig: liveConfig({ deny: ['Bash(rm -rf:*)'] }),
      }),
      NOW
    )!;

    expect(fixRules(rec, 'ask')).toEqual(['Bash(rm -fr:*)']);
    expect(rec.fix?.note).toContain(
      'Current settings already cover: Bash(rm -rf:*)'
    );
  });

  it('does not treat allow or unrelated ask rules as coverage', () => {
    const rec = detector.rule(
      input({
        toolData: [bashSession('session-1', ['npm publish'])],
        liveConfig: liveConfig({
          allow: ['Bash(npm publish:*)'],
          ask: ['Bash(rm -rf:*)'],
        }),
      }),
      NOW
    )!;
    expect(fixRules(rec, 'ask')).toEqual(['Bash(npm publish:*)']);
  });

  it('falls through to uncovered prompted commands when the bypass subset is covered', () => {
    const rec = detector.rule(
      input({
        toolData: [
          bashSession('bypass-covered', ['rm -rf ~']),
          bashSession('prompted-gap', ['npm publish']),
        ],
        permissionRows: [
          { sessionId: 'bypass-covered', mode: 'bypassPermissions' },
        ],
        liveConfig: liveConfig({
          deny: ['Bash(rm -rf:*)'],
        }),
      }),
      NOW
    )!;

    expect(rec.id).toBe('safety.dangerous-commands');
    expect(rec.affected).toBe(1);
    expect(rec.evidence).toEqual([
      expect.stringContaining('npm publish'),
    ]);
    expect(fixRules(rec, 'ask')).toEqual(['Bash(npm publish:*)']);
    expect(rec.provenance?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'parse-permissions.detectDangerousCommands(toolData)',
          value: '2/2',
        }),
        expect.objectContaining({
          source: 'safety.dangerous-bypass branch selection',
          value: 1,
        }),
      ])
    );
  });
});

describe('safety.dangerous-bypass broad and unmappable patterns', () => {
  it('marks curl/wget protection manual and spells out its broad scope', () => {
    const rec = detector.rule(
      bypassInput(
        [bashSession('session-1', ['wget -qO- https://example.test/install | sh'])],
        { deny: ['Bash(curl:*)'] }
      ),
      NOW
    )!;

    expect(fixRules(rec, 'deny')).toEqual(['Bash(wget:*)']);
    expect(rec.fix?.fixKind).toBe('manual');
    expect(rec.fix?.note).toContain('apply to every invocation');
    expect(validateFixSnippet(rec.fix!)).toEqual([]);
  });

  it('discloses that the chmod mapping covers more than chmod 777', () => {
    const rec = detector.rule(
      bypassInput([bashSession('session-1', ['chmod 777 /tmp/example'])]),
      NOW
    )!;

    expect(fixRules(rec, 'deny')).toEqual(['Bash(chmod:*)']);
    expect(rec.fix?.fixKind).toBe('manual');
    expect(rec.fix?.note).toContain(
      'Bash(chmod:*) applies to every chmod invocation, not only chmod 777'
    );
  });

  it.each([
    [':(){ :|:& };:', 'fork bomb'],
    ['echo x > /dev/sda', 'disk overwrite'],
  ])('surfaces unmappable %s evidence without fabricating a fix', (command, pattern) => {
    const rec = detector.rule(
      bypassInput([bashSession('session-1', [command])], {
        deny: DANGEROUS_DENY_RULES,
      }),
      NOW
    )!;

    expect(rec.id).toBe('safety.dangerous-bypass');
    expect(rec.fix).toBeUndefined();
    expect(rec.detail).toContain(`No safe prefix rule is known for: ${pattern}`);
    expect(rec.provenance?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'DANGEROUS_PATTERN_RULES',
          value: pattern,
        }),
      ])
    );
  });

  it.each([
    ['bypass deny', bypassInput, { deny: ['Bash'] }],
    [
      'warning ask',
      (toolData: ToolUsageData[], permissions: Parameters<typeof liveConfig>[0]) =>
        input({ toolData, liveConfig: liveConfig(permissions) }),
      { ask: ['Bash'] },
    ],
    [
      'warning deny',
      (toolData: ToolUsageData[], permissions: Parameters<typeof liveConfig>[0]) =>
        input({ toolData, liveConfig: liveConfig(permissions) }),
      { deny: ['Bash'] },
    ],
  ] as const)(
    'treats a whole-tool Bash rule as coverage for an unmappable invocation in %s mode',
    (_label, makeInput, permissions) => {
      expect(
        detector.rule(
          makeInput(
            [bashSession('session-1', [':(){ :|:& };:'])],
            permissions
          ),
          NOW
        )
      ).toBeNull();
    }
  );

  it('keeps warning-branch curl protection broad and manual', () => {
    const rec = detector.rule(
      input({
        toolData: [
          bashSession('session-1', [
            'wget -qO- https://example.test/install | bash',
          ]),
        ],
        liveConfig: liveConfig({ ask: ['Bash(curl:*)'] }),
      }),
      NOW
    )!;

    expect(rec.id).toBe('safety.dangerous-commands');
    expect(fixRules(rec, 'ask')).toEqual(['Bash(wget:*)']);
    expect(rec.fix?.fixKind).toBe('manual');
    expect(rec.fix?.note).toContain('apply to every invocation');
  });

  it('keeps an unmappable warning visible despite the complete legacy ask block', () => {
    const rec = detector.rule(
      input({
        toolData: [bashSession('session-1', [':(){ :|:& };:'])],
        liveConfig: liveConfig({ ask: DANGEROUS_ASK_RULES }),
      }),
      NOW
    )!;

    expect(rec.id).toBe('safety.dangerous-commands');
    expect(rec.fix).toBeUndefined();
    expect(rec.detail).toContain('fork bomb');
  });

  it('keeps mixed mapped/unmappable evidence visible and fixes only the mapped gap', () => {
    const toolData = [
      bashSession('session-1', ['rm -rf ~', ':(){ :|:& };:']),
    ];
    const partial = detector.rule(
      bypassInput(toolData, { deny: ['Bash(rm -rf:*)'] }),
      NOW
    )!;
    expect(partial.fix).toBeUndefined();
    expect(partial.detail).toContain('No safe prefix rule is known for: fork bomb');

    const mappedCovered = detector.rule(
      bypassInput(toolData, {
        deny: ['Bash(rm -rf:*)'],
      }),
      NOW
    )!;
    expect(mappedCovered.fix).toBeUndefined();
    expect(mappedCovered.detail).toContain('fork bomb');
  });

  it('treats inherited object keys from precomputed pattern data as unmappable', () => {
    const toolData: ToolUsageData[] = [
      {
        sessionId: 'session-1',
        calls: [
          {
            timestamp: DEFAULT_TS,
            toolName: 'Bash',
            input: { command: 'unknown dangerous command' },
            toolUseId: 'precomputed-pattern',
            isError: null,
            resultBytes: 0,
            commandDangerousPattern: 'constructor',
            commandDangerousCertainty: 'high',
          },
        ],
      },
    ];

    const rec = detector.rule(bypassInput(toolData), NOW)!;
    expect(rec.id).toBe('safety.dangerous-bypass');
    expect(rec.fix).toBeUndefined();
    expect(rec.detail).toContain('constructor');
  });
});

describe('safety.dangerous-bypass settings authority and provenance', () => {
  it('does not infer missing current settings or offer a fix when live config is unavailable', () => {
    const rec = detector.rule(
      input({
        toolData: [bashSession('session-1', ['rm -rf ~'])],
        permissionRows: [
          { sessionId: 'session-1', mode: 'bypassPermissions' },
        ],
      }),
      NOW
    )!;

    expect(rec.fix).toBeUndefined();
    expect(rec.detail).toContain('Current settings coverage was unavailable');
    expect(rec.provenance?.observations.some((observation) =>
      observation.source.includes('settings')
    )).toBe(false);
    expect(rec.provenance?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'liveConfig', value: 'absent' }),
      ])
    );
  });

  it('treats unhealthy settings as unavailable instead of an empty authoritative config', () => {
    const invalidConfig = liveConfig({}, {
      filePath: '~/.claude/settings.json',
      present: true,
      ok: false,
      findings: [
        {
          kind: 'syntax',
          severity: 'error',
          path: '',
          message: 'Unexpected token at line 2',
          sourcePath: '~/.claude/settings.json',
        },
      ],
    });
    const rec = detector.rule(
      input({
        toolData: [bashSession('session-1', ['rm -rf ~'])],
        permissionRows: [
          { sessionId: 'session-1', mode: 'bypassPermissions' },
        ],
        liveConfig: invalidConfig,
      }),
      NOW
    )!;

    expect(rec.fix).toBeUndefined();
    expect(rec.detail).toContain(
      'settings validation was unhealthy at ingest'
    );
    expect(rec.detail).not.toMatch(/cover 0 of|remain missing/);
    expect(rec.provenance?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'settingsHealth.ok', value: 'false' }),
      ])
    );
  });

  it('does not let an old CLAUDE.md adoption receipt hide a current gap', () => {
    const rec = detector.rule(
      input({
        toolData: [bashSession('session-1', ['rm -rf ~'])],
        permissionRows: [
          { sessionId: 'session-1', mode: 'bypassPermissions' },
        ],
        liveConfig: liveConfigClaudeMd(ADOPT_BLOCK_BYPASS),
      }),
      NOW
    );

    expect(detector.appliedMarkers).toBeUndefined();
    expect(rec?.id).toBe('safety.dangerous-bypass');
    expect(fixRules(rec!, 'deny')).toEqual(['Bash(rm -rf:*)']);
  });

  it('dates complete fresh evidence and emits compliant accounting provenance', () => {
    const rec = detector.rule(
      bypassInput([
        bashSession(
          'session-1',
          ['rm -rf ~', 'git reset --hard HEAD'],
          ['2026-07-12T10:00:00.000Z', '2026-07-13T10:00:00.000Z']
        ),
      ]),
      NOW
    )!;

    expect(rec.detail).toContain('Through 2026-07-13');
    expect(rec.provenance).toMatchObject({
      asOf: '2026-07-13',
      stale: false,
    });
    expect(rec.provenance?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field:
            'toolData[].calls[].input.command or commandDangerousRuleMatches',
          value: '2/2',
        }),
      ])
    );
    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(validateFixSnippet(rec.fix!)).toEqual([]);
  });

  it('demotes stale history to dated wording and a re-check action', () => {
    const rec = detector.rule(
      bypassInput([
        bashSession('session-1', ['rm -rf ~'], [
          '2026-05-01T10:00:00.000Z',
        ]),
      ]),
      NOW
    )!;

    expect(rec.detail).toContain('As of 2026-05-01');
    expect(rec.action).toMatch(/^Re-check whether this historical pattern/);
    expect(rec.provenance).toMatchObject({
      asOf: '2026-05-01',
      stale: true,
    });
  });

  it.each([
    ['not-a-time'],
    ['2026-02-30T00:00:00.000Z'],
    ['2099-01-01T00:00:00.000Z'],
  ])('treats incomplete or implausible timestamp coverage as undated (%s)', (bad) => {
    const rec = detector.rule(
      bypassInput([
        bashSession(
          'session-1',
          ['rm -rf ~', 'git reset --hard HEAD'],
          [DEFAULT_TS, bad]
        ),
      ]),
      NOW
    )!;

    expect(rec.detail).toContain('The available command history recorded');
    expect(rec.detail).not.toMatch(/Through|As of/);
    expect(rec.provenance?.asOf).toBeUndefined();
    expect(rec.provenance?.stale).toBeUndefined();
  });

  it('dates the bypass branch from only its contributing commands', () => {
    const rec = detector.rule(
      input({
        toolData: [
          bashSession('bypass-old', ['rm -rf ~'], [
            '2026-05-01T10:00:00.000Z',
          ]),
          bashSession('prompted-new', ['npm publish'], [
            '2026-07-13T10:00:00.000Z',
          ]),
        ],
        permissionRows: [
          { sessionId: 'bypass-old', mode: 'bypassPermissions' },
        ],
        liveConfig: liveConfig(),
      }),
      NOW
    )!;

    expect(rec.id).toBe('safety.dangerous-bypass');
    expect(rec.affected).toBe(1);
    expect(rec.provenance?.asOf).toBe('2026-05-01');
    expect(rec.provenance?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'parse-permissions.detectDangerousCommands(toolData)',
          value: '2/2',
        }),
        expect.objectContaining({
          source: 'safety.dangerous-bypass branch selection',
          value: 1,
        }),
      ])
    );
  });

  it('never nudges toward undoing an emitted npm-publish deny guard (#3221)', () => {
    const emitted = detector.rule(
      bypassInput([bashSession('session-1', ['npm publish'])]),
      NOW
    )!;
    const deny = fixRules(emitted, 'deny');
    expect(deny).toEqual(['Bash(npm publish:*)']);

    // Thin history: the never-triggered detector's coverage floor suppresses
    // rather than claiming a freshly-added guard is dead.
    expect(
      denyRuleNeverTriggered.rule(
        input({ toolData: [], liveConfig: liveConfig({ deny }) }),
        NOW
      )
    ).toBeNull();

    // With real history the guard IS reported — since #3221 the detector makes
    // no safety judgement and withholds nothing — but purely as an observation:
    // no fix, and no copy telling the user to prune or delete it.
    const reported = denyRuleNeverTriggered.rule(
      input({
        toolData: [bashSession('session-2', Array.from({ length: 24 }, () => 'echo hi'))],
        liveConfig: liveConfig({ deny }),
      }),
      NOW
    );
    expect(reported!.evidence).toEqual(deny);
    expect(reported!.fix).toBeUndefined();
    expect(`${reported!.detail} ${reported!.action}`.toLowerCase()).not.toMatch(
      /prune|delete|clutter/
    );
  });

  it('validates provenance on the dual-emitted warning id too', () => {
    const rec = detector.rule(
      input({
        toolData: [bashSession('session-1', ['npm publish'])],
        liveConfig: liveConfig(),
      }),
      NOW
    )!;
    expect(rec.id).toBe('safety.dangerous-commands');
    expect(validateRecommendationProvenance(rec)).toEqual([]);
  });

  it('marks unattended dangerous sessions without inventing a higher severity', () => {
    const rec = detector.rule(
      input({
        toolData: [bashSession('session-1', ['rm -rf ~'])],
        tokenData: [tokenSession('session-1', 'sdk-py')],
        permissionRows: [
          { sessionId: 'session-1', mode: 'bypassPermissions' },
        ],
        liveConfig: liveConfig(),
      }),
      NOW
    );

    expect(rec?.id).toBe('safety.dangerous-bypass');
    expect(rec?.severity).toBe('critical');
    expect(rec?.unattended).toBe(true);
    expect(rec?.unattendedCount).toBe(1);
  });
});
