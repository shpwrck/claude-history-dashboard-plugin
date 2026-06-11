export type CodingHarness = 'claude-code';

export interface DataSource {
  id: string;
  harness: CodingHarness;
  historyDir: string;
  configFile?: string;
}

export interface HistoryEntry {
  display: string;
  pastedContents: Record<string, PastedContent>;
  timestamp: number;
  project: string;
  sessionId: string;
  sourceId?: string;
  harness?: CodingHarness;
  /**
   * Human-readable session title (custom-title preferred over ai-title),
   * carried on transcript-derived entries so it survives session grouping
   * without a separate join. Absent for history.jsonl-only sessions.
   */
  title?: string;
}

export interface PastedContent {
  id: number;
  type: string;
  content: string;
}

/**
 * Per-session dimensions captured from the transcript JSONL lines.
 *
 * Each `~/.claude/projects/.../*.jsonl` line carries a few top-level fields
 * (`version` = Claude Code version, `gitBranch`, `entrypoint` = `cli` vs
 * `sdk-cli`) and, on assistant/usage lines, `message.usage.service_tier`.
 * These let cost & activity be sliced by CC version, branch,
 * human-vs-automation, and service tier. All fields are optional because the
 * history-derived `Session` objects predate transcript parsing and may not
 * have them populated.
 */
export interface SessionDimensions {
  sourceId?: string;
  harness?: CodingHarness;
  /** Claude Code version, e.g. "2.1.136". */
  version?: string;
  /** Git branch the session ran on. */
  gitBranch?: string;
  /**
   * Invocation entrypoint. Three real values: "cli" (interactive human),
   * "sdk-cli" (SDK-CLI automation), "sdk-py" (Python-SDK automation). Any
   * `sdk-*` is unattended — classify via `isUnattendedEntrypoint()`. There is
   * no "cron"/"interactive" entrypoint value.
   */
  entrypoint?: string;
  /** API service tier, e.g. "standard" / "priority" (from usage lines). */
  serviceTier?: string;
}

export interface Session extends SessionDimensions {
  sessionId: string;
  project: string;
  projectShort: string;
  entries: HistoryEntry[];
  startTime: number;
  endTime: number;
  duration: number;
  messageCount: number;
  /** Human-readable session title, if the transcript carried one. */
  title?: string;
}

/**
 * Always-on task-category taxonomy (#655). These buckets describe the user's
 * goal, not the session shape (`quick_question`/`multi_task`) and not a view
 * domain. The deterministic classifier maps local session signals here, while
 * real `/insights` facets may override the heuristic when present.
 */
export const TASK_CATEGORY_TAXONOMY = [
  {
    id: 'implementation',
    label: 'Implementation',
    description: 'Building or changing product code, tests, or wiring.',
  },
  {
    id: 'debugging',
    label: 'Debugging',
    description: 'Investigating and fixing failures, regressions, or broken tests.',
  },
  {
    id: 'review',
    label: 'Review',
    description: 'Auditing, reviewing, comparing, or validating existing work.',
  },
  {
    id: 'research',
    label: 'Research',
    description: 'Reading, explaining, searching, or understanding a system.',
  },
  {
    id: 'planning',
    label: 'Planning',
    description: 'Designing, decomposing, estimating, or writing implementation plans.',
  },
  {
    id: 'operations',
    label: 'Operations',
    description: 'Deploying, releasing, configuring infrastructure, or managing git/CI.',
  },
  {
    id: 'documentation',
    label: 'Documentation',
    description: 'Writing or updating docs, README files, changelogs, and guides.',
  },
  {
    id: 'other',
    label: 'Other',
    description: 'Fallback when local signals do not identify a stronger task category.',
  },
] as const;

export type TaskCategory = (typeof TASK_CATEGORY_TAXONOMY)[number]['id'];
export const DEFAULT_TASK_CATEGORY: TaskCategory = 'other';

export interface CompactionEvent {
  timestamp: string;
  beforeContext: number;
  afterContext: number;
  reductionPercent: number;
}

export interface SessionTokenData extends SessionDimensions {
  sessionId: string;
  /**
   * Project path recovered from the transcript path when available. Some
   * token-bearing transcripts do not produce user-turn history entries, so
   * project attribution cannot rely only on a Session join.
   */
  project?: string;
  projectShort?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  model: string;
  messageCount: number;
  entries: TokenEntry[];
  compactionEvents: CompactionEvent[];
  /**
   * True if any entry in this session used a model string that wasn't
   * recognized and fell back to Sonnet-tier pricing (see
   * `resolveModelPricing`). Lets the UI flag the cost estimate as a guess.
   */
  hasUnknownModel: boolean;
  /**
   * The session OPENER: the text of the FIRST user-role message in the
   * transcript, flattened to one line and TRUNCATED to ~200 chars (#743). A
   * coarse feature for the start/stop-oracle audit — NOT the full prompt; only
   * enough to derive explainable opener traits. `undefined` when the transcript
   * has no user message (e.g. a tool-only or assistant-only fragment).
   */
  opener?: string;
}

