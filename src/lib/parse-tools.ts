import { parseJsonl, parseMessage } from './parse-utils';
import { detectRiskyActionPatternName } from './parse-permissions';

/**
 * Distilled tool-call `input`. The raw `call.input` blob is the single largest
 * contributor to the dataset payload (file contents, full command bodies, MCP
 * argument blobs), but only a handful of small sub-fields are ever read
 * client-side. Session-detail rows keep those fields under the same names, but
 * the bulk dataset strips `input.command` after deriving compact Bash command
 * signals. Any field not listed here is intentionally dropped on the wire.
 *
 * Consumers (audited):
 *  - Bash `command`       → parse-tools (topBashCommands / bypass / subcommand /
 *                            repeated), parse-permissions (detectDangerousCommands)
 *  - file tools `file_path` → parse-files (Read/Edit/Write/NotebookEdit/MultiEdit)
 *  - Task `subagent_type` → parse-agents (aggregateAgentInvocations)
 *  - Skill `skill`        → parse-agents (aggregateSkillInvocations)
 */
export interface DistilledToolInput {
  command?: string;
  file_path?: string;
  subagent_type?: string;
  skill?: string;
}

/**
 * Categories of shell command that re-implement a first-class Claude tool.
 * Using the native tool is cheaper (no shell spin-up / output streaming) and
 * goes through permission integration, so each detected use is a nudge.
 */
export type BypassCategory = 'grep' | 'find' | 'cat' | 'sed' | 'awk' | 'cd';

export interface ToolCall {
  timestamp: string;
  toolName: string;
  input: DistilledToolInput;
  toolUseId: string;
  isError: boolean | null;
  /**
   * Size of the tool_result content in characters, used as a cheap proxy for
   * how many tokens the result consumed (no actual token count is available
   * per tool_result on the wire). 0 when no result was seen or it was empty.
   * Additive field — see cost-attribution's token-weighted attribution.
   */
  resultBytes: number;
  /** Compact fingerprint for repeat grouping after raw Bash text is stripped. */
  commandFingerprint?: string;
  /** Small redacted-ish display preview; raw command bodies stay out of bulk JSON. */
  commandPreview?: string;
  /** First executable token after leading env assignments. */
  commandHead?: string;
  /** Git-related command segments needed by workflow detectors after stripping. */
  commandGitSegments?: string[];
  /** Precomputed native-tool-bypass categories for Bash commands. */
  commandBypassCategories?: BypassCategory[];
  /** First dangerous-command pattern matched by the Bash command, if any. */
  commandDangerousPattern?: string;
  /** First high-impact action pattern matched by the Bash command, if any. */
  commandRiskyActionPattern?: string;
  /** Whether the command references Claude-specific paths such as `.claude`. */
  commandMentionsClaudePath?: boolean;
}

export interface ToolUsageData {
  sessionId: string;
  calls: ToolCall[];
}

export interface ToolAggregate {
  toolName: string;
  count: number;
  errorCount: number;
  errorRate: number;
}

export interface BashCommandStat {
  command: string;
  count: number;
}

const MAX_COMMAND_PREVIEW_LEN = 200;
const MAX_COMMAND_GIT_SEGMENTS = 12;

/**
 * Character length of a tool_result `content` value, used as a cheap proxy for
 * the result's token cost. `content` is either a string or an array of content
 * blocks (e.g. `[{ type: 'text', text: '...' }]`); for arrays we sum the length
 * of each block's `text`/`content` (falling back to a JSON encoding for opaque
 * blocks). Returns 0 for null/empty content.
 */
function resultContentSize(content: unknown): number {
  if (content == null) return 0;
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    let sum = 0;
    for (const block of content) {
      if (typeof block === 'string') {
        sum += block.length;
      } else if (block && typeof block === 'object') {
        const b = block as { text?: unknown; content?: unknown };
        if (typeof b.text === 'string') sum += b.text.length;
        else if (typeof b.content === 'string') sum += b.content.length;
        else sum += JSON.stringify(block).length;
      }
    }
    return sum;
  }
  if (typeof content === 'object') return JSON.stringify(content).length;
  return String(content).length;
}

