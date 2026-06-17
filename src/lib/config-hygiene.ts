/**
 * Config hygiene engine — the P/I/U layer from #172/#174.
 *
 * Each tracked resource (skill, subagent, MCP server, plugin) lives in three
 * states relative to the user's transcripts:
 *   - **Present** in transcripts (work that *could* use it happened)
 *   - **Installed** in live config (the user has it available)
 *   - **Used** in transcripts (it actually got invoked)
 *
 * This module walks the (P, I, U) cube against `liveConfig` × `SessionAttribution[]`
 * and emits findings for the gaps. Today it focuses on the I-and-not-U slice
 * ("installed but unused") because that's the highest-signal finding for the
 * personas we've talked through (P3 Quentin / P2 Priya / Marcus from
 * docs/user-stories.md). Future passes can fold in "present-but-not-installed"
 * once a semantic capability map exists.
 *
 * Design decisions captured in the issue body of #172:
 *  - **Lifecycle (Q5)**: A+B purist — a finding disappears when usage > 0
 *    inside the relevant scope, or when the resource is removed from config.
 *    No snooze state, no UI dismissal. Pure function of the bundle + attribution.
 *  - **Threshold (Q6)**: 30-day recency window for *active* resources
 *    (skills/subagents/MCP/plugins/commands). Tripwire resources (hooks,
 *    permission rules) would use lifetime — deferred from v1 because their
 *    attribution data isn't structured enough.
 *  - **Hedge (Q6)**: when the retained data window is shorter than the
 *    threshold ("you only have 7 days of history"), tag the finding so the UI
 *    can phrase honestly instead of claiming "30 days unused" against 7 days
 *    of data.
 *  - **Scope rollup (Q4)**: emit at the coarsest *true* scope. A global skill
 *    unused everywhere → one global finding. A project-scoped server unused
 *    only in the project that scopes it → one per-project finding. We never
 *    emit N per-project findings for one global resource (would drown the UI).
 *
 * The engine is pure — same input always gives the same output, no clock
 * reads except via the optional `now` parameter for testability. Tolerant of
 * missing or partial input: a null bundle returns no findings rather than
 * throwing.
 */
import type {
  LiveConfig,
  LiveMcpServer,
  LivePlugin,
  SettingsHealth,
  SettingsHealthFinding,
} from '../types';
import type { SessionAttribution } from './parse-agents';

/**
 * The resource families v1 of the hygiene engine knows about. `hook` and
 * `command` are deliberately absent from v1: hooks lack per-matcher
 * attribution in `parseRuntimeEvents` (only aggregated Stop-hook telemetry
 * exists) and slash commands have no transcript parser at all. Adding them
 * is its own piece of work — tracked as follow-ups on #174.
 */
export type HygieneResourceType = 'skill' | 'subagent' | 'command' | 'mcpServer' | 'plugin';

/**
 * Coarsest-true scope at which the finding fires. `global` means the resource
 * lives in `~/.claude` (or the user's top-level Claude Code config) and is
 * unused across every project's transcripts. A project-scoped finding fires
 * only when the resource is itself project-scoped, or when a single project
 * has explicitly enabled the resource (e.g. `enabledMcpjsonServers`) but
 * hasn't actually reached for it.
 */
export type HygieneScope = { kind: 'global' } | { kind: 'project'; project: string };

/**
 * Why the finding is surfaced. v1 only emits `unused`; richer states
 * (`underused`, `stale`, `redundant`) are deferred until we've seen the
 * `unused` lane in production and know what additional thresholds matter.
 */
export type HygieneState = 'unused';

/**
 * Optional hedges the UI can render alongside the finding text. Today only
 * one hedge exists; defined as a union so future cases (e.g.
 * `transcripts-missing-attribution`) don't have to change consumers.
 */
export type HygieneHedge = 'window-shorter-than-threshold';