/**
 * Per-turn assistant-behaviour features aggregated per session (#206).
 *
 * Cheap, numeric signals derived at ingest from the assistant's transcript
 * turns so the recommendations engine can reason about behaviour (refusals,
 * hedging, code density, ends-with-question, thinking size) without fetching
 * any transcript BLOB. All counts are per assistant turn; rates are
 * `<count> / assistantTurnCount`. See `src/lib/parse-assistant-features.ts`.
 */
export interface AssistantFeatures {
  sessionId: string;
  /** Number of assistant turns examined (denominator for rate computations). */
  assistantTurnCount: number;
  /** Total characters of assistant text across all turns. */
  textLength: number;
  /** Total markdown code fences (``` pairs) across assistant text. */
  codeBlockCount: number;
  /** Total `tool_use` blocks the assistant emitted. */
  toolCallCount: number;
  /** Turns whose text contains a refusal / course-correction marker. */
  refusalCount: number;
  /** Turns whose text contains a hedging / low-confidence marker. */
  hedgingCount: number;
  /** Turns whose text ends with a question mark. */
  endsWithQuestionCount: number;
  /** Uncompressed UTF-8 byte length of all thinking-block text (0 if none). */
  thinkingByteLen: number;
}

/**
 * Per-session user-prompt traits aggregated from `HistoryEntry.display` (#1274).
 *
 * This is intentionally text-free: the dashboard retains only numeric counts
 * that later detectors can correlate with outcomes. The original prompt prose
 * stays in the existing history/session data and is not duplicated here.
 */
export interface PromptAnalysis {
  sessionId: string;
  project: string;
  /** User prompt turns represented by this session. */
  promptTurnCount: number;
  /** Total characters across user prompt turns. */
  totalPromptChars: number;
  /** Average characters per user prompt turn. */
  avgPromptChars: number;
  /** Approximate sentence count across user prompt turns. */
  sentenceCount: number;
  /** Prompt turns phrased as questions. */
  questionTurnCount: number;
  /** Prompt turns starting with a direct action verb. */
  imperativeTurnCount: number;
  /** Prompt turns that include a file/path-like reference. */
  filePathMentionCount: number;
  /** Backtick-delimited identifiers or snippets mentioned in prompts. */
  backtickIdentifierCount: number;
  /** Sum of file/path and backtick specificity markers. */
  specificityMarkerCount: number;
  /** Short prompts with no file/path or backtick specificity markers. */
  lowSpecificityTurnCount: number;
  /** Prompt turns containing hedging or uncertainty language. */
  hedgingTurnCount: number;
  /** Prompt turns containing acceptance, constraint, or guardrail phrasing. */
  constraintTurnCount: number;
  /** Prompt turns with at least one pasted-content attachment. */
  pastedContentTurnCount: number;
  /** Total pasted-content attachment count across prompt turns. */
  pastedContentCount: number;
}

/**
 * Per-session model-deceit signal derived at ingest (#685, epic #683 slice A).
 *
 * The recommendation engine can't tell when an agent claims work it didn't do,
 * because detectors receive only parsed aggregates and the SPA dataset is
 * transcript-free by design. This parser correlates completion/verification
 * **claims** in assistant text against a session-wide **evidence index** (Bash
 * `tool_use` runs + their `tool_result` outcome, plus background
 * `<task-notification>` completions) and emits a tiny NUMERIC per-session
 * feature — exactly the shape of {@link AssistantFeatures} (#206), so it rides
 * the main dataset without inline transcripts. All correlation and
 * false-positive tuning lives in the parser; the downstream detector (slice B)
 * stays a thin read. See `src/lib/parse-deceit-signals.ts`.
 */
export interface DeceitSignals {
  sessionId: string;
  /** Number of assistant turns examined (denominator for rate computations). */
  assistantTurnCount: number;
  /**
   * Turns asserting an action ("I ran the tests") with no matching verification
   * evidence anywhere in the session. Honest scoped-disclosure, stale-but-true,
   * and real-background-completion claims are excluded (see the parser).
   */
  unbackedClaimCount: number;
  /**
   * Turns asserting success ("all green") that the most recent verification run
   * contradicts with a real failure (a non-zero exit / non-zero failure count —
   * NOT a sloppy "fail" substring like "0 failed").
   */
  contradictedClaimCount: number;
  /**
   * A tiny handful of short claim snippets (the flagged turns' claim text,
   * truncated) for evidence rows. Capped and never an inline transcript.
   */
  claimSnippets: string[];
}