/**
 * Reduce a raw tool_use `input` to the small set of sub-fields consumed
 * client-side (see DistilledToolInput). Only string values are kept, and large
 * free-text bodies (Write/Edit contents, MCP arg blobs, etc.) are dropped by
 * virtue of not being on the allowlist. The `command` string is kept in FULL
 * for the per-session session_blob row, while parseToolUsage also emits compact
 * command-derived fields on the ToolCall. assembleDataset() strips the raw
 * command from the bulk dataset after those fields are available.
 */
export function distillToolInput(input: unknown): DistilledToolInput {
  if (!input || typeof input !== 'object') return {};
  const src = input as Record<string, unknown>;
  const out: DistilledToolInput = {};
  if (typeof src.command === 'string') out.command = src.command;
  if (typeof src.file_path === 'string') out.file_path = src.file_path;
  if (typeof src.subagent_type === 'string') out.subagent_type = src.subagent_type;
  if (typeof src.skill === 'string') out.skill = src.skill;
  return out;
}

export function parseToolUsage(text: string, fileName: string): ToolUsageData | null {
  const sessionId = fileName.replace(/\.jsonl$/, '');

  // Map of tool_use_id -> ToolCall
  const callsById = new Map<string, ToolCall>();
  // Pending tool_results for tool_use_ids we haven't seen yet:
  // tool_use_id -> { isError, resultBytes }
  const pendingResults = new Map<
    string,
    { isError: boolean; resultBytes: number }
  >();

  for (const entry of parseJsonl(text)) {
    if (!entry.message) continue;
    const msg = parseMessage(entry.message);
    if (!msg || !Array.isArray(msg.content)) continue;

    if (entry.type === 'assistant') {
      for (const block of msg.content) {
        if (block?.type !== 'tool_use') continue;
        const toolUseId = block.id ?? '';
        if (!toolUseId) continue;
        const pending = pendingResults.get(toolUseId);
        const input = distillToolInput(block.input);
        const call: ToolCall = {
          timestamp: entry.timestamp ?? '',
          toolName: block.name ?? 'unknown',
          input,
          toolUseId,
          isError: pending !== undefined ? pending.isError : null,
          resultBytes: pending !== undefined ? pending.resultBytes : 0,
          ...(block.name === 'Bash' && input.command
            ? deriveBashCommandSignals(input.command)
            : {}),
        };
        callsById.set(toolUseId, call);
        if (pending !== undefined) pendingResults.delete(toolUseId);
      }
    } else if (entry.type === 'user') {
      for (const block of msg.content) {
        if (block?.type !== 'tool_result') continue;
        const toolUseId = block.tool_use_id ?? '';
        if (!toolUseId) continue;
        const isError = block.is_error === true;
        const resultBytes = resultContentSize(block.content);
        const existing = callsById.get(toolUseId);
        if (existing) {
          existing.isError = isError;
          existing.resultBytes = resultBytes;
        } else {
          // result arrived before tool_use was processed (unusual but defensive)
          pendingResults.set(toolUseId, { isError, resultBytes });
        }
      }
    }
  }

  const calls = Array.from(callsById.values());
  if (calls.length === 0) return null;

  return { sessionId, calls };
}

export function stripToolCommandBodies(data: ToolUsageData): ToolUsageData {
  return {
    ...data,
    calls: data.calls.map((call) => {
      if (typeof call.input.command !== 'string') {
        return call;
      }
      const { command: _command, ...input } = call.input;
      void _command;
      return { ...call, input };
    }),
  };
}

export function aggregateTools(data: ToolUsageData[]): ToolAggregate[] {
  const map = new Map<string, { count: number; errorCount: number }>();

  for (const session of data) {
    for (const call of session.calls) {
      const entry = map.get(call.toolName) ?? { count: 0, errorCount: 0 };
      entry.count += 1;
      if (call.isError === true) entry.errorCount += 1;
      map.set(call.toolName, entry);
    }
  }

  return Array.from(map.entries())
    .map(([toolName, { count, errorCount }]) => ({
      toolName,
      count,
      errorCount,
      errorRate: count === 0 ? 0 : (errorCount / count) * 100,
    }))
    .sort((a, b) => b.count - a.count);
}