export interface HygieneFinding {
  /**
   * Stable, deterministic id used as the React key and (eventually) as the
   * dismissal id if we ever back off purist lifecycle. Shape:
   * `<resourceType>.<state>:<resourceId>[@<projectPath>]`.
   */
  id: string;
  resourceType: HygieneResourceType;
  /** Human-readable name — skill folder name, agent file id, MCP server key,
   *  plugin registry id. */
  resourceId: string;
  scope: HygieneScope;
  state: HygieneState;
  /** Last invocation timestamp (epoch ms), null when never invoked at all. */
  lastSeen: number | null;
  /** Invocations summed across every retained session. */
  lifetimeCount: number;
  /** Invocations summed inside the recency window (or === lifetimeCount when
   *  `windowDays` is null, i.e. tripwire resources). */
  windowCount: number;
  /** Window the count was computed against, in days. `null` would denote a
   *  tripwire resource (lifetime); v1 only emits 30-day active windows. */
  windowDays: number;
  /** UI hedge — see {@link HygieneHedge}. Undefined when no hedge applies. */
  hedge?: HygieneHedge;
  /**
   * File that owns the resource definition or registry entry. The UI uses this
   * for "open config" affordances; it is provenance, not detector evidence.
   */
  sourcePath?: string;
  /**
   * Concrete filesystem path to prune when the resource is file-backed. MCP
   * servers are JSON keys, so they usually omit this and use sourcePath only.
   */
  removalPath?: string;
}

/** Recency window for the *active* resource types (Q6 in #172). */
const ACTIVE_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The minimum input the engine needs. Sessions are passed because attribution
 * carries only sessionIds; we join here to get per-invocation timestamps for
 * the recency window. Token data is *not* required — none of v1's findings
 * key off token counts, only invocation counts and timestamps.
 */
export interface HygieneInput {
  liveConfig: LiveConfig | null | undefined;
  attribution: SessionAttribution[];
  /** Lightweight session metadata — we only need `sessionId` and a
   *  timestamp to anchor each attribution row in time. */
  sessions: Array<{ sessionId: string; startTime: number; project?: string }>;
  /** Override the clock (testability). Defaults to `Date.now()`. */
  now?: number;
}

interface SessionUsage {
  project?: string;
  /** Session's anchoring timestamp, used to bucket invocations into the
   *  recency window. */
  startTime: number;
  /** All four attribution maps, copied off the SessionAttribution row so the
   *  joiner doesn't have to re-check property existence per resource. */
  agents: Record<string, number>;
  skills: Record<string, number>;
  commands: Record<string, number>;
  mcpServers: Record<string, number>;
}

/**
 * Join attribution to session start times so each invocation is dated.
 * Sessions without a matching attribution row contribute nothing (they
 * exercised no skill / agent / MCP). Attribution rows for unknown sessions
 * are dropped — happens when transcripts are stale or out of sync.
 */
function buildSessionUsage(
  attribution: SessionAttribution[],
  sessions: HygieneInput['sessions']
): SessionUsage[] {
  const sessionIndex = new Map(sessions.map((s) => [s.sessionId, s]));
  const out: SessionUsage[] = [];
  for (const a of attribution) {
    const session = sessionIndex.get(a.sessionId);
    if (!session) continue;
    out.push({
      project: session.project,
      startTime: session.startTime,
      agents: countMap(a.agents),
      skills: countMap(a.skills),
      // `?? {}`: attribution rows cached before #634 added this field won't carry
      // it; without the guard countMap(undefined) would throw and 500 the engine.
      commands: countMap(a.commands ?? {}),
      mcpServers: countMap(a.mcpServers),
    });
  }
  return out;
}

function countMap(rec: Record<string, { invocations: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, val] of Object.entries(rec)) {
    if (val && typeof val.invocations === 'number') out[name] = val.invocations;
  }
  return out;
}

/**
 * Lifetime + window counts and last-seen for a single resource id, looked up
 * across every session. The lookup key (`getCount`) is a function so the
 * caller picks which of the three attribution maps to read — same logic
 * applies to skills, agents, and MCP servers.
 */
