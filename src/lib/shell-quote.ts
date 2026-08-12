/**
 * The repo's single POSIX shell-quoting primitive (#3379).
 *
 * Several of the v0.6 audit's High findings are one defect wearing different
 * hats: untrusted artifact text — an MCP server name, a task directory entry, a
 * config path, a recorded command — interpolated into a COPYABLE snippet
 * without quoting, so pasting the "fix" ran whatever the artifact author chose
 * (#3212, #3213, #3230, #3231, and the `openablePath` double-quote vector in
 * PR #3372). That class recurred because there was nothing central to reach
 * for: five call sites had each re-typed the escape idiom, and they had already
 * drifted apart. This module is the thing to reach for.
 *
 * Dependency-free and browser-safe on purpose: `config-hygiene-actions.ts` and
 * `repeated-command-snippet.ts` ship in the sample bundle, so this leaf must not
 * import `node:*` (or anything else).
 *
 * ## What quoting does and does not buy you
 *
 * Single quotes suppress ALL expansion in every POSIX shell, so a quoted value
 * is exactly one inert argv element: `;`, `|`, `&`, backticks, `$(…)`, `$VAR`,
 * `*`, `~`, `{}`, `!` and newlines are all literal. The one character single
 * quotes cannot contain is `'` itself, so each is closed, escaped and reopened
 * — the standard `'\''` idiom.
 *
 * Quoting does NOT stop the invoked command from reading a value as an OPTION.
 * `rm '-rf'` and `rm -rf` are the same argv element and behave identically.
 * A caller that must not let an artifact supply an option needs a real defence:
 * a grammar check on the value (see `isSupportedMcpServerName` in
 * `detectors/reliability/mcp-needs-auth.ts`) or a `--` end-of-options marker
 * (see `config-hygiene-actions.ts`). {@link isInertShellWord} declines to pass
 * a leading-`-` value through unquoted so an option-lookalike is at least
 * visible as data in the rendered snippet, but that is legibility, not
 * protection — do not treat it as the option defence.
 */

/**
 * POSIX single-quote `value` so it survives copy-paste as exactly one inert
 * argv element. Always quotes, including values that would not have needed it.
 *
 * This is the primitive: it is the only place in the repo that spells the
 * `'\''` escape, so there is nothing to keep in sync.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Characters that are literal to every POSIX shell, so a word made only of them
 * needs no quoting. Deliberately excludes `~` (tilde expansion), `{}` (brace
 * expansion), `!` (history), `*?[]` (globbing), and all of `$`, backtick,
 * quotes, whitespace and the metacharacters `;&|<>()#`.
 */
const INERT_SHELL_WORD_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * True when `value` can be placed on a command line unquoted and still be
 * exactly one literal argv element.
 *
 * The empty string is not inert (it must be written `''` to exist as an
 * argument at all), and a leading `-` is excluded — see the module note: that
 * exclusion keeps an option-lookalike visible as quoted data, it does not stop
 * the command from parsing it as an option.
 */
export function isInertShellWord(value: string): boolean {
  return value.length > 0 && !value.startsWith('-') && INERT_SHELL_WORD_RE.test(value);
}

/**
 * Shell-quote `value` only when it needs it, so ordinary inputs stay readable
 * in a copyable snippet (`claude mcp auth github`, not
 * `claude mcp auth 'github'`) while anything else is quoted.
 *
 * Composed from {@link isInertShellWord} and {@link shellQuote} rather than
 * re-deriving either, so the "is it safe" test and the escape can never drift
 * apart. Prefer {@link shellQuote} when the snippet is destructive and you want
 * the quoting to be visible regardless.
 */
export function shellQuoteMinimal(value: string): string {
  return isInertShellWord(value) ? value : shellQuote(value);
}

/**
 * Format a filesystem PATH as one shell-safe argv element while preserving
 * home-directory semantics (#3254). {@link isInertShellWord} deliberately
 * treats `~` as non-inert because tilde-expansion changes the word — but for a
 * path in a copyable command that expansion is the point:
 * `~/.claude/settings.json` must keep meaning the user's home after pasting.
 *
 * So: a bare `~`, or a `~/` path whose remainder is provably inert, passes
 * through unquoted (expansion preserved, nothing for a shell to misparse). A
 * hostile `~/` path keeps its home meaning via a double-quoted `"$HOME"`
 * splice concatenated onto the single-quoted remainder — still exactly one
 * word to the shell. Everything else follows {@link shellQuoteMinimal}.
 */
export function shellQuotePathWithHome(path: string): string {
  if (path === '~' || (path.startsWith('~/') && isInertShellWord(path.slice(1)))) {
    return path;
  }
  return path.startsWith('~/')
    ? `"$HOME"${shellQuote(path.slice(1))}`
    : shellQuoteMinimal(path);
}
