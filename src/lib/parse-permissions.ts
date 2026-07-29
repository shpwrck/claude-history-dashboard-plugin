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
import { hasUnprovenShellExpansion } from './leave-behind';

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
  localeTranslated: boolean;
  delimiterStart: number;
  delimiterEnd: number;
}

export interface ShellHeredoc {
  commandLine: string;
  /** commandLine with every opener delimiter replaced by its lexical identity. */
  identityCommandLine: string;
  /** Zero-based lexical opener identity within commandLine. Delimiters are not
   * identities: one command may legally use the same delimiter more than once. */
  openerIndex: number;
  delimiter: string;
  quoted: boolean;
  body: string;
}

function isShellWordSeparator(ch: string): boolean {
  return /[\s;&|()<>]/.test(ch);
}

type ShellQuote = "'" | '"' | '`' | 'ansi' | null;

/** Whether a backslash quotes the following character in the active shell
 * quoting context. POSIX single quotes make every enclosed character literal,
 * including backslash itself; double quotes only retain backslash escaping for
 * the shell's small special-character set. */
function shellBackslashEscapes(
  quote: ShellQuote,
  next: string | undefined
): boolean {
  if (quote === "'") return false;
  if (quote === 'ansi') return next != null;
  if (quote === '"') return next != null && /[$`"\\\n\r]/.test(next);
  if (quote === '`') return next != null && /[$`\\\n\r]/.test(next);
  return next != null;
}

function decodeAnsiEscape(
  input: string,
  slashIndex: number
): { value: string; end: number; terminatesWord?: boolean } {
  const escaped = input[slashIndex + 1];
  if (escaped == null) return { value: '\\', end: slashIndex };
  const simple: Record<string, string> = {
    a: '\x07',
    b: '\b',
    e: '\x1b',
    E: '\x1b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '\\': '\\',
    "'": "'",
    '"': '"',
    '?': '?',
  };
  if (escaped in simple) {
    return { value: simple[escaped], end: slashIndex + 1 };
  }
  if (escaped === 'c' && input[slashIndex + 2] != null) {
    const target = input[slashIndex + 2];
    const codePoint = target === '?' ? 0x7f : target.charCodeAt(0) & 0x1f;
    return {
      value: codePoint === 0 ? '' : String.fromCharCode(codePoint),
      end: slashIndex + 2,
      ...(codePoint === 0 ? { terminatesWord: true } : {}),
    };
  }
  const numeric =
    escaped === 'x'
      ? { pattern: /^[0-9a-fA-F]{1,2}/, radix: 16, start: slashIndex + 2 }
      : escaped === 'u'
        ? { pattern: /^[0-9a-fA-F]{1,4}/, radix: 16, start: slashIndex + 2 }
        : escaped === 'U'
          ? { pattern: /^[0-9a-fA-F]{1,8}/, radix: 16, start: slashIndex + 2 }
          : /[0-7]/.test(escaped)
            ? { pattern: /^[0-7]{1,3}/, radix: 8, start: slashIndex + 1 }
            : null;
  if (numeric) {
    const digits = input.slice(numeric.start).match(numeric.pattern)?.[0];
    if (digits) {
      const codePoint = Number.parseInt(digits, numeric.radix);
      if (
        codePoint <= 0x10ffff &&
        !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return {
          value: codePoint === 0 ? '' : String.fromCodePoint(codePoint),
          end: numeric.start + digits.length - 1,
          ...(codePoint === 0 ? { terminatesWord: true } : {}),
        };
      }
    }
  }
  // Bash preserves the slash for an escape it does not recognize.
  return { value: `\\${escaped}`, end: slashIndex + 1 };
}

/** Decode Bash's ANSI-C `$'…'` quoting before the lightweight shell scanners
 * run. Treating it as ordinary single quotes is incorrect in both directions:
 * an escaped quote can expose a literal `;`, while escapes such as `\x20`
 * produce spaces inside a shell payload. Re-quoting the decoded argv fragment
 * with double quotes keeps separators literal and prevents expansion. */
function normalizeDollarQuotedStrings(source: string): string {
  const quoteForShell = (value: string): string =>
    `"${value.replace(/[\\"$`]/g, (character) => `\\${character}`)}"`;

  let out = '';
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      out += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && shellBackslashEscapes(quote, source[index + 1])) {
      out += character;
      escaped = true;
      continue;
    }
    if (quote) {
      out += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '$' && source[index + 1] === "'") {
      let value = '';
      let cursor = index + 2;
      let closed = false;
      let terminated = false;
      for (; cursor < source.length; cursor += 1) {
        if (source[cursor] === "'") {
          closed = true;
          break;
        }
        if (source[cursor] === '\\') {
          const decoded = decodeAnsiEscape(source, cursor);
          if (!terminated) value += decoded.value;
          terminated ||= decoded.terminatesWord === true;
          cursor = decoded.end;
        } else if (!terminated) {
          value += source[cursor];
        }
      }
      if (closed) {
        out += quoteForShell(value);
        index = cursor;
        continue;
      }
    }
    if (character === '$' && source[index + 1] === '"') {
      // Preserve Bash's locale-translation marker. It still opens ordinary
      // double-quote token boundaries, but downstream static-execution proofs
      // must see `$` and fail closed because gettext can replace the argv word.
      out += '$"';
      quote = '"';
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
    }
    out += character;
  }
  return out;
}

