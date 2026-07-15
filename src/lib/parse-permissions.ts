// From the `./parse-tools-types` leaf, not `./parse-tools` (#1582): `parse-tools`
// imports this module's classifier VALUES, so importing `ToolUsageData` from it
// closed a (type-only, runtime-erased) madge cycle. `DangerousCommandCertainty`
// also moved to that leaf (it is referenced by `ToolCall` there); re-exported here
// so existing `from './parse-permissions'` importers are unaffected.
import type { ToolUsageData, DangerousCommandCertainty } from './parse-tools-types';
export type { DangerousCommandCertainty } from './parse-tools-types';
import { evidenceRefForEntry, type EvidenceRef } from './evidence';
import type { SessionTimeline } from './parse-timeline';
export { parsePermissionData } from './parse-permission-data';
export type { PermissionChange } from './parse-permission-data';
import {
  bashSpec,
  parsePermRule,
  permRuleMatchesCall,
} from './permission-rules';

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
  certainty: DangerousCommandCertainty;
  /** Canonical rules matching the full invocation; null for legacy/invalid truth. */
  matchingRules: string[] | null;
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

const MAX_COMMAND_LEN = 200;

// ── executable-shell skeleton (#2039) ──────────────────────────────────────
// The dangerous-command matchers test for `rm -rf`/`git reset --hard`/`curl|sh`
// etc. as plain substrings of the command. That over-fires on text that merely
// CONTAINS those tokens without executing them: heredoc bodies (`cat > f <<'EOF'
// … rm -rf … EOF`), inline-script source (`node -e "… rm -rf …"`), and quoted
// string literals (a `'Bash(rm -rf:*)'` deny rule, prose being written to a
// file). We strip those regions to an "executable skeleton" before matching, so
// only tokens at real command positions count. Conservative by design — biased
// toward NOT flagging — so it never inflates a CRITICAL with non-deletions.
//
// Known limitation: a shell-exec wrapper DOES execute its quoted body
// (`sh -c 'rm -rf /'`), but quote-stripping hides it. These do not occur in the
// corpus this targets, and the conservative bias prefers a rare miss over the
// rampant false positives; revisit if a real `sh -c`-wrapped deletion appears.

interface HeredocOpener {
  delimiter: string;
  stripLeadingTabs: boolean;
  quoted: boolean;
}

export interface ShellHeredoc {
  commandLine: string;
  delimiter: string;
  quoted: boolean;
  body: string;
}

function isShellWordSeparator(ch: string): boolean {
  return /[\s;&|()<>]/.test(ch);
}

/** Whether a backslash quotes the following character in the active shell
 * quoting context. POSIX single quotes make every enclosed character literal,
 * including backslash itself; double quotes only retain backslash escaping for
 * the shell's small special-character set. */
