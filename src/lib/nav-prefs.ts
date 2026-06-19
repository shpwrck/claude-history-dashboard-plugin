/**
 * Per-user navigation preferences (which sidebar tabs are hidden) and the
 * one-time "you can hide tabs now" banner dismissal flag.
 *
 * Persisted in localStorage so the choice survives reloads. The shape is
 * forward-compatible with a future "persona presets" mechanism — that layer
 * will live alongside `hiddenViews` rather than replace it.
 */
import type { ComponentType } from 'react';
import type { SVGIconProps } from '@patternfly/react-icons/dist/esm/createIcon';
import BullseyeIcon from '@patternfly/react-icons/dist/esm/icons/bullseye-icon';
import StarIcon from '@patternfly/react-icons/dist/esm/icons/star-icon';
import CommentsIcon from '@patternfly/react-icons/dist/esm/icons/comments-icon';
import FolderIcon from '@patternfly/react-icons/dist/esm/icons/folder-icon';
import SearchIcon from '@patternfly/react-icons/dist/esm/icons/search-icon';
import CoinsIcon from '@patternfly/react-icons/dist/esm/icons/coins-icon';
import ToolsIcon from '@patternfly/react-icons/dist/esm/icons/tools-icon';
import FileAltIcon from '@patternfly/react-icons/dist/esm/icons/file-alt-icon';
import DollarSignIcon from '@patternfly/react-icons/dist/esm/icons/dollar-sign-icon';
import HistoryIcon from '@patternfly/react-icons/dist/esm/icons/history-icon';
import RunningIcon from '@patternfly/react-icons/dist/esm/icons/running-icon';
import RobotIcon from '@patternfly/react-icons/dist/esm/icons/robot-icon';
import ProjectDiagramIcon from '@patternfly/react-icons/dist/esm/icons/project-diagram-icon';
import ExclamationTriangleIcon from '@patternfly/react-icons/dist/esm/icons/exclamation-triangle-icon';
import LockIcon from '@patternfly/react-icons/dist/esm/icons/lock-icon';
import UsersIcon from '@patternfly/react-icons/dist/esm/icons/users-icon';
import BrainIcon from '@patternfly/react-icons/dist/esm/icons/brain-icon';
import HeartbeatIcon from '@patternfly/react-icons/dist/esm/icons/heartbeat-icon';
import CommentIcon from '@patternfly/react-icons/dist/esm/icons/comment-icon';
import ThLargeIcon from '@patternfly/react-icons/dist/esm/icons/th-large-icon';
import TachometerAltIcon from '@patternfly/react-icons/dist/esm/icons/tachometer-alt-icon';
import ClipboardCheckIcon from '@patternfly/react-icons/dist/esm/icons/clipboard-check-icon';
import TasksIcon from '@patternfly/react-icons/dist/esm/icons/tasks-icon';
import SitemapIcon from '@patternfly/react-icons/dist/esm/icons/sitemap-icon';
import ClipboardListIcon from '@patternfly/react-icons/dist/esm/icons/clipboard-list-icon';
import ChartLineIcon from '@patternfly/react-icons/dist/esm/icons/chart-line-icon';
import ChartPieIcon from '@patternfly/react-icons/dist/esm/icons/chart-pie-icon';
import CalendarAltIcon from '@patternfly/react-icons/dist/esm/icons/calendar-alt-icon';
import FlaskIcon from '@patternfly/react-icons/dist/esm/icons/flask-icon';
import ServerIcon from '@patternfly/react-icons/dist/esm/icons/server-icon';
import type { View, ActionDomain } from '../types';
import type { ViewRequirement, VariantCapabilities } from './variant-capabilities';

const STORAGE_KEY = 'claude-dashboard:nav-prefs';

/**
 * Sticky entrypoint scope (#132). `all` shows every session's activity;
 * `unattended` narrows the wired listings to non-interactive runs (see
 * {@link isUnattendedEntrypoint}). Persisted alongside the other nav prefs.
 */
export type EntrypointFilter = 'all' | 'unattended';

