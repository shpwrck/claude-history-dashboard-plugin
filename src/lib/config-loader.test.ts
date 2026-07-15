import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  assembleLiveConfig,
  hostEnvironmentObservation,
  hostEnvironmentObservationSignature,
  readStopHookConfigState,
} from './config-loader';
import { detector as settingsJsonInvalidDetector } from './detectors/reliability/settings-json-invalid';
import type { RecommendationInput } from './detectors/types';

describe('assembleLiveConfig', () => {
  it('passes the explicit names-only host environment observation to settings validation', () => {
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
      hooks: { Stop: [{ command: '${AVAILABLE} ${MISSING}' }] },
    }));

    const liveConfig = assembleLiveConfig({
      claudeDir,
      homeDir: root,
      environment: { source: 'host-launch', definedNames: ['AVAILABLE'] },
    });

    expect(liveConfig.settingsHealth.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'missing-env',
        path: 'hooks.Stop[0].command',
        environmentVariable: 'MISSING',
      }),
    ]));
    expect(liveConfig.settingsHealth.environment?.definedNames).toEqual(['AVAILABLE']);
  });

  it('validates global references against effective local environment definitions', () => {
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
      env: {
        OVERRIDDEN: '${GLOBAL_ONLY_MISSING}',
        BROKEN_OVERRIDE: 'global-value',
      },
      hooks: {
        Stop: [{
          command: '${LOCAL_ONLY} ${CHAINED} ${OVERRIDDEN} ${BROKEN_OVERRIDE}',
        }],
      },
    }));
    writeFileSync(join(claudeDir, 'settings.local.json'), JSON.stringify({
      env: {
        LOCAL_ONLY: 'configured-locally',
        CHAINED: '${HOST_ROOT}',
        OVERRIDDEN: 'configured-locally',
        BROKEN_OVERRIDE: '${MISSING_DEPENDENCY}',
      },
    }));

    const liveConfig = assembleLiveConfig({
      claudeDir,
      homeDir: root,
      environment: { source: 'host-launch', definedNames: ['HOST_ROOT'] },
    });
    const missingFindings = liveConfig.settingsHealth.findings
      .filter((finding) => finding.kind === 'missing-env');
    const missingNames = missingFindings
      .map((finding) => finding.environmentVariable);

    expect(missingFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'env.BROKEN_OVERRIDE',
        environmentVariable: 'MISSING_DEPENDENCY',
        sourcePath: '~/.claude/settings.local.json',
      }),
    ]));
    expect(missingNames).not.toEqual(expect.arrayContaining([
      'GLOBAL_ONLY_MISSING',
      'LOCAL_ONLY',
      'CHAINED',
      'OVERRIDDEN',
      'BROKEN_OVERRIDE',
    ]));
    expect(JSON.stringify(liveConfig.settingsHealth)).not.toContain(
      'configured-locally'
    );
  });

  it('validates every local finding class when global settings also exist', () => {
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
      model: 'claude-opus-4-8',
      env: { GLOBAL_TOKEN: 'configured-globally' },
    }));
    writeFileSync(join(claudeDir, 'settings.local.json'), JSON.stringify({
      model: 42,
      permisions: {},
      permissions: { allow: ['not a rule!'] },
      hooks: {
        Stop: [{
          hooks: [{ type: 'command', command: '${LOCAL_HOOK_MISSING}' }],
        }],
      },
    }));

    const liveConfig = assembleLiveConfig({
      claudeDir,
      homeDir: root,
      environment: { source: 'host-launch', definedNames: [] },
    });
    const localFindings = liveConfig.settingsHealth.findings.filter(
      (finding) => finding.sourcePath === '~/.claude/settings.local.json'
    );

    expect(localFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'type', path: 'model' }),
      expect.objectContaining({ kind: 'unknown-key', path: 'permisions' }),
      expect.objectContaining({
        kind: 'rule-format',
        path: 'permissions.allow[0]',
      }),
      expect.objectContaining({
        kind: 'missing-env',
        path: 'hooks.Stop[0].hooks[0].command',
        environmentVariable: 'LOCAL_HOOK_MISSING',
      }),
    ]));
  });

  it('sanitizes malformed local settings when global settings also exist', () => {
    const sentinel = 'local-global-pair-secret-sentinel';
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
      model: 'claude-opus-4-8',
    }));
    writeFileSync(
      join(claudeDir, 'settings.local.json'),
      `{"env":{"TOKEN":"${sentinel}",}}`
    );

    const liveConfig = assembleLiveConfig({
      claudeDir,
      homeDir: root,
      environment: { source: 'host-launch', definedNames: [] },
    });

    expect(liveConfig.settingsHealth.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'syntax',
        sourcePath: '~/.claude/settings.local.json',
        message: 'Invalid JSON syntax; repair the document and retry.',
      }),
    ]));
    const recommendation = settingsJsonInvalidDetector.rule({
      tokenData: [],
      toolData: [],
      sessions: [],
      projects: [],
      permissionRows: [],
      apiErrors: [],
      liveConfig,
    } as RecommendationInput, 0);
    expect(recommendation).not.toBeNull();
    expect(JSON.stringify({
      health: liveConfig.settingsHealth,
      recommendation,
    })).not.toContain(sentinel);
  });

  it('retains unresolved cycles that exist only in local environment definitions', () => {
    writeFileSync(join(claudeDir, 'settings.local.json'), JSON.stringify({
      env: {
        LOCAL_CYCLE_A: '${LOCAL_CYCLE_B}',
        LOCAL_CYCLE_B: '${LOCAL_CYCLE_A}',
      },
    }));

    const liveConfig = assembleLiveConfig({
      claudeDir,
      homeDir: root,
      environment: { source: 'host-launch', definedNames: [] },
    });

    expect(liveConfig.settingsHealth).toMatchObject({
      filePath: '~/.claude/settings.local.json',
      present: true,
    });
    expect(liveConfig.settingsHealth.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'missing-env',
        path: 'env.LOCAL_CYCLE_A',
        environmentVariable: 'LOCAL_CYCLE_B',
        sourcePath: '~/.claude/settings.local.json',
      }),
      expect.objectContaining({
        kind: 'missing-env',
        path: 'env.LOCAL_CYCLE_B',
        environmentVariable: 'LOCAL_CYCLE_A',
        sourcePath: '~/.claude/settings.local.json',
      }),
    ]));
  });

  it('keeps the observed environment scan stack-safe for deeply nested settings', () => {
    writeFileSync(
      join(claudeDir, 'settings.json'),
      `{"futureSetting":${'['.repeat(20_000)}"literal"${']'.repeat(20_000)}}`
    );

    expect(() => assembleLiveConfig({
      claudeDir,
      homeDir: root,
      environment: { source: 'host-launch', definedNames: [] },
    })).not.toThrow();
  });

  it('resolves a reverse-ordered environment chain within a practical work bound', {
    timeout: 15_000,
  }, () => {
    const env: Record<string, string> = {};
    for (let index = 2_999; index >= 0; index -= 1) {
      env[`V${index}`] = index === 0
        ? '${HOST_ROOT}'
        : '${V' + (index - 1) + '}';
    }
    const raw = JSON.stringify({
      env,
      hooks: { Stop: [{ command: '${V2999}' }] },
    });
    expect(Buffer.byteLength(raw)).toBeLessThan(1_048_576);
    writeFileSync(join(claudeDir, 'settings.json'), raw);

    const startedAt = performance.now();
    const liveConfig = assembleLiveConfig({
      claudeDir,
      homeDir: root,
      environment: { source: 'host-launch', definedNames: ['HOST_ROOT'] },
    });
    const elapsedMs = performance.now() - startedAt;

    expect(liveConfig.settingsHealth.findings).toEqual([]);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('serializes environment names without retaining values and suppresses unknown containers', () => {
    const direct = hostEnvironmentObservation({
      SAFE_NAME: 'super-secret-value',
      OTHER_NAME: 'another-secret',
    });
    expect(direct?.definedNames).toEqual(['OTHER_NAME', 'SAFE_NAME']);
    expect(JSON.stringify(direct)).not.toContain('super-secret-value');
    expect(JSON.stringify(direct)).not.toContain('another-secret');

    expect(hostEnvironmentObservation({ CHD_CONTAINERIZED: '1' })).toBeUndefined();
    expect(hostEnvironmentObservation({
      CHD_CONTAINERIZED: '1',
      CHD_HOST_ENV_NAMES: '["HOST_ONLY","HOST_ONLY","bad-name"]',
      CONTAINER_SECRET: 'must-not-leak',
    })?.definedNames).toEqual(['HOST_ONLY']);
  });

  it('builds a deterministic names-only cache signature with explicit unavailable states', () => {
    const a = { source: 'host-launch' as const, definedNames: ['ZED', 'ALPHA'] };
    const b = { source: 'host-launch' as const, definedNames: ['ALPHA', 'ZED'] };
    expect(hostEnvironmentObservationSignature(a, false)).toBe(
      hostEnvironmentObservationSignature(b, false)
    );
    expect(hostEnvironmentObservationSignature(a, false)).not.toContain('secret-value');
    expect(hostEnvironmentObservationSignature(undefined, false)).toBe('unavailable');
    expect(hostEnvironmentObservationSignature(a, true)).toBe('scoped');
  });
  let root: string;
  let claudeDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chd-config-'));
    claudeDir = join(root, '.claude');
    mkdirSync(claudeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads the current merged Stop-hook gate without scanning the full config bundle', () => {
    expect(readStopHookConfigState({ claudeDir, homeDir: root })).toBe('inactive');

    writeFileSync(
      join(claudeDir, 'settings.local.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'notify' }] }] } })
    );
    expect(readStopHookConfigState({ claudeDir, homeDir: root })).toBe('configured');

    writeFileSync(join(claudeDir, 'settings.local.json'), '{invalid');
    expect(readStopHookConfigState({ claudeDir, homeDir: root })).toBe('inactive');
  });

  it('includes readable project-only Stop hooks and fails closed on malformed project settings', () => {
    const projectRoot = join(root, 'repo-stop-hook');
    const projectClaudeDir = join(projectRoot, '.claude');
    const projectSettings = join(projectClaudeDir, 'settings.json');
    mkdirSync(projectClaudeDir, { recursive: true });
    writeFileSync(
      projectSettings,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'notify' }] }] } })
    );

    const options = { claudeDir, homeDir: root, projectRoots: [projectRoot] };
    expect(readStopHookConfigState(options)).toBe('configured');
    expect(assembleLiveConfig(options).projectSettings?.[projectRoot]).toBeDefined();

    writeFileSync(projectSettings, '{invalid');
    expect(readStopHookConfigState(options)).toBe('inactive');
    expect(assembleLiveConfig(options).projectSettings?.[projectRoot]).toBeUndefined();
  });

  it.each([
    {
      fileName: 'settings.local.json',
      displayPath: '~/.claude/settings.local.json',
      raw: '{"env":{"TOKEN":"local-quoted-sentinel",}}',
      sentinel: 'local-quoted-sentinel',
    },
    {
      fileName: 'settings.local.json',
      displayPath: '~/.claude/settings.local.json',
      raw: '{"env":{"TOKEN":LOCAL_UNQUOTED_SENTINEL}}',
      sentinel: 'LOCAL_UNQUOTED_SENTINEL',
    },
    {
      fileName: 'settings.json',
      displayPath: '~/.claude/settings.json',
      raw: '{"env":{"TOKEN":"global-quoted-sentinel",}}',
      sentinel: 'global-quoted-sentinel',
    },
  ])('does not serialize raw input from malformed $fileName', ({
    fileName,
    displayPath,
    raw,
    sentinel,
  }) => {
    writeFileSync(join(claudeDir, fileName), raw);

    const liveConfig = assembleLiveConfig({
      claudeDir,
      homeDir: root,
      environment: { source: 'host-launch', definedNames: [] },
    });
    const [finding] = liveConfig.settingsHealth.findings;

    expect(liveConfig.settingsHealth).toMatchObject({
      filePath: displayPath,
      present: true,
      ok: false,
    });
    expect(finding).toMatchObject({
      kind: 'syntax',
      severity: 'error',
      message: 'Invalid JSON syntax; repair the document and retry.',
      sourcePath: displayPath,
    });
    expect(finding).not.toHaveProperty('excerpt');
    expect(JSON.stringify(liveConfig.settingsHealth)).not.toContain(sentinel);
  });

  it('skips oversized optional config files while keeping bounded config inputs', () => {
    mkdirSync(join(claudeDir, 'skills', 'small-skill'), { recursive: true });
    mkdirSync(join(claudeDir, 'skills', 'huge-skill'), { recursive: true });
    mkdirSync(join(claudeDir, 'plugins'), { recursive: true });

    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ model: 'claude-opus-4-8', note: 'x'.repeat(2_000) })
    );
    writeFileSync(
      join(claudeDir, 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Bash(git status:*)'] } })
    );
    writeFileSync(join(claudeDir, 'CLAUDE.md'), 'x'.repeat(2_000));
    writeFileSync(join(root, '.claude.json'), JSON.stringify({ mcpServers: { huge: {} }, pad: 'x'.repeat(2_000) }));
    writeFileSync(
      join(claudeDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { huge: [{ scope: 'user', version: '1.0.0' }] }, pad: 'x'.repeat(2_000) })
    );
    writeFileSync(
      join(claudeDir, 'skills', 'small-skill', 'SKILL.md'),
      '---\ndescription: Small bounded skill\n---\n'
    );
    writeFileSync(
      join(claudeDir, 'skills', 'huge-skill', 'SKILL.md'),
      `---\ndescription: ${'x'.repeat(2_000)}\n---\n`
    );

    const liveConfig = assembleLiveConfig({
      claudeDir,
      homeDir: root,
      configFileMaxBytes: 1_024,
    });

    expect(liveConfig.settings.model).toBeUndefined();
    expect(liveConfig.settings.permissions).toEqual({
      allow: ['Bash(git status:*)'],
    });
    expect(liveConfig.claudeMd.global).toBeNull();
    expect(liveConfig.mcpServers).toEqual([]);
    expect(liveConfig.plugins).toEqual([]);
    expect(liveConfig.skills.map((skill) => skill.id).sort()).toEqual([
      'huge-skill',
      'small-skill',
    ]);
    expect(liveConfig.skills.find((skill) => skill.id === 'small-skill')).toEqual({
      id: 'small-skill',
      scope: 'user',
      path: join(claudeDir, 'skills', 'small-skill'),
      description: 'Small bounded skill',
    });
    expect(liveConfig.skills.find((skill) => skill.id === 'huge-skill')).toEqual({
      id: 'huge-skill',
      scope: 'user',
      path: join(claudeDir, 'skills', 'huge-skill'),
    });
  });

  it('caps live config resource directory reads before full-directory sorting', () => {
    const pluginRoot = join(claudeDir, 'plugins', 'cache', 'plug');
    mkdirSync(join(claudeDir, 'skills', 'a-skill'), { recursive: true });
    mkdirSync(join(claudeDir, 'skills', 'b-skill'), { recursive: true });
    mkdirSync(join(claudeDir, 'agents'), { recursive: true });
    mkdirSync(join(claudeDir, 'commands'), { recursive: true });
    mkdirSync(join(claudeDir, 'plugins'), { recursive: true });
    mkdirSync(join(pluginRoot, 'skills', 'a-plugin-skill'), { recursive: true });
    mkdirSync(join(pluginRoot, 'skills', 'b-plugin-skill'), { recursive: true });
    mkdirSync(join(pluginRoot, 'agents'), { recursive: true });
    mkdirSync(join(pluginRoot, 'commands'), { recursive: true });

    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ enabledPlugins: { alpha: true, beta: true } })
    );
    writeFileSync(
      join(root, '.claude.json'),
      JSON.stringify({
        mcpServers: { alpha: {}, beta: {} },
        projects: {
          '/repo/a': { mcpServers: { projectAlpha: {}, projectBeta: {} } },
        },
      })
    );
    writeFileSync(
      join(claudeDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          alpha: [{ scope: 'user', version: '1.0.0', installPath: pluginRoot }],
          beta: [{ scope: 'user', version: '1.0.0', installPath: pluginRoot }],
        },
      })
    );
    writeFileSync(join(claudeDir, 'agents', 'a-agent.md'), '# agent a\n');
    writeFileSync(join(claudeDir, 'agents', 'b-agent.md'), '# agent b\n');
    writeFileSync(join(claudeDir, 'commands', 'a-command.md'), '# command a\n');
    writeFileSync(join(claudeDir, 'commands', 'b-command.md'), '# command b\n');
    writeFileSync(
      join(pluginRoot, 'agents', 'a-plugin-agent.md'),
      '# plugin agent a\n'
    );
    writeFileSync(
      join(pluginRoot, 'agents', 'b-plugin-agent.md'),
      '# plugin agent b\n'
    );
    writeFileSync(
      join(pluginRoot, 'commands', 'a-plugin-command.md'),
      '# plugin command a\n'
    );
    writeFileSync(
      join(pluginRoot, 'commands', 'b-plugin-command.md'),
      '# plugin command b\n'
    );

    const liveConfig = assembleLiveConfig({
      claudeDir,
      homeDir: root,
      configResourceMaxEntries: 1,
    });

    expect(liveConfig.skills).toHaveLength(1);
    expect(['a-skill', 'b-skill']).toContain(liveConfig.skills[0]?.id);
    expect(liveConfig.subagents).toHaveLength(1);
    expect(['a-agent', 'b-agent']).toContain(liveConfig.subagents[0]?.id);
    expect(liveConfig.commands).toHaveLength(1);
    expect(['a-command', 'b-command']).toContain(liveConfig.commands[0]?.id);
    expect(liveConfig.plugins.map((plugin) => plugin.id)).toEqual(['alpha']);
    expect(liveConfig.plugins[0]?.bundled?.agents).toHaveLength(1);
    expect(['a-plugin-agent', 'b-plugin-agent']).toContain(
      liveConfig.plugins[0]?.bundled?.agents?.[0]
    );
    expect(liveConfig.plugins[0]?.bundled?.commands).toHaveLength(1);
    expect(['a-plugin-command', 'b-plugin-command']).toContain(
      liveConfig.plugins[0]?.bundled?.commands?.[0]
    );
    expect(liveConfig.plugins[0]?.bundled?.skills).toHaveLength(1);
    expect(['a-plugin-skill', 'b-plugin-skill']).toContain(
      liveConfig.plugins[0]?.bundled?.skills?.[0]
    );
    expect(liveConfig.mcpServers.map((server) => server.id)).toEqual(['alpha']);
  });

  it('preserves configured hook provenance when merging global and local settings', () => {
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'echo global' }],
            },
          ],
        },
      })
    );
    writeFileSync(
      join(claudeDir, 'settings.local.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Edit|Write',
              hooks: [{ type: 'command', command: 'echo local' }],
            },
          ],
        },
      })
    );

    const liveConfig = assembleLiveConfig({ claudeDir, homeDir: root });

    expect(liveConfig.settings.hooks?.PreToolUse).toEqual([
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'echo global' }],
        source: 'global',
      },
      {
        matcher: 'Edit|Write',
        hooks: [{ type: 'command', command: 'echo local' }],
        source: 'local',
      },
    ]);
  });

  it('reads project-scoped Claude resources from configured project roots (#1063)', () => {
    const projectRoot = join(root, 'repo-a');
    mkdirSync(join(projectRoot, '.claude', 'skills', 'project-skill'), {
      recursive: true,
    });
    mkdirSync(join(projectRoot, '.claude', 'agents'), { recursive: true });
    mkdirSync(join(projectRoot, '.claude', 'commands'), { recursive: true });
    writeFileSync(
      join(root, '.claude.json'),
      JSON.stringify({ projects: { [projectRoot]: {} } })
    );
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# Repo guidance\n');
    writeFileSync(
      join(projectRoot, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'] } })
    );
    writeFileSync(
      join(projectRoot, '.claude', 'skills', 'project-skill', 'SKILL.md'),
      '---\ndescription: Project-only test skill\n---\n'
    );
    writeFileSync(
      join(projectRoot, '.claude', 'agents', 'project-agent.md'),
      '# Project agent\n'
    );
    writeFileSync(
      join(projectRoot, '.claude', 'commands', 'project-command.md'),
      '# Project command\n'
    );

    const liveConfig = assembleLiveConfig({ claudeDir, homeDir: root });

    expect(liveConfig.claudeMd.perProject[projectRoot]).toBe('# Repo guidance\n');
    expect(liveConfig.projectSettings?.[projectRoot]?.permissions).toEqual({
      allow: ['Bash(npm test:*)'],
    });
    expect(liveConfig.skills).toContainEqual({
      id: 'project-skill',
      scope: 'project',
      projectPath: projectRoot,
      path: join(projectRoot, '.claude', 'skills', 'project-skill'),
      description: 'Project-only test skill',
    });
    expect(liveConfig.subagents).toContainEqual({
      id: 'project-agent',
      scope: 'project',
      projectPath: projectRoot,
      path: join(projectRoot, '.claude', 'agents', 'project-agent.md'),
    });
    expect(liveConfig.commands).toContainEqual({
      id: 'project-command',
      scope: 'project',
      projectPath: projectRoot,
      path: join(projectRoot, '.claude', 'commands', 'project-command.md'),
    });
  });

  it('does not read project roots while scoped ingest is active (#1063)', () => {
    const projectRoot = join(root, 'repo-scoped');
    mkdirSync(join(projectRoot, '.claude', 'commands'), { recursive: true });
    writeFileSync(
      join(root, '.claude.json'),
      JSON.stringify({ projects: { [projectRoot]: {} } })
    );
    writeFileSync(
      join(projectRoot, '.claude', 'commands', 'project-command.md'),
      '# Project command\n'
    );

    const liveConfig = assembleLiveConfig({
      claudeDir,
      homeDir: root,
      scoped: true,
    });

    expect(liveConfig.commands).toEqual([]);
    expect(liveConfig.claudeMd.perProject).toEqual({});
    expect(liveConfig.projectSettings).toEqual({});
  });

  // ── #2500 reference integrity: host-side existence at ingest ──────────────

  it('annotates hook commands with a timestamped present/missing path state (#2553)', () => {
    mkdirSync(join(claudeDir, 'hooks'), { recursive: true });
    writeFileSync(join(claudeDir, 'hooks', 'present.mjs'), '// hook\n');
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command:
                    'node ~/.claude/hooks/present.mjs && node ~/.claude/hooks/gone.mjs',
                },
              ],
            },
          ],
        },
      })
    );

    const liveConfig = assembleLiveConfig({
      claudeDir,
      homeDir: root,
      now: () => new Date('2026-07-15T02:03:04.000Z'),
    });
    const refs = liveConfig.settings.hooks?.Stop?.[0]?.hooks?.[0]?.referencedPaths;
    expect(refs).toEqual([
      {
        path: '~/.claude/hooks/present.mjs',
        state: 'present',
        checkedAt: '2026-07-15T02:03:04.000Z',
      },
      {
        path: '~/.claude/hooks/gone.mjs',
        state: 'missing',
        checkedAt: '2026-07-15T02:03:04.000Z',
      },
    ]);
  });

  it('distinguishes reachable from unavailable hook-script symlink targets (#2553)', () => {
    const externalSkill = join(root, '.agents', 'skills', 'hook-tools');
    mkdirSync(externalSkill, { recursive: true });
    writeFileSync(join(externalSkill, 'present.mjs'), '// hook\n');
    mkdirSync(join(claudeDir, 'skills'), { recursive: true });
    mkdirSync(join(claudeDir, 'hooks'), { recursive: true });
    symlinkSync('../../.agents/skills/hook-tools', join(claudeDir, 'skills', 'hook-tools'));
    symlinkSync('../../.agents/skills/unmounted', join(claudeDir, 'skills', 'unmounted'));
    symlinkSync(
      join(root, '.agents', 'hooks', 'unmounted.mjs'),
      join(claudeDir, 'hooks', 'dangling.mjs')
    );
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [{
            hooks: [{
              type: 'command',
              command: [
                'node ~/.claude/skills/hook-tools/present.mjs',
                'node ~/.claude/skills/hook-tools/gone.mjs',
                'node ~/.claude/skills/unmounted/run.mjs',
                'node ~/.claude/hooks/dangling.mjs',
              ].join(' && '),
            }],
          }],
        },
      })
    );

    const refs = assembleLiveConfig({
      claudeDir,
      homeDir: root,
      now: () => new Date('2026-07-15T02:03:04.000Z'),
    }).settings.hooks?.Stop?.[0]?.hooks?.[0]?.referencedPaths;

    expect(refs).toEqual([
      expect.objectContaining({
        path: '~/.claude/skills/hook-tools/present.mjs',
        state: 'present',
      }),
      expect.objectContaining({
        path: '~/.claude/skills/hook-tools/gone.mjs',
        state: 'missing',
      }),
      expect.objectContaining({
        path: '~/.claude/skills/unmounted/run.mjs',
        state: 'unverifiable',
      }),
      expect.objectContaining({
        path: '~/.claude/hooks/dangling.mjs',
        state: 'unverifiable',
      }),
    ]);
  });

  it('does not annotate unverifiable ($VAR-opaque) hook commands (#2500)', () => {
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            // $MY_TOOL is opaque; $CLAUDE_PROJECT_DIR is unresolvable in GLOBAL
            // settings (no project root) — both must be skipped, never flagged.
            { hooks: [{ type: 'command', command: '"$MY_TOOL" $CLAUDE_PROJECT_DIR/x.sh' }] },
          ],
        },
      })
    );

    const liveConfig = assembleLiveConfig({
      claudeDir,
      homeDir: root,
      now: () => new Date('2026-07-15T02:03:04.000Z'),
    });
    expect(
      liveConfig.settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.referencedPaths
    ).toBeUndefined();
  });

  it('resolves $CLAUDE_PROJECT_DIR for project-scoped hooks against the project root (#2500)', () => {
    const projectRoot = join(root, 'repo-hooks');
    mkdirSync(join(projectRoot, '.claude', 'hooks'), { recursive: true });
    writeFileSync(join(projectRoot, '.claude', 'hooks', 'present.sh'), '# hook\n');
    writeFileSync(
      join(root, '.claude.json'),
      JSON.stringify({ projects: { [projectRoot]: {} } })
    );
    writeFileSync(
      join(projectRoot, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              hooks: [
                { type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/present.sh' },
                { type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/gone.sh' },
              ],
            },
          ],
        },
      })
    );

    const liveConfig = assembleLiveConfig({
      claudeDir,
      homeDir: root,
      now: () => new Date('2026-07-15T02:03:04.000Z'),
    });
    const group = liveConfig.projectSettings?.[projectRoot]?.hooks?.PostToolUse?.[0];
    expect(group?.hooks?.[0]?.referencedPaths).toEqual([
      {
        path: '$CLAUDE_PROJECT_DIR/.claude/hooks/present.sh',
        state: 'present',
        checkedAt: '2026-07-15T02:03:04.000Z',
      },
    ]);
    expect(group?.hooks?.[1]?.referencedPaths).toEqual([
      {
        path: '$CLAUDE_PROJECT_DIR/.claude/hooks/gone.sh',
        state: 'missing',
        checkedAt: '2026-07-15T02:03:04.000Z',
      },
    ]);
  });

  it('flags a skill SKILL.md reference to a removed bundled path, keeping present ones (#2500)', () => {
    mkdirSync(join(claudeDir, 'skills', 'my-skill', 'references'), { recursive: true });
    writeFileSync(join(claudeDir, 'skills', 'my-skill', 'references', 'here.md'), 'ok\n');
    writeFileSync(
      join(claudeDir, 'skills', 'my-skill', 'SKILL.md'),
      [
        '---',
        'description: Test skill',
        '---',
        'See [the guide](references/here.md) and run `scripts/gone.py`.',
        'Also read [missing](references/gone.md).',
        'External [link](https://example.com/x.md) must be ignored.',
      ].join('\n')
    );

    const liveConfig = assembleLiveConfig({ claudeDir, homeDir: root });
    const found = liveConfig.skills.find((s) => s.id === 'my-skill');
    expect(found?.danglingRefs?.sort()).toEqual(['references/gone.md', 'scripts/gone.py']);
  });

  it('leaves danglingRefs absent for a skill whose references all resolve (#2500)', () => {
    mkdirSync(join(claudeDir, 'skills', 'clean-skill', 'scripts'), { recursive: true });
    writeFileSync(join(claudeDir, 'skills', 'clean-skill', 'scripts', 'run.sh'), '# ok\n');
    writeFileSync(
      join(claudeDir, 'skills', 'clean-skill', 'SKILL.md'),
      '---\ndescription: Clean skill\n---\nRun `scripts/run.sh`.\n'
    );

    const liveConfig = assembleLiveConfig({ claudeDir, homeDir: root });
    const found = liveConfig.skills.find((s) => s.id === 'clean-skill');
    expect(found?.danglingRefs).toBeUndefined();
  });
});
