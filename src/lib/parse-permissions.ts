import type { ToolUsageData } from './parse-tools';
import { evidenceRefForEntry, type EvidenceRef } from './evidence';
import type { SessionTimeline } from './parse-timeline';
import { parseJsonl, type RawSessionEntry } from './parse-utils';

export interface PermissionModeStat {
  mode: string;
  entryCount: number;
  sessionCount: number;
}

export type DangerousCommandCertainty = 'high' | 'medium';

export interface DangerousCommand {
  sessionId: string;
  timestamp: string;
  toolUseId: string;
  command: string; // truncated to 200 chars, newlines → " "
  pattern: string; // which pattern matched
  certainty: DangerousCommandCertainty;
}

export type RiskyActionCategory =
  | 'deploy'
  | 'production-config'
  | 'database'
  | 'secret-sensitive'
  | 'other-high-impact';

export type RiskyActionSeverity = 'critical' | 'warning';

export interface RiskyAction {
  sessionId: string;
  timestamp: string;
  toolUseId: string;
  command: string; // truncated to 200 chars, newlines → " "
  pattern: string;
  category: RiskyActionCategory;
  severity: RiskyActionSeverity;
  evidenceRef?: EvidenceRef;
}

export interface SessionSafetyScore {
  sessionId: string;
  dangerousCount: number;
  bypassMode: boolean;
  modes: string[];
}

export interface PermissionChange {
  sessionId: string;
  timestamp: string;
  fromMode: string | null;
  toMode: string;
}

// Adds permission-specific fields on top of the shared wire shape.
type PermissionSessionEntry = RawSessionEntry & {
  permissionMode?: unknown;
};

const MAX_COMMAND_LEN = 200;

// Matches `rm` followed by a flag cluster that contains both `r` and `f`,
// in either order: e.g. `-rf`, `-fr`, `-Rf`, `-rfv`, `-rfi`.
// Limitation: doesn't catch split flags like `rm -r -f` (existing behavior).
function hasRmRfFlags(cmd: string): boolean {
  const m = cmd.match(/\brm\s+-([a-zA-Z]+)\b/);
  if (!m) return false;
  const flags = m[1];
  // Reject if any char isn't a valid rm short option — guards against false
  // positives like `rm -frob` whose flag chunk happens to contain both r and f.
  if (!/^[rRfviIdP]+$/.test(flags)) return false;
  return /[rR]/.test(flags) && flags.includes('f');
}

// ── rm -rf target-aware certainty (#2011) ──────────────────────────────────
// `rm -rf` is only HIGH-certainty dangerous when its TARGET is catastrophic
// (`/`, `~`, `$HOME`, a bare/unguarded variable, a top-level system dir, or
// `.`/`..`). A clearly scoped, reversible target — a relative subpath under cwd,
// a `/tmp/…` scratch path, a worktree dir — is routine cleanup and downgrades to
// 'medium', so it no longer drives the CRITICAL bypassPermissions finding. When
// the target isn't visible (compound command truncated past the preview, or no
// command text), we stay 'high' — never under-report a genuinely dangerous rm.

/** The targets of the first `rm -<flags>` in a command, read up to the next
 *  shell operator. Empty when no target is visible. */