export interface NavPrefs {
  hiddenViews: View[];
  bannerDismissed: boolean;
  /**
   * Last route the user was on (#141), so a reload lands where they left off
   * instead of the static default. Absent until the first navigation; guarded
   * on read by {@link resolveInitialView} so a now-hidden view doesn't strand
   * the user on an invisible tab.
   */
  lastView?: View;
  /** Sticky interactive-vs-unattended scope (#132). Defaults to `'all'`. */
  entrypointFilter: EntrypointFilter;
  /**
   * Which curated-default *generation* this profile last reconciled with (#608).
   * Stamped to {@link CURRENT_NAV_LAYOUT_VERSION} on every read/migration. A
   * stored profile whose version predates the current one and that was never
   * explicitly customized adopts the new {@link CURATED_DEFAULT_HIDDEN_VIEWS};
   * legacy blobs (no version field) read as `0` so they migrate forward once.
   */
  navLayoutVersion: number;
  /**
   * Has the user *explicitly* chosen a visible-set (hidden/shown a tab via
   * Settings)? (#608) This is the opt-in signal that protects an intentional
   * choice from being clobbered by a curated default. It is deliberately
   * distinct from "happens to have an empty `hiddenViews`": a fresh profile and
   * a profile that accepted the curated default both leave it `false`, so a
   * later curated-default generation can still roll forward for them, while a
   * real customization (`true`) is preserved untouched.
   */
  customized: boolean;
}

/**
 * Static landing route used before any sticky value exists. The digest spine
 * (#491) — the ranked, safety-first cross-domain answer-sequence — is the
 * default landing; experts re-land on their sticky `lastView` instead (see
 * {@link resolveInitialView}).
 */
export const DEFAULT_VIEW: View = 'home';

/**
 * Sidebar group order (epic #490). The nav is organized by action-domain, not
 * data-type: the digest `home` first, then the six action domains with
 * **safety leading** (so a critical safety finding can't hide behind a cost tab
 * the user opens first — S1-Priya's siloing failure-mode), then the global
 * `discovery` Find utility, then the demoted `raw` orientation drawer.
 */
export const DOMAIN_ORDER: readonly ActionDomain[] = [
  'home',
  'safety',
  'cost',
  'success-rate',
  'speed',
  'context-health',
  'workflow-hygiene',
  'discovery',
  'raw',
] as const;

/** Human label per domain group header in the sidebar. */
export const DOMAIN_LABEL: Record<ActionDomain, string> = {
  home: 'Overview',
  safety: 'Stay safe',
  cost: 'Cut cost',
  'success-rate': 'Fail less',
  speed: 'Go faster',
  'context-health': 'Tame context',
  'workflow-hygiene': 'Clean workflow',
  discovery: 'Find',
  raw: 'Raw data',
};

/**
 * Current curated-default generation (#608). Bump this whenever
 * {@link CURATED_DEFAULT_HIDDEN_VIEWS} changes so never-customized profiles
 * re-reconcile to the new curated set on their next read. #609 (the recs-driven
 * default sidebar) is the first consumer that will raise this past `1`.
 */
export const CURRENT_NAV_LAYOUT_VERSION = 1;

/**
 * The curated default hidden-views set (#608). A fresh install and any
 * never-customized profile adopt exactly this set; an explicitly-customized
 * profile keeps its own. Empty today (so the default is still "show
 * everything", a no-op vs. the prior behaviour) — #608 ships the *versioned
 * opt-in machinery*; #609 populates this with the recs-driven selection and
 * bumps {@link CURRENT_NAV_LAYOUT_VERSION}, at which point never-customized
 * users migrate to it without clobbering anyone's explicit choice.
 */
export const CURATED_DEFAULT_HIDDEN_VIEWS: readonly View[] = [];

const DEFAULTS: NavPrefs = {
  hiddenViews: [...CURATED_DEFAULT_HIDDEN_VIEWS],
  bannerDismissed: false,
  entrypointFilter: 'all',
  navLayoutVersion: CURRENT_NAV_LAYOUT_VERSION,
  customized: false,
};