function shellBackslashEscapes(
  quote: "'" | '"' | '`' | null,
  next: string | undefined
): boolean {
  if (quote === "'") return false;
  if (quote === '"') return next != null && /[$`"\\\n\r]/.test(next);
  if (quote === '`') return next != null && /[$`\\\n\r]/.test(next);
  return next != null;
}

function heredocOpeners(
  line: string,
  initialQuote: "'" | '"' | null = null
): { openers: HeredocOpener[]; quote: "'" | '"' | null } {
  const openers: HeredocOpener[] = [];
  let quote = initialQuote;
  let arithmeticDepth = 0;
  let arithmeticBracketDepth = 0;
  let escaped = false;
  let atWordStart = true;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (quote === "'") {
      atWordStart = false;
      if (ch === "'") quote = null;
      continue;
    }
    if (escaped) {
      if (ch !== '\n' && ch !== '\r') atWordStart = false;
      escaped = false;
      continue;
    }
    if (ch === '\\' && shellBackslashEscapes(quote, line[index + 1])) {
      escaped = true;
      continue;
    }
    if (quote) {
      atWordStart = false;
      if (ch === quote) quote = null;
      continue;
    }
    if (arithmeticDepth > 0) {
      if (ch === '(') arithmeticDepth += 1;
      if (ch === ')') arithmeticDepth -= 1;
      continue;
    }
    if (arithmeticBracketDepth > 0) {
      if (ch === '[') arithmeticBracketDepth += 1;
      if (ch === ']') arithmeticBracketDepth -= 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      atWordStart = false;
      continue;
    }
    if (ch === '$' && line[index + 1] === '[') {
      arithmeticBracketDepth = 1;
      atWordStart = false;
      index += 1;
      continue;
    }
    if (
      (ch === '$' && line[index + 1] === '(' && line[index + 2] === '(') ||
      (ch === '(' && line[index + 1] === '(')
    ) {
      arithmeticDepth = 2;
      atWordStart = false;
      index += ch === '$' ? 2 : 1;
      continue;
    }
    if (ch === '#' && atWordStart) break;
    if (
      ch !== '<' ||
      line[index - 1] === '<' ||
      line[index + 1] !== '<' ||
      line[index + 2] === '<'
    ) {
      atWordStart = isShellWordSeparator(ch);
      continue;
    }

    let cursor = index + 2;
    const stripLeadingTabs = line[cursor] === '-';
    if (stripLeadingTabs) cursor += 1;
    while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
    let delimiterQuote: "'" | '"' | null = null;
    let quoted = false;
    let delimiter = '';
    while (cursor < line.length) {
      const delimiterChar = line[cursor];
      if (delimiterQuote) {
        if (delimiterChar === delimiterQuote) {
          delimiterQuote = null;
        } else {
          delimiter += delimiterChar;
        }
        cursor += 1;
        continue;
      }
      if (isShellWordSeparator(delimiterChar)) break;
      if (
        delimiterChar === '$' &&
        (line[cursor + 1] === "'" || line[cursor + 1] === '"')
      ) {
        quoted = true;
        delimiterQuote = line[cursor + 1] as "'" | '"';
        cursor += 2;
        continue;
      }
      if (delimiterChar === "'" || delimiterChar === '"') {
        quoted = true;
        delimiterQuote = delimiterChar;
        cursor += 1;
        continue;
      }
      if (delimiterChar === '\\' && cursor + 1 < line.length) {
        quoted = true;
        cursor += 1;
        delimiter += line[cursor];
        cursor += 1;
        continue;
      }
      delimiter += delimiterChar;
      cursor += 1;
    }
    if (delimiterQuote || !delimiter) continue;
    openers.push({ delimiter, stripLeadingTabs, quoted });
    atWordStart = false;
    index = cursor - 1;
  }
  return { openers, quote };
}

function scanHeredocs(s: string): { source: string; heredocs: ShellHeredoc[] } {
  const out: string[] = [];
  const heredocs: ShellHeredoc[] = [];
  let logicalCommandLine = '';
  let commandQuote: "'" | '"' | null = null;
  const pending: Array<{
    opener: HeredocOpener;
    commandLine: string;
    body: string[];
  }> = [];
  for (const line of s.split(/\r?\n/)) {
    if (pending.length > 0) {
      const current = pending[0];
      const opener = current.opener;
      const candidate = opener.stripLeadingTabs ? line.replace(/^\t+/, '') : line;
      if (candidate === opener.delimiter) {
        heredocs.push({
          commandLine: current.commandLine,
          delimiter: opener.delimiter,
          quoted: opener.quoted,
          body: current.body.join('\n'),
        });
        pending.shift();
      } else {
        current.body.push(candidate);
      }
      continue;
    }
    out.push(line);
    const continuedLine = logicalCommandLine + line;
    let trailingBackslashes = 0;
    for (
      let index = continuedLine.length - 1;
      index >= 0 && continuedLine[index] === '\\';
      index -= 1
    ) {
      trailingBackslashes += 1;
    }
    if (trailingBackslashes % 2 === 1) {
      logicalCommandLine = continuedLine.slice(0, -1);
      continue;
    }
    logicalCommandLine = '';
    const lineScan = heredocOpeners(continuedLine, commandQuote);
    commandQuote = lineScan.quote;
    pending.push(
      ...lineScan.openers.map((opener) => ({
        opener,
        commandLine: continuedLine,
        body: [],
      }))
    );
  }
  // An unterminated heredoc consumes through EOF; shells warn, but still feed
  // the accumulated body to the command.
  for (const current of pending) {
    heredocs.push({
      commandLine: current.commandLine,
      delimiter: current.opener.delimiter,
      quoted: current.opener.quoted,
      body: current.body.join('\n'),
    });
  }
  return { source: out.join('\n'), heredocs };
}

