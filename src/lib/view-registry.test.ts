import { describe, expect, it } from 'vitest';
import {
  filterViewDataByTime,
  VIEW_RENDERERS,
  type ViewData,
} from './view-registry';
import {
  NAV_ITEMS,
  DOMAIN_ORDER,
  isValidView,
  domainForView,
} from './nav-prefs';
import type { Session, TokenEntry, View } from '../types';
import { ALL_PROJECTS } from './routing';

const HOUR = 60 * 60 * 1000;

function historyEntry(sessionId: string, timestamp: number, project = '/repo/a') {
  return {
    display: `message ${sessionId}`,
    pastedContents: {},
    timestamp,
    project,
    sessionId,
  };
}

function session(sessionId: string, startTime: number, project = '/repo/a'): Session {
  return {
    sessionId,
    project,
    projectShort: project.split('/').pop() ?? project,
    entries: [historyEntry(sessionId, startTime, project)],
    startTime,
    endTime: startTime + HOUR,
    duration: HOUR,
    messageCount: 1,
  };
}

function tokenEntry(timestamp: string, inputTokens: number): TokenEntry {
  return {
    timestamp,
    inputTokens,
    outputTokens: 10,
    cacheCreationTokens: 1,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 2,
    webSearchRequests: 0,
    webFetchRequests: 0,
    model: 'claude-sonnet-4-5',
  };
}

function baseData(overrides: Partial<ViewData>): ViewData {
  return {
    entries: [],
    sessions: [],
    projects: [],
    tokenData: [],
    toolData: [],
    toolInventories: [],
    timelines: [],
    apiErrors: [],
    permissionRows: [],
    permissionChanges: [],
    agentSettings: [],
    attribution: [],
    runtimeEvents: [],
    churnGeometry: [],
    assistantFeatures: [],
    deceitSignals: [],
    liveConfig: null,
    repoMap: null,
    shadowCalls: null,
    memories: [],
    workflows: [],
    tasks: [],
    teams: [],
    reviewEvents: null,
    sessionRegistry: [],
    telemetry: [],
    debugLogs: [],
    statsCache: null,
    fileHistory: [],
    plans: [],
    updateResults: [],
    mcpAuth: null,
    configBackups: [],
    enterpriseSession: null,
    sampleAdoptionReceipts: [],
    ...overrides,
  };
}

describe('view registry ↔ nav catalog parity', () => {
  it('has exactly one renderer for every catalog view, and vice versa', () => {
    const catalog = new Set(NAV_ITEMS.map((i) => i.view));
    const renderers = new Set(Object.keys(VIEW_RENDERERS) as View[]);
    // Every catalog view is renderable…
    for (const v of catalog) expect(renderers.has(v)).toBe(true);
    // …and every renderer maps to a real catalog view (no orphans).
    for (const v of renderers) expect(catalog.has(v)).toBe(true);
    expect(renderers.size).toBe(catalog.size);
  });

  it('lists each view exactly once in the catalog', () => {
    const views = NAV_ITEMS.map((i) => i.view);
    expect(new Set(views).size).toBe(views.length);
  });

  it('every renderer key is a valid view', () => {
    for (const v of Object.keys(VIEW_RENDERERS)) {
      expect(isValidView(v)).toBe(true);
    }
  });
});

describe('domain structure (#490)', () => {
  it('orders safety ahead of cost in the sidebar', () => {
    expect(DOMAIN_ORDER.indexOf('safety')).toBeLessThan(
      DOMAIN_ORDER.indexOf('cost')
    );
  });

  it('keeps home first and raw last', () => {
    expect(DOMAIN_ORDER[0]).toBe('home');
    expect(DOMAIN_ORDER[DOMAIN_ORDER.length - 1]).toBe('raw');
  });

  it('demotes stats and activity into the raw drawer', () => {
    expect(domainForView('stats')).toBe('raw');
    expect(domainForView('activity')).toBe('raw');
  });

  it('puts the digest home in the home group and permissions under safety', () => {
    expect(domainForView('home')).toBe('home');
    expect(domainForView('permissions')).toBe('safety');
  });
});