export interface TokenEntry {
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  /** Total cache-creation tokens (5m + 1h). */
  cacheCreationTokens: number;
  /**
   * Subset of `cacheCreationTokens` written to the 1-hour cache
   * (`usage.cache_creation.ephemeral_1h_input_tokens`). Billed at the 2x
   * input rate vs 1.25x for 5-minute writes. Zero when the field is absent.
   */
  cacheCreation1hTokens: number;
  cacheReadTokens: number;
  /** `usage.server_tool_use.web_search_requests` (flat per-request billing). */
  webSearchRequests: number;
  /** `usage.server_tool_use.web_fetch_requests` (flat per-request billing). */
  webFetchRequests: number;
  model: string;
}

export interface ProjectStats {
  project: string;
  projectShort: string;
  sessionCount: number;
  messageCount: number;
  firstSeen: number;
  lastSeen: number;
  sessions: Session[];
}

/**
 * A `ProjectStats` leaf tagged with its position inside a {@link RepoGroup}:
 * `branch` is `"main"` for the base checkout and the worktree slug (the path
 * segment after `/.claude/worktrees/`) for each worktree. Derived purely from
 * the project path — `gitBranch` is not present in the history feed (#192).
 */
export interface RepoChild extends ProjectStats {
  branch: string;
}

/**
 * A parent repo with its worktrees folded in (#192). `groupWorktrees` builds
 * these from the flat `ProjectStats[]`: worktrees of the same checkout
 * (`<repo>/.claude/worktrees/<slug>`) roll up under one entry whose totals are
 * the aggregate of `worktrees`. A project with no worktree marker becomes a
 * single-child group rendered flat. Keying is on the full pre-marker `repo`
 * path, so two checkouts of the same repo name in different base dirs stay
 * separate.
 */
export interface RepoGroup {
  /** Parent repo path — the prefix before `/.claude/worktrees/`. */
  repo: string;
  repoShort: string;
  /** Rolled-up totals across `worktrees`. */
  sessionCount: number;
  messageCount: number;
  firstSeen: number;
  lastSeen: number;
  /** Every session across main + worktrees (for the parent heatmap). */
  sessions: Session[];
  /** Main checkout first, then worktrees by message count. */
  worktrees: RepoChild[];
}

export type View = 'home' | 'evaluator' | 'recommendations' | 'sessions' | 'projects' | 'search' | 'stats' | 'tokens' | 'tools' | 'files' | 'summary' | 'cost' | 'reclaim-compass' | 'timeline' | 'activity' | 'automation' | 'workflows' | 'errors' | 'permissions' | 'agents' | 'memories' | 'context' | 'conversation' | 'prompts' | 'patterns' | 'shadow-calls' | 'report-card' | 'review-queue' | 'tasks' | 'teams' | 'plans' | 'pulse' | 'adoption' | 'enterprise';

/**
 * Action-domain taxonomy (epic #490). The six genuine "what am I trying to do"
 * domains the actionability review + blind persona×band funnel converged on,
 * plus three structural buckets the nav needs:
 *  - `home`     — the digest spine + its cross-domain companions (recommendations, insights).
 *  - the six action domains — `safety` leads the nav and the digest (#491).
 *  - `discovery`— the global Find utility (search/sessions/projects/timeline).
 *  - `raw`      — demoted orientation views (stats/activity) in the Raw-data drawer.
 * Carried per-view in the nav catalog (`src/lib/nav-prefs.ts`) so the sidebar can
 * group by domain and the digest can rank across domains. See
 * `docs/reviews/nav-redesign-funnel.md`.
 */
export type ActionDomain =
  | 'home'
  | 'safety'
  | 'cost'
  | 'success-rate'
  | 'speed'
  | 'context-health'
  | 'workflow-hygiene'
  | 'discovery'
  | 'raw';

/**
 * Subset of the live Claude Code settings the dashboard cares about for
 * "is this recommendation already applied?" checks. Sourced from
 * `~/.claude/settings.json` (+ `settings.local.json` overrides). Every field
 * is optional because the file is user-edited and may be partial or missing
 * entirely; a malformed file degrades to an empty object.
 */
export interface LiveSettingsHook {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
  source?: 'global' | 'local';
}

export interface LiveSettings {
  model?: string;
  cleanupPeriodDays?: number;
  permissions?: {
    allow?: string[];
    ask?: string[];
    deny?: string[];
  };
  hooks?: {
    PreToolUse?: LiveSettingsHook[];
    PostToolUse?: LiveSettingsHook[];
    [event: string]: LiveSettingsHook[] | undefined;
  };
  /**
   * Per-plugin enablement. Keys are the plugin id (e.g.
   * `code-review@claude-plugins-official`); value is true when the plugin is
   * actively enabled.
   */
  enabledPlugins?: Record<string, boolean>;
}