/** Extract heredocs while retaining whether shell expansion is enabled. */
export function shellHeredocs(s: string): ShellHeredoc[] {
  return scanHeredocs(s).heredocs;
}

/** Remove heredoc bodies using shell's exact physical-line terminator rules. */
function stripHeredocBodies(s: string): string {
  return scanHeredocs(s).source;
}

/** Remove shell comments without erasing quoted `#` arguments. In POSIX shell
 * syntax `#` starts a comment only at the beginning of a word, so hashes inside
 * values such as `color=#fff` remain data. Newlines are retained because they
 * still separate executable commands. */
function stripShellComments(s: string): string {
  let out = '';
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;
  let atWordStart = true;

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote === "'") {
      out += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (escaped) {
      out += ch;
      // An escaped newline is removed later and preserves the lexical word
      // boundary from the prior physical line. Any other escaped character,
      // including whitespace, is part of the current word.
      if (ch !== '\n' && ch !== '\r') atWordStart = false;
      escaped = false;
      continue;
    }
    if (ch === '\\' && shellBackslashEscapes(quote, s[i + 1])) {
      out += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      atWordStart = false;
      continue;
    }
    if (ch === '#' && atWordStart) {
      while (i + 1 < s.length && s[i + 1] !== '\n') i += 1;
      continue;
    }
    out += ch;
    atWordStart = isShellWordSeparator(ch);
  }
  return out;
}

/** Blank single/double-quoted string literals, preserving token boundaries so a
 *  real `rm -rf "$VAR"` still reads as `rm -rf ""` (matched) while a quoted
 *  `"… rm -rf …"` argument to e.g. `node -e` loses its inner tokens. */
