import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { defaultDataSource, resolveSources } from './sources';

describe('coding-agent data sources', () => {
  it('defaults to the existing Claude Code projects root when no source config is set', () => {
    const homeDir = '/tmp/chd-home';
    const [source] = resolveSources({ env: {}, homeDir });

    expect(source).toEqual({
      id: 'claude-code',
      harness: 'claude-code',
      historyDir: join(homeDir, '.claude', 'projects'),
      configFile: join(homeDir, '.claude.json'),
    });
  });

  it('keeps the default historyDir equal to the previous PROJECTS constant', () => {
    const env = { CLAUDE_DIR: '/var/lib/claude-data' };
    const source = defaultDataSource({ env, homeDir: '/unused' });

    expect(source.historyDir).toBe(join(env.CLAUDE_DIR, 'projects'));
  });

  it('uses CLAUDE_HOME_DIR for the default Claude Code config file', () => {
    const source = defaultDataSource({
      env: {
        CLAUDE_DIR: '/var/lib/claude-data',
        CLAUDE_HOME_DIR: '/var/lib/claude-home',
      },
      homeDir: '/unused',
    });

    expect(source.configFile).toBe('/var/lib/claude-home/.claude.json');
  });

  it('parses valid CODING_AGENT_SOURCES JSON into DataSource descriptors', () => {
    const env = {
      CODING_AGENT_SOURCES: JSON.stringify([
        {
          id: 'workstation-a',
          harness: 'claude-code',
          historyDir: './fixtures/workstation-a/projects',
          configFile: './fixtures/workstation-a/.claude.json',
        },
      ]),
    };

    expect(resolveSources({ env, homeDir: '/unused' })).toEqual([
      {
        id: 'workstation-a',
        harness: 'claude-code',
        historyDir: resolve('./fixtures/workstation-a/projects'),
        configFile: resolve('./fixtures/workstation-a/.claude.json'),
      },
    ]);
  });

  it('registers a configured push-ingest artifact root as an auxiliary source', () => {
    const sources = resolveSources({
      env: {
        CLAUDE_DIR: '/var/lib/local-claude',
        PROBAITIO_INGEST_DIR: '/var/lib/pushed-artifacts',
      },
      homeDir: '/unused',
    });

    expect(sources).toEqual([
      {
        id: 'claude-code',
        harness: 'claude-code',
        historyDir: '/var/lib/local-claude/projects',
        configFile: '/var/lib/.claude.json',
      },
      {
        id: 'probaitio-ingest',
        harness: 'claude-code',
        historyDir: '/var/lib/pushed-artifacts/projects',
        configFile: '/var/lib/pushed-artifacts/.claude.json',
      },
    ]);
  });

  it('lets push-ingest source descriptors carry an explicit harness label', () => {
    const sources = resolveSources({
      env: {
        PROBAITIO_INGEST_DIR: '/var/lib/codex-artifacts',
        PROBAITIO_INGEST_SOURCE_ID: 'codex-push',
        PROBAITIO_INGEST_HARNESS: 'codex',
      },
      homeDir: '/home/u',
    });

    expect(sources[1]).toEqual({
      id: 'codex-push',
      harness: 'codex',
      historyDir: '/var/lib/codex-artifacts/projects',
      configFile: '/var/lib/codex-artifacts/.claude.json',
    });
  });

  it('falls back to the default source when CODING_AGENT_SOURCES is malformed', () => {
    const sources = resolveSources({
      env: {
        CODING_AGENT_SOURCES: '{not json',
        CLAUDE_DIR: '/tmp/custom-claude',
      },
      homeDir: '/unused',
    });

    expect(sources).toEqual([
      {
        id: 'claude-code',
        harness: 'claude-code',
        historyDir: '/tmp/custom-claude/projects',
        configFile: '/tmp/.claude.json',
      },
    ]);
  });
});
