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
});
