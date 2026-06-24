import { parseJsonl, parseMessage } from './parse-utils';
import {
  detectRiskyActionPatternName,
  rmRfCertainty,
  dangerousFragment,
  dangerousPatternCertainty,
  executableShellSkeleton,
  type DangerousCommandCertainty,
} from './parse-permissions';

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
  /**
   * Precomputed dangerous-command certainty (target-aware for `rm -rf`), derived
   * from the FULL command at parse time so it survives raw-body stripping (#2036).
   * Consumers (detectDangerousCommands) must prefer this over recomputing from the
   * truncated `commandPreview`, which can't see a `rm -rf <target>` buried past it.
   */
  commandDangerousCertainty?: DangerousCommandCertainty;
  /**
   * Precomputed display fragment centered on the dangerous match (e.g.
   * `rm -rf <target>`) so cited evidence isn't a misleading leading `cd …`/`mkdir`
   * prefix once the raw body is dropped (#2036).
   */
  commandDangerousFragment?: string;
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
    // A STANDALONE leading `cd` is wasted — cwd resets between Bash calls, so a
    // lone `cd /tmp` has no effect on the next call. But a `cd <dir> && <cmd>`
    // (or `;`/`|`-chained) form anchors the following command within the SAME
    // invocation — that is the MANDATED cwd-anchor idiom (AGENTS.md "Worktrees &
    // Branches" + the cwd-anchor-guard PreToolUse hook), NOT waste. Counting the
    // chained form mislabels the required anchor as a bypass (#2014), so flag a
    // leading `cd` only when no chain operator (`&&`/`||`/`;`/`|`/`&`) follows.
    test: (c) => /^cd\s/.test(c) && !/[;&|]/.test(c),
    hint: 'A standalone leading cd is wasted — cwd resets between Bash calls; use absolute paths. (A chained `cd <dir> && <cmd>` anchor is fine.)',
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
    // The `(?![\w-])` rejects the SAFE variants `--force-with-lease` /
    // `--force-if-includes` while still matching bare `--force` / `-f` (#2042).
    // Keep in sync with parse-permissions.ts DANGEROUS_PATTERNS.
    test: (c) => /\bgit\s+push\s+(-f|--force)(?![\w-])/i.test(c),
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
  // Match dangerous patterns against the executable skeleton (#2039): `rm -rf`
  // (and peers) inside heredoc bodies, quoted literals, or inline-script source
  // (`node -e "…"`) are not executed deletions and must not be flagged.
  const dangerousSkeleton = executableShellSkeleton(command);
  const dangerous = COMMAND_DANGEROUS_PATTERNS.find((pattern) =>
    pattern.test(dangerousSkeleton)
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
    ...(dangerous
      ? {
          commandDangerousPattern: dangerous.name,
          // Precompute certainty + fragment from the FULL command now, before the
          // raw body is stripped from the bulk payload (#2036). rm -rf certainty
          // is target-aware; others are static. Without this, downstream sees only
          // the 200-char preview and re-inflates buried scoped deletes to 'high'.
          commandDangerousCertainty:
            dangerous.name === 'rm -rf'
              ? rmRfCertainty(command)
              : dangerousPatternCertainty(dangerous.name),
          commandDangerousFragment: dangerousFragment(command, dangerous.name),
        }
      : {}),
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
// Tool-call right-sizing (#1924)
// ---------------------------------------------------------------------------
// Two faces of the same waste: a tool call that pulls FAR more into context than
// the task needed, then gets cache-read on every later turn (the steady-state
// tax that `context.compaction-large-tool-outputs` misses because it never forces
// a compaction). Face 1 — a fat FIRST-call over-fetch (whole-file Read where an
// offset/limit/Grep slice would do). Face 2 — chronically verbose USED tools
// (MCP + Bash) whose return payloads are bloated call after call.
//
// DEDUP (acceptance #1924): Bash commands that re-implement a native tool are
// native-bypass's territory (#951, workflow-rework band) — they are excluded here
// so the same bytes are not double-claimed. The reclaim claim books against the
// `cacheRead` pool under the `structural-prefix` cause, which the cascade runs
// AFTER native-bypass's `input`-pool workflow lever, so overlapping tokens carve
// disjoint slices by construction (see reclaim.ts).

/** Chars-per-token proxy (matches native-bypass / parse-file-reread). */
const RIGHTSIZE_CHARS_PER_TOKEN = 4;
/** A single Read whose result payload is at least this large is an over-fetch candidate. */
export const FAT_READ_BYTES = 25_000;
/** Baseline payload a targeted read (offset/limit/Grep) would have returned instead. */
export const TARGET_READ_BYTES = 4_000;
/** A used tool whose MEAN result payload is at least this large is chronically verbose. */
export const VERBOSE_AVG_BYTES = 10_000;
/** Baseline payload a leaner/paginated call to the same tool would return. */
export const TARGET_TOOL_BYTES = 2_000;
/** Minimum calls before a tool's mean payload is trustworthy as "chronic". */
export const MIN_VERBOSE_CALLS = 3;
/**
 * Cap on the cache-read tail multiplier, so one fat call in a very long session
 * can't claim an absurd tail. The cascade's `residual ≥ 0` guard caps the dollars
 * regardless; this just keeps `evidenceTokens` sane.
 */
const MAX_REMAINING_TURNS = 40;

/** One tool's payload footprint across the corpus (used tools only). */
export interface ToolPayloadRanking {
  toolName: string;
  calls: number;
  totalResultBytes: number;
  /** Mean result payload bytes per call (rounded). */
  avgResultBytes: number;
}

/** Per-session compounded excess, the unit the reclaim claim books. */
export interface ToolRightSizingScope {
  sessionId: string;
  /** Compounded excess cache-read tokens (excess payload tokens × remaining turns). */
  excessCacheReadTokens: number;
  /** Over-fetch + verbose calls counted in this session. */
  affectedCalls: number;
}

export interface ToolPayloadRightSizing {
  /** Per-tool payload ranking across USED tools (excl. native-bypass Bash), desc by mean payload. */
  ranking: ToolPayloadRanking[];
  /** Per-session compounded excess + counts, for the reclaim claim. */
  byScope: ToolRightSizingScope[];
  /** Total over-fetch + verbose calls across all sessions. */
  totalAffected: number;
  /** Total compounded excess cache-read tokens. */
  totalExcessTokens: number;
  /** Verbose used-tool offenders (mean payload ≥ threshold over enough MCP/Bash calls). */
  verboseTools: ToolPayloadRanking[];
  /** Total over-fetch Read calls across all sessions (full count, not capped). */
  overFetchCount: number;
  /** Largest single over-fetch reads, for evidence rows (desc, capped). */
  topOverFetch: { sessionId: string; resultBytes: number }[];
}

/** Whether a call belongs to native-bypass (#951) and so is excluded here. */
function isNativeBypassCall(call: ToolCall): boolean {
  return call.toolName === 'Bash' && bashBypassCategories(call).length > 0;
}

/**
 * Rank used tools by payload-bytes-per-call and dollarize the cache-compounded
 * tail of over-fetch reads + chronically verbose MCP/Bash returns. See the
 * section header for the two faces and the native-bypass dedup. Pure over the
 * distilled `toolData` (reads only `toolName`/`resultBytes`), so it runs on the
 * free/local path per ADR 0005.
 */
export function toolPayloadRightSizing(data: ToolUsageData[]): ToolPayloadRightSizing {
  // Pass 1 — global per-tool payload aggregate (excluding native-bypass Bash).
  const agg = new Map<string, { calls: number; totalResultBytes: number }>();
  for (const session of data) {
    for (const call of session.calls) {
      if (isNativeBypassCall(call)) continue;
      const e = agg.get(call.toolName) ?? { calls: 0, totalResultBytes: 0 };
      e.calls += 1;
      e.totalResultBytes += Math.max(0, call.resultBytes);
      agg.set(call.toolName, e);
    }
  }
  const ranking: ToolPayloadRanking[] = Array.from(agg.entries())
    .map(([toolName, { calls, totalResultBytes }]) => ({
      toolName,
      calls,
      totalResultBytes,
      avgResultBytes: calls === 0 ? 0 : Math.round(totalResultBytes / calls),
    }))
    .filter((r) => r.totalResultBytes > 0)
    .sort((a, b) => b.avgResultBytes - a.avgResultBytes);

  // Face 2 scope: chronically verbose MCP + Bash tools.
  const verboseTools = ranking.filter(
    (r) =>
      r.avgResultBytes >= VERBOSE_AVG_BYTES &&
      r.calls >= MIN_VERBOSE_CALLS &&
      (r.toolName.startsWith('mcp__') || r.toolName === 'Bash')
  );
  const verboseSet = new Set(verboseTools.map((t) => t.toolName));

  // Pass 2 — per-session compounded excess.
  const byScope: ToolRightSizingScope[] = [];
  const topOverFetch: { sessionId: string; resultBytes: number }[] = [];
  let totalAffected = 0;
  let totalExcessTokens = 0;
  let overFetchCount = 0;
  for (const session of data) {
    const n = session.calls.length;
    let excessCacheReadTokens = 0;
    let affectedCalls = 0;
    for (let i = 0; i < n; i++) {
      const call = session.calls[i];
      if (isNativeBypassCall(call)) continue;
      const bytes = Math.max(0, call.resultBytes);
      let excessBytes = 0;
      if (call.toolName === 'Read' && bytes >= FAT_READ_BYTES) {
        // Face 1 — first-call over-fetch (whole-file Read).
        excessBytes = bytes - TARGET_READ_BYTES;
        topOverFetch.push({ sessionId: session.sessionId, resultBytes: bytes });
        overFetchCount += 1;
      } else if (verboseSet.has(call.toolName) && bytes > TARGET_TOOL_BYTES) {
        // Face 2 — chronically verbose used tool (MCP/Bash). Read is handled by
        // Face 1 above, so a call is never counted by both faces.
        excessBytes = bytes - TARGET_TOOL_BYTES;
      }
      if (excessBytes <= 0) continue;
      // Cache-compounded tail: the payload is cache-read on every later turn it
      // sits in context. `remaining turns` is proxied by the calls after this one,
      // so a fat call that is the last in its session books a 0 tail (it was
      // never re-read) while still counting as an over-fetch occurrence.
      const remainingTurns = Math.min(MAX_REMAINING_TURNS, n - 1 - i);
      excessCacheReadTokens +=
        (excessBytes / RIGHTSIZE_CHARS_PER_TOKEN) * remainingTurns;
      affectedCalls += 1;
    }
    if (affectedCalls > 0) {
      byScope.push({
        sessionId: session.sessionId,
        excessCacheReadTokens,
        affectedCalls,
      });
      totalAffected += affectedCalls;
      totalExcessTokens += excessCacheReadTokens;
    }
  }
  topOverFetch.sort((a, b) => b.resultBytes - a.resultBytes);

  return {
    ranking,
    byScope,
    totalAffected,
    totalExcessTokens,
    verboseTools,
    overFetchCount,
    topOverFetch: topOverFetch.slice(0, 5),
  };
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
