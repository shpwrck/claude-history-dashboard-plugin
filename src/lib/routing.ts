/**
 * Hash-based routing (epic #490, #491) — the "one URL space".
 *
 * The dashboard navigates by React state (`currentView`) with a sticky
 * last-view (see `nav-prefs.ts`); this module makes that state *addressable* so
 * digest cards deep-link into raw views and any view is a shareable URL —
 * without a router dependency and without server rewrite rules (so the GitHub
 * Pages sample build keeps working unchanged).
 *
 * URL shape:
 *   #/cost?time=24h&project=All+projects
 *                               → the Cost view with the global dashboard filter
 *   #/sessions?session=<id>&time=24h&project=All+projects
 *                               → the Sessions view focused on one session
 *
 * Sync is bidirectional and loop-free: in-app navigation writes the hash; an
 * incoming hash (load, back/forward, paste) drives navigation. Both directions
 * guard on "does the hash view already equal the current view?", so the
 * write→hashchange→read cycle terminates immediately.
 */
import { useEffect, useRef } from 'react';
import type { View } from '../types';
import { isValidView, resolveViewRedirect, REDIRECTED_VIEW_TAB } from './nav-prefs';
// #2718: the React-free primitives live in routing-core.ts so the server can
// import them without pulling React/nav-prefs. Re-exported here so every existing
// `from './routing'` import is unchanged.
import {
  TIME_PRESETS,
  ALL_PROJECTS,
  DEFAULT_TIME_PRESET,
  presetToRange,
} from './routing-core';
import type { TimePreset, TimeRange } from './routing-core';
export {
  TIME_PRESETS,
  ALL_PROJECTS,
  DEFAULT_TIME_PRESET,
  presetToRange,
};
export type { TimePreset, TimeRange };

export const DEFAULT_DASHBOARD_FILTER: DashboardFilter = {
  time: DEFAULT_TIME_PRESET,
  project: ALL_PROJECTS,
};

export interface DashboardFilter {
  time: TimePreset;
  project: string;
}

export const ROUTE_FILTER_KEYS = [
  'project',
  'date',
  'tool',
  'file',
  'mode',
  // Model-family drill (#2418): the tokens view filters token entries by
  // `modelFamily(entry.model)`, so a Summary By-model row (which buckets
  // per-entry) hands off with matching entry-level semantics — unlike `mode`,
  // which substring-matches whole sessions on their last-model-wins fields.
  'family',
  // Rec-focus drill (#2437): the Recommendations view scrolls to / focuses the
  // recommendation card whose id matches (via its `rec-<id>` data-signal-id
  // anchor). A Reclaim Compass lever row's "Open recommendation evidence"
  // button carries its `leverId` here — the leverId IS a recommendation id
  // (e.g. `cost.output-verbosity`) — so the per-lever button lands scoped
  // instead of on the unscoped Recommendations list.
  'rec',
  'entrypoint',
  'pattern',
  'table',
  'from',
  'to',
  // Response-latency histogram drill (#3256): Sessions reproduces the source
  // bucket against its per-session timelines. Bounds mirror histogram
  // semantics exactly: elapsed milliseconds must be > latencyGtMs and
  // <= latencyLteMs. The open-ended final bucket omits latencyLteMs.
  'latencyGtMs',
  'latencyLteMs',
  'sort',
  'tab',
] as const;
export type RouteFilterKey = (typeof ROUTE_FILTER_KEYS)[number];
export type RouteFilter = Partial<Record<RouteFilterKey, string>>;

export interface ParsedRoute {
  /** The view named by the hash, if it is a known view id. */
  view?: View;
  /** A `?session=<id>` deep-link target, if present. */
  session?: string;
  /** Per-view evidence filters carried in the hash. */
  viewFilter: RouteFilter;
  /** The global dashboard filter, normalized to predictable defaults. */
  filter: DashboardFilter;
}

export interface ParseRouteOptions {
  /** Known project ids. When present, any other project falls back to All projects. */
  validProjects?: readonly string[] | undefined;
  /** Variant-specific fallback used only when the URL omits a valid time value. */
  defaultTime?: TimePreset | undefined;
}