export function topBashCommands(
  data: ToolUsageData[],
  limit = 10
): BashCommandStat[] {
  const counts = new Map<string, { command: string; count: number }>();

  for (const session of data) {
    for (const call of session.calls) {
      if (call.toolName !== 'Bash') continue;
      const command = bashCommandPreview(call);
      if (command === null) continue;
      const key = call.commandFingerprint ?? command;
      const current = counts.get(key) ?? { command, count: 0 };
      current.count += 1;
      counts.set(key, current);
    }
  }

  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/**
 * Pull the `command` string out of a Bash ToolCall input, or null if the call
 * isn't a usable Bash invocation. Shared by the analyses below.
 */
function bashCommand(call: ToolCall): string | null {
  if (call.toolName !== 'Bash') return null;
  const input = call.input;
  if (!input || typeof input !== 'object') return null;
  const command = (input as { command?: unknown }).command;
  if (typeof command !== 'string' || command.length === 0) return null;
  return command;
}

function bashCommandPreview(call: ToolCall): string | null {
  const command = bashCommand(call);
  if (command !== null) return command;
  return typeof call.commandPreview === 'string' && call.commandPreview.length > 0
    ? call.commandPreview
    : null;
}

function bashBypassCategories(call: ToolCall): BypassCategory[] {
  if (call.toolName !== 'Bash') return [];
  if (Array.isArray(call.commandBypassCategories)) {
    return call.commandBypassCategories;
  }
  const command = bashCommand(call);
  if (command === null) return [];
  const trimmed = command.trim();
  return BYPASS_DEFS.filter((def) => def.test(trimmed)).map((def) => def.category);
}

// ---------------------------------------------------------------------------
// Native-tool-bypass detector
// ---------------------------------------------------------------------------

export interface BypassStat {
  category: BypassCategory;
  /** The native tool the user should reach for instead. */
  nativeTool: string;
  count: number;
  hint: string;
}

export interface NativeToolBypass {
  categories: BypassStat[];
  /** Total Bash commands that matched at least one bypass category. */
  totalBypass: number;
  /** grep: native Grep calls vs Bash `grep` invocations. */
  grepRatio: { native: number; bash: number };
  /** find: native Glob calls vs Bash `find` invocations. */
  findRatio: { native: number; bash: number };
}

/**
 * Does `cmd` invoke one of `words` as a command word that is NOT fed from a
 * pipe? (#72)
 *
 * The native tool only replaces a bypass when the shell tool reads its OWN
 * argument (a file path or a search root). When the tool sits on the right of a
 * pipe — `cmd | grep …`, `… | sed …`, `… | awk …` — it consumes another
 * command's stdout, which native Grep/Read/Edit cannot do, so it is NOT a
 * bypass. We therefore match the tool token only at a command-word boundary
 * (start of string, or after `;`/`&`/whitespace) whose effective preceding
 * operator is not `|`. Leading uses and `;`/`&&`-separated uses still count.
 */
function matchesUnpiped(cmd: string, words: string[]): boolean {
  const re = new RegExp(`(${words.join('|')})(?=\\s|$)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    const start = m.index;
    // Must sit at a command-word boundary (mirrors the original anchors).
    const boundary = start === 0 || /[|&;\s]/.test(cmd[start - 1]);
    if (!boundary) continue;
    // Walk back over any whitespace to the effective preceding operator; if it
    // is a pipe, this token is stdin-fed and is not a native-tool bypass.
    let j = start - 1;
    while (j >= 0 && (cmd[j] === ' ' || cmd[j] === '\t')) j -= 1;
    if (j >= 0 && cmd[j] === '|') continue;
    return true;
  }
  return false;
}

const BYPASS_DEFS: Array<{
  category: BypassCategory;
  nativeTool: string;
  /** Matches the command string (whole string, post-trim). */
  test: (cmd: string) => boolean;
  hint: string;
}> = [
  {
    category: 'grep',
    nativeTool: 'Grep',
    // a `grep`/`rg`/`egrep` invocation as a command word, but NOT when piped
    // stdin (`… | grep`) — native Grep can't read another command's output.
    test: (c) => matchesUnpiped(c, ['grep', 'egrep', 'fgrep', 'rg']),
    hint: 'Prefer native Grep over Bash grep — faster, integrates with permissions.',
  },
  {
    category: 'find',
    nativeTool: 'Glob',
    // find walks a path it is given, so a piped `find` is unusual; still treat
    // a stdin-fed `find` as non-bypass for consistency. Keeps -exec/xargs uses.
    test: (c) => matchesUnpiped(c, ['find']),
    hint: 'Prefer native Glob over Bash find — pattern matching without a shell.',
  },
  {
    category: 'cat',
    nativeTool: 'Read',
    // leading cat/head/tail used to view a file
    test: (c) => /^(cat|head|tail)\s/.test(c),
    hint: 'Prefer native Read over cat/head/tail — paginates and tracks file state.',
  },
  {
    category: 'sed',
    nativeTool: 'Read/Edit',
    // not a bypass when fed by a pipe (`… | sed`) — Read/Edit edit files, not
    // another command's stdout.
    test: (c) => matchesUnpiped(c, ['sed']),
    hint: 'Prefer native Read/Edit over sed — explicit edits with permission checks.',
  },
  {
    category: 'awk',
    nativeTool: 'Read/Edit',
    // not a bypass when fed by a pipe (`… | awk`).
    test: (c) => matchesUnpiped(c, ['awk']),
    hint: 'Prefer native Read/Edit over awk for reading/transforming files.',
  },
  {
    category: 'cd',
    nativeTool: 'absolute paths',
    // a leading `cd ` — cwd resets between Bash calls, so this is wasted work
    test: (c) => /^cd\s/.test(c),
    hint: 'Leading cd is wasted — cwd resets between Bash calls; use absolute paths.',
  },
];

function commandFingerprint(command: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < command.length; i += 1) {
    hash ^= command.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(36)}:${command.length}`;
}

function commandPreview(command: string): string {
  const flat = command.replace(/\r?\n/g, ' ');
  return flat.length > MAX_COMMAND_PREVIEW_LEN
    ? flat.slice(0, MAX_COMMAND_PREVIEW_LEN)
    : flat;
}

function commandHead(command: string): string | undefined {
  const tokens = command.trim().split(/\s+/);
  let token = tokens[0] ?? '';
  let i = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) && i < tokens.length - 1) {
    i += 1;
    token = tokens[i];
  }
  return token || undefined;
}