/**
 * A fresh defaults object with its own `hiddenViews` array — never the module
 * constant's. Cloning the array (not just the object) keeps `DEFAULTS` immune to
 * a caller mutating the returned set in place; cheap insurance once #609 makes
 * {@link CURATED_DEFAULT_HIDDEN_VIEWS} non-empty.
 */
function freshDefaults(): NavPrefs {
  return { ...DEFAULTS, hiddenViews: [...DEFAULTS.hiddenViews] };
}

// Source of truth for the sidebar's view list. Lives here (not Layout.tsx) so
// Settings can render a checklist of every view without depending on Layout.
// Icons are monochrome PatternFly components (not glyph characters) so nothing
// renders with an emoji presentation in the masthead/sidebar (#508).
// The `domain` field (epic #490) groups each view under an action-domain in the
// sidebar (see {@link DOMAIN_ORDER}) and lets the digest map findings back to a
// landing view. Domain assignments for the cross-cutting views are first-pass
// and refined by the per-domain units (#492–498); the structural invariant
// #491 fixes is: a `home` group first, the six action domains with safety
// leading, a `discovery` Find group, and orientation/replay views demoted to `raw`.
// The `requires` field marks views that need more than the always-available
// dataset (epic #1852, ADR 0014). `serverData` views just need a rich dataset —
// shown on the sample showcase (full corpus) and on a user upload that covers
// them; `liveServer` views need the live backend control plane and stay out of
// the public SPA builds entirely (they also carry server-touching code that the
// `spa-boundary` gate forbids). See {@link variantCapabilities}.
export interface NavItem {
  view: View;
  label: string;
  icon: ComponentType<SVGIconProps>;
  domain: ActionDomain;
  /** Optional one-line explainer used by PageHeader; source of truth for views. */
  description?: string;
  requires?: ViewRequirement;
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    view: 'home',
    label: 'Overview',
    icon: TachometerAltIcon,
    domain: 'home',
    description:
      'Your highest-priority findings across cost, speed, success, safety, context, and workflow, ranked so you can act on what matters most first.',
  },
  {
    view: 'recommendations',
    label: 'Recommendations',
    icon: StarIcon,
    domain: 'home',
    description:
      'Prioritized fixes and habits from cost, context, workflow, safety, and reliability signals.',
  },
  {
    view: 'adoption',
    label: 'Adoption',
    icon: ClipboardCheckIcon,
    domain: 'home',
    description:
      'Tracks surfaced recommendations through marker-confirmed config adoption.',
    requires: 'serverData',
  },
  {
    view: 'provisioning',
    label: 'Provision',
    icon: ServerIcon,
    domain: 'home',
    requires: 'liveServer',
    description:
      'Launch and manage remote agent sessions on your cluster so you can run work outside your local machine.',
  },
  // liveServer (not serverData): the Diary fetches its daily digest from the
  // server (`fetchDigest` -> /api/digest) with no client-side fallback, so it has
  // no data to render on the sample/upload builds — hide it there rather than
  // ship an empty day (#1889).
  { view: 'diary', label: 'Diary', icon: CalendarAltIcon, domain: 'home', requires: 'liveServer' },
  {
    view: 'permissions',
    label: 'Permissions',
    icon: LockIcon,
    domain: 'safety',
    description:
      'Track permission modes, dangerous commands, prompt-prone tools, and policy candidates that shape safety posture.',
  },
  {
    view: 'enterprise',
    label: 'Enterprise',
    icon: LockIcon,
    domain: 'safety',
    requires: 'liveServer',
    description:
      'Configure enterprise authentication and review who has access when the dashboard runs in shared, multi-user mode.',
  },
  { view: 'summary', label: 'Summary', icon: ChartPieIcon, domain: 'cost' },
  {
    view: 'cost',
    label: 'Cost',
    icon: DollarSignIcon,
    domain: 'cost',
    description:
      "Per-tool costs use proportional attribution: each session's total cost is split across tool types by result size, falling back to call count when result sizes are unavailable.",
  },
  {
    view: 'reclaim-compass',
    label: 'Reclaim Compass',
    icon: BullseyeIcon,
    domain: 'cost',
    description:
      'Track your context-and-cost reclaim trend over time so you can see whether the changes you make are actually paying off.',
  },
  {
    view: 'tokens',
    label: 'Tokens',
    icon: CoinsIcon,
    domain: 'cost',
    description:
      'Track token volume, cache behavior, model mix, and estimated spend across loaded sessions.',
  },
  {
    view: 'files',
    label: 'File Impact',
    icon: FileAltIcon,
    domain: 'cost',
    description:
      'See which files and directories dominate reads, edits, writes, and repeated re-reads so you can reduce avoidable context churn.',
  },
  // Model Evals workbench (#1086, epic #975): routing-eval evidence + scoped
  // routing recommendations live under the cost lever (model routing).
  { view: 'model-evals', label: 'Model Evals', icon: FlaskIcon, domain: 'cost', requires: 'serverData' },
  {
    view: 'errors',
    label: 'Errors',
    icon: ExclamationTriangleIcon,
    domain: 'success-rate',
    description:
      'Spot which tools, commands, and sessions generate the most errors and retries so you can fix the flakiest steps in your workflow.',
  },
  {
    view: 'report-card',
    label: 'Report Card',
    icon: ClipboardCheckIcon,
    domain: 'success-rate',
    description:
      'Grade how reliably your unattended automation runs complete so you can tell whether headless agents are finishing their work or failing silently.',
    requires: 'serverData',
  },
  { view: 'review-queue', label: 'Review Queue', icon: ClipboardListIcon, domain: 'success-rate', requires: 'serverData' },
  {
    view: 'evaluator',
    label: 'Speed Check',
    icon: BullseyeIcon,
    domain: 'speed',
    description:
      'Compare response speed and throughput across models and sessions so you can see where latency is slowing your work down.',
  },
  { view: 'context', label: 'Context Health', icon: HeartbeatIcon, domain: 'context-health' },
  { view: 'conversation', label: 'Turn Patterns', icon: CommentIcon, domain: 'context-health' },
  { view: 'tools', label: 'Tool Usage', icon: ToolsIcon, domain: 'workflow-hygiene' },
  {
    view: 'agents',
    label: 'Agents',
    icon: UsersIcon,
    domain: 'workflow-hygiene',
    description:
      'See how often subagents, skills, and MCP tools are invoked and how well they perform so you can decide which to lean on and which to retire.',
  },
  {
    view: 'automation',
    label: 'Automation',
    icon: RobotIcon,
    domain: 'workflow-hygiene',
    description:
      'Review your unattended SDK and CLI runs so you can confirm scheduled and headless agents are doing what you expect.',
  },
  {
    view: 'workflows',
    label: 'Workflows',
    icon: ProjectDiagramIcon,
    domain: 'workflow-hygiene',
    description:
      'Inspect completed Workflow-tool runs so you can see how multi-agent orchestrations fanned out and where they spent time or failed.',
  },
  { view: 'prompts', label: 'Prompts', icon: CommentIcon, domain: 'workflow-hygiene' },
  {
    view: 'shadow-calls',
    label: 'Shadow Calls',
    icon: FlaskIcon,
    domain: 'workflow-hygiene',
    requires: 'serverData',
    description:
      'Review the shadow A/B experiments run against your tasks so you can see which alternative approaches beat your default and fed the recommendation engine.',
  },
  { view: 'patterns', label: 'Session Patterns', icon: ThLargeIcon, domain: 'workflow-hygiene' },
  // Not serverOnly: like Workflows, Memories accepts the user's own uploaded
  // `memory/*.md` in the SPA/upload build (#538) and shows a data-aware
  // "needs a server" placeholder only when empty (see Memories.tsx).
  {
    view: 'memories',
    label: 'Memories',
    icon: BrainIcon,
    domain: 'workflow-hygiene',
    description:
      'Browse the memory files Claude has saved per project so you can review, prune, or correct what the agent remembers about your work.',
  },
  {
    view: 'tasks',
    label: 'Task Health',
    icon: TasksIcon,
    domain: 'workflow-hygiene',
    description:
      'Track task completion rates and cold-session risk so you can catch work that stalls or gets dropped between sessions.',
    requires: 'serverData',
  },
  {
    view: 'teams',
    label: 'Team Coordination',
    icon: SitemapIcon,
    domain: 'workflow-hygiene',
    requires: 'serverData',
    description:
      'See how your multi-agent teams hand off work so you can spot stalled members and coordination bottlenecks.',
  },
  {
    view: 'plans',
    label: 'Task Plans',
    icon: ClipboardListIcon,
    domain: 'workflow-hygiene',
    requires: 'serverData',
    description:
      'Inspect the plans your agents wrote and how their shapes evolved, so you can see how work was scoped and broken down across sessions.',
  },
  {
    view: 'search',
    label: 'Search',
    icon: SearchIcon,
    domain: 'discovery',
    description:
      'Search across loaded sessions and transcripts to find conversations, tools, and files by keyword.',
  },
  {
    view: 'sessions',
    label: 'Sessions',
    icon: CommentsIcon,
    domain: 'discovery',
    description:
      'Browse loaded sessions with their projects, timestamps, message counts, and token totals.',
  },
  {
    view: 'projects',
    label: 'Projects',
    icon: FolderIcon,
    domain: 'discovery',
    description:
      'Break activity down by project to see where sessions, messages, and token spend concentrate.',
  },
  {
    view: 'timeline',
    label: 'Timeline',
    icon: HistoryIcon,
    domain: 'raw',
    description:
      'Replay your sessions on a time axis so you can see when work happened and how activity clustered over the day.',
  },
  // #14: the former standalone "Stats" view (UsageStats) is folded into
  // "Activity" (the survivor). Its old `#/stats` deep link is preserved via
  // {@link REDIRECTED_VIEWS} below, which resolves it to `activity`.
  { view: 'activity', label: 'Activity', icon: RunningIcon, domain: 'raw' },
  { view: 'pulse', label: 'Pulse', icon: ChartLineIcon, domain: 'raw', requires: 'serverData' },
] as const;

