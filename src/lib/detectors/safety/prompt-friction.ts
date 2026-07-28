import type { Detector, RecFix } from '../types';
import { permissionsContain, BASH_SAFE_ALLOW_RULES } from '../shared';
import { rankPromptProneTools } from '../../parse-permissions';

/**
 * Catalog of tools for which this detector is willing to emit a
 * `permissions.allow` snippet, mapped to the SCOPED rules it may propose.
 *
 * The evidence behind this recommendation establishes prompt FREQUENCY only —
 * how often a tool asked for approval. Frequency is not authorization safety:
 * a tool can be prompt-prone precisely because each of its calls deserves a
 * look. The previous implementation allowlisted the bare tool name for every
 * non-Bash tool, which blanket-authorized whatever that tool can do — including
 * arbitrary writes (`Write`, `Edit`, `NotebookEdit`), network egress
 * (`WebFetch`, `WebSearch`), and every capability of an `mcp__*` server
 * (#3223). Only entries listed here are proposed; anything else gets a
 * manual-analysis finding with no snippet.
 *
 * A `Map` (not an object literal) so a tool named `constructor`, `__proto__`,
 * or `toString` — tool names come from parsed transcripts — cannot inherit a
 * bogus "catalogued" entry from `Object.prototype`.
 *
 * An entry earns its place only if the rules it maps to are SCOPED to reviewed
 * operations that are non-destructive, non-network, and confined to the
 * workspace. Today that is `Bash` alone, mapped to the canonical
 * read-only/idempotent command list: the other obviously-safe tools (Read,
 * Grep, Glob, TodoWrite, …) are in `parse-permissions`' `NEVER_PROMPT_TOOLS`,
 * so they never surface as prompt friction in the first place and adding them
 * here would be unreachable decoration. Extend deliberately, per reviewed
 * operation — never by bare tool name.
 */
const SAFE_ALLOW_CATALOG: ReadonlyMap<string, readonly string[]> = new Map<
  string,
  readonly string[]
>([['Bash', BASH_SAFE_ALLOW_RULES]]);

/** The scoped allow rules we are willing to propose for `toolName`, if any. */
export function safeAllowRulesFor(toolName: string): readonly string[] | null {
  return SAFE_ALLOW_CATALOG.get(toolName) ?? null;
}

/** The tool driving the most permission prompts — seed an allowlist. */
export const detector: Detector = {
  id: 'safety.prompt-friction',
  category: 'safety',
  dataDeps: ['toolData', 'permissionRows', 'liveConfig'],
  rule(input) {
    const friction = rankPromptProneTools(input.toolData, input.permissionRows);
    const top = friction[0];
    // Only meaningful when one tool clearly dominates prompt-eligible calls.
    if (!top || top.promptableCalls < 20 || top.share < 25) return null;
    // Skip when the relevant allow rules are already in permissions.allow —
    // catalogued tools check their scoped rules, everything else checks the
    // bare tool name (which is what would have to be present for these calls to
    // stop prompting).
    const catalogued = safeAllowRulesFor(top.toolName);
    const alreadyAllowed = catalogued ?? [top.toolName];
    if (permissionsContain(input.liveConfig?.settings, 'allow', [...alreadyAllowed])) {
      return null;
    }

    // Only a catalogued tool gets a copy-paste allow snippet. For anything else
    // we still surface the friction, but the user decides what is safe to
    // allowlist — we have no evidence that the specific operations behind these
    // prompts are safe to blanket-authorize.
    const action = catalogued
      ? 'Seed a project allowlist for the safe variants of this tool by merging the snippet below into .claude/settings.json. (If installed, the /fewer-permission-prompts skill can generate one from your transcripts.)'
      : `Decide case by case which ${top.toolName} operations are safe before allowlisting anything. This finding measures prompt FREQUENCY, not safety — ${top.toolName} is not on the reviewed safe-to-allowlist list, so no allow snippet is offered. If you do allowlist it, scope the rule to the specific operations you have reviewed rather than the bare tool name.`;

    return {
      id: 'safety.prompt-friction',
      category: 'safety',
      severity: 'info',
      title: 'Reduce permission-prompt friction',
      detail: `${top.toolName} accounts for ${top.share.toFixed(0)}% of prompt-eligible tool calls (${top.promptableCalls} across ${top.sessionCount} sessions).`,
      action,
      affected: top.promptableCalls,
      evidence: friction
        .slice(0, 4)
        .map((f) => `${f.toolName}: ${f.promptableCalls} (${f.share.toFixed(0)}%)`),
      view: 'permissions',
      ...(catalogued
        ? {
            fix: {
              target: 'settings.json',
              label: `Allowlist safe ${top.toolName} calls`,
              // Declared, never inherited. An absent fixKind silently defaults
              // to 'validated' — the exact implicit-classification failure #3221
              // was about. Only a catalogued tool reaches here, so the snippet is
              // a self-contained settings.json fragment of reviewed, scoped rules
              // (no host path, no slash command, no host tool ref): genuinely
              // copy-paste-safe, and now explicitly claimed as such (#3223).
              fixKind: 'validated',
              note: 'Merge into .claude/settings.json — deep-merge the "permissions.allow" array. Allowed calls stop prompting; the rules below are this tool\'s reviewed, scoped safe variants (read-only/idempotent operations only), never the bare tool name.',
              snippet: JSON.stringify(
                { permissions: { allow: [...catalogued] } },
                null,
                2
              ),
            } satisfies RecFix,
          }
        : {}),
    };
  },
};
