import type { ToolUsageData } from './parse-tools';
import { parseJsonl, type RawSessionEntry } from './parse-utils';

export interface PermissionModeStat {
  mode: string;
  entryCount: number;
  sessionCount: number;
}

export interface DangerousCommand {
  sessionId: string;
  timestamp: string;
  toolUseId: string;
  command: string; // truncated to 200 chars, newlines → " "
  pattern: string; // which pattern matched
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

export const DANGEROUS_PATTERNS: {
  name: string;
  test: (cmd: string) => boolean;
}[] = [
  { name: 'rm -rf', test: hasRmRfFlags },
  { name: 'git reset --hard', test: (c) => /\bgit\s+reset\s+--hard/i.test(c) },
  {
    name: 'git push --force',
    test: (c) => /\bgit\s+push\s+(-f\b|--force\b)/i.test(c),
  },
  { name: 'chmod 777', test: (c) => /\bchmod\s+(-R\s+)?[0-7]*777\b/i.test(c) },
  { name: 'dd if=', test: (c) => /\bdd\s+if=/i.test(c) },
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

function truncateCommand(s: string): string {
  const flat = s.replace(/\r?\n/g, ' ');
  return flat.length > MAX_COMMAND_LEN ? flat.slice(0, MAX_COMMAND_LEN) : flat;
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
      if (typeof command !== 'string' || command.length === 0) continue;

      for (const { name, test } of DANGEROUS_PATTERNS) {
        if (test(command)) {
          out.push({
            sessionId: session.sessionId,
            timestamp: call.timestamp,
            toolUseId: call.toolUseId,
            command: truncateCommand(command),
            pattern: name,
          });
          break; // only record first matching pattern per command
        }
      }
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
