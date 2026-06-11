// Coverage guard for the marketing SPA's sample data (issue #526).
//
// The synthetic corpus in scripts/sample-data/build-corpus.mjs has to feed
// EVERY dashboard section. This suite runs the real parsers over it and asserts
// each comes back non-empty — and that the hand-injected signals (compaction,
// >200K context peak, retry storm, dangerous commands, 429/529 api errors,
// MCP/agent/skill attribution, the four runtime subtypes, tool-manifest deltas)
// actually survive parsing. If a parser changes shape such that the corpus no
// longer lights up a view, this fails instead of the SPA silently shipping an
// empty section.

import { describe, it, expect } from 'vitest';
// @ts-expect-error - plain ESM build helper, no .d.ts
import { buildSampleCorpus } from '../../scripts/sample-data/build-corpus.mjs';

import { parseHistoryJsonl, groupBySessions, groupByProjects } from './parse-history';
import { parseSessionJsonl } from './parse-sessions';
import { parseToolUsage } from './parse-tools';
import { parseToolInventory } from './parse-tool-inventory';
import { parseSessionTimeline } from './parse-timeline';
import { parseApiErrors, aggregateToolErrors, detectRetryGroups } from './parse-errors';
import { parsePermissionData, detectDangerousCommands, rankPromptProneTools } from './parse-permissions';
import { parseAgentSettings, parseAttribution, aggregateAttributionAgents, aggregateAttributionSkills, aggregateMcpUsage } from './parse-agents';
import { parseRuntimeEvents } from './parse-runtime-events';
import { parseChurnGeometry } from './parse-churn-geometry';
import { assembleRecommendationInput, buildRecommendations } from './recommendations';

const corpus = buildSampleCorpus();
const sessionFiles: { name: string; text: string }[] = corpus.sessions.map(
  (s: { sessionId: string; jsonl: string }) => ({
    name: `${s.sessionId}.jsonl`,
    text: s.jsonl,
  })
);

function flatMap<T>(fn: (text: string, name: string) => T[]): T[] {
  return sessionFiles.flatMap((f) => fn(f.text, f.name));
}
function collect<T>(fn: (text: string, name: string) => T | null): T[] {
  return sessionFiles.map((f) => fn(f.text, f.name)).filter((d): d is T => d !== null);
}

describe('sample corpus — determinism', () => {
  it('is byte-stable across builds (seeded)', () => {
    expect(JSON.stringify(buildSampleCorpus())).toEqual(JSON.stringify(corpus));
  });
});

describe('sample corpus — history / sessions / projects', () => {
  const entries = parseHistoryJsonl(corpus.historyJsonl);
  it('has history entries', () => {
    expect(entries.length).toBeGreaterThan(10);
  });
  it('groups into sessions across multiple projects', () => {
    const sessions = groupBySessions(entries);
    const projects = groupByProjects(sessions);
    expect(sessions.length).toBeGreaterThan(5);
    expect(projects.length).toBeGreaterThanOrEqual(3);
  });
  it('every history sessionId has a matching transcript file', () => {
    const transcriptIds = new Set(corpus.sessions.map((s: { sessionId: string }) => s.sessionId));
    for (const e of entries) expect(transcriptIds.has(e.sessionId)).toBe(true);
  });
});

describe('sample corpus — tokens', () => {
  const tokenData = collect(parseSessionJsonl);
  it('parses token data for most sessions', () => {
    expect(tokenData.length).toBeGreaterThan(5);
  });
  it('includes at least one >200K context peak (over-window)', () => {
    const peak = (e: { inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }) =>
      e.inputTokens + e.cacheReadTokens + e.cacheCreationTokens;
    const maxPeak = Math.max(
      ...tokenData.flatMap((t) => t.entries.map(peak))
    );
    expect(maxPeak).toBeGreaterThan(200000);
  });
  it('detects at least one compaction event', () => {
    const compactions = tokenData.reduce((n, t) => n + t.compactionEvents.length, 0);
    expect(compactions).toBeGreaterThan(0);
  });
  it('spans multiple models and records web-search usage', () => {
    const models = new Set(tokenData.map((t) => t.model));
    expect(models.size).toBeGreaterThanOrEqual(2);
    const webSearch = tokenData.flatMap((t) => t.entries).reduce((n, e) => n + e.webSearchRequests, 0);
    expect(webSearch).toBeGreaterThan(0);
  });
  it('derives observed model-pin savings for the sample recommendations UI', () => {
    const input = assembleRecommendationInput({
      tokenData,
      toolData: [],
      sessions: [],
      projects: [],
      permissionRows: [],
      apiErrors: [],
    });
    const rec = buildRecommendations(input).find(
      (r) => r.id === 'cost.automation-share'
    );

    expect(input.modelPinSavings).toBeDefined();
    expect(rec?.savingsAttribution?.realizedSavingsUsd).toBeGreaterThan(0);
  });
});