function heredocOpeners(
  line: string,
  initialQuote: "'" | '"' | 'ansi' | null = null
): { openers: HeredocOpener[]; quote: "'" | '"' | 'ansi' | null } {
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
    if (quote === 'ansi') {
      atWordStart = false;
      if (ch === '\\') escaped = true;
      else if (ch === "'") quote = null;
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
    if (ch === '$' && line[index + 1] === "'") {
      quote = 'ansi';
      atWordStart = false;
      index += 1;
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
    const delimiterStart = cursor;
    let delimiterQuote: "'" | '"' | null = null;
    let quoted = false;
    let localeTranslated = false;
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
        if (line[cursor + 1] === "'") {
          let ansiCursor = cursor + 2;
          let closed = false;
          let terminated = false;
          while (ansiCursor < line.length) {
            if (line[ansiCursor] === "'") {
              closed = true;
              ansiCursor += 1;
              break;
            }
            if (line[ansiCursor] === '\\') {
              const decoded = decodeAnsiEscape(line, ansiCursor);
              if (!terminated) delimiter += decoded.value;
              terminated ||= decoded.terminatesWord === true;
              ansiCursor = decoded.end + 1;
            } else if (!terminated) {
              delimiter += line[ansiCursor];
              ansiCursor += 1;
            } else {
              ansiCursor += 1;
            }
          }
          if (!closed) delimiterQuote = "'";
          cursor = ansiCursor;
        } else {
          localeTranslated = true;
          delimiterQuote = '"';
          cursor += 2;
        }
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
    // Quote removal may legitimately produce an empty delimiter (`<<''` or
    // an ANSI-C word truncated by NUL). Only a wholly missing unquoted word is
    // invalid; an empty quoted delimiter terminates on the next empty line.
    if (delimiterQuote || (!delimiter && !quoted)) continue;
    openers.push({
      delimiter,
      stripLeadingTabs,
      quoted,
      localeTranslated,
      delimiterStart,
      delimiterEnd: cursor,
    });
    atWordStart = false;
    index = cursor - 1;
  }
  return { openers, quote };
}

const HEREDOC_IDENTITY_PREFIX = '__chd_heredoc_opener_';

/** A shell-safe synthetic delimiter for one lexical heredoc opener. */
export function shellHeredocIdentityDelimiter(openerIndex: number): string {
  return `${HEREDOC_IDENTITY_PREFIX}${openerIndex}__`;
}

function identitySourceFromOpeners(
  commandLine: string,
  openers: readonly HeredocOpener[]
): string {
  const pieces: string[] = [];
  let cursor = 0;
  for (let openerIndex = 0; openerIndex < openers.length; openerIndex += 1) {
    const opener = openers[openerIndex];
    pieces.push(
      commandLine.slice(cursor, opener.delimiterStart),
      shellHeredocIdentityDelimiter(openerIndex)
    );
    cursor = opener.delimiterEnd;
  }
  pieces.push(commandLine.slice(cursor));
  return pieces.join('');
}

/** Replace delimiter words with unique shell-safe identities while preserving
 * every operator, fd prefix, and command boundary. This lets downstream stdin
 * routing compare the exact opener even when two heredocs both use `EOF`. */
export function shellHeredocIdentitySource(commandLine: string): string {
  const { openers } = heredocOpeners(commandLine);
  return identitySourceFromOpeners(commandLine, openers);
}

function scanHeredocs(s: string): {
  source: string;
  heredocs: ShellHeredoc[];
  localeTainted: boolean;
} {
  const out: string[] = [];
  const heredocs: ShellHeredoc[] = [];
  let logicalCommandLine = '';
  let logicalCommandStart = 0;
  let commandQuote: "'" | '"' | 'ansi' | null = null;
  const pending: Array<{
    opener: HeredocOpener;
    openerIndex: number;
    commandLine: string;
    identityCommandLine: string;
    body: string[];
  }> = [];
  let localeTainted = false;
  for (const line of s.split(/\r?\n/)) {
    if (pending.length > 0) {
      const current = pending[0];
      const opener = current.opener;
      const candidate = opener.stripLeadingTabs ? line.replace(/^\t+/, '') : line;
      if (candidate === opener.delimiter) {
        heredocs.push({
          commandLine: current.commandLine,
          identityCommandLine: current.identityCommandLine,
          openerIndex: current.openerIndex,
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
    if (logicalCommandLine === '') logicalCommandStart = out.length;
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
    if (lineScan.openers.some((opener) => opener.localeTranslated)) {
      // Gettext changes the delimiter word before quote removal, so neither
      // the heredoc body boundary nor any following source is statically
      // knowable. Drop the entire logical opener and the remainder rather than
      // manufacturing claims from a guessed `EOF` terminator.
      out.splice(logicalCommandStart);
      localeTainted = true;
      break;
    }
    const identityCommandLine = identitySourceFromOpeners(
      continuedLine,
      lineScan.openers
    );
    pending.push(
      ...lineScan.openers.map((opener, openerIndex) => ({
        opener,
        openerIndex,
        commandLine: continuedLine,
        identityCommandLine,
        body: [],
      }))
    );
  }
  // An unterminated heredoc consumes through EOF; shells warn, but still feed
  // the accumulated body to the command.
  for (const current of pending) {
    heredocs.push({
      commandLine: current.commandLine,
      identityCommandLine: current.identityCommandLine,
      openerIndex: current.openerIndex,
      delimiter: current.opener.delimiter,
      quoted: current.opener.quoted,
      body: current.body.join('\n'),
    });
  }
  return { source: out.join('\n'), heredocs, localeTainted };
}

/** Extract heredocs while retaining whether shell expansion is enabled. */
export function shellHeredocs(s: string): ShellHeredoc[] {
  return scanHeredocs(s).heredocs;
}

/** Remove shell comments without erasing quoted `#` arguments. In POSIX shell
 * syntax `#` starts a comment only at the beginning of a word, so hashes inside
 * values such as `color=#fff` remain data. Newlines are retained because they
 * still separate executable commands. */
function stripShellComments(s: string): string {
  let out = '';
  let quote: ShellQuote = null;
  let escaped = false;
  let atWordStart = true;
  const parenthesisContexts: Array<{
    extglob: boolean;
    wordPart: boolean;
    opaque: boolean;
    kind: 'substitution' | 'extglob' | 'arithmetic' | 'nested' | 'subshell';
  }> = [];
  let opaqueContextDepth = 0;
  const casePhases: Array<'subject' | 'await-in' | 'pattern' | 'body'> = [];
  let shellWord = '';
  let shellWordPresent = false;
  let atCommandStart = true;
  const flushShellWord = () => {
    if (!shellWordPresent || opaqueContextDepth === 0) {
      shellWord = '';
      shellWordPresent = false;
      return;
    }
    const phase = casePhases.at(-1);
    if (
      shellWord === 'case' &&
      atCommandStart &&
      (phase == null || phase === 'body')
    ) {
      casePhases.push('subject');
    } else if (phase === 'subject') {
      casePhases[casePhases.length - 1] = 'await-in';
    } else if (shellWord === 'in' && phase === 'await-in') {
      casePhases[casePhases.length - 1] = 'pattern';
    } else if (
      shellWord === 'esac' &&
      (phase === 'body' || phase === 'pattern')
    ) {
      casePhases.pop();
    }
    if (phase !== 'pattern') atCommandStart = false;
    shellWord = '';
    shellWordPresent = false;
  };
  const noteShellWordCharacter = (character: string) => {
    shellWord += character;
    shellWordPresent = true;
  };
  const consumeQuotedCaseSubject = () => {
    if (casePhases.at(-1) === 'subject') {
      casePhases[casePhases.length - 1] = 'await-in';
      atCommandStart = false;
    }
  };

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
      if (ch !== '\n' && ch !== '\r') noteShellWordCharacter(`\\${ch}`);
      escaped = false;
      continue;
    }
    if (quote === 'ansi') {
      out += ch;
      if (ch === '\\') escaped = true;
      else if (ch === "'") quote = null;
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
    if (ch === '$' && s[i + 1] === "'") {
      flushShellWord();
      consumeQuotedCaseSubject();
      if (opaqueContextDepth > 0) atCommandStart = false;
      quote = 'ansi';
      out += "$'";
      atWordStart = false;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      flushShellWord();
      consumeQuotedCaseSubject();
      if (opaqueContextDepth > 0) atCommandStart = false;
      quote = ch;
      out += ch;
      atWordStart = false;
      continue;
    }
    if (ch === '(') {
      flushShellWord();
      consumeQuotedCaseSubject();
      const inheritedExtglob = parenthesisContexts.at(-1)?.extglob ?? false;
      const inheritedOpaque = opaqueContextDepth > 0;
      const extglobOpener = /[@!?+*]/.test(s[i - 1] ?? '');
      const substitutionOpener = /[$<>]/.test(s[i - 1] ?? '');
      const arithmetic =
        (s[i - 1] === '$' && s[i + 1] === '(') ||
        (s[i - 1] === '(' && s[i - 2] === '$') ||
        (!inheritedOpaque && s[i + 1] === '(');
      const opaque =
        inheritedOpaque || extglobOpener || substitutionOpener || arithmetic;
      parenthesisContexts.push({
        extglob: inheritedExtglob || extglobOpener,
        wordPart: inheritedExtglob || extglobOpener || substitutionOpener,
        opaque,
        kind: substitutionOpener
          ? 'substitution'
          : extglobOpener
            ? 'extglob'
            : arithmetic
              ? 'arithmetic'
              : inheritedOpaque
                ? 'nested'
                : 'subshell',
      });
      if (opaque) opaqueContextDepth += 1;
      if (!inheritedOpaque && opaqueContextDepth > 0) atCommandStart = true;
      out += ch;
      atWordStart = true;
      continue;
    }
    if (ch === ')') {
      flushShellWord();
      const context = parenthesisContexts.at(-1);
      if (
        context?.opaque &&
        context.kind === 'substitution' &&
        casePhases.at(-1) === 'pattern'
      ) {
        casePhases[casePhases.length - 1] = 'body';
        atCommandStart = true;
        out += ch;
        atWordStart = true;
        continue;
      }
      parenthesisContexts.pop();
      if (context?.opaque) opaqueContextDepth -= 1;
      if (opaqueContextDepth === 0) {
        casePhases.length = 0;
        atCommandStart = false;
      }
      out += ch;
      atWordStart = !(context?.wordPart ?? false);
      continue;
    }
    if (
      ch === '#' &&
      atWordStart &&
      !(parenthesisContexts.at(-1)?.extglob ?? false)
    ) {
      while (i + 1 < s.length && s[i + 1] !== '\n') i += 1;
      continue;
    }
    out += ch;
    if (!isShellWordSeparator(ch)) noteShellWordCharacter(ch);
    else flushShellWord();
    if (
      ch === ';' &&
      casePhases.at(-1) === 'body' &&
      (s[i + 1] === ';' || s[i + 1] === '&')
    ) {
      casePhases[casePhases.length - 1] = 'pattern';
      atCommandStart = false;
    } else if (
      opaqueContextDepth > 0 &&
      casePhases.at(-1) !== 'pattern' &&
      (ch === ';' || ch === '&' || ch === '|' || ch === '\n')
    ) {
      atCommandStart = true;
    }
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
  const heredocScan = scanHeredocs(command);
  const withoutComments = stripShellComments(heredocScan.source);
  const localeTainted =
    heredocScan.localeTainted ||
    hasLocaleTranslatedShellWord(withoutComments);
  const executable = normalizeDollarQuotedStrings(withoutComments).replace(
    /\\\r?\n/g,
    ''
  );
  return localeTainted
    ? `$"__chd_locale_tainted_command__"\n${executable}`
    : executable;
}

/** True only for an unescaped Bash gettext word opener at executable syntax. */
export function hasLocaleTranslatedShellWord(source: string): boolean {
  const normalized = source.replace(/\\\r?\n/g, '');
  interface LocaleScanFrame {
    quote: "'" | '"' | null;
    parenthesisDepth: number;
  }
  const frames: LocaleScanFrame[] = [{ quote: null, parenthesisDepth: 0 }];
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    const frame = frames.at(-1)!;
    if (frame.quote === "'") {
      if (character === "'") frame.quote = null;
      continue;
    }
    if (
      character === '\\' &&
      shellBackslashEscapes(frame.quote, normalized[index + 1])
    ) {
      index += 1;
      continue;
    }
    if (
      character === '$' &&
      normalized[index + 1] === '(' &&
      normalized[index + 2] !== '('
    ) {
      frames.push({ quote: null, parenthesisDepth: 1 });
      index += 1;
      continue;
    }
    // `$"..."` inside a nested executable context can carry data into a later
    // segment through assignments, arrays, functions, or substitutions. Static
    // mutation claims do not attempt shell dataflow: any potentially executable
    // marker taints the whole command. Only a proven single-quoted literal is
    // exempt; false negatives are safer than locale-dependent false claims.
    if (frame.quote === '"') {
      if (character === '"') frame.quote = null;
      continue;
    }
    if (character === '$' && normalized[index + 1] === '"') return true;
    if (character === "'") {
      frame.quote = "'";
    } else if (character === '"') {
      frame.quote = '"';
    } else if (frames.length > 1 && character === '(') {
      frame.parenthesisDepth += 1;
    } else if (frames.length > 1 && character === ')') {
      frame.parenthesisDepth -= 1;
      if (frame.parenthesisDepth === 0) frames.pop();
    }
  }
  return false;
}

/** The command reduced to tokens at real command positions: heredoc bodies and
 *  quoted literals removed (#2039). Matchers run against THIS, not the raw text. */
export function executableShellSkeleton(command: string): string {
  const executable = executableShellSource(command);
  return hasLocaleTranslatedShellWord(executable)
    ? ''
    : stripQuotedLiterals(executable);
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

export type ExecutableShellListOperator =
  | ';'
  | '\n'
  | '&'
  | '&&'
  | '||'
  | '|'
  | '|&'
  | ';;'
  | ';&'
  | ';;&';

export interface ExecutableShellListSegment {
  source: string;
  followingOperator?: ExecutableShellListOperator;
}

function splitShellListSegments(command: string): ExecutableShellListSegment[] {
  const out: ExecutableShellListSegment[] = [];
  let start = 0;
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;
  const parenthesisContexts: Array<{
    opaque: boolean;
    kind: 'substitution' | 'extglob' | 'arithmetic' | 'nested' | 'subshell';
  }> = [];
  let opaqueContextDepth = 0;
  const casePhases: Array<'subject' | 'await-in' | 'pattern' | 'body'> = [];
  let shellWord = '';
  let shellWordPresent = false;
  let atCommandStart = true;
  let parameterDepth = 0;

  const flushShellWord = () => {
    if (!shellWordPresent || opaqueContextDepth === 0) {
      shellWord = '';
      shellWordPresent = false;
      return;
    }
    const phase = casePhases.at(-1);
    if (
      shellWord === 'case' &&
      atCommandStart &&
      (phase == null || phase === 'body')
    ) {
      casePhases.push('subject');
    } else if (phase === 'subject') {
      casePhases[casePhases.length - 1] = 'await-in';
    } else if (shellWord === 'in' && phase === 'await-in') {
      casePhases[casePhases.length - 1] = 'pattern';
    } else if (
      shellWord === 'esac' &&
      (phase === 'body' || phase === 'pattern')
    ) {
      casePhases.pop();
    }
    if (phase !== 'pattern') atCommandStart = false;
    shellWord = '';
    shellWordPresent = false;
  };
  const noteShellWordCharacter = (character: string) => {
    shellWord += character;
    shellWordPresent = true;
  };
  const consumeQuotedCaseSubject = () => {
    if (casePhases.at(-1) === 'subject') {
      casePhases[casePhases.length - 1] = 'await-in';
      atCommandStart = false;
    }
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (escaped) {
      noteShellWordCharacter(`\\${ch}`);
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
      flushShellWord();
      consumeQuotedCaseSubject();
      if (opaqueContextDepth > 0) atCommandStart = false;
      quote = ch;
      continue;
    }
    if (ch === '(') {
      flushShellWord();
      consumeQuotedCaseSubject();
      const inheritedOpaque = opaqueContextDepth > 0;
      const previous = command[i - 1] ?? '';
      const extglob = /[@!?+*]/.test(previous);
      const substitution = /[$<>]/.test(previous);
      const arithmetic =
        (previous === '$' && command[i + 1] === '(') ||
        (previous === '(' && command[i - 2] === '$') ||
        (!inheritedOpaque && command[i + 1] === '(');
      const opaque = inheritedOpaque || extglob || substitution || arithmetic;
      parenthesisContexts.push({
        opaque,
        kind: substitution
          ? 'substitution'
          : extglob
            ? 'extglob'
            : arithmetic
              ? 'arithmetic'
              : inheritedOpaque
                ? 'nested'
                : 'subshell',
      });
      if (opaque) opaqueContextDepth += 1;
      if (!inheritedOpaque && opaqueContextDepth > 0) atCommandStart = true;
      continue;
    }
    if (ch === ')' && parenthesisContexts.length > 0) {
      flushShellWord();
      const context = parenthesisContexts.at(-1)!;
      if (
        context.opaque &&
        context.kind === 'substitution' &&
        casePhases.at(-1) === 'pattern'
      ) {
        casePhases[casePhases.length - 1] = 'body';
        atCommandStart = true;
        continue;
      }
      parenthesisContexts.pop();
      if (context.opaque) opaqueContextDepth -= 1;
      if (opaqueContextDepth === 0) {
        casePhases.length = 0;
        atCommandStart = false;
      }
      continue;
    }
    if (ch === ')') return [];
    if (ch === '{' && (parameterDepth > 0 || command[i - 1] === '$')) {
      parameterDepth += 1;
      continue;
    }
    if (ch === '}' && parameterDepth > 0) {
      parameterDepth -= 1;
      continue;
    }
    // Control operators inside command/process/arithmetic substitutions,
    // extglobs, subshells, and parameter expansions belong to the containing
    // word or compound command. Splitting there can detach a locale-dependent
    // `$"..."` word from the outer mutation and manufacture a static claim.
    if (!isShellWordSeparator(ch)) noteShellWordCharacter(ch);
    else flushShellWord();
    if (opaqueContextDepth > 0 || parameterDepth > 0) {
      if (
        ch === ';' &&
        casePhases.at(-1) === 'body' &&
        (command[i + 1] === ';' || command[i + 1] === '&')
      ) {
        casePhases[casePhases.length - 1] = 'pattern';
        atCommandStart = false;
      } else if (
        casePhases.at(-1) !== 'pattern' &&
        (ch === ';' || ch === '&' || ch === '|' || ch === '\n')
      ) {
        atCommandStart = true;
      }
      continue;
    }
    const next = command[i + 1];
    const isDouble = (ch === '&' && next === '&') || (ch === '|' && next === '|');
    const isPipeAnd = ch === '|' && next === '&';
    const isCaseTerminator = ch === ';' && (next === ';' || next === '&');
    const isDoubleCaseTerminator =
      isCaseTerminator && next === ';' && command[i + 2] === '&';
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
      isCaseTerminator ||
      isBackgroundSeparator ||
      ch === ';' ||
      ch === '\n' ||
      isPipeline;
    if (!isSeparator) continue;
    const segment = command.slice(start, i).trim();
    const operatorLength = isDoubleCaseTerminator
      ? 3
      : isDouble || isPipeAnd || isCaseTerminator
        ? 2
        : 1;
    const operator = command.slice(i, i + operatorLength) as ExecutableShellListOperator;
    if (!segment && operator !== '\n') return [];
    if (segment) out.push({ source: segment, followingOperator: operator });
    start = i + operatorLength;
    i += operatorLength - 1;
  }

  if (quote != null || parenthesisContexts.length > 0 || parameterDepth > 0) {
    return [];
  }
  const tail = command.slice(start).trim();
  if (tail) out.push({ source: tail });
  if (
    !tail &&
    ['|', '|&', '&&', '||'].includes(out.at(-1)?.followingOperator ?? '')
  ) {
    return [];
  }
  return out;
}

function splitShellSegments(command: string): string[] {
  return splitShellListSegments(command).map((segment) => segment.source);
}

// NUL cannot occur in an executable shell argv. Use it to retain an
// unforgeable distinction between a redirect glyph made literal by local
// quoting/escaping and a genuine backslash byte. OpenSSH removes the former
// quote boundary when it reconstructs remote source, while the latter must
// remain escaped.
const PROTECTED_SHELL_CHARS = new Set(['<', '>', '|', '&', ';', '(', ')']);
const PROTECTED_EMPTY_SHELL_WORD = '\0';

function protectShellSyntaxChar(char: string): string {
  return PROTECTED_SHELL_CHARS.has(char) ? `\0${char}` : char;
}

export function decodeProtectedShellRedirects(token: string): string {
  if (token === PROTECTED_EMPTY_SHELL_WORD) return '';
  return token.replace(/\0([<>|&;()])/g, '$1');
}

/** Top-level executable shell stages together with the operator that follows
 * each one. Quoted strings and nested substitutions remain inside their owning
 * stage, so callers can reason about ordinary lists without attributing dead
 * boolean/case branches to the outer command. */
export function executableShellListSegments(
  command: string
): ExecutableShellListSegment[] {
  const executable = executableShellSource(command);
  return hasLocaleTranslatedShellWord(executable)
    ? []
    : splitShellListSegments(executable);
}

function tokenizeShellSegment(segment: string): string[] {
  // A real shell command cannot contain NUL. Reject it before introducing the
  // internal provenance marker so transcript bytes cannot forge that marker.
  if (segment.includes('\0')) return [];
  const out: string[] = [];
  let token = '';
  let tokenHasQuotedSyntax = false;
  let quote: "'" | '"' | '`' | null = null;
  let quotedPart = '';
  let escaped = false;
  let unquotedDollarPrefix = false;

  const push = () => {
    if (token.length > 0 || tokenHasQuotedSyntax) {
      out.push(token || PROTECTED_EMPTY_SHELL_WORD);
    }
    token = '';
    tokenHasQuotedSyntax = false;
  };

  const protectQuotedRedirect = () => {
    // Local quote boundaries disappear when OpenSSH concatenates trailing
    // argv into remote shell source. Preserve every shell metacharacter here,
    // not only redirect glyphs, so local syntax validation sees an argv byte
    // while remote reconstruction can deliberately decode and reparse it.
    const protectedPart = quotedPart.replace(
      /[<>|&;()]/g,
      protectShellSyntaxChar
    );
    // Append only the just-closed fragment. Re-slicing and rebuilding the
    // growing word at every quote boundary makes adjacent quoted fragments
    // quadratic on transcript-controlled input.
    token += protectedPart;
    quotedPart = '';
  };

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote === "'") {
      if (ch === "'") {
        protectQuotedRedirect();
        quote = null;
      } else quotedPart += ch;
      continue;
    }
    if (escaped) {
      // Keep escaped redirect glyphs distinguishable from shell operators.
      // OpenSSH removes this local escape when reconstructing remote source;
      // a dedicated marker avoids conflating it with a genuine backslash.
      const escapedChar = protectShellSyntaxChar(ch);
      if (quote) quotedPart += escapedChar;
      else token += escapedChar;
      tokenHasQuotedSyntax = true;
      escaped = false;
      unquotedDollarPrefix = false;
      continue;
    }
    if (ch === '\\' && shellBackslashEscapes(quote, segment[i + 1])) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        protectQuotedRedirect();
        quote = null;
      } else quotedPart += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      // ANSI-C `$'...'` has already been normalized before tokenization, so
      // its prefix is not an argv character. Preserve the `$` on Bash's
      // locale-translated `$"..."` form: its contents depend on runtime locale
      // and therefore cannot prove a static executable command.
      if (unquotedDollarPrefix && ch === "'") token = token.slice(0, -1);
      quote = ch;
      quotedPart = '';
      tokenHasQuotedSyntax = true;
      unquotedDollarPrefix = false;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      unquotedDollarPrefix = false;
      continue;
    }
    if (ch === '(' || ch === ')') {
      push();
      out.push(ch);
      unquotedDollarPrefix = false;
      continue;
    }
    // Preserve quote provenance for redirects: an unquoted `>file` is split
    // into an operator + target, while the literal argument `'>file'` remains
    // one token and therefore cannot be mistaken for a write.
    if (ch === '&' && segment[i + 1] === '>') {
      push();
      const append = segment[i + 2] === '>';
      out.push(append ? '&>>' : '&>');
      i += append ? 2 : 1;
      unquotedDollarPrefix = false;
      continue;
    }
    if (ch === '>') {
      const fd = !tokenHasQuotedSyntax && /^\d+$/.test(token) ? token : '';
      if (fd) token = '';
      else push();
      const following = segment[i + 1];
      const operator =
        following === '>'
          ? '>>'
          : following === '|'
            ? '>|'
            : following === '&'
              ? '>&'
              : '>';
      out.push(`${fd}${operator}`);
      if (operator !== '>') i += 1;
      unquotedDollarPrefix = false;
      continue;
    }
    if (ch === '<') {
      if (segment[i + 1] === '(') {
        // Process substitution is an argv word, not an input redirection.
        token += '<(';
        i += 1;
        unquotedDollarPrefix = false;
        continue;
      }
      const fd = !tokenHasQuotedSyntax && /^\d+$/.test(token) ? token : '';
      if (fd) token = '';
      else push();
      let operator = '<';
      if (segment[i + 1] === '<') {
        operator = segment[i + 2] === '<' ? '<<<' : '<<';
        i += operator.length - 1;
        if (operator === '<<' && segment[i + 1] === '-') {
          operator = '<<-';
          i += 1;
        }
      } else if (segment[i + 1] === '>' || segment[i + 1] === '&') {
        operator += segment[i + 1];
        i += 1;
      }
      out.push(`${fd}${operator}`);
      unquotedDollarPrefix = false;
      continue;
    }
    token += ch;
    unquotedDollarPrefix = ch === '$';
  }
  // Preserve the prior fail-closed token shape for an unclosed quote. Closed
  // fragments take the provenance path above; an unclosed fragment never
  // becomes a proven redirect operator.
  if (quote) token += quotedPart;
  push();
  return out;
}

/** Raw lexical tokens before executable/wrapper normalization. Syntax proof
 * must inspect this surface because normalization intentionally drops
 * redirect-only tokens that are irrelevant to argv but decisive to parsing. */
export function rawExecutableShellTokens(segment: string): string[] {
  return tokenizeShellSegment(segment);
}

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(token);
}

