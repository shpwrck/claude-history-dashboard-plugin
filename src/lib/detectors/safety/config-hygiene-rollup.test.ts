import { describe, it, expect } from 'vitest';
import { detector } from './config-hygiene-rollup';
import { buildRecommendations } from '../../recommendations';
import type { RecommendationInput } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 5, 1, 0, 0, 0);

function liveConfig(over: Record<string, unknown> = {}): NonNullable<RecommendationInput['liveConfig']> {
  return {
    settings: {},
    settingsHealth: null,
    claudeMd: { global: null, perProject: {} },
    plugins: [],
    mcpServers: [],
    skills: [],
    subagents: [],
    commands: [],
    ...over,
  } as unknown as NonNullable<RecommendationInput['liveConfig']>;
}

// Two sessions ~40 days apart so the data window exceeds the 30-day threshold
// (no hedge). Empty attribution → every resource is unused.
const wideSessions = [
  { sessionId: 's-old', startTime: NOW - 40 * DAY_MS },
  { sessionId: 's-new', startTime: NOW - 1 * DAY_MS },
];

function input(over: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: wideSessions as unknown as RecommendationInput['sessions'],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    attribution: [],
    liveConfig: liveConfig({
      mcpServers: [
        { id: 'server-a', scope: 'global' },
        { id: 'server-b', scope: 'global' },
      ],
      plugins: [
        { id: 'plug-a', scope: 'global', bundled: { skills: ['plug-a-skill'], agents: [] } },
      ],
    }),
    ...over,
  };
}

describe('safety.config-hygiene-rollup (#1164)', () => {
  it('rolls unused mcpServer/plugin findings into one rec that flows through buildRecommendations()', () => {
    const recs = buildRecommendations(input(), NOW);
    const rollup = recs.filter((r) => r.id === 'safety.config-hygiene-rollup');
    expect(rollup).toHaveLength(1); // ONE summary card
    expect(rollup[0].category).toBe('safety');
    expect(rollup[0].affected).toBe(3); // 2 mcp + 1 plugin
    expect(rollup[0].detail).toMatch(/2 MCP server\(s\)/);
    expect(rollup[0].detail).toMatch(/1 plugin\(s\)/);
  });

  it('does NOT emit families covered by workflow.unused-installed-* (no double-count)', () => {
    // Unused skills/subagents/commands present, but NO mcp/plugin → rollup stays silent.
    const rec = detector.rule(
      input({
        liveConfig: liveConfig({
          skills: [{ id: 'skill-x', scope: 'global' }],
          subagents: [{ id: 'agent-x', scope: 'global' }],
          commands: [{ id: 'cmd-x', scope: 'global' }],
        }),
      }),
      NOW,
    );
    expect(rec).toBeNull();
    // And when it does fire, evidence references only mcpServer/plugin.
    const fired = detector.rule(input(), NOW)!;
    expect(fired.evidence?.every((e) => /^(mcpServer|plugin)\b/.test(e))).toBe(true);
  });

  it('carries auditable provenance citing config-hygiene', () => {
    const rec = detector.rule(input(), NOW)!;
    expect(rec.provenance?.observations[0].source).toBe('config-hygiene');
    expect(rec.provenance?.asOf).toBe('2026-06-01');
    expect(rec.provenance?.stale).toBeUndefined(); // wide window → not stale
  });

  it('demotes wording and marks provenance stale when the data window is short', () => {
    const rec = detector.rule(
      input({ sessions: [{ sessionId: 's1', startTime: NOW - 2 * DAY_MS }] as unknown as RecommendationInput['sessions'] }),
      NOW,
    )!;
    expect(rec.detail).toMatch(/provisional/i);
    expect(rec.provenance?.stale).toBe(true);
  });

  it('stays quiet below the minimum (one unused resource)', () => {
    const rec = detector.rule(
      input({ liveConfig: liveConfig({ mcpServers: [{ id: 'lonely', scope: 'global' }] }) }),
      NOW,
    );
    expect(rec).toBeNull();
  });

  it('returns null with no liveConfig', () => {
    expect(detector.rule(input({ liveConfig: null }), NOW)).toBeNull();
  });

  it('counts a server as used when attribution shows an invocation in-window', () => {
    const rec = detector.rule(
      input({
        attribution: [
          { sessionId: 's-new', agents: {}, skills: {}, mcpServers: { 'server-a': { invocations: 4 } }, mcpTools: {} },
        ] as unknown as RecommendationInput['attribution'],
      }),
      NOW,
    );
    // server-a now used → only server-b + plug-a remain (2) → still fires, affected 2.
    expect(rec?.affected).toBe(2);
  });
});
