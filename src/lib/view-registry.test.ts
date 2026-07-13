// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isValidElement } from 'react';
import {
  filterViewDataByProject,
  filterViewDataByTime,
  shouldShowFilteredEmptyState,
  VIEW_ANCHORS,
  VIEW_RENDERERS,
  VIEW_DATA_FILTER_POLICIES,
  type ViewContext,
  type ViewData,
} from './view-registry';
import {
  NAV_ITEMS,
  DOMAIN_ORDER,
  getNavItem,
  isValidView,
  resolveViewRedirect,
  REDIRECTED_VIEW_TAB,
  domainForView,
} from './nav-prefs';
import type {
  HistoryEntry,
  PromptAnalysis,
  Session,
  SessionTokenData,
  TokenEntry,
  View,
} from '../types';
import { ALL_PROJECTS, type DashboardFilter } from './routing';
import { groupByProjects } from './parse-history';
import { parseMemories, projectPathToSlug } from './parse-memories';

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

const telemetryEnv = {
  node_version: 'v24',
  terminal: 'tmux',
  wsl_version: '',
  linux_distro_id: 'ubuntu',
  arch: 'x64',
  build_time: '2026-06-01',
};

function telemetryRow(sessionId: string, timestamp: string) {
  return {
    event_name: 'tengu_api_slow_first_byte',
    client_timestamp: timestamp,
    model: 'claude-sonnet-4-5',
    betas: '',
    session_id: sessionId,
    attempt: 1,
    elapsed_ms: 0,
    env: telemetryEnv,
  };
}

function modelLatencyRow(sessionId: string, timestamp: string) {
  return {
    session_id: sessionId,
    model: 'claude-sonnet-4-5',
    apiDurationMs: 10_000,
    toolDurationMs: 0,
    inputTokens: 1_000,
    outputTokens: 500,
    client_timestamp: timestamp,
  };
}

function debugRow(sessionId: string) {
  return {
    sessionId,
    ttfbP50: 100,
    ttfbP90: 200,
    ttfbMax: 200,
    ttfbSampleCount: 1,
    maxRetryAttempt: 0,
    slowFirstByteCount: 0,
    fastModeLostCount: 0,
  };
}

function registryRow(sessionId: string, cwd: string, startedAt: number) {
  return {
    pid: Math.abs(sessionId.split('').reduce((sum, c) => sum + c.charCodeAt(0), 0)),
    sessionId,
    cwd,
    startedAt,
    procStart: '1',
    version: '2.1.180',
    peerProtocol: 1,
    kind: 'interactive',
    entrypoint: 'cli',
  };
}