function summariseUsage(
  resourceId: string,
  usages: SessionUsage[],
  windowStart: number,
  getCount: (u: SessionUsage, id: string) => number,
  project?: string
): { lastSeen: number | null; lifetimeCount: number; windowCount: number } {
  let lastSeen: number | null = null;
  let lifetimeCount = 0;
  let windowCount = 0;
  for (const u of usages) {
    if (project && u.project !== project) continue;
    const n = getCount(u, resourceId);
    if (n <= 0) continue;
    lifetimeCount += n;
    if (u.startTime >= windowStart) windowCount += n;
    if (lastSeen == null || u.startTime > lastSeen) lastSeen = u.startTime;
  }
  return { lastSeen, lifetimeCount, windowCount };
}

function resourceScope(resource: { scope?: string; projectPath?: string }): HygieneScope {
  return resource.scope === 'project'
    ? { kind: 'project', project: resource.projectPath ?? '(unknown)' }
    : { kind: 'global' };
}

/**
 * Effective retained-data window in days — the span between the oldest
 * session we have and `now`. When this is shorter than {@link ACTIVE_WINDOW_DAYS}
 * we tag findings with the `window-shorter-than-threshold` hedge so the UI
 * can phrase honestly instead of overstating staleness.
 *
 * Returns `Infinity` when there are no sessions at all, so the "data window
 * shorter than threshold" check naturally evaluates false (we can't claim a
 * resource is unused when there's nothing to compare against, but in that
 * case `lifetimeCount` would also be 0 and we'd surface it as unused with
 * the hedge anyway — that's the honest reading).
 */
function effectiveDataWindowDays(
  sessions: HygieneInput['sessions'],
  now: number
): number {
  if (sessions.length === 0) return Infinity;
  let oldest = now;
  for (const s of sessions) {
    if (s.startTime > 0 && s.startTime < oldest) oldest = s.startTime;
  }
  return Math.max(0, (now - oldest) / DAY_MS);
}

/**
 * Emit a single "unused" finding for an installed resource. Centralised so
 * every resource family agrees on the shape (id, hedge application, window
 * accounting) without each call site re-deriving them.
 */
function emitUnusedFinding(args: {
  resourceType: HygieneResourceType;
  resourceId: string;
  scope: HygieneScope;
  summary: ReturnType<typeof summariseUsage>;
  hedge?: HygieneHedge;
  sourcePath?: string;
  removalPath?: string;
}): HygieneFinding {
  const {
    resourceType,
    resourceId,
    scope,
    summary,
    hedge,
    sourcePath,
    removalPath,
  } = args;
  const scopeSuffix = scope.kind === 'project' ? `@${scope.project}` : '';
  return {
    id: `${resourceType}.unused:${resourceId}${scopeSuffix}`,
    resourceType,
    resourceId,
    scope,
    state: 'unused',
    lastSeen: summary.lastSeen,
    lifetimeCount: summary.lifetimeCount,
    windowCount: summary.windowCount,
    windowDays: ACTIVE_WINDOW_DAYS,
    ...(hedge ? { hedge } : {}),
    ...(sourcePath ? { sourcePath } : {}),
    ...(removalPath ? { removalPath } : {}),
  };
}

function skillManifestPath(resourcePath: string | undefined): string | undefined {
  if (!resourcePath) return undefined;
  return resourcePath.endsWith('/') ? `${resourcePath}SKILL.md` : `${resourcePath}/SKILL.md`;
}

/**
 * MCP servers come in two scopes in the bundle: `global` (registered in
 * `~/.claude.json`'s top-level `mcpServers`) and `project` (registered in a
 * specific project's entry). The rollup rule (Q4) says:
 *  - global server, used in any session → no finding
 *  - global server, used nowhere → one global finding
 *  - project-scoped server, unused inside its project → one per-project
 *    finding (we never emit a "global unused" for a project-scoped server)
 */
function findingsForMcpServers(
  servers: LiveMcpServer[],
  usages: SessionUsage[],
  windowStart: number,
  hedge: HygieneHedge | undefined
): HygieneFinding[] {
  const out: HygieneFinding[] = [];
  for (const s of servers) {
    const summary = summariseUsage(
      s.id,
      usages,
      windowStart,
      (u, id) => u.mcpServers[id] ?? 0
    );
    if (summary.windowCount > 0) continue;
    const scope: HygieneScope =
      s.scope === 'global'
        ? { kind: 'global' }
        : { kind: 'project', project: s.enabledByProjects?.[0] ?? '(unknown)' };
    out.push(
      emitUnusedFinding({
        resourceType: 'mcpServer',
        resourceId: s.id,
        scope,
        summary,
        hedge,
        sourcePath: s.sourcePath,
      })
    );
  }
  return out;
}