/**
 * Canonical raw-evidence destinations for duplicated recommendation signals
 * (#1615). Keep this matrix beside {@link NAV_ITEMS}: when a view moves in the
 * sidebar, the matching evidence owner is reviewed in the same file. Digest and
 * recommendation drill-throughs must resolve cross-domain signals through this
 * table before falling back to a detector's local `view`.
 *
 * Matrix:
 * - token-usage -> Tokens for token volume, cache, model mix, and context-window pressure.
 * - model-routing -> Model Evals for model/task fit and eval routing gaps.
 * - agent-usage -> Agents for subagent, skill, and MCP inventory/usage.
 * - automation-runs -> Automation for SDK/unattended run evidence.
 * - tool-usage -> Tool Usage for command loops, native-bypass, and effectiveness.
 * - file-impact -> File Impact for read/edit churn and repeated file evidence.
 * - permission-safety -> Permissions for modes, bypasses, dangerous commands, and policy.
 * - error-retry -> Errors for API, hook, retry, and tool-error evidence.
 * - speed-latency -> Speed Check for wall-clock, model-latency, and evaluator speed.
 * - workflow-runs -> Workflows for workflow execution failures and runaway cost.
 * - task-health -> Task Health for blocked, abandoned, and owner-concentrated tasks.
 * - activity-history -> Activity for historical trends and stale-project evidence.
 */
