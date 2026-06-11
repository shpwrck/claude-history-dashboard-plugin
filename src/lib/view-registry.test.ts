import { describe, expect, it } from 'vitest';
import {
  filterViewDataByProject,
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
import type {
  HistoryEntry,
  Session,
  SessionTokenData,
  TokenEntry,
  View,
} from '../types';
import { ALL_PROJECTS, type DashboardFilter } from './routing';
import { groupByProjects } from './parse-history';

const HOUR = 60 * 60 * 1000;

function historyEntry(
  sessionId: string,
  project: string,
  timestamp: number
): HistoryEntry {
  return {
    display: `${sessionId} prompt`,
    pastedContents: {},
    timestamp,
    project,
    sessionId,
  };
}

function session(
  sessionId: string,
  project: string,
  startTime: number,
  entries: HistoryEntry[] = []
): Session {
  return {
    sessionId,
    project,
    projectShort: project.split('/').pop() ?? project,
    entries,
    startTime,
    endTime: startTime + 1000,
    duration: 1000,
    messageCount: entries.length,
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

function tokenRow(
  sessionId: string,
  project: string | undefined,
  timestamp: string
): SessionTokenData {
  const row: SessionTokenData = {
    sessionId,
    totalInputTokens: 10,
    totalOutputTokens: 5,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    model: 'claude-sonnet-4-5-20250929',
    messageCount: 1,
    entries: [
      {
        timestamp,
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
        webSearchRequests: 0,
        webFetchRequests: 0,
        model: 'claude-sonnet-4-5-20250929',
      },
    ],
    compactionEvents: [],
    hasUnknownModel: false,
  };
  if (project) {
    row.project = project;
    row.projectShort = project.split('/').pop();
  }
  return row;
}

function emptyData(overrides: Partial<ViewData> = {}): ViewData {
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
    promptAnalysis: [],
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

// #834's time-filter suite used a `baseData` helper; it is identical to
// `emptyData` (full empty ViewData + overrides), so alias it after merging the
// two suites' fixtures.
const baseData = emptyData;

const allProjectsFilter: DashboardFilter = {
  time: 'all',
  project: ALL_PROJECTS,
};

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

describe('project-scoped view data filtering', () => {
  it('leaves all-projects data untouched', () => {
    const data = emptyData();

    expect(filterViewDataByProject(data, allProjectsFilter)).toBe(data);
  });

  it('keeps only direct project rows and rows belonging to matching sessions', () => {
    const alphaProject = '/work/alpha';
    const betaProject = '/work/beta';
    const alphaEntry = historyEntry('alpha-1', alphaProject, 1000);
    const betaEntry = historyEntry('beta-1', betaProject, 2000);
    const alphaSession = session('alpha-1', alphaProject, 1000, [alphaEntry]);
    const betaSession = session('beta-1', betaProject, 2000, [betaEntry]);
    const sessions = [alphaSession, betaSession];
    const data = emptyData({
      entries: [alphaEntry, betaEntry],
      sessions,
      projects: groupByProjects(sessions),
      tokenData: [
        tokenRow('alpha-1', alphaProject, '2026-01-01T00:00:00.000Z'),
        tokenRow('beta-1', betaProject, '2026-01-02T00:00:00.000Z'),
        tokenRow('missing-project', undefined, '2026-01-03T00:00:00.000Z'),
      ],
      toolData: [
        { sessionId: 'alpha-1', calls: [] },
        { sessionId: 'beta-1', calls: [] },
        { sessionId: 'orphan', calls: [] },
      ],
      toolInventories: [
        { sessionId: 'alpha-1', toolsAvailable: [], toolsUsed: [], unusedTools: [], utilizationPct: 0 },
        { sessionId: 'beta-1', toolsAvailable: [], toolsUsed: [], unusedTools: [], utilizationPct: 0 },
      ],
      timelines: [
        { sessionId: 'alpha-1', startTime: '', endTime: '', entries: [] },
        { sessionId: 'beta-1', startTime: '', endTime: '', entries: [] },
      ],
      apiErrors: [
        { sessionId: 'alpha-1', timestamp: '', summary: '' },
        { sessionId: 'beta-1', timestamp: '', summary: '' },
      ],
      permissionRows: [
        { sessionId: 'alpha-1', mode: 'acceptEdits' },
        { sessionId: 'beta-1', mode: 'default' },
      ],
      permissionChanges: [
        {
          sessionId: 'alpha-1',
          timestamp: '',
          fromMode: null,
          toMode: 'acceptEdits',
        },
        { sessionId: 'beta-1', timestamp: '', fromMode: null, toMode: 'default' },
      ],
      agentSettings: [
        { sessionId: 'alpha-1', timestamp: '', name: 'model', value: 'sonnet' },
        { sessionId: 'beta-1', timestamp: '', name: 'model', value: 'opus' },
      ],
      attribution: [
        { sessionId: 'alpha-1', agents: {}, skills: {}, commands: {}, mcpServers: {}, mcpTools: {} },
        { sessionId: 'beta-1', agents: {}, skills: {}, commands: {}, mcpServers: {}, mcpTools: {} },
      ],
      runtimeEvents: [
        { sessionId: 'alpha-1', turns: [], stopHooks: [], awaySummaries: [], scheduledFires: [] },
        { sessionId: 'beta-1', turns: [], stopHooks: [], awaySummaries: [], scheduledFires: [] },
      ],
      churnGeometry: [
        { sessionId: 'alpha-1', edits: [], files: [] },
        { sessionId: 'beta-1', edits: [], files: [] },
      ],
      assistantFeatures: [
        {
          sessionId: 'alpha-1',
          assistantTurnCount: 1,
          textLength: 1,
          codeBlockCount: 0,
          toolCallCount: 0,
          refusalCount: 0,
          hedgingCount: 0,
          endsWithQuestionCount: 0,
          thinkingByteLen: 0,
        },
        {
          sessionId: 'beta-1',
          assistantTurnCount: 1,
          textLength: 1,
          codeBlockCount: 0,
          toolCallCount: 0,
          refusalCount: 0,
          hedgingCount: 0,
          endsWithQuestionCount: 0,
          thinkingByteLen: 0,
        },
      ],
      deceitSignals: [
        {
          sessionId: 'alpha-1',
          assistantTurnCount: 1,
          unbackedClaimCount: 0,
          contradictedClaimCount: 0,
          claimSnippets: [],
        },
        {
          sessionId: 'beta-1',
          assistantTurnCount: 1,
          unbackedClaimCount: 0,
          contradictedClaimCount: 0,
          claimSnippets: [],
        },
      ],
      workflows: [
        {
          runId: 'wf-alpha',
          workflowName: 'Alpha flow',
          status: 'completed',
          startTime: 1000,
          durationMs: 10,
          agentCount: 1,
          totalTokens: 10,
          totalToolCalls: 1,
          defaultModel: 'sonnet',
          sessionId: 'alpha-1',
          phases: [],
          agents: [],
        },
        {
          runId: 'wf-beta',
          workflowName: 'Beta flow',
          status: 'completed',
          startTime: 2000,
          durationMs: 10,
          agentCount: 1,
          totalTokens: 10,
          totalToolCalls: 1,
          defaultModel: 'sonnet',
          sessionId: 'beta-1',
          phases: [],
          agents: [],
        },
      ],
    });

    const filtered = filterViewDataByProject(data, {
      time: 'all',
      project: alphaProject,
    });

    expect(filtered.entries.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.sessions.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.projects.map((item) => item.project)).toEqual([alphaProject]);
    expect(filtered.tokenData.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.toolData.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.toolInventories.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.timelines.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.apiErrors.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.permissionRows.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.permissionChanges.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.agentSettings.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.attribution.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.runtimeEvents.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.churnGeometry.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.assistantFeatures.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.deceitSignals.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.workflows.map((item) => item.sessionId)).toEqual(['alpha-1']);
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
      historyEntry('old', '/repo/old', older),
      historyEntry('mid', '/repo/mid', within7d),
      historyEntry('recent', '/repo/recent', within24h),
    ],
    sessions: [
      session('old', '/repo/old', older),
      session('mid', '/repo/mid', within7d),
      session('recent', '/repo/recent', within24h),
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