function rmRfTargets(command: string): string[] {
  const m = command.match(/\brm\s+-[a-zA-Z]+\s+([^\n|;&]+)/);
  if (!m) return [];
  const tokens = m[1].trim().match(/(?:"[^"]*"|'[^']*'|\S)+/g) ?? [];
  return tokens.filter((t) => !t.startsWith('-')); // drop trailing flags
}

function unquoteTarget(t: string): string {
  return t.replace(/^['"]/, '').replace(/['"]$/, '').trim();
}

/** A target whose deletion is catastrophic (or whose expansion could be). */
function isCatastrophicRmTarget(raw: string): boolean {
  const t = unquoteTarget(raw);
  if (!t) return true;
  if (t === '.' || t === '..' || t === './' || t === '../') return true;
  // root, home, or a bare/root-only variable expansion (an unset var deletes cwd/root)
  if (/^(\/|~|\$\{?\w+\}?)\/?\*?$/.test(t)) return true;
  // bare top-level system directories
  if (/^\/(etc|usr|var|bin|sbin|lib|lib64|boot|dev|sys|proc|opt|root|home)\/?\*?$/.test(t)) {
    return true;
  }
  return false;
}

/** A clearly scoped, reversible target: a /tmp scratch subpath, or a relative
 *  subpath under cwd with no shell-variable expansion. */
function isScopedRmTarget(raw: string): boolean {
  const t = unquoteTarget(raw);
  if (!t) return false;
  if (/^\/tmp\/\S+/.test(t)) return true;
  if (!t.startsWith('/') && !t.startsWith('~') && !t.includes('$')) {
    return t !== '.' && t !== '..' && t !== './' && t !== '../';
  }
  return false;
}

export function rmRfCertainty(command: string): DangerousCommandCertainty {
  const targets = rmRfTargets(command);
  if (targets.length === 0) return 'high'; // target not visible → conservative
  if (targets.some(isCatastrophicRmTarget)) return 'high';
  if (targets.every(isScopedRmTarget)) return 'medium';
  return 'high'; // mixed / unrecognised → conservative
}

/** Display fragment for a dangerous command. For `rm -rf` we start the slice at
 *  the match so the cited evidence shows `rm -rf <target>` instead of a leading
 *  `cd …`/`mkdir …` prefix that hides what was deleted (#2011). */
export function dangerousFragment(command: string, pattern: string): string {
  if (pattern === 'rm -rf') {
    const idx = command.search(/\brm\s+-[a-zA-Z]+/);
    if (idx > 0) return truncateCommand(command.slice(idx));
  }
  return truncateCommand(command);
}

export const DANGEROUS_PATTERNS: {
  name: string;
  test: (cmd: string) => boolean;
  certainty?: DangerousCommandCertainty;
}[] = [
  { name: 'rm -rf', test: hasRmRfFlags },
  { name: 'git reset --hard', test: (c) => /\bgit\s+reset\s+--hard/i.test(c) },
  {
    name: 'git push --force',
    test: (c) => /\bgit\s+push\s+(-f\b|--force\b)/i.test(c),
  },
  { name: 'chmod 777', test: (c) => /\bchmod\s+(-R\s+)?[0-7]*777\b/i.test(c) },
  { name: 'dd if=', test: (c) => /\bdd\s+if=/i.test(c), certainty: 'medium' },
  {
    name: 'fork bomb',
    test: (c) => /:\(\)\s*\{\s*:\s*\|\s*:&\s*\}\s*;:/.test(c),
  },
  { name: 'mkfs', test: (c) => /\bmkfs\.\w+|\bmkfs\b/i.test(c) },
  { name: 'disk overwrite', test: (c) => />\s*\/dev\/sd[a-z]/i.test(c) },
  {
    name: 'curl pipe shell',
    test: (c) => /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/i.test(c),
  },
  { name: 'npm publish', test: (c) => /\bnpm\s+publish\b/.test(c) },
];

export function dangerousPatternCertainty(pattern: string): DangerousCommandCertainty {
  return DANGEROUS_PATTERNS.find((p) => p.name === pattern)?.certainty ?? 'high';
}

/**
 * Maps a detected dangerous-command pattern name (see DANGEROUS_PATTERNS) to the
 * canonical `settings.json` rule string(s) that would gate it — the seed for the
 * Policy Builder's deny/ask rows (#133). Kept consistent with the canonical
 * deny block the dangerous-bypass recommendation pastes (`DANGEROUS_DENY_RULES`
 * in recommendations.ts). `fork bomb` is intentionally absent: a `:(){ :|:& };:`
 * payload has no command prefix to match, so no `Bash(prefix:*)` rule can gate
 * it — it produces no row rather than a misleading one.
 */
export const DANGEROUS_PATTERN_RULES: Record<string, string[]> = {
  'rm -rf': ['Bash(rm -rf:*)', 'Bash(rm -fr:*)'],
  'git reset --hard': ['Bash(git reset --hard:*)'],
  'git push --force': ['Bash(git push --force:*)', 'Bash(git push -f:*)'],
  'chmod 777': ['Bash(chmod:*)'],
  'dd if=': ['Bash(dd:*)'],
  mkfs: ['Bash(mkfs:*)'],
  'disk overwrite': ['Bash(dd:*)'],
  'curl pipe shell': ['Bash(curl:*)', 'Bash(wget:*)'],
  'npm publish': ['Bash(npm publish:*)'],
};

interface RiskyActionPattern {
  name: string;
  category: RiskyActionCategory;
  severity: RiskyActionSeverity;
  test: (cmd: string) => boolean;
}

function splitShellSegments(command: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    const next = command[i + 1];
    const isDouble = (ch === '&' && next === '&') || (ch === '|' && next === '|');
    const isSeparator = isDouble || ch === ';' || ch === '\n' || ch === '|';
    if (!isSeparator) continue;
    const segment = command.slice(start, i).trim();
    if (segment) out.push(segment);
    start = i + (isDouble ? 2 : 1);
    if (isDouble) i += 1;
  }

  const tail = command.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function tokenizeShellSegment(segment: string): string[] {
  const out: string[] = [];
  let token = '';
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;

  const push = () => {
    if (token.length > 0) out.push(token);
    token = '';
  };

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (escaped) {
      token += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else token += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    token += ch;
  }
  push();
  return out;
}

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(token);
}

function executableTokens(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (isEnvAssignment(t)) {
      i += 1;
      continue;
    }
    if (t === 'sudo' || t === 'time' || t === 'command') {
      i += 1;
      while (i < tokens.length && tokens[i].startsWith('-')) i += 1;
      continue;
    }
    if (t === 'env') {
      i += 1;
      while (i < tokens.length && (tokens[i].startsWith('-') || isEnvAssignment(tokens[i]))) {
        i += 1;
      }
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

function commandSegments(command: string): string[][] {
  return splitShellSegments(command)
    .map(tokenizeShellSegment)
    .map(executableTokens)
    .filter((tokens) => tokens.length > 0);
}

function hasHelpArg(tokens: string[]): boolean {
  return tokens.some((t) => t === '--help' || t === '-h' || t === 'help');
}

function hasDryRunArg(tokens: string[]): boolean {
  return tokens.some((t) => t === '--dry-run' || t.startsWith('--dry-run='));
}

function isKubectlMutation(tokens: string[]): boolean {
  const [head, verb, subverb] = tokens;
  if (head !== 'kubectl' && head !== 'k') return false;
  if (hasHelpArg(tokens) || hasDryRunArg(tokens)) return false;
  if (verb === 'rollout') return ['restart', 'undo', 'pause', 'resume'].includes(subverb);
  return ['apply', 'delete', 'patch', 'replace', 'scale', 'cordon', 'drain'].includes(verb);
}

function isHelmMutation(tokens: string[]): boolean {
  const [head, verb] = tokens;
  return (
    head === 'helm' &&
    !hasHelpArg(tokens) &&
    ['upgrade', 'install', 'rollback', 'uninstall'].includes(verb)
  );
}

function isComposeDeploy(tokens: string[]): boolean {
  const [head, sub, verb] = tokens;
  if (head !== 'docker' && head !== 'podman') return false;
  if (hasHelpArg(tokens) || hasDryRunArg(tokens)) return false;
  return sub === 'compose' && ['up', 'restart'].includes(verb);
}

function isNamedDeploy(tokens: string[]): boolean {
  const [head, verb] = tokens;
  if (hasHelpArg(tokens) || hasDryRunArg(tokens)) return false;
  if (head === 'vercel' || head === 'flyctl' || head === 'fly') return verb === 'deploy';
  if (head === 'netlify') return verb === 'deploy' && tokens.includes('--prod');
  return false;
}

function isTerraformMutation(tokens: string[]): boolean {
  const [head, verb] = tokens;
  return (
    (head === 'terraform' || head === 'tofu') &&
    !hasHelpArg(tokens) &&
    ['apply', 'destroy', 'import', 'taint'].includes(verb)
  );
}

function isInfraMutation(tokens: string[]): boolean {
  const [head, verb, subverb] = tokens;
  if (hasHelpArg(tokens) || hasDryRunArg(tokens)) return false;
  if (head === 'pulumi') return ['up', 'destroy', 'import'].includes(verb);
  if (head === 'cdk') return verb === 'deploy';
  if (head === 'aws') {
    return (
      (verb === 'cloudformation' && subverb === 'deploy') ||
      (verb === 'ecs' && subverb === 'update-service') ||
      (verb === 'ssm' && subverb === 'put-parameter')
    );
  }
  return false;
}

function isDatabaseMutation(tokens: string[], command: string): boolean {
  const [head, verb, subverb] = tokens;
  if (hasHelpArg(tokens) || hasDryRunArg(tokens)) return false;
  if (
    head === 'prisma' &&
    verb === 'migrate' &&
    ['deploy', 'reset'].includes(subverb)
  ) {
    return true;
  }
  if (head === 'supabase' && verb === 'db' && ['push', 'reset'].includes(subverb)) {
    return true;
  }
  if (head === 'rails' && /^db:(migrate|drop|reset|seed)$/.test(verb ?? '')) {
    return true;
  }
  if (!['psql', 'mysql', 'mariadb', 'sqlcmd', 'mongosh', 'redis-cli'].includes(head)) {
    return false;
  }
  return /\b(drop|truncate|delete\s+from|alter\s+table|update\s+\w+|flushall)\b/i.test(
    command
  );
}

const SECRET_ENV_RE =
  /\$(?:\{)?[A-Z_][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*(?:\})?/i;

function isSecretSensitive(tokens: string[], command: string): boolean {
  const [head, verb, subverb] = tokens;
  if (hasHelpArg(tokens)) return false;
  if ((head === 'echo' || head === 'printf') && SECRET_ENV_RE.test(command)) {
    return true;
  }
  if (head === 'gh' && verb === 'secret' && subverb === 'set') return true;
  if (head === 'kubectl' && verb === 'create' && subverb === 'secret') return true;
  if (head === 'aws' && verb === 'secretsmanager' && subverb === 'put-secret-value') {
    return true;
  }
  return false;
}

function isOtherHighImpact(tokens: string[]): boolean {
  const [head, verb, subverb] = tokens;
  if (hasHelpArg(tokens) || hasDryRunArg(tokens)) return false;
  if (head === 'gh' && verb === 'pr' && subverb === 'merge') return true;
  if (head === 'git' && verb === 'push') {
    return (
      tokens.includes('--tags') ||
      tokens.includes('master') ||
      tokens.includes('main')
    );
  }
  return false;
}

export const RISKY_ACTION_PATTERNS: RiskyActionPattern[] = [
  {
    name: 'kubectl mutation',
    category: 'deploy',
    severity: 'warning',
    test: (cmd) => commandSegments(cmd).some(isKubectlMutation),
  },
  {
    name: 'helm release mutation',
    category: 'deploy',
    severity: 'warning',
    test: (cmd) => commandSegments(cmd).some(isHelmMutation),
  },
  {
    name: 'compose deployment',
    category: 'deploy',
    severity: 'warning',
    test: (cmd) => commandSegments(cmd).some(isComposeDeploy),
  },
  {
    name: 'platform deploy',
    category: 'deploy',
    severity: 'warning',
    test: (cmd) => commandSegments(cmd).some(isNamedDeploy),
  },
  {
    name: 'terraform mutation',
    category: 'production-config',
    severity: 'warning',
    test: (cmd) => commandSegments(cmd).some(isTerraformMutation),
  },
  {
    name: 'infra config mutation',
    category: 'production-config',
    severity: 'warning',
    test: (cmd) => commandSegments(cmd).some(isInfraMutation),
  },
  {
    name: 'database mutation',
    category: 'database',
    severity: 'critical',
    test: (cmd) =>
      commandSegments(cmd).some((tokens) => isDatabaseMutation(tokens, cmd)),
  },
  {
    name: 'secret exposure or mutation',
    category: 'secret-sensitive',
    severity: 'critical',
    test: (cmd) => commandSegments(cmd).some((tokens) => isSecretSensitive(tokens, cmd)),
  },
  {
    name: 'repository publication',
    category: 'other-high-impact',
    severity: 'warning',
    test: (cmd) => commandSegments(cmd).some(isOtherHighImpact),
  },
];

const RISKY_ACTION_BY_NAME = new Map(
  RISKY_ACTION_PATTERNS.map((pattern) => [pattern.name, pattern])
);

export function detectRiskyActionPatternName(command: string): string | null {
  return RISKY_ACTION_PATTERNS.find((pattern) => pattern.test(command))?.name ?? null;
}

function truncateCommand(s: string): string {
  const flat = s.replace(/\r?\n/g, ' ');
  return flat.length > MAX_COMMAND_LEN ? flat.slice(0, MAX_COMMAND_LEN) : flat;
}

function evidenceRefForToolCall(
  timelines: readonly SessionTimeline[] | undefined,
  sessionId: string,
  call: { timestamp: string; toolUseId: string; toolName: string }
): EvidenceRef | undefined {
  const timeline = timelines?.find((candidate) => candidate.sessionId === sessionId);
  if (!timeline) return undefined;
  const byToolId = timeline.entries.findIndex(
    (entry) => entry.kind === 'tool_use' && entry.toolUseId === call.toolUseId
  );
  const index =
    byToolId >= 0
      ? byToolId
      : timeline.entries.findIndex(
          (entry) =>
            entry.kind === 'tool_use' &&
            entry.timestamp === call.timestamp &&
            entry.toolName === call.toolName
        );
  if (index < 0) return undefined;
  return evidenceRefForEntry(timeline, index) ?? undefined;
}

export function parsePermissionData(
  text: string,
  fileName: string
): {
  perModeEntries: { mode: string; sessionId: string }[];
  changes: PermissionChange[];
} | null {
  const sessionId = fileName.replace(/\.jsonl$/, '');

  const perModeEntries: { mode: string; sessionId: string }[] = [];
  const changes: PermissionChange[] = [];

  let lastMode: string | null = null;
  let sawAny = false;

  for (const entry of parseJsonl(text) as PermissionSessionEntry[]) {
    const mode = entry.permissionMode;
    if (typeof mode !== 'string' || mode.length === 0) continue;

    sawAny = true;
    perModeEntries.push({ mode, sessionId });

    if (mode !== lastMode) {
      changes.push({
        sessionId,
        timestamp: entry.timestamp ?? '',
        fromMode: lastMode,
        toMode: mode,
      });
      lastMode = mode;
    }
  }

  if (!sawAny) return null;
  return { perModeEntries, changes };
}

export function aggregatePermissionModes(
  rows: { mode: string; sessionId: string }[]
): PermissionModeStat[] {
  const map = new Map<string, { entryCount: number; sessions: Set<string> }>();

  for (const r of rows) {
    const existing = map.get(r.mode) ?? {
      entryCount: 0,
      sessions: new Set<string>(),
    };
    existing.entryCount += 1;
    existing.sessions.add(r.sessionId);
    map.set(r.mode, existing);
  }

  return Array.from(map.entries())
    .map(([mode, { entryCount, sessions }]) => ({
      mode,
      entryCount,
      sessionCount: sessions.size,
    }))
    .sort((a, b) => b.entryCount - a.entryCount);
}

/**
 * One tool's prompt-friction estimate.
 *
 * `promptableCalls` is the number of invocations of this tool that occurred in
 * sessions whose permission mode never escalated past `default`/`auto` — i.e.
 * sessions where each tool use is eligible to trigger an interactive
 * permission prompt. See {@link rankPromptProneTools} for the precision caveat.
 */
export interface ToolPromptFriction {
  toolName: string;
  /** Tool invocations made under a prompt-eligible (non-bypass) mode. */
  promptableCalls: number;
  /** Distinct sessions contributing those calls. */
  sessionCount: number;
  /** Share of all prompt-eligible, prompt-capable tool calls, 0–100. */
  share: number;
}

/**
 * Permission modes that suppress interactive prompts. A session that ever runs
 * in one of these is treated as not prompt-eligible, because Claude Code stops
 * asking once the user opts into bypass / always-accept behavior.
 */
const PROMPT_SUPPRESSING_MODES = new Set(['bypassPermissions', 'acceptEdits']);

/**
 * Tools that never raise an interactive permission prompt under `default` mode
 * (#75). These are read-only inspection tools and agent-internal / automatic
 * tools that Claude Code allows without asking, so counting them as
 * "prompt-prone" inflates the friction ranking with calls that can't be
 * allowlisted away (Read alone was ~24% of eligible calls). Excluded from the
 * ranking entirely.
 *
 * Includes the read-only file/search tools (Read, Grep, Glob), the always-auto
 * housekeeping tools (TodoWrite, BashOutput, KillShell, ToolSearch), and the
 * agent/task-orchestration tools the runtime fires without a prompt
 * (Task/Agent, the Task* family, Monitor, AskUserQuestion). MCP tools and
 * Bash/Edit/Write — which do prompt under `default` — are intentionally absent.
 */
const NEVER_PROMPT_TOOLS = new Set<string>([
  'Read',
  'Grep',
  'Glob',
  'TodoWrite',
  'BashOutput',
  'KillShell',
  'KillBash',
  'ToolSearch',
  'Task',
  'Agent',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
  'TaskStop',
  'Monitor',
  'AskUserQuestion',
]);

/**
 * Rank tools by how often they are likely to trigger an interactive permission
 * prompt, surfacing the most prompt-prone tools so a project allowlist can be
 * seeded for them.
 *
 * Tools that never prompt under `default` ({@link NEVER_PROMPT_TOOLS} — Read,
 * Grep, Glob, TodoWrite, etc.) are excluded, so the ranking reflects tools that
 * can actually be allowlisted to cut prompts (#75).
 *
 * APPROXIMATION / LIMITATION: the transcript JSONL does **not** record a
 * per-tool permission decision (there is no "this tool_use was prompted /
 * approved / denied" field). The only permission signal is `permissionMode`,
 * and it appears on `permission-mode` / `user` lines, never on the `tool_use`
 * line itself. We therefore cannot say a specific call was prompted. Instead we
 * approximate: a session whose mode set never includes a prompt-suppressing
 * mode ({@link PROMPT_SUPPRESSING_MODES}) is "prompt-eligible", and every
 * prompt-capable tool call (i.e. not in {@link NEVER_PROMPT_TOOLS}) in such a
 * session is one that could have raised a prompt under `default`. Tools are
 * ranked by that count. This still over-counts (not every eligible call
 * actually prompts — repeats and pre-allowlisted tools don't) but gives an
 * honest relative ordering of which tools drive prompt friction. `share` is
 * computed over the prompt-capable calls only.
 *
 * Pure: depends only on its arguments.
 */
export function rankPromptProneTools(
  data: ToolUsageData[],
  permissionRows: { mode: string; sessionId: string }[]
): ToolPromptFriction[] {
  // Which sessions ever entered a prompt-suppressing mode?
  const suppressedSessions = new Set<string>();
  const sessionsWithModeInfo = new Set<string>();
  for (const r of permissionRows) {
    sessionsWithModeInfo.add(r.sessionId);
    if (PROMPT_SUPPRESSING_MODES.has(r.mode)) {
      suppressedSessions.add(r.sessionId);
    }
  }

  const counts = new Map<string, { calls: number; sessions: Set<string> }>();
  for (const session of data) {
    // Only sessions with mode info and no prompt-suppressing mode are
    // prompt-eligible. Sessions with no mode info at all are excluded — we
    // can't claim they were prompting.
    if (!sessionsWithModeInfo.has(session.sessionId)) continue;
    if (suppressedSessions.has(session.sessionId)) continue;

    for (const call of session.calls) {
      // Skip tools that never prompt under `default` — they aren't friction
      // and can't be allowlisted away (#75).
      if (NEVER_PROMPT_TOOLS.has(call.toolName)) continue;
      const existing = counts.get(call.toolName) ?? {
        calls: 0,
        sessions: new Set<string>(),
      };
      existing.calls += 1;
      existing.sessions.add(session.sessionId);
      counts.set(call.toolName, existing);
    }
  }

  let total = 0;
  for (const { calls } of counts.values()) total += calls;

  return Array.from(counts.entries())
    .map(([toolName, { calls, sessions }]) => ({
      toolName,
      promptableCalls: calls,
      sessionCount: sessions.size,
      share: total === 0 ? 0 : (calls / total) * 100,
    }))
    .sort((a, b) => b.promptableCalls - a.promptableCalls);
}

export function detectDangerousCommands(
  data: ToolUsageData[]
): DangerousCommand[] {
  const out: DangerousCommand[] = [];

  for (const session of data) {
    for (const call of session.calls) {
      if (call.toolName !== 'Bash') continue;
      const input = call.input;
      if (!input || typeof input !== 'object') continue;
      const command = (input as { command?: unknown }).command;
      const commandText =
        typeof command === 'string' && command.length > 0 ? command : null;
      const precomputedPattern =
        typeof call.commandDangerousPattern === 'string'
          ? call.commandDangerousPattern
          : null;
      const preview =
        typeof call.commandPreview === 'string' && call.commandPreview.length > 0
          ? call.commandPreview
          : null;

      if (precomputedPattern) {
        const text = commandText ?? preview ?? '';
        out.push({
          sessionId: session.sessionId,
          timestamp: call.timestamp,
          toolUseId: call.toolUseId,
          // Prefer the parse-time fragment (#2036): the bulk toolData payload
          // drops raw command bodies, so `text` here is the 200-char preview and
          // can't show a `rm -rf <target>` buried past it. The precomputed
          // fragment was sliced from the FULL command at ingest. Fall back to the
          // live slice when no precompute exists (uploads keep the full body).
          command:
            typeof call.commandDangerousFragment === 'string'
              ? call.commandDangerousFragment
              : dangerousFragment(text, precomputedPattern),
          pattern: precomputedPattern,
          // Prefer the parse-time certainty (#2036): target-aware rm -rf certainty
          // needs the full command, which body-stripping removes — recomputing
          // from the truncated preview would wrongly fall back to 'high' for a
          // scoped delete. The precompute was done from the full command at
          // ingest. Fall back to the live computation when absent.
          certainty:
            call.commandDangerousCertainty ??
            (precomputedPattern === 'rm -rf'
              ? rmRfCertainty(text)
              : dangerousPatternCertainty(precomputedPattern)),
        });
        continue;
      }

      if (commandText === null) continue;
      for (const { name, test, certainty } of DANGEROUS_PATTERNS) {
        if (!test(commandText)) continue;
        out.push({
          sessionId: session.sessionId,
          timestamp: call.timestamp,
          toolUseId: call.toolUseId,
          command: dangerousFragment(commandText, name),
          pattern: name,
          // rm -rf certainty is target-aware (#2011); other patterns are static.
          certainty: name === 'rm -rf' ? rmRfCertainty(commandText) : certainty ?? 'high',
        });
        break; // only record first matching pattern per command
      }
    }
  }

  return out.sort((a, b) => {
    if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
    if (a.timestamp === b.timestamp) return 0;
    return a.timestamp < b.timestamp ? -1 : 1;
  });
}

export function detectRiskyActions(
  data: ToolUsageData[],
  timelines?: readonly SessionTimeline[]
): RiskyAction[] {
  const out: RiskyAction[] = [];

  for (const session of data) {
    for (const call of session.calls) {
      if (call.toolName !== 'Bash') continue;
      const input = call.input;
      if (!input || typeof input !== 'object') continue;
      const command = (input as { command?: unknown }).command;
      const commandText =
        typeof command === 'string' && command.length > 0 ? command : null;
      const precomputedPattern =
        typeof call.commandRiskyActionPattern === 'string'
          ? RISKY_ACTION_BY_NAME.get(call.commandRiskyActionPattern) ?? null
          : null;
      const preview =
        typeof call.commandPreview === 'string' && call.commandPreview.length > 0
          ? call.commandPreview
          : null;

      const pattern =
        precomputedPattern ??
        (commandText === null
          ? null
          : RISKY_ACTION_PATTERNS.find((candidate) =>
              candidate.test(commandText)
            ) ?? null);
      if (!pattern) continue;

      out.push({
        sessionId: session.sessionId,
        timestamp: call.timestamp,
        toolUseId: call.toolUseId,
        command: truncateCommand(commandText ?? preview ?? ''),
        pattern: pattern.name,
        category: pattern.category,
        severity: pattern.severity,
        evidenceRef: evidenceRefForToolCall(timelines, session.sessionId, call),
      });
    }
  }

  return out.sort((a, b) => {
    if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
    if (a.timestamp === b.timestamp) return 0;
    return a.timestamp < b.timestamp ? -1 : 1;
  });
}

export function computeSafetyScores(
  dangerous: DangerousCommand[],
  permissionRows: { mode: string; sessionId: string }[]
): SessionSafetyScore[] {
  const dangerCounts = new Map<string, number>();
  for (const d of dangerous) {
    // Gate on HIGH-certainty (#2011): scoped/reversible rm -rf (./.worktrees,
    // /tmp, …) is 'medium' and must not drive the bypassPermissions safety
    // score. Mirrors session-scorecard's high-certainty filter so both the
    // dangerous-bypass and unattended-sessions detectors agree on the count.
    if (d.certainty !== 'high') continue;
    dangerCounts.set(d.sessionId, (dangerCounts.get(d.sessionId) ?? 0) + 1);
  }

  const sessionModes = new Map<string, Set<string>>();
  for (const r of permissionRows) {
    const existing = sessionModes.get(r.sessionId) ?? new Set<string>();
    existing.add(r.mode);
    sessionModes.set(r.sessionId, existing);
  }

  const sessionIds = new Set<string>([
    ...dangerCounts.keys(),
    ...sessionModes.keys(),
  ]);

  const out: SessionSafetyScore[] = [];
  for (const sessionId of sessionIds) {
    const modes = sessionModes.get(sessionId);
    const modeList = modes ? Array.from(modes).sort() : [];
    out.push({
      sessionId,
      dangerousCount: dangerCounts.get(sessionId) ?? 0,
      bypassMode: modes?.has('bypassPermissions') ?? false,
      modes: modeList,
    });
  }

  return out.sort((a, b) => b.dangerousCount - a.dangerousCount);
}