function assignmentTaintsExecutableIdentity(token: string): boolean {
  const name = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(token)?.[1];
  return (
    name != null &&
    (name === 'PATH' ||
      name.startsWith('LD_') ||
      name.startsWith('DYLD_') ||
      ['BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS'].includes(name))
  );
}

function trustedExecutableName(token: string): string | null {
  const command = token.replace(/^[({]+/, '');
  if (!command.includes('/')) return command.includes('\\') ? null : command;
  const trusted =
    /^\/(?:bin|sbin|usr\/(?:bin|sbin|local\/(?:bin|sbin))|opt\/homebrew\/(?:bin|sbin))\/([^/]+)$/.exec(
      command
    );
  return trusted?.[1] ?? null;
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
  '-U',
  '--other-user',
  '-V',
  '--version',
  '-v',
  '--validate',
  '-K',
  '--remove-timestamp',
]);
const SUDO_SHORT_OPTIONS_WITH_ARGUMENT = new Set([
  ...'CcDghpRrTtUu',
]);
const SUDO_SHORT_OPTIONS_WITHOUT_ARGUMENT = new Set([
  ...'ABbeEHikKlnNPSVsv',
]);
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

interface SudoInvocation {
  commandIndex: number | null;
  editMode: boolean;
}

interface SudoShortOption {
  consumesNext: boolean;
  backgroundMode: boolean;
  editMode: boolean;
  queryMode: boolean;
}

/** Parse a sudo short cluster left-to-right. Once an argument-taking flag is
 * reached, the rest of that same token is its attached value, not more flags. */
function parseSudoShortOption(option: string): SudoShortOption | null {
  if (!/^-[^-]/.test(option)) return null;
  let backgroundMode = false;
  let editMode = false;
  let queryMode = false;
  for (let index = 1; index < option.length; index += 1) {
    const flag = option[index];
    if (SUDO_SHORT_OPTIONS_WITH_ARGUMENT.has(flag)) {
      if (flag === 'U') queryMode = true;
      return {
        consumesNext: index === option.length - 1,
        backgroundMode,
        editMode,
        queryMode,
      };
    }
    if (!SUDO_SHORT_OPTIONS_WITHOUT_ARGUMENT.has(flag)) return null;
    if (flag === 'b') backgroundMode = true;
    if (flag === 'e') editMode = true;
    if (flag === 'l' || flag === 'v' || flag === 'V' || flag === 'K') {
      queryMode = true;
    }
  }
  return { consumesNext: false, backgroundMode, editMode, queryMode };
}

/** Locate sudo's command, preserving sudoedit as an operation rather than
 * accidentally treating its file operands as an executable command. */
function sudoInvocation(tokens: string[], start: number): SudoInvocation {
  let i = start;
  let editMode = false;
  while (i < tokens.length) {
    const option = tokens[i];
    if (option === '--') return { commandIndex: i + 1, editMode };
    if (!option.startsWith('-')) return { commandIndex: i, editMode };
    if (option === '--edit') {
      editMode = true;
      i += 1;
      continue;
    }
    if (option === '--background') {
      return { commandIndex: null, editMode: false };
    }
    if (
      option === '-R' ||
      option === '--chroot' ||
      option.startsWith('--chroot=') ||
      /^-[^-]*R/.test(option)
    ) {
      return { commandIndex: null, editMode: false };
    }
    if (
      SUDO_INFORMATIONAL_OPTIONS.has(option) ||
      option.startsWith('--other-user=')
    ) {
      return { commandIndex: null, editMode: false };
    }
    const short = parseSudoShortOption(option);
    if (short) {
      if (short.backgroundMode || short.queryMode) {
        return { commandIndex: null, editMode: false };
      }
      editMode ||= short.editMode;
      i += short.consumesNext ? 2 : 1;
      continue;
    }
    i += SUDO_OPTIONS_WITH_ARGUMENT.has(option) ? 2 : 1;
  }
  return { commandIndex: i, editMode };
}

function execCommandIndex(tokens: string[], start: number): number | null {
  let index = start;
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const option = tokens[index];
    if (option === '--') return index + 1;
    if (option === '--help' || option === '--version') return null;
    index += option === '-a' ? 2 : 1;
  }
  return index < tokens.length ? index : null;
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
    if (option.startsWith('-S') && option.length > 2) {
      return [
        ...tokenizeShellSegment(option.slice(2)),
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
      if (assignmentTaintsExecutableIdentity(t)) return [];
      i += 1;
      continue;
    }
    if (t === 'sudo') {
      const invocation = sudoInvocation(tokens, i + 1);
      if (invocation.commandIndex == null) {
        i = tokens.length;
        break;
      }
      if (invocation.editMode) {
        return ['sudoedit', ...tokens.slice(invocation.commandIndex)];
      }
      i = invocation.commandIndex;
      continue;
    }
    if (t === 'exec') {
      const commandIndex = execCommandIndex(tokens, i + 1);
      if (commandIndex == null) return [];
      // `exec >path` applies redirections to the current shell without a
      // wrapped command. Keep that segment intact so mutation classifiers see
      // the shell-opened path.
      if (/^\d*>>?$/.test(tokens[commandIndex])) return tokens.slice(i);
      i = commandIndex;
      continue;
    }
    if (t === 'time') {
      if (
        tokens[i + 1] === '--help' ||
        tokens[i + 1] === '--version' ||
        tokens[i + 1] === '-V'
      ) {
        return [];
      }
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
    const trustedName = trustedExecutableName(executable[0]);
    if (!trustedName) return [];
    executable[0] = trustedName;
  }
  return executable.filter((token, index) => index > 0 || token.length > 0);
}

/** Keep shell-opened output paths attached after wrapper normalization. Prefix
 * redirects (`>file true`) and query wrappers otherwise disappear while their
 * filesystem effect still occurs before the command is invoked. */
function preserveOutputRedirections(
  executable: string[],
  rawTokens: string[]
): string[] {
  const redirections: string[] = [];
  for (let index = 0; index < rawTokens.length; index += 1) {
    if (!/^(?:\d*(?:>>|>\||>)|>&|&>>?)$/.test(rawTokens[index])) continue;
    const target = rawTokens[index + 1];
    if (target == null) continue;
    redirections.push(rawTokens[index], target);
    index += 1;
  }
  if (redirections.length === 0) return executable;

  const command: string[] = [];
  for (let index = 0; index < executable.length; index += 1) {
    if (/^(?:\d*(?:>>|>\||>)|>&|&>>?)$/.test(executable[index])) {
      index += 1;
      continue;
    }
    command.push(executable[index]);
  }
  return [...(command.length > 0 ? command : [':']), ...redirections];
}

function commandSegments(command: string): string[][] {
  const normalized = command.replace(/\\\r?\n/g, '');
  if (normalized.includes('\0')) return [];
  // A gettext word can flow into later segments through assignments, arrays,
  // functions, or substitutions. Without a full shell/dataflow proof, no
  // mutation claim from this command is auditable.
  if (hasLocaleTranslatedShellWord(normalized)) return [];
  return splitShellSegments(normalized)
    .map(tokenizeShellSegment)
    .map((tokens) => preserveOutputRedirections(executableTokens(tokens), tokens))
    .filter((tokens) => tokens.length > 0);
}

/** Executable shell segments with internal local quote/escape provenance.
 * Callers that reconstruct source (notably OpenSSH's remote command) must keep
 * these markers until they deliberately join and reparse argv. */
export function executableShellSegmentsWithSyntaxProvenance(
  command: string
): string[][] {
  return commandSegments(executableShellSource(command));
}

/**
 * Executable shell segments with heredoc bodies removed. Quoted arguments stay
 * attached to their real command (so an ssh payload remains inspectable), while
 * prose inside echo/printf/node arguments cannot become a command head. The
 * public token surface contains only the argv bytes a caller would observe;
 * source-reconstruction code uses the provenance-preserving variant above.
 */
export function executableShellSegments(command: string): string[][] {
  return executableShellSegmentsWithSyntaxProvenance(command).map((tokens) =>
    tokens.map(decodeProtectedShellRedirects)
  );
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
    !hasDryRunArg(tokens) &&
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

function detectRiskyActionPattern(command: string): RiskyActionPattern | null {
  const executable = executableShellSource(command);
  return RISKY_ACTION_PATTERNS.find((pattern) => pattern.test(executable)) ?? null;
}

export function detectRiskyActionPatternName(command: string): string | null {
  return detectRiskyActionPattern(command)?.name ?? null;
}

function truncateCommand(s: string): string {
  const flat = s.replace(/\r?\n/g, ' ');
  return flat.length > MAX_COMMAND_LEN ? flat.slice(0, MAX_COMMAND_LEN) : flat;
}

interface TimelineEvidenceIndex {
  byToolUseId: Map<string, number>;
  byFallbackKey: Map<string, number>;
}

function evidenceFallbackKey(timestamp: string, toolName: string): string {
  // Length-prefix the first tuple field so concatenation cannot collide.
  return `${timestamp.length}:${timestamp}${toolName}`;
}

function indexTimelineEvidence(timeline: SessionTimeline): TimelineEvidenceIndex {
  const byToolUseId = new Map<string, number>();
  const byFallbackKey = new Map<string, number>();
  for (let index = 0; index < timeline.entries.length; index += 1) {
    const entry = timeline.entries[index];
    if (entry.kind !== 'tool_use') continue;
    if (
      typeof entry.toolUseId === 'string' &&
      !byToolUseId.has(entry.toolUseId)
    ) {
      // `findIndex` returned the earliest duplicate; keep first-write-wins.
      byToolUseId.set(entry.toolUseId, index);
    }
    if (typeof entry.toolName !== 'string') continue;
    const fallbackKey = evidenceFallbackKey(entry.timestamp, entry.toolName);
    if (!byFallbackKey.has(fallbackKey)) {
      // Preserve the fallback `findIndex`'s earliest-match semantics too.
      byFallbackKey.set(fallbackKey, index);
    }
  }
  return { byToolUseId, byFallbackKey };
}

/**
 * Resolve risky-action evidence without rescanning timelines and entries per
 * action. Both indexes are lazy: a corpus with no risky action pays no timeline
 * work, and entries are indexed only for sessions that actually emit one.
 */
function createEvidenceRefResolver(
  timelines: readonly SessionTimeline[] | undefined
): (
  sessionId: string,
  call: { timestamp: string; toolUseId: string; toolName: string }
) => EvidenceRef | undefined {
  let timelinesBySession: Map<string, SessionTimeline> | undefined;
  let indexedTimelineCount = 0;
  const evidenceByTimeline = new WeakMap<SessionTimeline, TimelineEvidenceIndex>();

  return (sessionId, call) => {
    if (!timelines) return undefined;
    if (!timelinesBySession) {
      timelinesBySession = new Map<string, SessionTimeline>();
    }
    let timeline = timelinesBySession.get(sessionId);
    while (!timeline && indexedTimelineCount < timelines.length) {
      const candidate = timelines[indexedTimelineCount];
      indexedTimelineCount += 1;
      if (!timelinesBySession.has(candidate.sessionId)) {
        // The old `Array.find` selected the earliest duplicate session.
        timelinesBySession.set(candidate.sessionId, candidate);
      }
      timeline = timelinesBySession.get(sessionId);
    }
    if (!timeline) return undefined;

    let evidenceIndex = evidenceByTimeline.get(timeline);
    if (!evidenceIndex) {
      evidenceIndex = indexTimelineEvidence(timeline);
      evidenceByTimeline.set(timeline, evidenceIndex);
    }
    const byToolUseId = evidenceIndex.byToolUseId.get(call.toolUseId);
    const entryIndex =
      byToolUseId ??
      evidenceIndex.byFallbackKey.get(
        evidenceFallbackKey(call.timestamp, call.toolName)
    );
    if (entryIndex === undefined) return undefined;
    return evidenceRefForEntry(timeline, entryIndex) ?? undefined;
  };
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

      if (commandText === null || call.commandAnalysisComplete === true) {
        continue;
      }
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
  const evidenceRefForToolCall = createEvidenceRefResolver(timelines);

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

      if (precomputedPattern) {
        out.push({
          sessionId: session.sessionId,
          timestamp: call.timestamp,
          toolUseId: call.toolUseId,
          command: truncateCommand(commandText ?? preview ?? ''),
          pattern: precomputedPattern.name,
          category: precomputedPattern.category,
          severity: precomputedPattern.severity,
          evidenceRef: evidenceRefForToolCall(session.sessionId, call),
        });
        continue;
      }
      if (commandText === null || call.commandAnalysisComplete === true) {
        continue;
      }
      const detectedRawPattern =
        detectRiskyActionPattern(commandText);
      const rawHasDynamicArgv =
        hasUnprovenShellExpansion(executableShellSource(commandText));
      const pattern =
        !rawHasDynamicArgv || detectedRawPattern?.category === 'secret-sensitive'
          ? detectedRawPattern
          : null;
      if (!pattern) continue;

      out.push({
        sessionId: session.sessionId,
        timestamp: call.timestamp,
        toolUseId: call.toolUseId,
        command: truncateCommand(commandText ?? preview ?? ''),
        pattern: pattern.name,
        category: pattern.category,
        severity: pattern.severity,
        evidenceRef: evidenceRefForToolCall(session.sessionId, call),
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