/**
 * A plugin counts as "used" when *any* of its bundled artifacts (skills /
 * agents we can attribute today; commands deferred) fires inside the window.
 * Plugins without an enumerable bundle (`bundled` undefined or empty) are
 * skipped — we can't honestly answer "is it used" without knowing what it
 * ships.
 */
function findingsForPlugins(
  plugins: LivePlugin[],
  usages: SessionUsage[],
  windowStart: number,
  hedge: HygieneHedge | undefined
): HygieneFinding[] {
  const out: HygieneFinding[] = [];
  for (const p of plugins) {
    const bundled = p.bundled;
    if (!bundled) continue;
    const skillIds = bundled.skills ?? [];
    const agentIds = bundled.agents ?? [];
    if (skillIds.length === 0 && agentIds.length === 0) continue;
    let lastSeen: number | null = null;
    let lifetimeCount = 0;
    let windowCount = 0;
    for (const id of skillIds) {
      const s = summariseUsage(id, usages, windowStart, (u, k) => u.skills[k] ?? 0);
      lifetimeCount += s.lifetimeCount;
      windowCount += s.windowCount;
      if (s.lastSeen != null && (lastSeen == null || s.lastSeen > lastSeen)) {
        lastSeen = s.lastSeen;
      }
    }
    for (const id of agentIds) {
      const s = summariseUsage(id, usages, windowStart, (u, k) => u.agents[k] ?? 0);
      lifetimeCount += s.lifetimeCount;
      windowCount += s.windowCount;
      if (s.lastSeen != null && (lastSeen == null || s.lastSeen > lastSeen)) {
        lastSeen = s.lastSeen;
      }
    }
    if (windowCount > 0) continue;
    out.push(
      emitUnusedFinding({
        resourceType: 'plugin',
        resourceId: p.id,
        scope: p.scope === 'project'
          ? { kind: 'project', project: p.installPath || '(unknown)' }
          : { kind: 'global' },
        summary: { lastSeen, lifetimeCount, windowCount },
        hedge,
        sourcePath: p.sourcePath,
        removalPath: p.installPath,
      })
    );
  }
  return out;
}

/**
 * Top-level entry. Returns findings sorted by (resource-type group →
 * lastSeen ascending → resourceId ascending), matching the UI's stable
 * grouping requirement from Q7.
 */
export function computeConfigHygiene(input: HygieneInput): HygieneFinding[] {
  const lc = input.liveConfig;
  if (!lc) return [];
  const now = input.now ?? Date.now();
  const windowStart = now - ACTIVE_WINDOW_DAYS * DAY_MS;
  const dataWindowDays = effectiveDataWindowDays(input.sessions, now);
  const hedge: HygieneHedge | undefined =
    dataWindowDays < ACTIVE_WINDOW_DAYS
      ? 'window-shorter-than-threshold'
      : undefined;
  const usages = buildSessionUsage(input.attribution, input.sessions);

  const out: HygieneFinding[] = [];

  for (const skill of lc.skills) {
    const scope = resourceScope(skill);
    const summary = summariseUsage(
      skill.id,
      usages,
      windowStart,
      (u, id) => u.skills[id] ?? 0,
      scope.kind === 'project' ? scope.project : undefined
    );
    if (summary.windowCount > 0) continue;
    out.push(
      emitUnusedFinding({
        resourceType: 'skill',
        resourceId: skill.id,
        scope,
        summary,
        hedge,
        sourcePath: skillManifestPath(skill.path),
        removalPath: skill.path,
      })
    );
  }

  // Subagents — same logic as skills, different attribution map.
  for (const agent of lc.subagents) {
    const scope = resourceScope(agent);
    const summary = summariseUsage(
      agent.id,
      usages,
      windowStart,
      (u, id) => u.agents[id] ?? 0,
      scope.kind === 'project' ? scope.project : undefined
    );
    if (summary.windowCount > 0) continue;
    out.push(
      emitUnusedFinding({
        resourceType: 'subagent',
        resourceId: agent.id,
        scope,
        summary,
        hedge,
        sourcePath: agent.path,
        removalPath: agent.path,
      })
    );
  }

  // Commands — slash-command definitions under ~/.claude/commands/. Usage comes
  // from the parsed `<command-name>` markers (parse-agents commands map), not a
  // native attribution field (#634). Lifts the v1 deferral noted above.
  for (const cmd of lc.commands) {
    const scope = resourceScope(cmd);
    const summary = summariseUsage(
      cmd.id,
      usages,
      windowStart,
      (u, id) => u.commands[id] ?? 0,
      scope.kind === 'project' ? scope.project : undefined
    );
    if (summary.windowCount > 0) continue;
    out.push(
      emitUnusedFinding({
        resourceType: 'command',
        resourceId: cmd.id,
        scope,
        summary,
        hedge,
        sourcePath: cmd.path,
        removalPath: cmd.path,
      })
    );
  }

  out.push(...findingsForMcpServers(lc.mcpServers, usages, windowStart, hedge));
  out.push(...findingsForPlugins(lc.plugins, usages, windowStart, hedge));

  return sortFindings(out);
}