export function getNavItem(view: View): NavItem | undefined {
  return NAV_ITEMS.find((item) => item.view === view);
}

/** Views needing a rich dataset (sample corpus / covered upload / server). */
export const SERVER_DATA_VIEWS = new Set<View>(
  NAV_ITEMS.filter((i) => i.requires === 'serverData').map((i) => i.view)
);

/** Views needing the live backend control plane — excluded from public SPA builds. */
export const LIVE_SERVER_VIEWS = new Set<View>(
  NAV_ITEMS.filter((i) => i.requires === 'liveServer').map((i) => i.view)
);

/**
 * Union of views that need more than the always-available dataset. Retained for
 * callers that only care "is this gated at all" (e.g. the live-server redirect
 * guard); finer gating uses {@link isNavViewAvailable} with the variant caps.
 */
export const SERVER_ONLY_VIEWS = new Set<View>(
  NAV_ITEMS.filter((i) => i.requires).map((i) => i.view)
);

/**
 * Whether a view is available under a delivery variant's capabilities (epic
 * #1852, ADR 0014). `liveServer` views need the backend control plane;
 * `serverData` views need a rich dataset (the sample corpus, a covered upload,
 * or a server). Kept here (using the derived sets) so this module stays free of
 * any `@api-client` value import. Callers pass `variantCapabilities()`.
 */