export interface RouteToHashOptions {
  /** Optional `?session=<id>` deep-link target. */
  session?: string | undefined;
  /** Optional global filter query. Omitted only by legacy/test callers. */
  filter?: DashboardFilter | undefined;
  /** Optional per-view evidence filters. */
  viewFilter?: RouteFilter | undefined;
}

export function isTimePreset(value: string | null | undefined): value is TimePreset {
  return TIME_PRESETS.includes(value as TimePreset);
}

export function normalizeTimePreset(
  value: string | null | undefined,
  fallback: TimePreset = DEFAULT_TIME_PRESET
): TimePreset {
  return isTimePreset(value) ? value : fallback;
}

export function normalizeProjectFilter(
  value: string | null | undefined,
  validProjects?: readonly string[]
): string {
  const project = value?.trim();
  if (!project || project === ALL_PROJECTS) return ALL_PROJECTS;
  if (validProjects && validProjects.length > 0 && !validProjects.includes(project)) {
    return ALL_PROJECTS;
  }
  return project;
}

export function normalizeDashboardFilter(
  filter: Partial<DashboardFilter> | null | undefined,
  validProjects?: readonly string[]
): DashboardFilter {
  return {
    time: normalizeTimePreset(filter?.time),
    project: normalizeProjectFilter(filter?.project, validProjects),
  };
}

export function parseDashboardFilter(
  query: string | URLSearchParams,
  options: ParseRouteOptions = {}
): DashboardFilter {
  const params =
    typeof query === 'string'
      ? new URLSearchParams(query.replace(/^\?/, ''))
      : query;
  return {
    time: normalizeTimePreset(params.get('time'), options.defaultTime),
    project: normalizeProjectFilter(params.get('project'), options.validProjects),
  };
}

export function serializeDashboardFilter(
  filter: DashboardFilter,
  params = new URLSearchParams()
): URLSearchParams {
  const normalized = normalizeDashboardFilter(filter);
  params.set('time', normalized.time);
  params.set('project', normalized.project);
  return params;
}

function routeFilterValue(
  key: RouteFilterKey,
  value: string | null | undefined
): string | undefined {
  const normalized = value?.trim();
  return normalized && !(key === 'project' && normalized === ALL_PROJECTS)
    ? normalized
    : undefined;
}

function parseRouteFilter(query: string | URLSearchParams): RouteFilter {
  const params =
    typeof query === 'string'
      ? new URLSearchParams(query.replace(/^\?/, ''))
      : query;
  const filter: RouteFilter = {};
  for (const key of ROUTE_FILTER_KEYS) {
    const value = routeFilterValue(key, params.get(key));
    if (value) filter[key] = value;
  }
  return filter;
}

function serializeRouteFilter(
  filter: RouteFilter | null | undefined,
  params = new URLSearchParams()
): URLSearchParams {
  for (const key of ROUTE_FILTER_KEYS) {
    const value = routeFilterValue(key, filter?.[key]);
    if (value) params.set(key, value);
  }
  return params;
}

function routeFiltersEqual(
  a: RouteFilter | null | undefined,
  b: RouteFilter | null | undefined
): boolean {
  return ROUTE_FILTER_KEYS.every(
    (key) => routeFilterValue(key, a?.[key]) === routeFilterValue(key, b?.[key])
  );
}

export function dashboardFiltersEqual(
  a: DashboardFilter,
  b: DashboardFilter
): boolean {
  return a.time === b.time && a.project === b.project;
}

