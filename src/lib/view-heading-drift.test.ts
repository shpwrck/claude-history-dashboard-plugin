// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, Suspense } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { renderView, VIEW_RENDERERS, type ViewContext, type ViewData } from './view-registry';
import { ALL_PROJECTS } from './routing';
import type { View } from '../types';

vi.mock('@api-client', () => ({
  SERVER_AVAILABLE: false,
  analyzeLocal: vi.fn().mockResolvedValue({
    source: 'deterministic',
    recommendations: [],
    analysis: null,
    model: null,
    reason: 'unavailable',
  }),
  createRemoteSession: vi.fn().mockResolvedValue({ ok: false, error: 'unavailable' }),
  deleteRemoteSession: vi.fn().mockResolvedValue({ ok: false, error: 'unavailable' }),
  fetchAdoptionReceipts: vi.fn().mockResolvedValue([]),
  fetchAuditFindings: vi.fn().mockResolvedValue([]),
  fetchAuditRun: vi.fn().mockResolvedValue({
    status: 'skipped',
    reason: 'test',
    findings: [],
  }),
  fetchAuthSession: vi.fn().mockResolvedValue(null),
  fetchDataset: vi.fn().mockRejectedValue(new Error('unavailable')),
  fetchDigest: vi.fn().mockRejectedValue(new Error('unavailable')),
  fetchEnterpriseAuditExport: vi.fn().mockResolvedValue(null),
  fetchEnterpriseOrganization: vi.fn().mockResolvedValue(null),
  fetchEnterpriseReadinessReceipt: vi.fn().mockResolvedValue(null),
  fetchHybridSearch: vi.fn().mockResolvedValue({ results: [], error: null }),
  fetchLive: vi.fn().mockResolvedValue(null),
  fetchMemories: vi.fn().mockResolvedValue({ projects: [] }),
  fetchRemoteSessions: vi.fn().mockResolvedValue({
    ok: true,
    configured: false,
    sessions: [],
  }),
  fetchSessionTimeline: vi.fn().mockResolvedValue(null),
  fetchSessionTools: vi.fn().mockResolvedValue(null),
  fetchSourceHistoryJsonl: vi.fn().mockResolvedValue(null),
  fetchSourceSessionJsonl: vi.fn().mockResolvedValue(null),
  fetchTranscriptContent: vi.fn().mockResolvedValue(null),
  fetchTranscriptThinking: vi.fn().mockResolvedValue(null),
  fetchUsage: vi.fn().mockResolvedValue({ available: false, reason: 'test' }),
  fetchWorkflows: vi.fn().mockResolvedValue({ runs: [] }),
  loadDefaultHistory: vi.fn().mockRejectedValue(new Error('unavailable')),
  regenerateInsights: vi.fn().mockResolvedValue({ ok: false, alreadyRunning: false }),
  writePolicy: vi.fn().mockResolvedValue({ ok: false, error: 'unavailable' }),
}));

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (typeof window.matchMedia === 'undefined') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const emptyData: ViewData = {
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
  secretsAtRest: [],
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
  modelEvalSummary: null,
  updateResults: [],
  mcpAuth: null,
  configBackups: [],
  externalGuidance: [],
  enterpriseSession: null,
  sampleAdoptionReceipts: [],
};

const noop = () => {};

const emptyContext: ViewContext = {
  filter: { time: 'all', project: ALL_PROJECTS },
  routeFilter: {},
  data: emptyData,
  nav: {
    navigateTo: noop,
    navigateWithFilter: noop,
    scrollToAnchor: () => false,
    openSession: noop,
    openEvidence: noop,
    setActiveSessionId: noop,
    setActiveProjectId: noop,
    focusSessionId: null,
    focusEvidenceRef: null,
    consumeFocus: noop,
    reloadFromDisk: noop,
    onFilterChange: noop,
    onActiveDomains: noop,
  },
  serverAvailable: false,
};

function textFor(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function headingLabel(element: Element): string {
  const text = textFor(element);
  return text ? `${element.tagName.toLowerCase()}: ${text}` : element.tagName.toLowerCase();
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('view page heading drift guard (#1599)', () => {
  // jsdom does not compute PatternFly typography, so this guard asserts the
  // observable contract: semantic heading level plus PF size classes.
  it.each(Object.keys(VIEW_RENDERERS) as View[])(
    '%s renders exactly one h1 page title before smaller headings',
    async (view) => {
      const { container } = render(
        createElement(
          Suspense,
          { fallback: createElement('div', { 'data-testid': 'lazy-view-loading' }, 'Loading') },
          renderView(view, emptyContext)
        )
      );

      await waitFor(() => {
        expect(container.querySelector('[data-testid="lazy-view-loading"]')).toBeNull();
        // #2418: bumped 5000→15000ms because the Summary lazy chunk grew when it
        // pulled in @patternfly/react-table (the By-project Table), pushing the
        // slowest view's lazy-import + first render past the old 5s ceiling on a
        // contended CI/vitest worker. The guard only cares that the chunk
        // eventually resolves, so a wider ceiling avoids flakes without masking a
        // real regression.
      }, { timeout: 15000 });

      const h1s = Array.from(container.querySelectorAll('h1'));
      expect(
        h1s.map(textFor),
        `${view} should render exactly one h1 page title`
      ).toHaveLength(1);
      expect(
        h1s[0].classList.contains('pf-m-3xl'),
        `${view} h1 should use the page-title 3xl size`
      ).toBe(true);

      const headings = Array.from(container.querySelectorAll('h1,h2,h3,h4,h5,h6'));
      expect(
        headings.length,
        `${view} should render at least one heading`
      ).toBeGreaterThan(0);
      expect(headings[0]).toBe(h1s[0]);

      const oversizedSubheadings = headings.filter(
        (heading) =>
          heading !== h1s[0] &&
          (heading.classList.contains('pf-m-3xl') ||
            heading.classList.contains('pf-m-2xl'))
      );
      expect(
        oversizedSubheadings.map(headingLabel),
        `${view} should not render 2xl/3xl section or sub-section headings`
      ).toEqual([]);
    }
  );
});