describe('filterViewDataByTime', () => {
  const latest = Date.parse('2026-06-11T12:00:00.000Z');
  const within24h = latest - 6 * HOUR;
  const within7d = latest - 3 * 24 * HOUR;
  const older = latest - 20 * 24 * HOUR;

  const data = baseData({
    entries: [
      historyEntry('old', older, '/repo/old'),
      historyEntry('mid', within7d, '/repo/mid'),
      historyEntry('recent', within24h, '/repo/recent'),
    ],
    sessions: [
      session('old', older, '/repo/old'),
      session('mid', within7d, '/repo/mid'),
      session('recent', within24h, '/repo/recent'),
    ],
    tokenData: [
      {
        sessionId: 'mixed',
        totalInputTokens: 300,
        totalOutputTokens: 30,
        totalCacheCreationTokens: 3,
        totalCacheReadTokens: 6,
        model: 'claude-sonnet-4-5',
        messageCount: 3,
        entries: [
          tokenEntry(new Date(older).toISOString(), 100),
          tokenEntry(new Date(within7d).toISOString(), 100),
          tokenEntry(new Date(within24h).toISOString(), 100),
        ],
        compactionEvents: [
          {
            timestamp: new Date(within24h).toISOString(),
            beforeContext: 100,
            afterContext: 40,
            reductionPercent: 60,
          },
        ],
        hasUnknownModel: false,
      },
    ],
    toolData: [
      {
        sessionId: 'mixed',
        calls: [
          {
            timestamp: new Date(older).toISOString(),
            toolName: 'Read',
            input: {},
            toolUseId: 'old-tool',
            isError: false,
            resultBytes: 1,
          },
          {
            timestamp: new Date(within24h).toISOString(),
            toolName: 'Bash',
            input: { command: 'npm test' },
            toolUseId: 'recent-tool',
            isError: false,
            resultBytes: 1,
          },
        ],
      },
    ],
    timelines: [
      {
        sessionId: 'mixed',
        startTime: new Date(older).toISOString(),
        endTime: new Date(within24h).toISOString(),
        entries: [
          {
            timestamp: new Date(older).toISOString(),
            kind: 'user',
            summary: 'old',
          },
          {
            timestamp: new Date(within24h).toISOString(),
            kind: 'assistant',
            summary: 'recent',
          },
        ],
      },
    ],
  });

  it('preserves all data for the all-time preset', () => {
    expect(
      filterViewDataByTime(data, { time: 'all', project: ALL_PROJECTS })
    ).toBe(data);
  });

  it('filters representative dashboard arrays to the last 24 hours', () => {
    const filtered = filterViewDataByTime(data, {
      time: '24h',
      project: ALL_PROJECTS,
    });

    expect(filtered.entries.map((entry) => entry.sessionId)).toEqual(['recent']);
    expect(filtered.sessions.map((row) => row.sessionId)).toEqual(['recent']);
    expect(filtered.projects.map((project) => project.project)).toEqual(['/repo/recent']);
    expect(filtered.tokenData[0].entries).toHaveLength(1);
    expect(filtered.tokenData[0].totalInputTokens).toBe(100);
    expect(filtered.toolData[0].calls.map((call) => call.toolUseId)).toEqual([
      'recent-tool',
    ]);
    expect(filtered.timelines[0].entries.map((entry) => entry.summary)).toEqual([
      'recent',
    ]);
  });

  it('uses the same dataset anchor for wider presets', () => {
    const filtered = filterViewDataByTime(data, {
      time: '7d',
      project: ALL_PROJECTS,
    });

    expect(filtered.entries.map((entry) => entry.sessionId)).toEqual([
      'mid',
      'recent',
    ]);
    expect(filtered.sessions.map((row) => row.sessionId)).toEqual([
      'mid',
      'recent',
    ]);
  });
});
