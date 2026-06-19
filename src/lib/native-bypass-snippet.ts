/**
 * Turn a native-tool-bypass finding into a copyable CORRECTIVE (#1804, epic
 * #1485). The Native-Tool Bypass surface (Tools view) and the
 * `workflow.native-bypass` detector both list Bash commands that re-implement a
 * first-class tool (`grep`/`find`/`cat`/`sed`/`awk`/leading `cd`). This is the
 * read-side primitive that lets the user ACT on that label instead of just
 * reading it: copy a ready-made CLAUDE.md guidance block that tells the agent to
 * prefer the native tool for exactly the patterns it actually bypassed.
 *
 * Why a CLAUDE.md prose block (not a shell snippet): the corrective for a
 * native-bypass is behavioural guidance, not a command to run, so a prose block
 * is the genuinely useful artifact and — unlike a generated shell wrapper
 * (#1803) — carries no heredoc-delimiter / injection hazard. The detector's
 * existing `fix` already offers the complementary settings.json deny-rule
 * snippet; this adds the softer, copy-into-CLAUDE.md steer.
 *
 * Pure string transformation — no fs, no network, no `@api-client` — so it is
 * safe in both the server and SPA (upload) builds.
 */

/** One bypassed category as carried by the finding / the parse-tools table row. */
export interface NativeBypassCorrectiveRow {
  /** The bypassed Bash pattern family, e.g. `grep`, `cat`, `cd`. */
  category: string;
  /** The native tool (or guidance) to prefer instead, e.g. `Grep`, `Read/Edit`. */
  nativeTool: string;
}

/** Map a bypassed category to a single corrective bullet line. */
function correctiveLine(row: NativeBypassCorrectiveRow): string {
  // `cd` is special: there is no native tool — the cure is using absolute paths
  // because the Bash cwd resets between calls. Phrase it as guidance, not a swap.
  if (row.category === 'cd') {
    return `- Don't lead a Bash command with \`cd\` — the working directory resets between calls; use ${row.nativeTool} instead.`;
  }
  return `- Use the native ${row.nativeTool} tool instead of Bash \`${row.category}\`.`;
}

/**
 * Build a copyable CLAUDE.md guidance block that steers the agent onto native
 * tools for the patterns it actually bypassed. `rows` is the finding's bypassed
 * categories (already sorted by count); an empty list falls back to the full
 * canonical set so the snippet is always actionable.
 */
export function nativeBypassGuidanceSnippet(
  rows: NativeBypassCorrectiveRow[]
): string {
  const FALLBACK: NativeBypassCorrectiveRow[] = [
    { category: 'grep', nativeTool: 'Grep' },
    { category: 'find', nativeTool: 'Glob' },
    { category: 'cat', nativeTool: 'Read' },
  ];
  // De-dupe by category, preserving order, so a finding that lists a category
  // twice never emits a duplicate bullet.
  const seen = new Set<string>();
  const source = (rows.length > 0 ? rows : FALLBACK).filter((r) => {
    if (seen.has(r.category)) return false;
    seen.add(r.category);
    return true;
  });
  return [
    '## Prefer native tools over shell equivalents',
    '',
    'Native tools are faster, cost fewer context tokens, and run through',
    'permission integration. Reach for them first:',
    '',
    ...source.map(correctiveLine),
  ].join('\n');
}

/**
 * Build a copyable single-line corrective for ONE bypassed category — the
 * per-row affordance on the Native-Tool Bypass table. Drops the leading `- `
 * bullet so it reads as a standalone sentence when pasted on its own.
 */
export function nativeBypassRowSnippet(row: NativeBypassCorrectiveRow): string {
  return correctiveLine(row).replace(/^- /, '');
}