/**
 * Canonical resource-type order — the single source of truth for grouping,
 * sorting, and rendering hygiene findings. Adding a {@link HygieneResourceType}
 * member here flows through `TYPE_ORDER`, the `ConfigHygiene` group buckets, and
 * its render order, so a new type can never silently drop a bucket again (#759:
 * `command` was missing from `ConfigHygiene`'s buckets and crashed the
 * Recommendations view to a blank screen).
 */
export const HYGIENE_RESOURCE_TYPES: readonly HygieneResourceType[] = [
  'skill',
  'subagent',
  'command',
  'mcpServer',
  'plugin',
];

const TYPE_ORDER: Record<HygieneResourceType, number> = Object.fromEntries(
  HYGIENE_RESOURCE_TYPES.map((t, i) => [t, i])
) as Record<HygieneResourceType, number>;

/**
 * Pre-compute a stable resource-type → findings map so the render path doesn't
 * re-filter the array for each group. A bucket is seeded for every canonical
 * resource type, and the `??= []` is belt-and-suspenders: even a finding whose
 * `resourceType` somehow escapes {@link HYGIENE_RESOURCE_TYPES} lands in its own
 * bucket instead of crashing the consumer with a `.push` on undefined (#759:
 * the `command` type had no bucket and blanked the Recommendations view).
 */
export function groupFindings(
  findings: HygieneFinding[]
): Record<HygieneResourceType, HygieneFinding[]> {
  const out = Object.fromEntries(
    HYGIENE_RESOURCE_TYPES.map((t) => [t, [] as HygieneFinding[]])
  ) as Record<HygieneResourceType, HygieneFinding[]>;
  for (const f of findings) (out[f.resourceType] ??= []).push(f);
  return out;
}

function sortFindings(findings: HygieneFinding[]): HygieneFinding[] {
  return findings.slice().sort((a, b) => {
    const t = TYPE_ORDER[a.resourceType] - TYPE_ORDER[b.resourceType];
    if (t !== 0) return t;
    // Stalest first within group — null lastSeen (never used) is the
    // staleest, so push it ahead of any timestamp.
    const aSeen = a.lastSeen ?? -1;
    const bSeen = b.lastSeen ?? -1;
    if (aSeen !== bSeen) return aSeen - bSeen;
    return a.resourceId.localeCompare(b.resourceId);
  });
}

/**
 * UI label per resource family — kept here next to the engine so a future
 * change touches one file. The labels intentionally read as nouns
 * ("Subagents") rather than verbs/states ("Subagent recommendations") because
 * Q7 grouped findings under resource-type headings, not action headings.
 */
export const RESOURCE_TYPE_LABEL: Record<HygieneResourceType, string> = {
  skill: 'Skills',
  subagent: 'Subagents',
  command: 'Commands',
  mcpServer: 'MCP servers',
  plugin: 'Plugins',
};