/** Locally-installed resource the dashboard can enumerate from the filesystem. */
export interface LiveResource {
  /** Stable, user-facing identifier. For skills/agents/commands this is the
   *  directory name (e.g. `diagnose`); for plugins it's the registry id. */
  id: string;
  /** Where the resource lives: `user` = `~/.claude/*`; `project` = inside a
   *  project's `.claude/*`. Phase 1 ships `user` scope only (the container
   *  cannot reach project roots). */
  scope: 'user' | 'project';
  /** Absolute path the resource was discovered at — useful for tracing in the
   *  UI ("global skill" vs "project skill"). */
  path: string;
  /** For skills (dir-as-resource): the `description` from the SKILL.md
   *  frontmatter, when readable. Tokenised into trigger keywords by the
   *  discovery-failure detector (#136). Absent for file-resources
   *  (agents/commands) and when the manifest/field is missing or unreadable. */
  description?: string;
}

/** A plugin's bundled artifacts so phase 2 can roll up "any used" to "plugin
 *  used". Discovered by scanning the plugin's install directory; absent when
 *  the directory layout doesn't expose them. */
export interface LivePlugin {
  /** Registry id (e.g. `code-review@claude-plugins-official`). */
  id: string;
  scope: 'user' | 'project';
  version: string;
  installPath: string;
  installedAt: string;
  /** Identifiers of bundled skills/commands/agents discovered in the plugin's
   *  install dir; phase 2 attribution maps these to "plugin used". Empty when
   *  the bundle layout couldn't be enumerated. */
  bundled?: { skills?: string[]; commands?: string[]; agents?: string[] };
}

/** A configured MCP server, with the project paths that explicitly enabled it. */
export interface LiveMcpServer {
  /** Server name as keyed in `mcpServers` (e.g. `github`, `playwright`). */
  id: string;
  /** `global` = lives in the top-level `~/.claude.json` mcpServers map;
   *  `project` = lives in a specific project entry's `mcpServers` map. */
  scope: 'global' | 'project';
  /** Project paths whose `enabledMcpjsonServers` lists this server, when the
   *  server is global. Empty for project-scoped servers. */
  enabledByProjects?: string[];
}

/**
 * The bundle of live Claude Code config the dashboard reads on each
 * `/api/dataset.json` request. Used by:
 *  - the enumerated rec engine to suppress recs whose fix is already present
 *    (settings.json from #166, CLAUDE.md headings/body phrases for phase 1 of
 *    #172)
 *  - the (forthcoming) P/I/U layer for installed-resource awareness
 *
 * Every field degrades to "missing" when the underlying source is unreadable
 * so a malformed config file doesn't sink the panel.
 */
/**
 * One problem found while validating a raw `settings.json` (#167). `path` is a
 * dotted/indexed location (`permissions.deny[3]`) or `''` for a whole-file
 * syntax error. Syntax findings carry `line`/`column`/`excerpt` to point at the
 * offending spot.
 */
export interface SettingsHealthFinding {
  kind: 'syntax' | 'type' | 'unknown-key' | 'rule-format';
  severity: 'error' | 'warning';
  path: string;
  message: string;
  line?: number;
  column?: number;
  excerpt?: string;
}

/**
 * Validation verdict for a settings file (#167). `present` is false when the
 * file is absent (nothing to validate — not an error); `ok` is true when there
 * are no error-severity findings (warnings alone still pass).
 */
export interface SettingsHealth {
  /** Display path, e.g. `~/.claude/settings.json`. */
  filePath: string;
  present: boolean;
  ok: boolean;
  findings: SettingsHealthFinding[];
}

export interface LiveConfig {
  /** Merged global + local settings.json. Same shape #166 shipped. */
  settings: LiveSettings;
  /**
   * Validation verdict for the raw `~/.claude/settings.json` (#167). Computed
   * at ingest against the raw bytes — the merged `settings` above has already
   * dropped unknown keys and can't surface syntax errors. `null`/absent when
   * not computed. Project/local settings validation is a follow-up.
   */
  settingsHealth?: SettingsHealth | null;
  claudeMd: {
    /** `~/.claude/CLAUDE.md` text when present. */
    global: string | null;
    /** Per-project CLAUDE.md keyed by project path. Phase 1 ships `{}` — the
     *  container cannot reach project roots without a mount change. Reserved
     *  here so consumers don't have to re-shape when phase 2 fills it. */
    perProject: Record<string, string>;
  };
  plugins: LivePlugin[];
  mcpServers: LiveMcpServer[];
  /** Locally-installed skills under `~/.claude/skills/<id>/SKILL.md`. */
  skills: LiveResource[];
  /** Locally-installed subagents under `~/.claude/agents/<id>.md`. */
  subagents: LiveResource[];
  /** Locally-installed slash commands under `~/.claude/commands/<id>.md`. */
  commands: LiveResource[];
}