const WORKFLOW_GIT_SEGMENT_RE =
  /\bgit\s+(?:stash\b|switch\b|checkout\b|reflog\b|cherry-pick\b|merge\s+--ff-only\b)/;

function compactGitSegment(part: string): string {
  if (part.length <= MAX_COMMAND_PREVIEW_LEN) return part;
  const matchIndex = part.search(WORKFLOW_GIT_SEGMENT_RE);
  if (matchIndex < 0) return part.slice(0, MAX_COMMAND_PREVIEW_LEN);
  const start = Math.max(0, matchIndex - 80);
  return part.slice(start, start + MAX_COMMAND_PREVIEW_LEN);
}

function commandGitSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((part) => part.trim())
    .filter((part) => WORKFLOW_GIT_SEGMENT_RE.test(part))
    .map(compactGitSegment)
    .slice(0, MAX_COMMAND_GIT_SEGMENTS);
}

// Kept in sync with parse-permissions.ts so the bulk toolData payload can drop
// raw command bodies while dangerous-command consumers keep their exact signal.
function hasDangerousRmRfFlags(cmd: string): boolean {
  const m = cmd.match(/\brm\s+-([a-zA-Z]+)\b/);
  if (!m) return false;
  const flags = m[1];
  if (!/^[rRfviIdP]+$/.test(flags)) return false;
  return /[rR]/.test(flags) && flags.includes('f');
}