function promptRow(sessionId: string, project: string): PromptAnalysis {
  return {
    sessionId,
    project,
    promptTurnCount: 2,
    totalPromptChars: 120,
    avgPromptChars: 60,
    sentenceCount: 2,
    questionTurnCount: 1,
    imperativeTurnCount: 1,
    filePathMentionCount: 1,
    filePathTurnCount: 1,
    backtickIdentifierCount: 0,
    specificityMarkerCount: 1,
    lowSpecificityTurnCount: 0,
    hedgingTurnCount: 0,
    constraintTurnCount: 1,
    pastedContentTurnCount: 0,
    pastedContentCount: 0,
  };
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
    taskSteering: [],
    churnGeometry: [],
    valueFlow: [],
    taskSuccess: [],
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
    modelLatency: [],
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

function viewContext(
  filter: DashboardFilter = allProjectsFilter,
  dataOverrides: Partial<ViewData> = {}
): ViewContext {
  return {
    data: emptyData(dataOverrides),
    filter,
    routeFilter: {},
    serverAvailable: true,
    nav: {
      navigateTo: () => {},
      navigateWithFilter: () => {},
      scrollToAnchor: () => false,
      openSession: () => {},
      openEvidence: () => {},
      setActiveSessionId: () => {},
      setActiveProjectId: () => {},
      focusSessionId: null,
      focusEvidenceRef: null,
      consumeFocus: () => {},
      reloadFromDisk: () => {},
      onFilterChange: () => {},
      onActiveDomains: () => {},
    },
  };
}

describe('view registry ↔ nav catalog parity', () => {
  it('has a renderer for every catalog view, plus one per absorbed composite tab', () => {
    const catalog = new Set(NAV_ITEMS.map((i) => i.view));
    const renderers = new Set(Object.keys(VIEW_RENDERERS) as View[]);
    // Every catalog view is renderable…
    for (const v of catalog) expect(renderers.has(v)).toBe(true);
    // …and every renderer maps to a catalog view OR an absorbed composite-tab
    // id (#2351) whose delegating renderer forces the right tab for any direct
    // render path (normal routing resolves these ids via REDIRECTED_VIEWS).
    const absorbed = new Set(Object.keys(REDIRECTED_VIEW_TAB) as View[]);
    for (const v of renderers) {
      expect(
        catalog.has(v) || absorbed.has(v),
        `renderer '${v}' must be a catalog view or an absorbed composite tab`
      ).toBe(true);
    }
    // Every absorbed id keeps its delegating renderer.
    for (const v of absorbed) expect(renderers.has(v)).toBe(true);
    expect(renderers.size).toBe(catalog.size + absorbed.size);
  });

  it('lists each view exactly once in the catalog', () => {
    const views = NAV_ITEMS.map((i) => i.view);
    expect(new Set(views).size).toBe(views.length);
  });

  it('registers Analyze locally as a live-server action route', () => {
    expect(NAV_ITEMS.find((item) => item.view === 'local-analyze')).toMatchObject({
      label: 'Analyze locally',
      contract: 'action',
      domain: 'home',
      requires: 'liveServer',
    });
  });

  it.each([
    ['all projects', allProjectsFilter, null],
    [
      'a selected project',
      { time: '7d', project: '/work/alpha' } satisfies DashboardFilter,
      '/work/alpha',
    ],
  ])('passes %s into the local analysis renderer', (_name, filter, expected) => {
    const node = VIEW_RENDERERS['local-analyze']?.(viewContext(filter));

    expect(isValidElement(node)).toBe(true);
    if (!isValidElement<{ project?: string | null }>(node)) {
      throw new Error('Expected local analysis renderer to return an element');
    }
    expect(node.props.project).toBe(expected);
  });

  it('resolves policy-write capability fail-closed for enterprise and permissive for local mode', () => {
    const renderedCapability = (
      authRequired: boolean,
      canWritePolicy?: boolean,
      error?: string
    ): boolean | undefined => {
      const node = VIEW_RENDERERS.permissions?.(
        viewContext(allProjectsFilter, {
          enterpriseSession: {
            mode: authRequired ? 'enterprise' : 'single-user',
            authRequired,
            authenticated: true,
            configured: true,
            principal: null,
            organization: null,
            capabilities:
              canWritePolicy === undefined ? {} : { canWritePolicy },
            ...(error ? { error } : {}),
          },
        })
      );

      expect(isValidElement(node)).toBe(true);
      if (!isValidElement<{ canWritePolicy?: boolean }>(node)) {
        throw new Error('Expected Permissions renderer to return an element');
      }
      return node.props.canWritePolicy;
    };

    expect(renderedCapability(true)).toBe(false);
    expect(renderedCapability(true, false)).toBe(false);
    expect(renderedCapability(true, true)).toBe(true);
    expect(renderedCapability(false, false)).toBe(true);
    expect(renderedCapability(false, false, 'Auth check failed')).toBe(false);
  });

  it('demotes Timeline into the raw-data drawer domain', () => {
    expect(NAV_ITEMS.find((item) => item.view === 'timeline')).toMatchObject({
      label: 'Timeline',
      domain: 'raw',
    });
  });

  it('carries PageHeader descriptions for the reference and rollout migrations', () => {
    expect(NAV_ITEMS.find((item) => item.view === 'cost')?.description).toMatch(
      /Per-tool costs use proportional attribution/
    );
    expect(NAV_ITEMS.find((item) => item.view === 'tokens')?.description).toMatch(
      /Track token volume/
    );
    expect(NAV_ITEMS.find((item) => item.view === 'files')?.description).toMatch(
      /files and directories dominate reads/
    );
    expect(
      NAV_ITEMS.find((item) => item.view === 'permissions')?.description
    ).toMatch(/permission modes/);
    // Absorbed composite-tab views (#2351) keep their explainers reachable via
    // getNavItem (their tab content still renders its own PageHeader).
    expect(getNavItem('agents')?.description).toMatch(
      /subagents, skills, and MCP/
    );
    expect(
      NAV_ITEMS.find((item) => item.view === 'capabilities')?.description
    ).toMatch(/tool usage and effectiveness/i);
    expect(
      NAV_ITEMS.find((item) => item.view === 'automation')?.description
    ).toMatch(/SDK\/CLI runs, task health/);
    expect(getNavItem('workflows')?.description).toMatch(/Workflow-tool runs/);
    expect(NAV_ITEMS.find((item) => item.view === 'errors')?.description).toMatch(
      /errors and retries/
    );
    expect(
      NAV_ITEMS.find((item) => item.view === 'report-card')?.description
    ).toMatch(/how reliably your unattended automation/);
    expect(
      NAV_ITEMS.find((item) => item.view === 'evaluator')?.description
    ).toMatch(/response speed and throughput/);
    expect(getNavItem('memories')?.description).toMatch(
      /memory files Claude has saved/
    );
    expect(getNavItem('tasks')?.description).toMatch(/task completion rates/);
    expect(NAV_ITEMS.find((item) => item.view === 'search')?.description).toMatch(
      /Search across loaded sessions/
    );
    expect(
      NAV_ITEMS.find((item) => item.view === 'sessions')?.description
    ).toMatch(/Browse loaded sessions/);
    expect(
      NAV_ITEMS.find((item) => item.view === 'projects')?.description
    ).toMatch(/Break activity down by project/);
    expect(getNavItem('teams')?.description).toMatch(
      /multi-agent teams hand off work/
    );
    expect(getNavItem('plans')?.description).toMatch(/how their shapes evolved/);
    expect(
      NAV_ITEMS.find((item) => item.view === 'context')?.description
    ).toMatch(/context window your sessions consume/);
    expect(
      NAV_ITEMS.find((item) => item.view === 'conversation')?.description
    ).toMatch(/conversations flow turn by turn/);
    expect(
      NAV_ITEMS.find((item) => item.view === 'timeline')?.description
    ).toMatch(/Replay your sessions on a time axis/);
    expect(
      NAV_ITEMS.find((item) => item.view === 'activity')?.description
    ).toMatch(/when and where you work/i);
    expect(
      NAV_ITEMS.find((item) => item.view === 'pulse')?.description
    ).toMatch(/Week-over-week activity trend/i);
  });

  it('retires Forensic Graph from nav while redirecting old deep links to Timeline', () => {
    expect(NAV_ITEMS.some((item) => item.view === 'forensics')).toBe(false);
    expect(isValidView('forensics')).toBe(true);
    expect(resolveViewRedirect('forensics')).toBe('timeline');
    expect(VIEW_RENDERERS.forensics).toBeUndefined();
  });

  it('absorbs the workflow-hygiene peers into composites with tab-preserving redirects (#2351)', () => {
    const expected: Array<[View, View, string]> = [
      ['tools', 'capabilities', 'tools'],
      ['agents', 'capabilities', 'agents'],
      ['prompts', 'capabilities', 'prompts'],
      ['memories', 'capabilities', 'memories'],
      ['tasks', 'automation', 'tasks'],
      ['teams', 'automation', 'teams'],
      ['plans', 'automation', 'plans'],
      ['workflows', 'automation', 'workflows'],
    ];
    for (const [absorbed, composite, tab] of expected) {
      // Out of the sidebar catalog…
      expect(
        NAV_ITEMS.some((item) => item.view === absorbed),
        `${absorbed} must not be a sidebar destination`
      ).toBe(false);
      // …but old deep links still parse and land on the composite's tab…
      expect(isValidView(absorbed)).toBe(true);
      expect(resolveViewRedirect(absorbed)).toBe(composite);
      expect(REDIRECTED_VIEW_TAB[absorbed]).toBe(tab);
      // …and a direct render path still resolves (delegating renderer).
      expect(VIEW_RENDERERS[absorbed]).toBeDefined();
    }
    // The composites themselves are catalog views with renderers.
    expect(NAV_ITEMS.some((item) => item.view === 'capabilities')).toBe(true);
    expect(NAV_ITEMS.some((item) => item.view === 'automation')).toBe(true);
    expect(VIEW_RENDERERS.capabilities).toBeDefined();
    expect(VIEW_RENDERERS.automation).toBeDefined();
  });

  it('every renderer key is a valid view', () => {
    for (const v of Object.keys(VIEW_RENDERERS)) {
      expect(isValidView(v)).toBe(true);
    }
  });

  it('registers Reclaim Compass as a cost-owned anchor destination (#1279)', () => {
    expect(VIEW_ANCHORS['reclaim-compass']).toEqual({
      parentView: 'cost',
      signalId: 'reclaim-compass',
    });
    expect(NAV_ITEMS.find((item) => item.view === 'reclaim-compass')).toMatchObject({
      label: 'Reclaim Compass',
      domain: 'cost',
    });

    const node = VIEW_RENDERERS['reclaim-compass']?.(viewContext());

    expect(isValidElement(node)).toBe(true);
    if (!isValidElement<{ focusSignalId?: string }>(node)) {
      throw new Error('Expected Reclaim Compass renderer to return an element');
    }
    expect(node.props.focusSignalId).toBe('reclaim-compass');
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
        tokenRow('alpha-token-only', alphaProject, '2026-01-01T01:00:00.000Z'),
        tokenRow('beta-1', betaProject, '2026-01-02T00:00:00.000Z'),
        tokenRow('missing-project', undefined, '2026-01-03T00:00:00.000Z'),
      ],
      sessionRegistry: [
        registryRow('alpha-1', alphaProject, 1000),
        registryRow('alpha-token-only', alphaProject, 1500),
        registryRow('alpha-registry-only', alphaProject, 1750),
        registryRow('beta-1', betaProject, 2000),
      ],
      telemetry: [
        telemetryRow('alpha-1', '2026-01-01T00:00:00.000Z'),
        telemetryRow('alpha-token-only', '2026-01-01T01:00:00.000Z'),
        telemetryRow('alpha-registry-only', '2026-01-01T01:30:00.000Z'),
        telemetryRow('beta-1', '2026-01-02T00:00:00.000Z'),
      ],
      modelLatency: [
        modelLatencyRow('alpha-1', '2026-01-01T00:00:00.000Z'),
        modelLatencyRow('alpha-token-only', '2026-01-01T01:00:00.000Z'),
        modelLatencyRow('alpha-registry-only', '2026-01-01T01:30:00.000Z'),
        modelLatencyRow('beta-1', '2026-01-02T00:00:00.000Z'),
      ],
      debugLogs: [
        debugRow('alpha-token-only'),
        debugRow('alpha-registry-only'),
        debugRow('beta-1'),
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
      taskSteering: [
        {
          sessionId: 'alpha-1',
          taskIndex: 0,
          startTime: '',
          endTime: '',
          wallClockMs: 0,
          costUsd: 0,
          humanTurns: 0,
          corrective: 0,
          clarifyingAnswer: 0,
          approving: 0,
          other: 0,
          interruptions: 0,
          divergenceRate: 0,
        },
        {
          sessionId: 'beta-1',
          taskIndex: 0,
          startTime: '',
          endTime: '',
          wallClockMs: 0,
          costUsd: 0,
          humanTurns: 0,
          corrective: 0,
          clarifyingAnswer: 0,
          approving: 0,
          other: 0,
          interruptions: 0,
          divergenceRate: 0,
        },
      ],
      churnGeometry: [
        { sessionId: 'alpha-1', edits: [], files: [] },
        { sessionId: 'beta-1', edits: [], files: [] },
      ],
      valueFlow: [
        { sessionId: 'alpha-1', edges: [], hypotheses: [] },
        { sessionId: 'beta-1', edges: [], hypotheses: [] },
      ],
      taskSuccess: [
        {
          sessionId: 'alpha-1',
          taskIndex: 0,
          startTime: '',
          endTime: '',
          wallClockMs: 0,
          verdict: 'none',
          agentClaim: 'none',
          confidence: 'unknown',
          successScore: 0.5,
          backedByMutation: false,
          mutatingToolCount: 0,
          toolCallCount: 0,
          toolResultCount: 0,
          toolErrorCount: 0,
          toolErrorRate: 0,
          errorPenalty: 0,
        },
        {
          sessionId: 'beta-1',
          taskIndex: 0,
          startTime: '',
          endTime: '',
          wallClockMs: 0,
          verdict: 'none',
          agentClaim: 'none',
          confidence: 'unknown',
          successScore: 0.5,
          backedByMutation: false,
          mutatingToolCount: 0,
          toolCallCount: 0,
          toolResultCount: 0,
          toolErrorCount: 0,
          toolErrorRate: 0,
          errorPenalty: 0,
        },
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
      promptAnalysis: [
        promptRow('alpha-1', alphaProject),
        promptRow('beta-1', betaProject),
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
      fileHistory: [
        {
          sessionId: 'alpha-1',
          churn: 3,
          spanMin: 12.5,
          burstRate: 0.24,
          reworkScore: 3.7,
          firstMs: 950,
          lastMs: 1050,
        },
        {
          sessionId: 'beta-1',
          churn: 2,
          spanMin: 4.5,
          burstRate: 0.44,
          reworkScore: 2.9,
          firstMs: 1950,
          lastMs: 2050,
        },
      ],
      // Build via the real parser so `project` carries the on-disk SLUG the
      // parser produces (e.g. `-work-alpha`), not the cwd path — this is the
      // shape the project filter must join against (adversarial review, #2426).
      memories: parseMemories({
        projects: [
          {
            slug: projectPathToSlug(alphaProject),
            files: [
              {
                name: 'alpha.md',
                content:
                  '---\nname: alpha-note\ndescription: alpha memory\nmetadata:\n  type: project\n---\nalpha body\n',
              },
            ],
          },
          {
            slug: projectPathToSlug(betaProject),
            files: [
              {
                name: 'beta.md',
                content:
                  '---\nname: beta-note\ndescription: beta memory\nmetadata:\n  type: project\n---\nbeta body\n',
              },
            ],
          },
        ],
      }),
    });

    const filtered = filterViewDataByProject(data, {
      time: 'all',
      project: alphaProject,
    });

    expect(filtered.entries.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.sessions.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.projects.map((item) => item.project)).toEqual([alphaProject]);
    expect(filtered.tokenData.map((item) => item.sessionId)).toEqual([
      'alpha-1',
      'alpha-token-only',
    ]);
    expect(filtered.sessionRegistry.map((item) => item.sessionId)).toEqual([
      'alpha-1',
      'alpha-token-only',
      'alpha-registry-only',
    ]);
    expect(filtered.telemetry.map((item) => item.session_id)).toEqual([
      'alpha-1',
      'alpha-token-only',
      'alpha-registry-only',
    ]);
    expect(filtered.modelLatency.map((item) => item.session_id)).toEqual([
      'alpha-1',
      'alpha-token-only',
      'alpha-registry-only',
    ]);
    expect(filtered.debugLogs.map((item) => item.sessionId)).toEqual([
      'alpha-token-only',
      'alpha-registry-only',
    ]);
    expect(filtered.toolData.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.toolInventories.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.timelines.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.apiErrors.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.permissionRows.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.permissionChanges.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.agentSettings.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.attribution.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.runtimeEvents.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.taskSteering.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.churnGeometry.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.valueFlow.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.taskSuccess.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.assistantFeatures.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.promptAnalysis.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.deceitSignals.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.workflows.map((item) => item.sessionId)).toEqual(['alpha-1']);
    expect(filtered.fileHistory.map((item) => item.sessionId)).toEqual(['alpha-1']);
    // The path-format `ctx.project` must join to the slug-format memory key.
    expect(filtered.memories.map((item) => item.project)).toEqual([
      projectPathToSlug(alphaProject),
    ]);
    expect(
      filtered.memories.flatMap((item) => item.memories.map((m) => m.name))
    ).toEqual(['alpha-note']);
  });

  it('records explicit filter-policy decisions for audited fields', () => {
    expect(VIEW_DATA_FILTER_POLICIES.workflows).toMatchObject({
      time: 'filtered',
      project: 'filtered',
    });
    expect(VIEW_DATA_FILTER_POLICIES.fileHistory).toMatchObject({
      time: 'filtered',
      project: 'filtered',
    });
    expect(VIEW_DATA_FILTER_POLICIES.memories).toMatchObject({
      time: 'global',
      project: 'filtered',
    });
    expect(VIEW_DATA_FILTER_POLICIES.plans).toMatchObject({
      time: 'global',
      project: 'global',
    });
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

  it('keeps home-domain page-header explainers in the nav catalog', () => {
    expect(getNavItem('recommendations')?.description).toMatch(/cost, context/i);
    expect(getNavItem('adoption')?.description).toMatch(/marker-confirmed/i);
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
    sessionRegistry: [
      registryRow('old', '/repo/old', older),
      registryRow('recent', '/repo/recent', within24h),
      registryRow('registry-recent', '/repo/recent', within24h + 1000),
    ],
    telemetry: [
      telemetryRow('old', new Date(older).toISOString()),
      telemetryRow('mixed', new Date(within24h).toISOString()),
      telemetryRow('recent', new Date(within24h).toISOString()),
      telemetryRow('registry-recent', new Date(within24h + 1000).toISOString()),
    ],
    modelLatency: [
      modelLatencyRow('old', new Date(older).toISOString()),
      modelLatencyRow('mixed', new Date(within24h).toISOString()),
      modelLatencyRow('recent', new Date(within24h).toISOString()),
      modelLatencyRow('registry-recent', new Date(within24h + 1000).toISOString()),
    ],
    debugLogs: [
      debugRow('old'),
      debugRow('mixed'),
      debugRow('recent'),
      debugRow('registry-recent'),
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
    workflows: [
      {
        runId: 'wf-old',
        workflowName: 'Old WF',
        status: 'completed',
        startTime: older,
        durationMs: 10,
        agentCount: 1,
        totalTokens: 10,
        totalToolCalls: 1,
        defaultModel: 'sonnet',
        sessionId: 'old',
        phases: [],
        agents: [],
      },
      {
        runId: 'wf-recent',
        workflowName: 'Recent WF',
        status: 'completed',
        startTime: within24h,
        durationMs: 20,
        agentCount: 1,
        totalTokens: 12,
        totalToolCalls: 2,
        defaultModel: 'sonnet',
        sessionId: 'recent',
        phases: [],
        agents: [],
      },
    ],
    fileHistory: [
      {
        sessionId: 'old',
        churn: 2,
        spanMin: 6,
        burstRate: 0.2,
        reworkScore: 2.1,
        firstMs: older - 120_000,
        lastMs: older + 60_000,
      },
      {
        sessionId: 'recent',
        churn: 3,
        spanMin: 8,
        burstRate: 0.2,
        reworkScore: 1.2,
        firstMs: within24h - 120_000,
        lastMs: within24h + 120_000,
      },
      {
        sessionId: 'missing',
        churn: 10,
        spanMin: 20,
        burstRate: 1,
        reworkScore: 5,
        firstMs: older - 120_000,
        lastMs: within7d,
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
    expect(filtered.sessionRegistry.map((row) => row.sessionId)).toEqual([
      'recent',
      'registry-recent',
    ]);
    expect(filtered.telemetry.map((row) => row.session_id)).toEqual([
      'mixed',
      'recent',
      'registry-recent',
    ]);
    expect(filtered.modelLatency.map((row) => row.session_id)).toEqual([
      'mixed',
      'recent',
      'registry-recent',
    ]);
    expect(filtered.debugLogs.map((row) => row.sessionId)).toEqual([
      'mixed',
      'recent',
      'registry-recent',
    ]);
    expect(filtered.workflows.map((row) => row.runId)).toEqual(['wf-recent']);
    expect(filtered.fileHistory.map((row) => row.sessionId)).toEqual(['recent']);
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

describe('filtered empty-state guard', () => {
  it('shows a tab-level filtered empty state when the active filter removes all rows for that view', () => {
    const latest = Date.parse('2026-06-11T12:00:00.000Z');
    const old = latest - 10 * 24 * HOUR;
    const filter: DashboardFilter = { time: '24h', project: ALL_PROJECTS };
    const data = emptyData({
      entries: [historyEntry('anchor-session', '/repo/anchor', latest)],
      tokenData: [
        tokenRow('old-session', '/repo/old', new Date(old).toISOString()),
      ],
    });
    const filtered = filterViewDataByTime(data, filter);

    expect(filtered.tokenData).toEqual([]);
    expect(shouldShowFilteredEmptyState('summary', filter, data, filtered)).toBe(true);
  });

  it('shows the prompt analyzer filtered empty state when active filters remove all prompt rows', () => {
    const latest = Date.parse('2026-06-11T12:00:00.000Z');
    const old = latest - 10 * 24 * HOUR;
    const filter: DashboardFilter = { time: '24h', project: ALL_PROJECTS };
    const data = emptyData({
      entries: [historyEntry('anchor-session', '/repo/anchor', latest)],
      sessions: [
        session('old-session', '/repo/old', old),
        session('anchor-session', '/repo/anchor', latest),
      ],
      promptAnalysis: [promptRow('old-session', '/repo/old')],
    });
    const filtered = filterViewDataByTime(data, filter);

    expect(filtered.promptAnalysis).toEqual([]);
    expect(shouldShowFilteredEmptyState('prompts', filter, data, filtered)).toBe(true);
  });

  it('does not replace a naturally empty view or an unfiltered view', () => {
    const empty = emptyData();
    expect(
      shouldShowFilteredEmptyState('sessions', allProjectsFilter, empty, empty)
    ).toBe(false);
    expect(
      shouldShowFilteredEmptyState('summary', { time: '24h', project: ALL_PROJECTS }, empty, empty)
    ).toBe(false);
  });
});