export function isNavViewAvailable(
  view: View,
  caps: VariantCapabilities,
  uploadCoveredViews: ReadonlySet<View> = new Set()
): boolean {
  if (LIVE_SERVER_VIEWS.has(view)) return caps.hasLiveServer;
  if (SERVER_DATA_VIEWS.has(view)) {
    return caps.hasServerData || uploadCoveredViews.has(view);
  }
  return true;
}

/**
 * #610: the dense "Clean workflow" (workflow-hygiene) group holds 9 flat peers —
 * the worst junk drawer in the nav. Surface only the operational triad by
 * default; the rest sit behind an in-group "+ N more" expander (rendered in
 * PFLayout). Order here is the surfaced order. Composes with the SPA filter
 * (server-only members already drop out) and per-user hidden views.
 */
export const WORKFLOW_HYGIENE_CORE: readonly View[] = [
  'tools',
  'agents',
  'automation',
];

/**
 * #612: the `discovery` ("Find") group exposed multiple co-equal tabs with no
 * scent for which to click first, so novice first-clicks get consumed browsing
 * the corpus instead of reading the coaching digest. Surface Search as the
 * primary Find entry; the remaining discovery views sit behind a "Browse"
 * sub-level (an in-group NavExpandable), mirroring the #610 "+ N more" pattern.
 * Order here is the surfaced order. Composes with the SPA filter (server-only
 * members already drop out) and per-user hidden views, and with the recs-driven
 * default (#609): `search` is in the curated core, the browse views are not.
 */
export const DISCOVERY_CORE: readonly View[] = ['search'];

const VALID_VIEWS = new Set<View>(NAV_ITEMS.map((i) => i.view));

/**
 * Retired view ids that must keep resolving for old deep links (#14). Each key
 * is a no-longer-cataloged route that maps to its survivor: `stats` was merged
 * into `activity`, so `#/stats` resolves as `#/activity`. The router treats a
 * redirect source as a valid hash ({@link isValidView}) and callers funnel the
 * parsed view through {@link resolveViewRedirect} so it lands on the survivor.
 */
export const REDIRECTED_VIEWS: Readonly<Partial<Record<View, View>>> = {
  stats: 'activity',
  // #1509: the standalone graph-first surface was folded into Timeline as an
  // evidence overlay. Old `#/forensics` links now land on the merged surface.
  forensics: 'timeline',
};

/**
 * Map a (possibly retired) view to its current survivor (#14). A live catalog
 * view is returned unchanged; a redirected source resolves to its target. Used
 * by the hash router and `navigateTo` so `#/stats` lands on `activity` instead
 * of stranding on a removed view.
 */
export function resolveViewRedirect(view: View): View {
  return REDIRECTED_VIEWS[view] ?? view;
}

/**
 * Type-guard: is `v` one of the catalog's view ids? Used by the hash router.
 * Retired-but-redirected ids ({@link REDIRECTED_VIEWS}) count as valid so an old
 * deep link still parses and can be funnelled to its survivor.
 */
export function isValidView(v: string): v is View {
  return VALID_VIEWS.has(v as View) || v in REDIRECTED_VIEWS;
}

/** The action-domain a view belongs to (defaults to `raw` for any unlisted view). */
export function domainForView(view: View): ActionDomain {
  return NAV_ITEMS.find((i) => i.view === view)?.domain ?? 'raw';
}

