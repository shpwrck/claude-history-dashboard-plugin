// Node-side twin of src/lib/shell-quote.ts (#3379).
//
// The canonical primitive is the TypeScript leaf; read its module comment for
// what quoting does and does not buy you (short version: single quotes make a
// value exactly one inert argv element, but they do NOT stop a command from
// reading it as an option — that needs a grammar check or a `--` marker).
//
// This twin exists because plain `scripts/**/*.mjs` entry points run under bare
// `node`, with no TypeScript loader, so they cannot import the .ts leaf. Two
// implementations would normally be exactly the drift this issue set out to
// remove, so they are pinned together by scripts/shell-quote-parity.test.mjs,
// which runs BOTH over the same hostile corpus plus fuzz and fails CI on the
// first divergent byte. Change one, change the other, or the gate stops you.

/** POSIX single-quote `value` so it survives copy-paste as one inert argv element. */
export function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** See src/lib/shell-quote.ts — excludes `~{}!*?[]$`, backtick, quotes, whitespace, `;&|<>()#`. */
const INERT_SHELL_WORD_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** True when `value` can be placed on a command line unquoted and stay one literal argv element. */
export function isInertShellWord(value) {
  return value.length > 0 && !value.startsWith('-') && INERT_SHELL_WORD_RE.test(value);
}

/** Quote only when needed, so ordinary inputs stay readable. */
export function shellQuoteMinimal(value) {
  return isInertShellWord(value) ? value : shellQuote(value);
}

/** See src/lib/shell-quote.ts — path quoting that preserves `~/` home semantics (#3254). */
export function shellQuotePathWithHome(path) {
  if (path === '~' || (path.startsWith('~/') && isInertShellWord(path.slice(1)))) {
    return path;
  }
  return path.startsWith('~/')
    ? `"$HOME"${shellQuote(path.slice(1))}`
    : shellQuoteMinimal(path);
}