describe('sample corpus — tools / errors / files', () => {
  const toolData = collect(parseToolUsage);
  it('parses tool calls', () => {
    expect(toolData.flatMap((t) => t.calls).length).toBeGreaterThan(20);
  });
  it('has at least one errored tool call', () => {
    expect(toolData.flatMap((t) => t.calls).some((c) => c.isError === true)).toBe(true);
  });
  it('aggregates a non-trivial tool-error rate', () => {
    expect(aggregateToolErrors(toolData).some((s) => s.errorCalls > 0)).toBe(true);
  });
  it('contains a retry storm (run of >=4 same-tool calls)', () => {
    expect(detectRetryGroups(toolData).some((g) => g.count >= 4)).toBe(true);
  });
  it('re-reads at least one file 3+ times in a session', () => {
    const reread = toolData.some((t) => {
      const counts = new Map<string, number>();
      for (const c of t.calls) {
        if (c.toolName === 'Read' && typeof c.input?.file_path === 'string') {
          counts.set(c.input.file_path, (counts.get(c.input.file_path) ?? 0) + 1);
        }
      }
      return [...counts.values()].some((n) => n >= 3);
    });
    expect(reread).toBe(true);
  });

  const apiErrors = flatMap(parseApiErrors);
  it('has native 429 and 529 api errors with retry telemetry', () => {
    const statuses = new Set(apiErrors.map((e) => e.status));
    expect(statuses.has(429)).toBe(true);
    expect(statuses.has(529)).toBe(true);
    expect(apiErrors.some((e) => typeof e.retryAttempt === 'number')).toBe(true);
  });
});

describe('sample corpus — tool inventory', () => {
  const inventories = collect(parseToolInventory);
  it('reconstructs an availability manifest with unused tools', () => {
    expect(inventories.length).toBeGreaterThan(0);
    expect(inventories.some((i) => i.unusedTools.length > 0)).toBe(true);
  });
});

describe('sample corpus — timeline', () => {
  const timelines = collect(parseSessionTimeline);
  it('builds timelines covering every entry kind', () => {
    expect(timelines.length).toBeGreaterThan(5);
    const kinds = new Set(timelines.flatMap((t) => t.entries.map((e) => e.kind)));
    for (const k of ['user', 'assistant', 'tool_use', 'tool_result', 'thinking']) {
      expect(kinds.has(k as never)).toBe(true);
    }
  });
});

describe('sample corpus — permissions', () => {
  const parsed = collect(parsePermissionData);
  const rows = parsed.flatMap((p) => p.perModeEntries);
  const changes = parsed.flatMap((p) => p.changes);
  const toolData = collect(parseToolUsage);
  it('has permission-mode rows and at least one mode change', () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(changes.some((c) => c.fromMode !== null)).toBe(true);
  });
  it('flags dangerous commands', () => {
    const dangerous = detectDangerousCommands(toolData);
    expect(dangerous.length).toBeGreaterThan(0);
    const patterns = new Set(dangerous.map((d) => d.pattern));
    expect(patterns.has('rm -rf')).toBe(true);
    expect(patterns.has('git push --force')).toBe(true);
  });
  it('ranks prompt-prone tools (a prompt-eligible session exists)', () => {
    expect(rankPromptProneTools(toolData, rows).length).toBeGreaterThan(0);
  });
});

describe('sample corpus — agents / skills / mcp / settings', () => {
  const attribution = collect(parseAttribution);
  const agentSettings = flatMap(parseAgentSettings);
  it('records agent-setting events', () => {
    expect(agentSettings.length).toBeGreaterThan(0);
  });
  it('has native agent, skill, and MCP attribution', () => {
    expect(aggregateAttributionAgents(attribution).length).toBeGreaterThan(0);
    expect(aggregateAttributionSkills(attribution).length).toBeGreaterThan(0);
    expect(aggregateMcpUsage(attribution).length).toBeGreaterThan(0);
  });
});

describe('sample corpus — runtime events', () => {
  const runtime = collect(parseRuntimeEvents);
  const timelines = collect(parseSessionTimeline);
  it('emits all four runtime subtypes', () => {
    expect(runtime.some((r) => r.turns.length > 0)).toBe(true);
    expect(runtime.some((r) => r.stopHooks.length > 0)).toBe(true);
    expect(runtime.some((r) => r.awaySummaries.length > 0)).toBe(true);
    expect(runtime.some((r) => r.scheduledFires.length > 0)).toBe(true);
  });
  it('has a stop hook that errored and prevented continuation', () => {
    const stops = runtime.flatMap((r) => r.stopHooks);
    expect(stops.some((s) => s.hadErrors)).toBe(true);
    expect(stops.some((s) => s.preventedContinuation)).toBe(true);
  });
  it('surfaces the time-motion speed finding from parsed sample data', () => {
    const rec = buildRecommendations({
      tokenData: [],
      toolData: [],
      sessions: [],
      projects: [],
      permissionRows: [],
      apiErrors: [],
      runtimeEvents: runtime,
      timelines,
    }).find((r) => r.id === 'speed.time-motion');

    expect(rec?.detail).toContain('serial Read latency');
    expect(rec?.detail).toContain('idle/AFK');
  });
});

describe('sample corpus — churn geometry', () => {
  const churnGeometry = collect(parseChurnGeometry);
  it('parses structuredPatch line geometry across a stop-hook boundary', () => {
    expect(
      churnGeometry.some((s) =>
        s.files.some((f) => f.postStopReeditRanges > 0 && f.grossLines >= 50)
      )
    ).toBe(true);
  });

  it('feeds the churn-geometry recommendation detector', () => {
    const input = assembleRecommendationInput({
      tokenData: [],
      toolData: [],
      sessions: [],
      projects: [],
      permissionRows: [],
      apiErrors: [],
      churnGeometry,
    });
    const rec = buildRecommendations(input).find(
      (r) => r.id === 'workflow.churn-geometry'
    );

    expect(rec).toBeDefined();
  });
});