/**
 * The always-visible curated core (#609, keystone of epic #604). On a fresh /
 * never-customized profile the sidebar shows exactly this set PLUS every view
 * whose action-domain currently has an active digest finding (see
 * {@link isDefaultVisibleView}) — the digest is the discovery vector, so a view
 * that produces no finding produces no scent and stays hidden until detectors
 * surface one. Everything else is one "Show advanced views" toggle away, and
 * any view remains reachable by deep-link / digest card regardless of the
 * sidebar (the hash router renders any valid view).
 */
export const CURATED_CORE_VIEWS: readonly View[] = [
  'home',
  'recommendations',
  'permissions',
  'cost',
  'reclaim-compass',
  'errors',
  'search',
];

const CURATED_CORE_SET = new Set<View>(CURATED_CORE_VIEWS);

/**
 * Is `view` in the recs-driven default-visible set? (#609) True when the view is
 * in the curated core, or when its action-domain currently has an active digest
 * finding. `findingDomains` is the set the DigestSpine computes (reused, not
 * recomputed); an empty/absent set means "no findings yet" → core only.
 */
export function isDefaultVisibleView(
  view: View,
  findingDomains: ReadonlySet<ActionDomain> | null | undefined
): boolean {
  return CURATED_CORE_SET.has(view) || (findingDomains?.has(domainForView(view)) ?? false);
}

function sanitize(raw: unknown): NavPrefs {
  if (!raw || typeof raw !== 'object') return freshDefaults();
  const obj = raw as Record<string, unknown>;
  const rawHidden = Array.isArray(obj.hiddenViews) ? obj.hiddenViews : [];
  const hiddenViews = rawHidden.filter(
    (v): v is View => typeof v === 'string' && VALID_VIEWS.has(v as View)
  );
  const bannerDismissed = obj.bannerDismissed === true;
  const lastView =
    typeof obj.lastView === 'string' && VALID_VIEWS.has(obj.lastView as View)
      ? (obj.lastView as View)
      : undefined;
  const entrypointFilter: EntrypointFilter =
    obj.entrypointFilter === 'unattended' ? 'unattended' : 'all';
  // Legacy blobs (pre-#608) carry no version → read as 0 so they migrate forward
  // exactly once. A non-finite/missing value is treated as 0 for the same reason.
  const navLayoutVersion =
    typeof obj.navLayoutVersion === 'number' && Number.isFinite(obj.navLayoutVersion)
      ? obj.navLayoutVersion
      : 0;
  // Explicit-customization signal. Honour a stored flag, but also INFER it from a
  // *legacy* (version-0) profile: before #608 the only way to populate
  // `hiddenViews` was an explicit Settings toggle, so a non-empty legacy
  // hidden-set IS a customization and must survive the first migration intact.
  // The inference is scoped to version 0: once #608+ stamps a version, a
  // non-empty `hiddenViews` may just be an *adopted* curated default, so a
  // versioned blob's `customized` field is the sole source of truth — otherwise
  // a downgrade would mistake a curated default for an explicit choice and
  // freeze the profile out of future curated generations.
  const customized =
    obj.customized === true || (navLayoutVersion === 0 && hiddenViews.length > 0);
  return {
    hiddenViews,
    bannerDismissed,
    entrypointFilter,
    navLayoutVersion,
    customized,
    ...(lastView ? { lastView } : {}),
  };
}

/**
 * Reconcile a parsed profile with the current curated-default generation (#608).
 * Pure and idempotent: a profile already at {@link CURRENT_NAV_LAYOUT_VERSION} is
 * returned untouched. A profile that predates it adopts
 * {@link CURATED_DEFAULT_HIDDEN_VIEWS} *only* when it was never explicitly
 * customized; an explicit choice is preserved. Either way the version is stamped
 * so the reconciliation runs once per generation, not on every read.
 */
export function migrateNavPrefs(prefs: NavPrefs): NavPrefs {
  if (prefs.navLayoutVersion >= CURRENT_NAV_LAYOUT_VERSION) return prefs;
  return {
    ...prefs,
    hiddenViews: prefs.customized
      ? prefs.hiddenViews
      : [...CURATED_DEFAULT_HIDDEN_VIEWS],
    navLayoutVersion: CURRENT_NAV_LAYOUT_VERSION,
  };
}