function stripQuotedLiterals(s: string): string {
  return s
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** Shell source with non-executable bodies/comments removed but quoting kept. */
export function executableShellSource(command: string): string {
  return stripShellComments(stripHeredocBodies(command)).replace(/\\\r?\n/g, '');
}

/** The command reduced to tokens at real command positions: heredoc bodies and
 *  quoted literals removed (#2039). Matchers run against THIS, not the raw text. */
export function executableShellSkeleton(command: string): string {
  return stripQuotedLiterals(executableShellSource(command));
}

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
    // The `(?![\w-])` rejects the SAFE variants `--force-with-lease` /
    // `--force-if-includes` (they refuse to clobber a moved remote — the
    // recommended way to push a rebased branch) while still matching the bare
    // dangerous `--force` / `-f` (#2042). Keep in sync with parse-tools.ts.
    test: (c) => /\bgit\s+push\s+(-f|--force)(?![\w-])/i.test(c),
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
 * Policy Builder's deny/ask rows (#133). `fork bomb` is intentionally absent:
 * a `:(){ :|:& };:` payload has no command prefix to match. `disk overwrite`
 * is also absent because a redirect such as `echo x > /dev/sda` is not gated
 * by `Bash(dd:*)`. Both produce evidence without a misleading settings rule.
 */
export const DANGEROUS_PATTERN_RULES: Record<string, string[]> = {
  'rm -rf': ['Bash(rm -rf:*)', 'Bash(rm -fr:*)'],
  'git reset --hard': ['Bash(git reset --hard:*)'],
  'git push --force': ['Bash(git push --force:*)', 'Bash(git push -f:*)'],
  'chmod 777': ['Bash(chmod:*)'],
  'dd if=': ['Bash(dd:*)'],
  mkfs: ['Bash(mkfs:*)'],
  'curl pipe shell': ['Bash(curl:*)', 'Bash(wget:*)'],
  'npm publish': ['Bash(npm publish:*)'],
};

function canonicalRulesForPattern(pattern: string): string[] {
  if (!Object.hasOwn(DANGEROUS_PATTERN_RULES, pattern)) return [];
  const rules = DANGEROUS_PATTERN_RULES[pattern];
  return Array.isArray(rules) ? rules : [];
}

/**
 * Canonical dangerous-pattern rules that match the complete raw Bash call.
 * This must run before bulk ingest strips `input.command`; display previews are
 * deliberately not accepted as coverage evidence.
 */
export function matchingDangerousPermissionRules(
  pattern: string,
  command: string
): string[] {
  return canonicalRulesForPattern(pattern).filter(
    (rule) =>
      permRuleMatchesCall(rule, {
        toolName: 'Bash',
        input: { command },
      }) === true
  );
}

function validatedPersistedRuleMatches(
  pattern: string,
  value: unknown
): string[] | null {
  if (!Array.isArray(value)) return null;
  const canonical = canonicalRulesForPattern(pattern);
  if (
    value.some(
      (candidate) =>
        typeof candidate !== 'string' || !canonical.includes(candidate)
    )
  ) {
    return null;
  }
  const typed = value as string[];
  const persisted = new Set(typed);
  if (persisted.size !== typed.length) return null;

  // Persisted truth must describe one possible raw Bash invocation, not merely
  // contain individually canonical members. Alias pairs such as rm -rf/-fr,
  // git push --force/-f, and curl/wget cannot both match one direct-prefix
  // call. Treat such impossible shapes as malformed unknown truth.
  const witnessCommands = typed.flatMap((rule) => {
    const { tool, specifier } = parsePermRule(rule);
    if (tool !== 'Bash' || specifier === null) return [];
    const { literal } = bashSpec(specifier);
    return [literal, `${literal} __chd_permission_probe__`];
  });
  if (
    typed.length > 0 &&
    !witnessCommands.some((command) =>
      typed.every(
        (rule) =>
          permRuleMatchesCall(rule, {
            toolName: 'Bash',
            input: { command },
          }) === true
      )
    )
  ) {
    return null;
  }
  return canonical.filter((rule) => persisted.has(rule));
}

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
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && shellBackslashEscapes(quote, command[i + 1])) {
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
    const isPipeAnd = ch === '|' && next === '&';
    const isPipeline = ch === '|' && command[i - 1] !== '>';
    const isBackgroundSeparator =
      ch === '&' &&
      next !== '&' &&
      command[i - 1] !== '|' &&
      next !== '>' &&
      command[i - 1] !== '>' &&
      command[i - 1] !== '<';
    const isSeparator =
      isDouble ||
      isPipeAnd ||
      isBackgroundSeparator ||
      ch === ';' ||
      ch === '\n' ||
      isPipeline;
    if (!isSeparator) continue;
    const segment = command.slice(start, i).trim();
    if (segment) out.push(segment);
    start = i + (isDouble || isPipeAnd ? 2 : 1);
    if (isDouble || isPipeAnd) i += 1;
  }

  const tail = command.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function tokenizeShellSegment(segment: string): string[] {
  const out: string[] = [];
  let token = '';
  let quote: "'" | '"' | '`' | null = null;
  let quotedPartStart = 0;
  let escaped = false;

  const push = () => {
    if (token.length > 0) out.push(token);
    token = '';
  };

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote === "'") {
      if (ch === "'") {
        const quotedPart = token.slice(quotedPartStart);
        if (/^\d*>>?$/.test(quotedPart)) {
          token =
            token.slice(0, quotedPartStart) +
            quotedPart.replace('>', '\\>');
        }
        quote = null;
      } else token += ch;
      continue;
    }
    if (escaped) {
      // Keep escaped redirect glyphs distinguishable from shell operators.
      // `\>` is an argv character, not a write, including inside an SSH
      // payload that will be parsed a second time by the remote classifier.
      token += ch === '>' ? `\\${ch}` : ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && shellBackslashEscapes(quote, segment[i + 1])) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        const quotedPart = token.slice(quotedPartStart);
        if (/^\d*>>?$/.test(quotedPart)) {
          token =
            token.slice(0, quotedPartStart) +
            quotedPart.replace('>', '\\>');
        }
        quote = null;
      } else token += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      quotedPartStart = token.length;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    if (ch === '(' || ch === ')') {
      push();
      out.push(ch);
      continue;
    }
    // Preserve quote provenance for redirects: an unquoted `>file` is split
    // into an operator + target, while the literal argument `'>file'` remains
    // one token and therefore cannot be mistaken for a write.
    if (ch === '>') {
      const fd = /^\d+$/.test(token) ? token : '';
      if (fd) token = '';
      else push();
      const append = segment[i + 1] === '>';
      out.push(`${fd}${append ? '>>' : '>'}`);
      if (append || segment[i + 1] === '|') i += 1;
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

const SHELL_CONTROL_PREFIXES = new Set([
  'if',
  'then',
  'elif',
  'else',
  'while',
  'until',
  'do',
  '!',
  '{',
  '(',
]);

const SUDO_OPTIONS_WITH_ARGUMENT = new Set([
  '-C', '-c', '-D', '-g', '-h', '-p', '-R', '-r', '-T', '-t', '-U', '-u',
  '--close-from', '--chdir', '--group', '--host', '--prompt', '--chroot',
  '--role', '--command-timeout', '--type', '--other-user', '--user',
]);
const SUDO_INFORMATIONAL_OPTIONS = new Set([
  '--help',
  '-l',
  '--list',
  '-V',
  '--version',
  '-v',
  '--validate',
  '-K',
  '--remove-timestamp',
]);
const SUDO_INFORMATIONAL_SHORT_CLUSTER = /^-[ABbeEHikKlnNPSVsv]*[lvV][ABbeEHikKlnNPSVsv]*$/;
const SUDO_COMBINED_OPTION_WITH_ARGUMENT = /^-[ABbeEHikKlnNPSVsv]*[CcDghpRrTtUu]$/;
const TIME_OPTIONS_WITH_ARGUMENT = new Set(['-f', '-o', '--format', '--output']);
const ENV_OPTIONS_WITH_ARGUMENT = new Set([
  '-C',
  '-S',
  '-u',
  '--chdir',
  '--split-string',
  '--unset',
]);
const TIMEOUT_OPTIONS_WITH_ARGUMENT = new Set([
  '-k',
  '-s',
  '--kill-after',
  '--signal',
]);

function skipWrapperOptions(
  tokens: string[],
  start: number,
  optionsWithArgument: Set<string>
): number {
  let i = start;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    if (tokens[i] === '--') return i + 1;
    const option = tokens[i];
    i += optionsWithArgument.has(option) ? 2 : 1;
  }
  return i;
}

