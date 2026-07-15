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
 * (#1803) — carries no heredoc-delimiter / injection hazard. Both the Tools
 * surface and detector reuse this generator so neither invents blanket shell
 * permission rules for a behavioural preference.
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
  /**
   * Proven leading command aliases that produced this category. Omitted/null
   * keeps legacy category-level callers conservative.
   */
  observedCommands?: readonly string[] | null;
}

/** Map a bypassed category to a single corrective bullet line. */
function correctiveLine(row: NativeBypassCorrectiveRow): string {
  // `cd` is special: there is no native tool — the cure is using absolute paths
  // because the Bash cwd resets between calls. Phrase it as guidance, not a swap.
  if (row.category === 'cd') {
    return `- Avoid a standalone Bash \`cd\` command — its working-directory change ends with the call; use ${row.nativeTool}, or chain \`cd <dir> && <cmd>\` to anchor a same-call command.`;
  }
  const observed =
    row.observedCommands && row.observedCommands.length > 0
      ? row.observedCommands
      : [row.category];
  const bashExamples = observed
    .map((command) => `Bash \`${command}\``)
    .join(' or ');
  return `- Use the native ${row.nativeTool} tool instead of ${bashExamples}.`;
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
    '## Prefer native tools and path-safe shell usage',
    '',
    'For avoidable shell patterns, choose native tools or path-safe alternatives before Bash.',
    'Keep file work structured and permission-aware. Apply these examples; category names are generic when an observed alias is unavailable:',
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