// ── settings.json validation (#167) ─────────────────────────────────────
// A user's settings.json can drift into an invalid state (orphan `{}` block,
// misspelled keys, wrong value types) with no surfacing — Claude Code just
// silently ignores it. This validator runs at ingest against the RAW bytes
// (the merged LiveSettings has already dropped unknown keys and can't show
// syntax errors) and ships a SettingsHealth verdict the ConfigHygiene section
// renders. Pure and dependency-free so it's unit-testable in isolation.

/**
 * Documented top-level settings.json keys. Anything outside this set is flagged
 * as a likely typo (warning, not error — Claude Code tolerates extra keys).
 * Kept deliberately broad; missing a real key only costs a spurious warning.
 */
const KNOWN_SETTINGS_KEYS = new Set([
  'model', 'cleanupPeriodDays', 'permissions', 'hooks', 'enabledPlugins',
  'env', 'theme', 'apiKeyHelper', 'includeCoAuthoredBy',
  'enableAllProjectMcpServers', 'enabledMcpjsonServers',
  'disabledMcpjsonServers', 'autoUpdates', 'verbose', 'forceLoginMethod',
  'statusLine', 'outputStyle', 'preferredNotifChannel',
  'messageIdleNotifThresholdMs', 'spinnerTipsEnabled', 'alwaysThinkingEnabled',
  'autoCompactEnabled', 'disableAllHooks', 'feedbackSurveyState',
  'awsAuthRefresh', 'awsCredentialExport', 'sandbox', 'permissionMode',
  'defaultMode', 'skipDangerousModePermissionPrompt', 'skipAutoPermissionPrompt',
  'inputNeededNotifEnabled', 'agentPushNotifEnabled', 'idleNotifEnabled',
  'mcpServers', 'otelHeadersHelper', 'language', '$schema',
]);

/**
 * Levenshtein edit distance, capped — used to tell a misspelling of a known
 * key ("permisions") apart from a genuinely-new key the dashboard doesn't know
 * yet. Claude Code's settings schema grows over time, so a blanket
 * "unknown ⇒ typo" warning produces false positives on valid configs; only
 * near-matches to a known key are flagged.
 */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 3; // early out — beyond the threshold we care about
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Is `key` a likely misspelling of a known settings key? True when it's within
 * edit distance 2 of one (and not an exact known key). Keys that are unknown
 * but far from every known key are left alone — probably a real key we haven't
 * catalogued, not a typo.
 */