const COMMAND_DANGEROUS_PATTERNS: Array<{
  name: string;
  test: (cmd: string) => boolean;
}> = [
  { name: 'rm -rf', test: hasDangerousRmRfFlags },
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

export function deriveBashCommandSignals(command: string): Partial<ToolCall> {
  const trimmed = command.trim();
  const bypassCategories = BYPASS_DEFS.filter((def) => def.test(trimmed)).map(
    (def) => def.category
  );
  const dangerous = COMMAND_DANGEROUS_PATTERNS.find((pattern) =>
    pattern.test(command)
  );
  const riskyAction = detectRiskyActionPatternName(command);
  const head = commandHead(command);
  const gitSegments = commandGitSegments(command);
  return {
    commandFingerprint: commandFingerprint(command),
    commandPreview: commandPreview(command),
    ...(head ? { commandHead: head } : {}),
    ...(gitSegments.length > 0 ? { commandGitSegments: gitSegments } : {}),
    ...(bypassCategories.length > 0
      ? { commandBypassCategories: bypassCategories }
      : {}),
    ...(dangerous ? { commandDangerousPattern: dangerous.name } : {}),
    ...(riskyAction ? { commandRiskyActionPattern: riskyAction } : {}),
    ...(command.includes('.claude') ? { commandMentionsClaudePath: true } : {}),
  };
}

/**
 * Classify every Bash command against the bypass categories above. A single
 * command can count toward multiple categories (e.g. `find … -name … && grep …`).
 * Pipe-fed tool invocations (`cmd | grep …`) are NOT counted — see
 * {@link matchesUnpiped} (#72) — because no native tool replaces a stdin filter.
 * Returns per-category counts plus the native-vs-Bash ratio for grep & find.
 */
export function nativeToolBypass(data: ToolUsageData[]): NativeToolBypass {
  const counts = new Map<BypassCategory, number>();
  let nativeGrep = 0;
  let nativeGlob = 0;

  for (const session of data) {
    for (const call of session.calls) {
      if (call.toolName === 'Grep') {
        nativeGrep += 1;
        continue;
      }
      if (call.toolName === 'Glob') {
        nativeGlob += 1;
        continue;
      }
      for (const category of bashBypassCategories(call)) {
        counts.set(category, (counts.get(category) ?? 0) + 1);
      }
    }
  }

  const categories = BYPASS_DEFS.filter((d) => (counts.get(d.category) ?? 0) > 0)
    .map((d) => ({
      category: d.category,
      nativeTool: d.nativeTool,
      count: counts.get(d.category) ?? 0,
      hint: d.hint,
    }))
    .sort((a, b) => b.count - a.count);

  const totalBypass = categories.reduce((sum, c) => sum + c.count, 0);

  return {
    categories,
    totalBypass,
    grepRatio: { native: nativeGrep, bash: counts.get('grep') ?? 0 },
    findRatio: { native: nativeGlob, bash: counts.get('find') ?? 0 },
  };
}

/** Per-session count + result-byte sum of native-tool-bypass Bash commands. */
export interface NativeBypassScope {
  sessionId: string;
  /** Bypass Bash commands in this session (a command can match >1 category once). */
  count: number;
  /**
   * Sum of `tool_result` `resultBytes` over those bypass commands — the **direct**
   * byte cost their shell output re-billed into context that a native Grep/Read
   * would not have paid the same way. A char-count proxy (no per-call token count
   * is on the wire); 0 when no bypass command carried a result payload.
   */
  resultBytes: number;
}

/**
 * Per-session breakdown of native-tool-bypass commands and the result bytes they
 * returned, for the workflow byte-lever reclaim claim (#951). Counts a command
 * once even if it matches several bypass categories (mirrors `totalBypass`), and
 * sums that call's `resultBytes` once — the **direct byte delta** the engine
 * dollarizes (bytes the shell streamed back into context). Sessions with no
 * bypass command are omitted.
 */
export function nativeBypassByScope(data: ToolUsageData[]): NativeBypassScope[] {
  const out: NativeBypassScope[] = [];
  for (const session of data) {
    let count = 0;
    let resultBytes = 0;
    for (const call of session.calls) {
      // A single command can satisfy multiple BYPASS_DEFS; count it once.
      if (bashBypassCategories(call).length === 0) continue;
      count += 1;
      if (call.resultBytes > 0) resultBytes += call.resultBytes;
    }
    if (count > 0) out.push({ sessionId: session.sessionId, count, resultBytes });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bash subcommand breakdown
// ---------------------------------------------------------------------------

export interface BashSubcommandStat {
  /** First token of the command (ls, git, cd, grep, make, npx, …). */
  token: string;
  count: number;
}

/**
 * Group Bash invocations by their first token, so `git status` and `git log`
 * both roll up under `git`. Sorted descending by count.
 */
export function bashSubcommandStats(
  data: ToolUsageData[],
  limit = 15
): BashSubcommandStat[] {
  const counts = new Map<string, number>();

  for (const session of data) {
    for (const call of session.calls) {
      const cmd = bashCommand(call);
      // First whitespace-delimited token of the trimmed command. Strip a
      // leading env-var assignment prefix (FOO=bar cmd) if present.
      let token = call.commandHead;
      if (!token && cmd !== null) token = commandHead(cmd);
      if (!token) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([token, count]) => ({ token, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Repeated commands
// ---------------------------------------------------------------------------

export interface RepeatedCommandStat {
  command: string;
  /** Number of distinct sessions in which the command repeated ≥3×. */
  sessions: number;
  /** Total times the command ran across those sessions. */
  totalCount: number;
  /** Highest per-session repeat count. */
  maxPerSession: number;
}

/**
 * Identical Bash command strings run ≥3× within a single session — candidates
 * for a hook, skill, or Makefile target. Counts are scoped per session, then
 * aggregated so a command repeated in several sessions surfaces once.
 */
export function repeatedCommands(
  data: ToolUsageData[],
  minPerSession = 3,
  limit = 15
): RepeatedCommandStat[] {
  const agg = new Map<
    string,
    { sessions: number; totalCount: number; maxPerSession: number }
  >();

  for (const session of data) {
    const perSession = new Map<string, { command: string; count: number }>();
    for (const call of session.calls) {
      const cmd = bashCommandPreview(call);
      if (cmd === null) continue;
      const key = call.commandFingerprint ?? cmd;
      const current = perSession.get(key) ?? { command: cmd, count: 0 };
      current.count += 1;
      perSession.set(key, current);
    }
    for (const { command, count } of perSession.values()) {
      if (count < minPerSession) continue;
      const entry = agg.get(command) ?? {
        sessions: 0,
        totalCount: 0,
        maxPerSession: 0,
      };
      entry.sessions += 1;
      entry.totalCount += count;
      entry.maxPerSession = Math.max(entry.maxPerSession, count);
      agg.set(command, entry);
    }
  }

  return Array.from(agg.entries())
    .map(([command, v]) => ({ command, ...v }))
    .sort((a, b) => b.totalCount - a.totalCount)
    .slice(0, limit);
}

// ── Correction mining (#1040, epic #866) ───────────────────────────────────
// Mine failed→fixed tool pairs: a tool call that errored, followed within a
// small window by a SAME-tool call that succeeded at the same intent, with the
// argument diffed to the corrective fact (wrong path → right path). The
// deterministic counterpart to headroom's `learn`.
//
// SCOPE / PRECISION (deliberately narrow — this feeds a recommendation surface,
// so a false "correction" is worse than a missed one, per epic #866):
//  - Only the FILE-PATH category ships. The command-variant category (e.g.
//    `python3 foo.py` → `uv run python foo.py`) is DEFERRED: a "same target
//    token" gate can't tell a runner swap from a different operation on the same
//    file (`cat foo` → `rm foo`), which would emit a misleading fix.
//  - search-scope / large-file categories need `pattern`/`offset`/`limit`, which
//    `distillToolInput` drops on the wire — also out of scope until distilled.

export type CorrectionCategory = 'file-path';

export interface CorrectionFact {
  category: CorrectionCategory;
  toolName: string;
  /** The argument value on the failed call. */
  failed: string;
  /** The argument value on the subsequent successful call. */
  succeeded: string;
  sessionId: string;
}

/** File tools whose `file_path` correction means "same file, wrong location". */
const CORRECTION_FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
/** How many later calls to scan for the fix after a failed call. */
const CORRECTION_WINDOW = 6;
/** Minimum stem length — below this, stem collisions are too likely. */
const MIN_STEM_LEN = 3;
/**
 * Stems too generic to be a reliable "same file" key: the same basename stem
 * recurs across unrelated files (a per-package `index.ts`, a `main`, a `mod`),
 * so matching on them would pair distinct files into a false correction.
 */
const GENERIC_STEMS = new Set([
  'index', 'main', 'mod', 'app', 'lib', 'types', 'type', 'config', 'conf',
  'init', '__init__', 'test', 'tests', 'spec', 'utils', 'util', 'helpers',
  'helper', 'readme', 'makefile', 'dockerfile', 'setup', 'package', 'mode',
]);

/** Filename without directory. */
function pathBasename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}
/** Filename without directory OR extension — the "stem" (FirstClassEntity). */
function pathStem(p: string): string {
  const base = pathBasename(p);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}
/**
 * Whether a stem is distinctive enough to key a "same file" correction: starts
 * with an alphanumeric (excludes dotfiles like `.gitignore`/`.env`), is at least
 * MIN_STEM_LEN long, and is not a generic, collision-prone name.
 */
function isDistinctiveStem(stem: string): boolean {
  return (
    stem.length >= MIN_STEM_LEN &&
    /^[a-z0-9]/i.test(stem) &&
    !GENERIC_STEMS.has(stem.toLowerCase())
  );
}

/**
 * Extract file-path corrective facts from failed→fixed tool sequences within
 * each session.
 *
 * For each errored file-tool call (`isError === true`) with a `file_path`, scan
 * the next `window` calls for the FIRST same-tool success (`isError === false`)
 * whose path differs but shares a DISTINCTIVE stem — same file, different
 * dir/extension, e.g. `…/FirstClassEntity.java` → `…/FirstClassEntity.scala`.
 * Generic stems (`index`, `main`, …) and dotfiles are excluded so distinct files
 * that merely share a basename are never paired into a false correction.
 *
 * Deterministic and transcript-free (reads only the distilled `toolData`), so it
 * runs on the free/local path per ADR 0005.
 */
export function mineCorrections(
  data: ToolUsageData[],
  window = CORRECTION_WINDOW
): CorrectionFact[] {
  const facts: CorrectionFact[] = [];
  for (const session of data) {
    const calls = session.calls;
    for (let i = 0; i < calls.length; i++) {
      const failed = calls[i];
      if (failed.isError !== true) continue;
      if (!CORRECTION_FILE_TOOLS.has(failed.toolName)) continue;
      const failedArg = failed.input.file_path;
      if (!failedArg) continue;
      const stem = pathStem(failedArg);
      if (!isDistinctiveStem(stem)) continue;

      for (let j = i + 1; j < calls.length && j <= i + window; j++) {
        const fix = calls[j];
        if (fix.toolName !== failed.toolName || fix.isError !== false) continue;
        const okArg = fix.input.file_path;
        if (!okArg || okArg === failedArg) continue;
        if (pathStem(okArg) !== stem) continue;

        facts.push({
          category: 'file-path',
          toolName: failed.toolName,
          failed: failedArg,
          succeeded: okArg,
          sessionId: session.sessionId,
        });
        break; // one correction per failed call
      }
    }
  }
  return facts;
}

export interface AggregatedCorrection extends CorrectionFact {
  /** Number of mined facts with this exact failed→succeeded correction. */
  occurrences: number;
}

/**
 * Group identical `failed → succeeded` corrections and rank by occurrence count
 * (a fact the agent re-guesses repeatedly ranks higher). The `sessionId`
 * retained is the first one seen, for an evidence link.
 */
export function aggregateCorrections(facts: CorrectionFact[]): AggregatedCorrection[] {
  const agg = new Map<string, AggregatedCorrection>();
  for (const f of facts) {
    const key = `${f.category}\0${f.failed}\0${f.succeeded}`;
    const prev = agg.get(key);
    if (prev) prev.occurrences += 1;
    else agg.set(key, { ...f, occurrences: 1 });
  }
  return Array.from(agg.values()).sort((a, b) => b.occurrences - a.occurrences);
}
