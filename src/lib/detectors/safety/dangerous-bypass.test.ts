import { describe, expect, it } from 'vitest';
import { detector } from './dangerous-bypass';
import {
  DANGEROUS_ASK_RULES,
  DANGEROUS_DENY_RULES,
} from '../shared';
import type { RecommendationInput } from '../types';
import type { LiveConfig, SessionTokenData } from '../../../types';
import type { ToolCall, ToolUsageData } from '../../parse-tools';

const ts = (i: number) => `2026-06-12T10:00:0${i}.000Z`;

function bash(command: string, sessionId = 'session-1', index = 0): ToolUsageData {
  const call: ToolCall = {
    timestamp: ts(index),
    toolName: 'Bash',
    input: { command },
    toolUseId: `tool-${index}`,
    isError: null,
    resultBytes: 0,
  };
  return { sessionId, calls: [call] };
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
  permissions: NonNullable<LiveConfig['settings']>['permissions']
): LiveConfig {
  return { settings: { permissions }, mcpServers: [] } as unknown as LiveConfig;
}

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

describe('safety.dangerous-bypass', () => {
  it('flags destructive commands that ran under bypassPermissions', () => {
    const rec = detector.rule(
      input({
        toolData: [bash('rm -rf /tmp/build-output')],
        permissionRows: [{ sessionId: 'session-1', mode: 'bypassPermissions' }],
      }),
      0
    );

    expect(rec).toMatchObject({
      id: 'safety.dangerous-bypass',
      category: 'safety',
      severity: 'critical',
      affected: 1,
      view: 'permissions',
      fix: {
        target: 'settings.json',
        label: 'Add destructive-command deny rules',
      },
    });
    expect(rec?.evidence?.[0]).toContain('session-');
    expect(rec?.evidence?.[0]).toContain('rm -rf');
    expect(rec?.fix?.snippet).toContain('"deny"');
    expect(rec?.fix?.snippet).toContain('"Bash(rm -rf:*)"');
  });

  it('emits the warning-only dangerous-commands variant outside bypass mode', () => {
    const rec = detector.rule(input({ toolData: [bash('git reset --hard HEAD~1')] }), 0);

    expect(rec).toMatchObject({
      id: 'safety.dangerous-commands',
      category: 'safety',
      severity: 'warning',
      affected: 1,
      fix: {
        target: 'settings.json',
        label: 'Confirm before destructive commands',
      },
    });
    expect(rec?.fix?.snippet).toContain('"ask"');
    expect(rec?.fix?.snippet).toContain('"Bash(git reset --hard:*)"');
  });

  it('stays silent on benign commands and when the canonical fixes are already applied', () => {
    expect(detector.rule(input({ toolData: [bash('git status --short')] }), 0)).toBeNull();

    expect(
      detector.rule(
        input({
          toolData: [bash('rm -rf /tmp/build-output')],
          permissionRows: [{ sessionId: 'session-1', mode: 'bypassPermissions' }],
          liveConfig: liveConfig({ deny: DANGEROUS_DENY_RULES }),
        }),
        0
      )
    ).toBeNull();

    expect(
      detector.rule(
        input({
          toolData: [bash('git reset --hard HEAD~1')],
          liveConfig: liveConfig({ ask: DANGEROUS_ASK_RULES }),
        }),
        0
      )
    ).toBeNull();
  });

  it('marks unattended dangerous sessions without inventing a higher severity', () => {
    const rec = detector.rule(
      input({
        toolData: [bash('rm -rf /tmp/build-output')],
        tokenData: [tokenSession('session-1', 'sdk-py')],
        permissionRows: [{ sessionId: 'session-1', mode: 'bypassPermissions' }],
      }),
      0
    );

    expect(rec?.id).toBe('safety.dangerous-bypass');
    expect(rec?.severity).toBe('critical');
    expect(rec?.unattended).toBe(true);
  });
});