function nearestKnownKey(key: string, known: Set<string>): string | null {
  let best: string | null = null;
  let bestDist = 3;
  for (const k of known) {
    const d = editDistance(key, k);
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  return bestDist <= 2 ? best : null;
}

const KNOWN_PERMISSION_KEYS = new Set([
  'allow', 'ask', 'deny', 'defaultMode', 'additionalDirectories',
]);

function jsonType(v: unknown): string {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

/** Map a character offset in `raw` to 1-based line/column. */
function offsetToLineCol(raw: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  const end = Math.min(offset, raw.length);
  for (let i = 0; i < end; i++) {
    if (raw[i] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

/** A permission rule is `Tool` or `Tool(specifier)`. */
function looksLikePermissionRule(s: string): boolean {
  return /^[A-Za-z][\w-]*(\(.*\))?$/.test(s.trim());
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate a raw settings.json string (#167). Returns a {@link SettingsHealth}
 * verdict: a syntax error short-circuits (with line/column/excerpt); otherwise
 * the parsed object is schema-checked — known-key whitelist (unknown ⇒
 * warning), value types for the documented keys, and permission-rule shape.
 * `raw === null` (file absent/unreadable) is reported as `present:false`,
 * `ok:true` — nothing to validate is not a failure.
 */
export function validateSettingsJson(
  filePath: string,
  raw: string | null
): SettingsHealth {
  if (raw === null) {
    return { filePath, present: false, ok: true, findings: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const posMatch = /position (\d+)/.exec(msg);
    let line: number | undefined;
    let column: number | undefined;
    let excerpt: string | undefined;
    if (posMatch) {
      ({ line, column } = offsetToLineCol(raw, Number(posMatch[1])));
      excerpt = raw.split('\n')[line - 1]?.trim().slice(0, 160);
    }
    return {
      filePath,
      present: true,
      ok: false,
      findings: [
        {
          kind: 'syntax',
          severity: 'error',
          path: '',
          message: `Invalid JSON — ${msg}`,
          line,
          column,
          excerpt,
        },
      ],
    };
  }

  const findings: SettingsHealthFinding[] = [];

  if (!isPlainObject(parsed)) {
    findings.push({
      kind: 'type',
      severity: 'error',
      path: '',
      message: `Top level must be a JSON object, got ${jsonType(parsed)}.`,
    });
    return { filePath, present: true, ok: false, findings };
  }

  const error = (path: string, message: string) =>
    findings.push({ kind: 'type', severity: 'error', path, message });

  for (const key of Object.keys(parsed)) {
    if (KNOWN_SETTINGS_KEYS.has(key)) continue;
    // Only flag keys that look like a misspelling of a known one; an unknown
    // key far from every known key is probably a real setting we don't track.
    const near = nearestKnownKey(key, KNOWN_SETTINGS_KEYS);
    if (near) {
      findings.push({
        kind: 'unknown-key',
        severity: 'warning',
        path: key,
        message: `"${key}" looks like a typo of "${near}" — Claude Code will ignore an unrecognized key.`,
      });
    }
  }

  if ('model' in parsed && typeof parsed.model !== 'string') {
    error('model', `"model" should be a string, got ${jsonType(parsed.model)}.`);
  }
  if (
    'cleanupPeriodDays' in parsed &&
    typeof parsed.cleanupPeriodDays !== 'number'
  ) {
    error(
      'cleanupPeriodDays',
      `"cleanupPeriodDays" should be a number, got ${jsonType(parsed.cleanupPeriodDays)}.`
    );
  }
  if ('env' in parsed && !isPlainObject(parsed.env)) {
    error('env', `"env" should be an object, got ${jsonType(parsed.env)}.`);
  }
  if ('enabledPlugins' in parsed && !isPlainObject(parsed.enabledPlugins)) {
    error(
      'enabledPlugins',
      `"enabledPlugins" should be an object, got ${jsonType(parsed.enabledPlugins)}.`
    );
  }
  if ('hooks' in parsed && !isPlainObject(parsed.hooks)) {
    error('hooks', `"hooks" should be an object, got ${jsonType(parsed.hooks)}.`);
  }

  if ('permissions' in parsed) {
    const perms = parsed.permissions;
    if (!isPlainObject(perms)) {
      error(
        'permissions',
        `"permissions" should be an object, got ${jsonType(perms)}.`
      );
    } else {
      for (const bucket of ['allow', 'ask', 'deny'] as const) {
        if (!(bucket in perms)) continue;
        const arr = perms[bucket];
        if (!Array.isArray(arr)) {
          error(
            `permissions.${bucket}`,
            `"permissions.${bucket}" should be an array of rule strings, got ${jsonType(arr)}.`
          );
          continue;
        }
        arr.forEach((rule, i) => {
          if (typeof rule !== 'string') {
            error(
              `permissions.${bucket}[${i}]`,
              `Rule should be a string, got ${jsonType(rule)}.`
            );
          } else if (!looksLikePermissionRule(rule)) {
            findings.push({
              kind: 'rule-format',
              severity: 'warning',
              path: `permissions.${bucket}[${i}]`,
              message: `"${rule}" doesn't look like a permission rule (expected "Tool" or "Tool(specifier)").`,
            });
          }
        });
      }
      for (const key of Object.keys(perms)) {
        if (!KNOWN_PERMISSION_KEYS.has(key)) {
          findings.push({
            kind: 'unknown-key',
            severity: 'warning',
            path: `permissions.${key}`,
            message: `Unknown "permissions" sub-key "${key}" — likely a typo.`,
          });
        }
      }
    }
  }

  const ok = !findings.some((f) => f.severity === 'error');
  return { filePath, present: true, ok, findings };
}