/**
 * Pick the route to land on at load (#141). Prefers the sticky `lastView`, but
 * guards it: a stored view that's invalid, now hidden, or server-only in upload
 * mode falls through to the default. If even the default is unavailable, falls
 * back to the first still-visible tab.
 */
export function resolveInitialView(
  prefs: NavPrefs,
  caps: VariantCapabilities,
  uploadCoveredViews: ReadonlySet<View> = new Set()
): View {
  const hidden = new Set(prefs.hiddenViews);
  const isVisible = (v: View) =>
    VALID_VIEWS.has(v) &&
    !hidden.has(v) &&
    isNavViewAvailable(v, caps, uploadCoveredViews);
  if (prefs.lastView && isVisible(prefs.lastView)) return prefs.lastView;
  if (isVisible(DEFAULT_VIEW)) return DEFAULT_VIEW;
  const firstVisible = NAV_ITEMS.find(
    (i) => !hidden.has(i.view) && isNavViewAvailable(i.view, caps, uploadCoveredViews)
  );
  return firstVisible ? firstVisible.view : DEFAULT_VIEW;
}

/** Record the last-viewed route, returning a new prefs object (#141). */
export function setLastView(prefs: NavPrefs, view: View): NavPrefs {
  if (prefs.lastView === view) return prefs;
  return { ...prefs, lastView: view };
}

export function getNavPrefs(): NavPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return freshDefaults();
    const parsed = sanitize(JSON.parse(raw));
    const migrated = migrateNavPrefs(parsed);
    // Persist the reconciliation so it runs once per generation, not on every
    // read: without this the on-disk blob stays stale and a never-customized
    // profile would re-adopt the curated default on every cold load (#608).
    // `migrateNavPrefs` returns the same reference when nothing changed.
    if (migrated !== parsed) setNavPrefs(migrated);
    return migrated;
  } catch {
    return freshDefaults();
  }
}

export function setNavPrefs(prefs: NavPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* localStorage may be disabled (private mode etc.) — silently fail */
  }
}

export function hideView(prefs: NavPrefs, view: View): NavPrefs {
  if (prefs.hiddenViews.includes(view)) return prefs;
  // An explicit hide is a customization (#608): mark it so a curated default
  // can never roll over this choice.
  return { ...prefs, hiddenViews: [...prefs.hiddenViews, view], customized: true };
}

export function showView(prefs: NavPrefs, view: View): NavPrefs {
  if (!prefs.hiddenViews.includes(view)) return prefs;
  return {
    ...prefs,
    hiddenViews: prefs.hiddenViews.filter((v) => v !== view),
    customized: true,
  };
}

export function showAllViews(prefs: NavPrefs): NavPrefs {
  if (prefs.hiddenViews.length === 0) return prefs;
  // Explicitly revealing every tab is itself a customization (#608): the user
  // wants everything, so a future curated default must not re-hide views.
  return { ...prefs, hiddenViews: [], customized: true };
}

export function dismissBanner(prefs: NavPrefs): NavPrefs {
  if (prefs.bannerDismissed) return prefs;
  return { ...prefs, bannerDismissed: true };
}

/**
 * Flip the recs-driven-sidebar mode (#609): the "Show advanced views" toggle.
 * Collapse clears `customized` (back to the curated core + finding-domains);
 * expand sets it (the full advanced list). Both legs PRESERVE the user's
 * explicit `hiddenViews` — "Show advanced" reveals the advanced nav, it does not
 * silently discard a Settings hide-choice — so a collapse->expand round-trip can
 * never lose a customized hidden-set.
 */
export function toggleAdvancedNav(prefs: NavPrefs): NavPrefs {
  return { ...prefs, customized: !prefs.customized };
}

/** Set the sticky entrypoint scope (#132), returning a new prefs object. */
export function setEntrypointFilter(
  prefs: NavPrefs,
  entrypointFilter: EntrypointFilter
): NavPrefs {
  if (prefs.entrypointFilter === entrypointFilter) return prefs;
  return { ...prefs, entrypointFilter };
}
