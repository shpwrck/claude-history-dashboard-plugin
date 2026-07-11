import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleLiveConfig } from './config-loader';

describe('assembleLiveConfig', () => {
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

  it('annotates hook commands with each referenced path and its existence (#2500)', () => {
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

    const liveConfig = assembleLiveConfig({ claudeDir, homeDir: root });
    const refs = liveConfig.settings.hooks?.Stop?.[0]?.hooks?.[0]?.referencedPaths;
    expect(refs).toEqual([
      { path: '~/.claude/hooks/present.mjs', exists: true },
      { path: '~/.claude/hooks/gone.mjs', exists: false },
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

    const liveConfig = assembleLiveConfig({ claudeDir, homeDir: root });
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

    const liveConfig = assembleLiveConfig({ claudeDir, homeDir: root });
    const group = liveConfig.projectSettings?.[projectRoot]?.hooks?.PostToolUse?.[0];
    expect(group?.hooks?.[0]?.referencedPaths).toEqual([
      { path: '$CLAUDE_PROJECT_DIR/.claude/hooks/present.sh', exists: true },
    ]);
    expect(group?.hooks?.[1]?.referencedPaths).toEqual([
      { path: '$CLAUDE_PROJECT_DIR/.claude/hooks/gone.sh', exists: false },
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