/** Parse a `window.location.hash` string into a {@link ParsedRoute}. */
export function parseRoute(
  hash: string,
  options: ParseRouteOptions = {}
): ParsedRoute {
  // Strip a leading '#', then a leading '/', leaving "<view>[?query]".
  const body = hash.replace(/^#/, '').replace(/^\//, '');
  if (!body) {
    return {
      viewFilter: {},
      filter: parseDashboardFilter('', options),
    };
  }
  const [path, query = ''] = body.split('?');
  const params = new URLSearchParams(query);
  const out: ParsedRoute = {
    viewFilter: parseRouteFilter(params),
    filter: parseDashboardFilter(params, options),
  };
  if (path && isValidView(path)) {
    // Funnel retired/absorbed route ids through the redirect map (#14, #2351)
    // at parse time, so both the read side (hashchange → navigate) and the
    // write side (canonical-hash rewrite) agree on the survivor view. An
    // absorbed composite-tab id (`#/tools`, `#/tasks`, …) additionally injects
    // its tab into the view filter so the composite lands on the right tab.
    out.view = resolveViewRedirect(path);
    const tab = REDIRECTED_VIEW_TAB[path];
    if (tab && !out.viewFilter.tab) out.viewFilter.tab = tab;
  }
  if (query) {
    const session = params.get('session');
    if (session) out.session = session;
  }
  return out;
}

/** Build the canonical hash for a view and optional query params. */
export function routeToHash(
  view: View,
  options: RouteToHashOptions = {}
): string {
  const params = new URLSearchParams();
  if (options.session) params.set('session', options.session);
  if (options.filter) serializeDashboardFilter(options.filter, params);
  if (options.viewFilter) serializeRouteFilter(options.viewFilter, params);
  const query = params.toString();
  return query ? `#/${view}?${query}` : `#/${view}`;
}

export interface NavigateWithFilterOptions {
  dashboardFilter?: DashboardFilter | undefined;
  session?: string | undefined;
}

export function navigateWithFilter(
  view: View,
  viewFilter: RouteFilter,
  options: NavigateWithFilterOptions = {}
): string {
  const nextHash = routeToHash(view, {
    session: options.session,
    filter: options.dashboardFilter,
    viewFilter,
  });
  if (typeof window !== 'undefined' && window.location.hash !== nextHash) {
    window.location.hash = nextHash;
  }
  return nextHash;
}

function cssEscape(value: string): string {
  const maybeCss = globalThis as typeof globalThis & {
    CSS?: { escape?: (value: string) => string };
  };
  if (maybeCss.CSS?.escape) return maybeCss.CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

export interface ScrollToSignalAnchorOptions {
  block?: ScrollLogicalPosition;
  behavior?: ScrollBehavior;
  focus?: boolean;
}

export function scrollToSignalAnchor(
  signalId: string | null | undefined,
  options: ScrollToSignalAnchorOptions = {}
): boolean {
  const normalized = signalId?.trim();
  if (!normalized || typeof document === 'undefined') return false;
  const target = document.querySelector<HTMLElement>(
    `[data-signal-id="${cssEscape(normalized)}"]`
  );
  if (!target) return false;
  target.scrollIntoView({
    block: options.block ?? 'start',
    behavior: options.behavior ?? 'smooth',
  });
  if (options.focus) {
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  }
  return true;
}

/**
 * The deferred in-view scroll used by KPI tiles and evidence links: waits one
 * tick so the smooth scroll runs after the click settles (#1813), falling back
 * to the synchronous scroll outside a browser. One home for the idiom that
 * used to be copied per view (#2349) — ErrorRetry/SessionPatterns delegate
 * here; keep any future scroll-behavior change in this function.
 */
export function deferredScrollToSignalAnchor(
  signalId: string,
  options: ScrollToSignalAnchorOptions = { focus: true }
): void {
  if (typeof window === 'undefined') {
    scrollToSignalAnchor(signalId, options);
    return;
  }
  window.setTimeout(() => scrollToSignalAnchor(signalId, options), 0);
}

/** Parse the current `window.location.hash` (empty in non-browser/test envs). */
export function initialRoute(options: ParseRouteOptions = {}): ParsedRoute {
  if (typeof window === 'undefined') {
    return {
      viewFilter: {},
      filter: parseDashboardFilter('', options),
    };
  }
  return parseRoute(window.location.hash, options);
}

/**
 * The view to land on at first paint, honouring an incoming deep link over the
 * sticky/default. Returns `null` when the hash names no view, so the caller can
 * fall back to {@link resolveInitialView}.
 */
export function initialViewFromHash(): View | null {
  return initialRoute().view ?? null;
}

/** The filter to seed App state with at first paint. */
export function initialDashboardFilterFromHash(
  options: ParseRouteOptions = {}
): DashboardFilter {
  return initialRoute(options).filter;
}

export function initialRouteFilterFromHash(
  options: ParseRouteOptions = {}
): RouteFilter {
  return initialRoute(options).viewFilter;
}

export interface HashRouteHandlers {
  /** The currently-rendered view (the write side reads this). */
  currentView: View;
  /** The currently-resolved global dashboard filter. */
  dashboardFilter: DashboardFilter;
  /** The current per-view evidence filter. */
  viewFilter: RouteFilter;
  /** Navigate to a view (App's `navigateTo`). */
  onNavigate: (view: View) => void;
  /** Open a session by id (App's `openSession`; itself navigates to Sessions). */
  onOpenSession: (sessionId: string, filter?: DashboardFilter) => void;
  /** Update the URL-backed dashboard filter. */
  onFilterChange: (filter: DashboardFilter) => void;
  /** Update the URL-backed per-view evidence filter. */
  onViewFilterChange: (filter: RouteFilter) => void;
  /** Known project ids for stale-project fallback. */
  validProjects?: readonly string[] | undefined;
  /** Variant-specific fallback used only by hashes without a valid time value. */
  defaultTime?: TimePreset | undefined;
}

/**
 * Keep `window.location.hash` and the app's `currentView` in sync.
 *
 * - On mount and on every `hashchange` (back/forward, manual edit, pasted
 *   link): apply the hash — open a `?session=` deep link, else navigate to the
 *   named view (skipped when it already matches, breaking the loop).
 * - When `currentView` changes from in-app navigation: write `#/<view>` (unless
 *   the hash already names it, e.g. the hashchange that *caused* the change, or
 *   a session deep link whose view already matches — leaving its `?session=`
 *   param intact so the URL stays shareable).
 */
export function useHashRoute({
  currentView,
  dashboardFilter,
  viewFilter,
  onNavigate,
  onOpenSession,
  onFilterChange,
  onViewFilterChange,
  validProjects,
  defaultTime,
}: HashRouteHandlers): void {
  // Latest handlers/state, read inside the stable hashchange listener without
  // re-subscribing. Updated in an effect (never during render).
  const ref = useRef({
    currentView,
    dashboardFilter,
    viewFilter,
    onNavigate,
    onOpenSession,
    onFilterChange,
    onViewFilterChange,
    validProjects,
    defaultTime,
  });
  useEffect(() => {
    ref.current = {
      currentView,
      dashboardFilter,
      viewFilter,
      onNavigate,
      onOpenSession,
      onFilterChange,
      onViewFilterChange,
      validProjects,
      defaultTime,
    };
  });

  // Read side: apply the hash on mount and on every hashchange.
  useEffect(() => {
    const apply = () => {
      const { view, session, filter, viewFilter } = parseRoute(window.location.hash, {
        validProjects: ref.current.validProjects,
        defaultTime: ref.current.defaultTime,
      });
      if (!dashboardFiltersEqual(filter, ref.current.dashboardFilter)) {
        ref.current.onFilterChange(filter);
      }
      if (!routeFiltersEqual(viewFilter, ref.current.viewFilter)) {
        ref.current.onViewFilterChange(viewFilter);
      }
      if (session) {
        ref.current.onOpenSession(session, filter);
        return;
      }
      if (view && view !== ref.current.currentView) {
        ref.current.onNavigate(view);
      }
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);

  // Write side: reflect in-app navigation into the hash.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const currentRoute = parseRoute(window.location.hash, {
      validProjects,
      defaultTime,
    });
    const nextHash = routeToHash(currentView, {
      session: currentRoute.view === currentView ? currentRoute.session : undefined,
      filter: dashboardFilter,
      viewFilter:
        currentRoute.view === currentView ? currentRoute.viewFilter : undefined,
    });
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    }
  }, [currentView, dashboardFilter, viewFilter, validProjects, defaultTime]);
}