/** Return the wrapped command index, or null when sudo itself is the action. */
function sudoCommandIndex(tokens: string[], start: number): number | null {
  let i = start;
  while (i < tokens.length) {
    const option = tokens[i];
    if (option === '--') return i + 1;
    if (!option.startsWith('-')) return i;
    if (
      SUDO_INFORMATIONAL_OPTIONS.has(option) ||
      SUDO_INFORMATIONAL_SHORT_CLUSTER.test(option)
    ) {
      return null;
    }
    i +=
      SUDO_OPTIONS_WITH_ARGUMENT.has(option) ||
      SUDO_COMBINED_OPTION_WITH_ARGUMENT.test(option)
        ? 2
        : 1;
  }
  return i;
}

/** `command -v/-V` reports resolution; it does not execute the operand. */
function commandExecutableIndex(tokens: string[], start: number): number | null {
  let i = start;
  while (i < tokens.length) {
    const option = tokens[i];
    if (option === '--') return i + 1;
    if (!option.startsWith('-')) return i;
    if (
      option === '--help' ||
      option === '--version' ||
      /^-[^-]*[vV]/.test(option)
    ) {
      return null;
    }
    i += 1;
  }
  return i;
}

function envExecutableTokens(tokens: string[], start: number): string[] {
  let i = start;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const option = tokens[i];
    if (option === '--') return tokens.slice(i + 1);
    if (option === '--help' || option === '--version') return [];
    if (option === '-S' || option === '--split-string') {
      const splitString = tokens[i + 1] ?? '';
      return [
        ...tokenizeShellSegment(splitString),
        ...tokens.slice(i + 2),
      ];
    }
    if (option.startsWith('--split-string=')) {
      return [
        ...tokenizeShellSegment(option.slice('--split-string='.length)),
        ...tokens.slice(i + 1),
      ];
    }
    i += ENV_OPTIONS_WITH_ARGUMENT.has(option) ? 2 : 1;
  }
  return tokens.slice(i);
}

