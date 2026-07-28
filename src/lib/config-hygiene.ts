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
  SettingsEnvironmentObservation,
} from '../types';
import type { SessionAttribution } from './parse-agents';
import { projectIdentityKey, sameProjectIdentity } from './project-identity';

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
 * Returns `Infinity` when there are no sessions at all — kept defined for
 * this helper in isolation, but `computeConfigHygiene` (#3118) now returns no
 * findings at all *before* reaching this call when `sessions` is empty:
 * zero retained sessions is zero observation, not evidence for "unused", so
 * no hedge can make an unused claim honest in that case.
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
 *
 * A project-scoped server's usage MUST be summarised scoped to its own
 * project (#3119): passing no `project` to `summariseUsage` means a
 * same-named MCP server invoked in a completely unrelated project would
 * incorrectly suppress this project's unused finding. `enabledByProjects`
 * is also evaluated entry-by-entry rather than collapsed to `[0]`, so a
 * server that in principle lists more than one owning project gets one
 * independently-summarised finding per project instead of silently
 * dropping the rest.
 *
 * Scoping to a project reproduces #3118's "no evidence" problem one level
 * down, and the general form of that problem is "no evidence *inside the
 * window the claim is about*" — not merely "no evidence ever". A project
 * whose only retained session is 40 days old still has zero observation
 * inside the active 30-day window, so an "unused in the last 30 days" claim
 * for it is exactly as unfounded as one for a project with no sessions at
 * all. `projectObservations` — keyed by every project with at least one
 * session whose `startTime >= windowStart`, mapping to *that project's own*
 * hedge (see {@link computeProjectObservations}) — gates each per-project
 * finding on presence, and hedges it on the mapped value, so a stale-only
 * project is excluded the same way an unobserved one is, and a
 * thinly-observed project (in-window, but with only a few days of its own
 * history) is hedged from its own coverage rather than borrowing a
 * different project's longer one. Guard and hedge are one computation, so
 * they cannot disagree (#3118/#3119).
 *
 * `enabledByProjects` and `session.project` are independently-sourced
 * spellings of the same project root, so they can disagree on separators,
 * trailing slashes, or Windows drive-letter/UNC case even when they name the
 * same project. `projectObservations` is keyed by canonical identity
 * ({@link projectObservationKey}), and `usagesForProject` matches by
 * {@link sameProjectIdentity} rather than raw string equality, so a session
 * recorded under one spelling still counts as usage — and as
 * observation-in-window — for a config entry recorded under an equivalent
 * one. Otherwise a real invocation could be excluded from the usage summary
 * while still admitting the project through the observation gate, producing
 * an "unused" finding for a server that is demonstrably in use.
 */
function findingsForMcpServers(
  servers: LiveMcpServer[],
  usages: SessionUsage[],
  windowStart: number,
  hedge: HygieneHedge | undefined,
  projectObservations: ReadonlyMap<string, HygieneHedge | undefined>
): HygieneFinding[] {
  const out: HygieneFinding[] = [];
  for (const s of servers) {
    if (s.scope === 'global') {
      const summary = summariseUsage(
        s.id,
        usages,
        windowStart,
        (u, id) => u.mcpServers[id] ?? 0
      );
      if (summary.windowCount > 0) continue;
      out.push(
        emitUnusedFinding({
          resourceType: 'mcpServer',
          resourceId: s.id,
          scope: { kind: 'global' },
          summary,
          hedge,
          sourcePath: s.sourcePath,
        })
      );
      continue;
    }

    const projects =
      s.enabledByProjects && s.enabledByProjects.length > 0
        ? s.enabledByProjects
        : ['(unknown)'];
    for (const project of projects) {
      const key = projectObservationKey(project);
      // No session for this project *inside the active window* → no
      // in-window observation → cannot honestly claim "unused" within that
      // window (#3118's reasoning, generalized to staleness as well as
      // absence — a project whose only session predates the window is
      // exactly as unobserved-in-window as one with no session at all).
      // Looked up by canonical identity so an equivalent spelling of the
      // same project still matches.
      if (!projectObservations.has(key)) continue;
      const summary = summariseUsage(
        s.id,
        // Matched by canonical project identity (#3119 follow-up), not raw
        // `u.project === project` string equality — see the doc comment
        // above for why that matters.
        usagesForProject(usages, project),
        windowStart,
        (u, id) => u.mcpServers[id] ?? 0
      );
      if (summary.windowCount > 0) continue;
      out.push(
        emitUnusedFinding({
          resourceType: 'mcpServer',
          resourceId: s.id,
          scope: { kind: 'project', project },
          summary,
          // This project's own hedge — never the global one — so a thinly
          // observed project can't inherit an unrelated project's longer
          // history and lose a hedge it should carry.
          hedge: projectObservations.get(key),
          sourcePath: s.sourcePath,
        })
      );
    }
  }
  return out;
}

/**
 * Canonical key for a project spelling, scoped to the MCP per-project guard/
 * hedge/usage-matching above (#3119 follow-up). Collapses spellings
 * `project-identity.ts` proves equivalent (trailing slash, path-separator or
 * drive-letter/UNC case on Windows) via {@link projectIdentityKey}, falling
 * back to the raw string when it isn't a provably canonicalizable absolute
 * path — the same fallback {@link sameProjectIdentity} uses, so two
 * unparseable-but-textually-equal spellings still match.
 */
function projectObservationKey(project: string): string {
  const canonical = projectIdentityKey(project);
  // Namespace the raw fallback so it can never collide with a canonical key.
  // `projectIdentityKey` returns a serialized form (e.g. `posix:/repo/a`); a
  // project string that happens to equal one of those would otherwise map to
  // the same bucket as the genuinely-different identity it resembles, letting
  // an unrelated session pass the observation gate while `usagesForProject`
  // (which compares by `sameProjectIdentity`, not by this key) correctly
  // excludes its usage — an evidence-free "unused" claim.
  return canonical ?? `raw:${project}`;
}

/**
 * `usages` restricted to one project, matched by canonical identity
 * ({@link sameProjectIdentity}) rather than raw string equality — see the
 * {@link findingsForMcpServers} doc comment for why a project-scoped MCP
 * server needs this instead of `summariseUsage`'s built-in strict-equality
 * project filter.
 */
function usagesForProject(usages: SessionUsage[], project: string): SessionUsage[] {
  return usages.filter(
    (u) => u.project != null && sameProjectIdentity(u.project, project)
  );
}

/**
 * Per-project observation map, shared by every project-scoped resource family
 * (skills, subagents, commands and MCP servers): presence of a project's
 * canonical key
 * ({@link projectObservationKey}) is the #3118/#3119 in-window guard (at least one
 * session with `windowStart <= startTime <= now`); the value is that
 * project's OWN hedge, derived from the span between *its own* oldest
 * retained session and `now` — the same shape as
 * {@link effectiveDataWindowDays}, just scoped to one project instead of
 * every session. Computing guard and hedge from the same per-project data
 * means they can never disagree: a project can't pass the guard via its own
 * in-window session yet get hedged (or not) using a completely different
 * project's coverage.
 *
 * Two upper-bound rules keep this honest:
 *  - Sessions are grouped by canonical project identity, not raw string
 *    equality, so `/repo/a/` and `/repo/a` (or a Windows drive-letter/UNC
 *    case/separator variant) contribute to the same project's guard and
 *    coverage instead of silently splitting into two.
 *  - A session timestamped after `now` (clock skew, or malformed imported
 *    data) is excluded entirely — from both the in-window guard and the
 *    coverage span — mirroring the upper bound `computeActivityRollups`
 *    (`session-summaries.ts`) already applies. Without this, a project with
 *    no valid current-or-historical session could still pass the guard on
 *    a bogus future timestamp.
 */
function computeProjectObservations(
  sessions: HygieneInput['sessions'],
  windowStart: number,
  now: number
): Map<string, HygieneHedge | undefined> {
  const oldestByProject = new Map<string, number>();
  const observedInWindow = new Set<string>();
  for (const s of sessions) {
    if (!s.project) continue;
    if (s.startTime > now) continue;
    const key = projectObservationKey(s.project);
    if (s.startTime >= windowStart) observedInWindow.add(key);
    if (s.startTime > 0) {
      const oldest = oldestByProject.get(key);
      if (oldest == null || s.startTime < oldest) oldestByProject.set(key, s.startTime);
    }
  }
  const out = new Map<string, HygieneHedge | undefined>();
  for (const project of observedInWindow) {
    const oldest = oldestByProject.get(project) ?? now;
    const days = Math.max(0, (now - oldest) / DAY_MS);
    out.set(project, days < ACTIVE_WINDOW_DAYS ? 'window-shorter-than-threshold' : undefined);
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
 * Built-in test fixtures that ship for smoke-testing the agent pipeline, not as
 * real, user-facing resources (#2015). The harness's echo-validator is
 * infrastructure — it can never have organic invocations, so flagging it for
 * removal is a permanent false positive. Kept as an explicit, auditable set
 * (rather than a fuzzy `test-*` pattern) so a genuinely-named user skill like
 * `test-runner` is never silently dropped.
 */
const KNOWN_TEST_FIXTURES = new Set(['test-echo-validator']);

/**
 * True for resources that can never legitimately appear in the "installed but
 * unused" list, so flagging them for removal is a permanent false positive
 * (#2015). This is an EXCLUSION, never a usage rollup — it reattributes no
 * counts, it only drops structurally-not-removable resources:
 *  - `_`-prefixed ids are shared-utility dirs (e.g. `_shared`), not invocable
 *    skills — zero invocations by construction.
 *  - Subskills (`<parentId>-<phase>`, the split-skill pattern) are invoked
 *    transitively via their installed parent skill, so a zero *direct* count is
 *    expected and removing one breaks the parent. We treat an id as a subskill
 *    only when an *installed skill* is a hyphen-boundary prefix of it (e.g.
 *    `burn-epic-pick` under `burn-epic`, `groom-release-loose-floor` under
 *    `groom-release`). Parent set is skills only, so directly-invocable subagent
 *    variants like `ponytail-lite` (no installed skill parent) stay flagged.
 *  - Built-in test fixtures (see {@link KNOWN_TEST_FIXTURES}).
 */
function isStructurallyExcluded(
  resourceId: string,
  installedSkillIds: ReadonlySet<string>
): boolean {
  if (resourceId.startsWith('_')) return true;
  if (KNOWN_TEST_FIXTURES.has(resourceId)) return true;
  const parts = resourceId.split('-');
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('-');
    if (prefix !== resourceId && installedSkillIds.has(prefix)) return true;
  }
  return false;
}

/**
 * One project-scoped resource family (skills, subagents, commands). These three
 * differ only in which attribution map they read and where their files live, so
 * they share one traversal rather than three near-identical loops (#3388).
 *
 * That is not tidiness. The defect this fixes was precisely that ONE family
 * (MCP servers, #3119) got the per-project guard and the other three silently
 * did not. With one traversal there is no per-family place for the guard to go
 * missing from: a new resource family either goes through here and inherits it,
 * or is visibly doing something different.
 */
interface ScopedResourceFamily<T> {
  resourceType: HygieneResourceType;
  items: readonly T[];
  /** Which attribution map this family's usage is counted from. */
  getCount: (u: SessionUsage, id: string) => number;
  id: (resource: T) => string;
  sourcePath: (resource: T) => string | undefined;
  removalPath: (resource: T) => string | undefined;
  /**
   * Whether {@link isStructurallyExcluded} applies. Skills and subagents have
   * structurally-not-removable members (`_shared` dirs, subskills, test
   * fixtures); commands do not, and applying it there would silently drop a
   * real `_`-prefixed command.
   */
  applyStructuralExclusions: boolean;
}

/**
 * Findings for one project-scoped resource family.
 *
 * A project-scoped resource resolves its guard, its hedge AND its usage from
 * the same canonical project identity. Deriving any of the three differently is
 * how #3118/#3119 kept recurring: a project could pass a canonical-identity
 * guard while its usage was matched by raw string equality, so `/repo/a/` and
 * `/repo/a` counted as the same project for "did we observe it" and as
 * different projects for "was it used" — an evidence-free "unused" claim about
 * a project we had in fact observed.
 */
function findingsForScopedResources<T extends { scope?: string; projectPath?: string }>(
  family: ScopedResourceFamily<T>,
  usages: SessionUsage[],
  windowStart: number,
  globalHedge: HygieneHedge | undefined,
  projectObservations: ReadonlyMap<string, HygieneHedge | undefined>,
  installedSkillIds: ReadonlySet<string>
): HygieneFinding[] {
  const out: HygieneFinding[] = [];
  for (const resource of family.items) {
    const resourceId = family.id(resource);
    if (
      family.applyStructuralExclusions &&
      isStructurallyExcluded(resourceId, installedSkillIds)
    ) {
      continue;
    }
    const scope = resourceScope(resource);

    let scopedUsages = usages;
    let hedge = globalHedge;
    if (scope.kind === 'project') {
      const key = projectObservationKey(scope.project);
      // No session for this project inside the active window → no in-window
      // observation → nothing scoped to it can honestly be called "unused"
      // (#3118/#3119's reasoning, extended to these families by #3388).
      if (!projectObservations.has(key)) continue;
      // This project's OWN hedge, never the global one, so a thinly-observed
      // project cannot borrow a longer-observed project's coverage.
      hedge = projectObservations.get(key);
      // Canonical identity, matching the guard above — not `u.project ===
      // project` string equality. See this function's doc comment.
      scopedUsages = usagesForProject(usages, scope.project);
    }

    const summary = summariseUsage(resourceId, scopedUsages, windowStart, family.getCount);
    if (summary.windowCount > 0) continue;
    out.push(
      emitUnusedFinding({
        resourceType: family.resourceType,
        resourceId,
        scope,
        summary,
        hedge,
        sourcePath: family.sourcePath(resource),
        removalPath: family.removalPath(resource),
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
  // Zero retained sessions means zero observation window — there is no
  // evidence to compare any resource's usage against, so no resource can be
  // honestly called "unused" (#3118). Emit no findings rather than an
  // unhedged blanket "unused" claim for every installed resource.
  if (input.sessions.length === 0) return [];
  const now = input.now ?? Date.now();
  const windowStart = now - ACTIVE_WINDOW_DAYS * DAY_MS;
  const dataWindowDays = effectiveDataWindowDays(input.sessions, now);
  const hedge: HygieneHedge | undefined =
    dataWindowDays < ACTIVE_WINDOW_DAYS
      ? 'window-shorter-than-threshold'
      : undefined;
  const usages = buildSessionUsage(input.attribution, input.sessions);
  // Installed skill ids — the parent set for the subskill exclusion (#2015).
  const installedSkillIds = new Set(lc.skills.map((s) => s.id));
  // Per-project MCP guard + hedge, computed together (see
  // computeProjectObservations) so a project with no in-window
  // observation can never be called "unused", and a project that IS
  // in-window-observed is hedged from its own coverage rather than the
  // global minimum across every project (#3118/#3119).
  const projectObservations = computeProjectObservations(
    input.sessions,
    windowStart,
    now
  );

  const out: HygieneFinding[] = [];

  // Skills, subagents and commands share one traversal so the per-project
  // guard cannot be present on some families and missing on others — which is
  // exactly the defect #3388 fixes (MCP servers had it, these three did not).
  out.push(
    ...findingsForScopedResources(
      {
        resourceType: 'skill',
        items: lc.skills,
        getCount: (u, id) => u.skills[id] ?? 0,
        id: (r) => r.id,
        sourcePath: (r) => skillManifestPath(r.path),
        removalPath: (r) => r.path,
        // Structurally-not-removable resources (#2015): `_shared` utility dirs,
        // subskills of an installed parent, built-in test fixtures.
        applyStructuralExclusions: true,
      },
      usages,
      windowStart,
      hedge,
      projectObservations,
      installedSkillIds
    )
  );

  out.push(
    ...findingsForScopedResources(
      {
        resourceType: 'subagent',
        items: lc.subagents,
        getCount: (u, id) => u.agents[id] ?? 0,
        id: (r) => r.id,
        sourcePath: (r) => r.path,
        removalPath: (r) => r.path,
        // Same structural exclusions as skills (#2015). The subskill-prefix
        // check is keyed on installed SKILLS, so a directly-invocable subagent
        // variant (e.g. `ponytail-lite`) stays flagged.
        applyStructuralExclusions: true,
      },
      usages,
      windowStart,
      hedge,
      projectObservations,
      installedSkillIds
    )
  );

  // Commands — slash-command definitions under ~/.claude/commands/. Usage comes
  // from the parsed `<command-name>` markers (parse-agents commands map), not a
  // native attribution field (#634).
  out.push(
    ...findingsForScopedResources(
      {
        resourceType: 'command',
        items: lc.commands,
        getCount: (u, id) => u.commands[id] ?? 0,
        id: (r) => r.id,
        sourcePath: (r) => r.path,
        removalPath: (r) => r.path,
        applyStructuralExclusions: false,
      },
      usages,
      windowStart,
      hedge,
      projectObservations,
      installedSkillIds
    )
  );

  out.push(
    ...findingsForMcpServers(lc.mcpServers, usages, windowStart, hedge, projectObservations)
  );
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

function interpolatedEnvironmentNames(value: string): string[] {
  const names: string[] = [];
  for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    if (match.index > 0 && value[match.index - 1] === '\\') continue;
    names.push(match[1]);
  }
  return names;
}

/**
 * Transient effective `settings.env` input for missing-variable validation.
 * Values are used only to resolve dependency chains and are never returned in
 * {@link SettingsHealth}; local overrides identify global definitions that no
 * longer participate in Claude Code's effective configuration.
 */
export interface EffectiveSettingsEnvironment {
  definitions: Readonly<Record<string, unknown>>;
  localOverrides: readonly string[];
  /** Display path attached to findings derived from local overrides. */
  localSourcePath?: string;
}

/**
 * Validate a raw settings.json string (#167). Returns a {@link SettingsHealth}
 * verdict: a syntax error short-circuits with numeric location metadata when
 * available; raw parser messages and source excerpts are not retained.
 * Otherwise the parsed object is schema-checked — known-key whitelist (unknown ⇒
 * warning), value types for the documented keys, and permission-rule shape.
 * `raw === null` (file absent/unreadable) is reported as `present:false`,
 * `ok:true` — nothing to validate is not a failure.
 */
export function validateSettingsJson(
  filePath: string,
  raw: string | null,
  environment?: SettingsEnvironmentObservation,
  effectiveSettingsEnvironment?: EffectiveSettingsEnvironment
): SettingsHealth {
  if (raw === null) {
    return { filePath, present: false, ok: true, findings: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const parserMessage = e instanceof Error ? e.message : String(e);
    const posMatch = /position (\d+)/.exec(parserMessage);
    let line: number | undefined;
    let column: number | undefined;
    if (posMatch) {
      ({ line, column } = offsetToLineCol(raw, Number(posMatch[1])));
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
          message: 'Invalid JSON syntax; repair the document and retry.',
          sourcePath: filePath,
          line,
          column,
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
      sourcePath: filePath,
    });
    return { filePath, present: true, ok: false, findings };
  }

  const error = (path: string, message: string) =>
    findings.push({
      kind: 'type', severity: 'error', path, message, sourcePath: filePath,
    });

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
        sourcePath: filePath,
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
              message: 'Permission rule should use "Tool" or "Tool(specifier)" syntax.',
              sourcePath: filePath,
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
            sourcePath: filePath,
          });
        }
      }
    }
  }

  // `/doctor` also reports settings strings that reference variables absent
  // from the launch environment. The caller supplies a names-only host
  // observation: this pure validator never reads process.env, and no secret
  // values enter the dataset. Variables declared by settings.env count as
  // defined because Claude Code exports them before consuming other settings.
  if (environment) {
    const resolvedEnvironmentNames = new Set(environment.definedNames);
    const environmentDefinitions = effectiveSettingsEnvironment?.definitions
      ?? (isPlainObject(parsed.env) ? parsed.env : {});
    if (isPlainObject(environmentDefinitions)) {
      // Resolve settings.env from literal/host-defined roots with a dependency
      // worklist. Rescanning every definition once per chain level is quadratic
      // for reverse-ordered chains; the reverse edges below process each
      // definition and dependency once while leaving cycles unresolved.
      const unresolvedDependencyCounts = new Map<string, number>();
      const dependentsByDependency = new Map<string, string[]>();
      const ready: string[] = [];
      for (const [name, value] of Object.entries(environmentDefinitions)) {
        if (resolvedEnvironmentNames.has(name) || typeof value !== 'string') {
          continue;
        }
        const unresolvedDependencies = new Set(
          interpolatedEnvironmentNames(value).filter(
            (dependency) => !resolvedEnvironmentNames.has(dependency)
          )
        );
        unresolvedDependencyCounts.set(name, unresolvedDependencies.size);
        if (unresolvedDependencies.size === 0) {
          ready.push(name);
          continue;
        }
        for (const dependency of unresolvedDependencies) {
          const dependents = dependentsByDependency.get(dependency) ?? [];
          dependents.push(name);
          dependentsByDependency.set(dependency, dependents);
        }
      }
      while (ready.length > 0) {
        const name = ready.pop()!;
        if (resolvedEnvironmentNames.has(name)) continue;
        resolvedEnvironmentNames.add(name);
        for (const dependent of dependentsByDependency.get(name) ?? []) {
          const remaining = (unresolvedDependencyCounts.get(dependent) ?? 0) - 1;
          unresolvedDependencyCounts.set(dependent, remaining);
          if (remaining === 0) ready.push(dependent);
        }
      }
    }
    // A configured env name satisfies references elsewhere in settings even
    // when its own definition is unresolved. Its dependency is diagnosed at
    // env.NAME instead of producing a misleading downstream "set NAME" fix.
    const downstreamEnvironmentNames = new Set([
      ...resolvedEnvironmentNames,
      ...Object.keys(environmentDefinitions),
    ]);
    const localOverrides = new Set(
      effectiveSettingsEnvironment?.localOverrides ?? []
    );
    const emitted = new Set<string>();
    interface PendingSettingsValue {
      value: unknown;
      path: string;
      environmentDefinition: boolean;
      sourcePath: string;
    }
    const scan = (initial: PendingSettingsValue): void => {
      const pending = [initial];
      while (pending.length > 0) {
        const current = pending.pop()!;
        const { value, path, environmentDefinition, sourcePath } = current;
        if (typeof value === 'string') {
          // Only explicit `${NAME}` config interpolation is unambiguous here.
          // Bare `$NAME` inside hook commands depends on shell quoting/escaping
          // and cannot be diagnosed safely without a shell parser.
          const availableNames = environmentDefinition
            ? resolvedEnvironmentNames
            : downstreamEnvironmentNames;
          for (const name of interpolatedEnvironmentNames(value)) {
            const key = `${path}\0${name}`;
            if (!availableNames.has(name) && !emitted.has(key)) {
              emitted.add(key);
              findings.push({
                kind: 'missing-env',
                severity: 'warning',
                path,
                environmentVariable: name,
                message: `"${path}" references environment variable "${name}", which was absent from the dashboard's names-only host launch snapshot; verify it in Claude Code's launch environment.`,
                sourcePath,
              });
            }
          }
          continue;
        }
        if (Array.isArray(value)) {
          for (let index = value.length - 1; index >= 0; index -= 1) {
            pending.push({
              value: value[index],
              path: `${path}[${index}]`,
              environmentDefinition,
              sourcePath,
            });
          }
          continue;
        }
        if (isPlainObject(value)) {
          const entries = Object.entries(value);
          for (let index = entries.length - 1; index >= 0; index -= 1) {
            const [key, entry] = entries[index];
            // A local env definition shadows the raw global definition. It
            // participates through the effective traversal below instead.
            if (path === 'env' && localOverrides.has(key)) continue;
            pending.push({
              value: entry,
              path: path ? `${path}.${key}` : key,
              environmentDefinition: environmentDefinition || path === 'env',
              sourcePath,
            });
          }
        }
      }
    };
    // `parsed` is the raw global file, so the traversal below intentionally
    // skips locally overridden env keys. Traverse their effective values here
    // so unresolved local dependencies and local-only cycles still produce
    // path-specific findings. The values remain transient and are never
    // included in SettingsHealth.
    for (const [name, value] of Object.entries(environmentDefinitions)) {
      if (localOverrides.has(name)) {
        scan({
          value,
          path: `env.${name}`,
          environmentDefinition: true,
          sourcePath: effectiveSettingsEnvironment?.localSourcePath ?? filePath,
        });
      }
    }
    scan({
      value: parsed,
      path: '',
      environmentDefinition: false,
      sourcePath: filePath,
    });
  }

  const ok = !findings.some((f) => f.severity === 'error');
  return { filePath, present: true, ok, findings, environment };
}