function timeoutCommandIndex(tokens: string[], start: number): number | null {
  let i = start;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const option = tokens[i];
    if (option === '--') {
      i += 1;
      break;
    }
    if (option === '--help' || option === '--version') return null;
    i += TIMEOUT_OPTIONS_WITH_ARGUMENT.has(option) ? 2 : 1;
  }
  return i < tokens.length ? i + 1 : null; // skip the duration operand
}

function executableTokens(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (SHELL_CONTROL_PREFIXES.has(t)) {
      i += 1;
      continue;
    }
    if (/^\d*>>?$/.test(t)) {
      i += 2;
      continue;
    }
    if (isEnvAssignment(t)) {
      i += 1;
      continue;
    }
    if (t === 'sudo') {
      const commandIndex = sudoCommandIndex(tokens, i + 1);
      if (commandIndex == null) {
        i = tokens.length;
        break;
      }
      i = commandIndex;
      continue;
    }
    if (t === 'time') {
      i = skipWrapperOptions(tokens, i + 1, TIME_OPTIONS_WITH_ARGUMENT);
      continue;
    }
    if (t === 'command') {
      const commandIndex = commandExecutableIndex(tokens, i + 1);
      if (commandIndex == null) {
        i = tokens.length;
        break;
      }
      i = commandIndex;
      continue;
    }
    if (t === 'env') {
      return executableTokens(envExecutableTokens(tokens, i + 1));
    }
    if (t === 'timeout') {
      const commandIndex = timeoutCommandIndex(tokens, i + 1);
      if (commandIndex == null) return [];
      i = commandIndex;
      continue;
    }
    if (t === 'nohup') {
      if (tokens[i + 1] === '--help' || tokens[i + 1] === '--version') {
        return [];
      }
      i = skipWrapperOptions(tokens, i + 1, new Set());
      continue;
    }
    break;
  }
  const executable = tokens.slice(i);
  if (executable.length > 0) {
    executable[0] = executable[0].replace(/^[({]+/, '').split('/').pop() ?? '';
  }
  return executable.filter((token, index) => index > 0 || token.length > 0);
}

function commandSegments(command: string): string[][] {
  return splitShellSegments(command)
    .map(tokenizeShellSegment)
    .map(executableTokens)
    .filter((tokens) => tokens.length > 0);
}

/**
 * Executable shell segments with heredoc bodies removed. Quoted arguments stay
 * attached to their real command (so an ssh payload remains inspectable), while
 * prose inside echo/printf/node arguments cannot become a command head.
 */
export function executableShellSegments(command: string): string[][] {
  return commandSegments(executableShellSource(command));
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
        const matchingRules =
          commandText !== null
            ? matchingDangerousPermissionRules(precomputedPattern, commandText)
            : validatedPersistedRuleMatches(
                precomputedPattern,
                call.commandDangerousRuleMatches
              );
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
          matchingRules,
        });
        continue;
      }

      if (commandText === null) continue;
      // Match against the executable skeleton (#2039) so `rm -rf` (and peers)
      // inside heredocs/quoted literals/inline-script bodies don't false-fire.
      const skeleton = executableShellSkeleton(commandText);
      for (const { name, test, certainty } of DANGEROUS_PATTERNS) {
        if (!test(skeleton)) continue;
        out.push({
          sessionId: session.sessionId,
          timestamp: call.timestamp,
          toolUseId: call.toolUseId,
          command: dangerousFragment(commandText, name),
          pattern: name,
          // rm -rf certainty is target-aware (#2011); other patterns are static.
          certainty: name === 'rm -rf' ? rmRfCertainty(commandText) : certainty ?? 'high',
          matchingRules: matchingDangerousPermissionRules(name, commandText),
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
