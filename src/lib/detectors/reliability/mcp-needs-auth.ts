/**
 * Detector: reliability.mcp-needs-auth (#567)
 *
 * Persona P4 Devi (DevOps, unattended Claude Code via CI/cron/sdk-cli):
 *   "Before an unattended run fires, will it silently no-op because an MCP server
 *   it depends on needs interactive re-auth?"
 *
 * A cron/CI/sdk agent CANNOT complete an OAuth flow. When a load-bearing MCP
 * server (one that unattended sessions actively call) has an expired token, every
 * tool call to it fails — the run burns tokens and silently makes no progress.
 *
 * Strategy: classify each needs-auth server as **blocking** (unattended sessions
 * actively call it, call count > 0 from attribution data) or **advisory** (no
 * unattended call history). HIGH when any blocking server needs auth; WARNING when
 * advisory-only. Emits copy-pasteable claude mcp auth re-auth commands; blocking
 * findings also include a pre-flight GATE snippet.
 *
 * Data sources:
 *  - `mcpAuth`     — parsed ~/.claude/mcp-needs-auth-cache.json (new optional field)
 *  - `attribution` — SessionAttribution[] for per-server unattended call counts
 *  - `sessions`    — Session[] to identify unattended (sdk-*) sessions
 */

import type { Detector, RecommendationInput } from '../types';
import type { McpAuthState } from '../../parse-mcp-auth';
import { classifyAuthServers } from '../../parse-mcp-auth';
import { isUnattendedEntrypoint } from '../../parse-sessions';

/**
 * Build a per-server unattended-call-count map from attribution data, scoped to
 * sessions whose entrypoint is sdk-* (unattended). We use `attribution.mcpServers`
 * which tallies invocations per server per session.
 *
 * When attribution is absent, returns {} — all servers are treated as advisory.
 */
function buildUnattendedCallMap(input: RecommendationInput): Record<string, number> {
  const { attribution, sessions } = input;
  if (!attribution || attribution.length === 0) return {};

  // Build a set of unattended session IDs
  const unattendedIds = new Set<string>(
    (sessions ?? [])
      .filter((s) => isUnattendedEntrypoint(s.entrypoint))
      .map((s) => s.sessionId)
  );
  if (unattendedIds.size === 0) return {};

  // Sum invocations per MCP server across unattended sessions only
  const callMap: Record<string, number> = {};
  for (const attr of attribution) {
    if (!unattendedIds.has(attr.sessionId)) continue;
    for (const [server, count] of Object.entries(attr.mcpServers)) {
      callMap[server] = (callMap[server] ?? 0) + count.invocations;
    }
  }
  return callMap;
}

/**
 * Shell safety of the generated fix (#3212, #3213).
 *
 * Server names are KEYS of `~/.claude/mcp-needs-auth-cache.json` — whatever the
 * on-disk JSON happens to contain, not a validated identifier. They used to be
 * interpolated raw into `claude mcp auth <name>` lines and into a double-quoted
 * `echo`, so a name holding a space, a quote, `;`, `$(...)`, a newline, or a
 * leading `-` silently changed what the user's one-click copy would execute —
 * at best re-authenticating the wrong server, at worst running attacker-chosen
 * shell. Two independent defences, applied in this order:
 *
 *  1. GRAMMAR ({@link isSupportedMcpServerName}) — a name must match the
 *     canonical MCP server-name grammar before it may appear in an executable
 *     line at all. Anything else is reported as inert data and the user is told
 *     to re-authenticate it by hand; no executable snippet is emitted for it.
 *  2. QUOTING ({@link shellQuote}) — every value that does reach a command line
 *     is POSIX shell-quoted, so an accepted name is always exactly one argv
 *     element and the snippet stays inert even if the grammar is later widened.
 *
 * We deliberately do NOT emit a `--` end-of-options marker: `claude mcp auth`
 * is not documented to accept one, and a snippet that only parses on some CLI
 * versions is not copy-paste-safe. The grammar's first-character rule already
 * makes an option-lookalike name unrepresentable.
 */

/**
 * Canonical MCP server-name grammar: an identifier starting with an
 * alphanumeric or `_`, followed by alphanumerics, `_`, `.` or `-`, capped at
 * 128 characters. This is the shape real servers use (`github`,
 * `cloudflare-api`, `Claude_Code_Remote`) and every character in it is inert to
 * a POSIX shell. A leading `-` is excluded so a name can never be read as an
 * option.
 */
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** True when `name` is a server name this detector will put on a command line. */
export function isSupportedMcpServerName(name: unknown): name is string {
  return typeof name === 'string' && MCP_SERVER_NAME_RE.test(name);
}

/**
 * Characters that are literal to every POSIX shell, so a value made only of
 * them needs no quoting. Deliberately excludes `~` (tilde expansion), `{}`
 * (brace expansion), `!` (history), `*?[]` (globbing) and all of `$`, backtick,
 * quotes, whitespace and the metacharacters `;&|<>()#`.
 */
const SHELL_SAFE_LITERAL_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * POSIX shell-quote a value so it survives copy-paste as exactly one argv
 * element. Values made purely of literal characters pass through unquoted (so
 * `claude mcp auth github` stays readable); everything else is single-quoted
 * with embedded single quotes escaped as `'\''`, which is inert in every POSIX
 * shell because single quotes suppress all expansion.
 */
export function shellQuote(value: string): string {
  if (value.length > 0 && !value.startsWith('-') && SHELL_SAFE_LITERAL_RE.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render a server name for human-readable prose/evidence. Supported names print
 * as-is; an unsupported one is JSON-quoted so control characters and newlines
 * are escaped and it reads unmistakably as data rather than as a command.
 */
export function displayServerName(name: string): string {
  return isSupportedMcpServerName(name) ? name : JSON.stringify(name);
}

/** Split names into the ones safe to put on a command line and the rest. */
function partitionNames(names: string[]): { supported: string[]; unsupported: string[] } {
  const supported: string[] = [];
  const unsupported: string[] = [];
  for (const n of names) (isSupportedMcpServerName(n) ? supported : unsupported).push(n);
  return { supported, unsupported };
}

function displayList(names: string[]): string {
  return names.map(displayServerName).join(', ');
}

/**
 * Pre-flight CI/cron gate. `safeBlockerNames` must already have cleared
 * {@link isSupportedMcpServerName}; blockers whose name did NOT clear it are
 * summarised by count only, so no unvalidated data ever reaches the executable
 * snippet. The diagnostic string is single-quoted on top of that, so it stays
 * inert even if a name were to slip through.
 */
function buildGateSnippet(safeBlockerNames: string[], unsupportedBlockerCount: number): string {
  const parts = [...safeBlockerNames];
  if (unsupportedBlockerCount > 0) {
    parts.push(`${unsupportedBlockerCount} server(s) with an unsupported name`);
  }
  const nameList = parts.length > 0 ? parts.join(', ') : 'see dashboard detail';
  const message =
    `::error::MCP re-auth required (${nameList}) — ` +
    `run claude mcp auth interactively, then retry`;
  return [
    '# Add to the top of your CI/cron entrypoint, before launching claude:',
    'MCP_AUTH_STATUS=$(claude mcp auth --check 2>/dev/null; echo $?)',
    'if [ "$MCP_AUTH_STATUS" = "1" ]; then',
    `  echo ${shellQuote(message)}`,
    '  exit 1   # fail fast instead of a silent zero-progress run',
    'fi',
  ].join('\n');
}

/**
 * One `claude mcp auth <server>` line per name. Callers MUST pass only names
 * that already cleared {@link isSupportedMcpServerName}; the quoting here is
 * the second line of defence, not the first.
 */
function buildReauthCommands(serverNames: string[]): string {
  return serverNames.map((n) => `claude mcp auth ${shellQuote(n)}`).join('\n');
}

/** The manual-action sentence shown for names that cannot go on a command line. */
function manualActionNote(unsupported: string[]): string {
  return (
    `${unsupported.length} server name(s) (${displayList(unsupported)}) are not valid MCP ` +
    `server names, so no command is generated for them — re-authenticate those servers by ` +
    `hand from an interactive Claude Code session and fix the name in your MCP config.`
  );
}

export const detector: Detector = {
  id: 'reliability.mcp-needs-auth',
  category: 'reliability',
  dataDeps: ['attribution', 'sessions', 'mcpAuth'],

  rule(input: RecommendationInput) {
    // mcpAuth is a first-class optional field on RecommendationInput.
    const st = (input as RecommendationInput & { mcpAuth?: McpAuthState | null }).mcpAuth;
    if (!st || !st.serversNeedingAuth.length) return null;

    const callMap = buildUnattendedCallMap(input);
    const { blocking, advisory } = classifyAuthServers(st, callMap);

    // Nothing to report
    if (blocking.length === 0 && advisory.length === 0) return null;

    const blockerNames = blocking.map((b) => b.name);
    const advisoryNames = advisory.map((a) => a.name);
    const allNames = [...blockerNames, ...advisoryNames];
    const totalServers = blocking.length + advisory.length;

    // Only names that clear the canonical grammar may reach a command line
    // (#3212/#3213). The rest are still REPORTED — the server genuinely needs
    // re-auth — but only as inert, JSON-quoted data plus a manual instruction.
    const { supported: safeAll, unsupported } = partitionNames(allNames);
    const safeBlockers = blockerNames.filter(isSupportedMcpServerName);

    const severity = blocking.length > 0 ? 'critical' : 'warning';

    let detail: string;
    if (blocking.length > 0 && advisory.length > 0) {
      detail =
        `${blocking.length} blocking MCP server(s) (${displayList(blockerNames)}) ` +
        `and ${advisory.length} advisory server(s) (${displayList(advisoryNames)}) ` +
        `need interactive re-auth. Unattended (CI/cron/sdk) sessions cannot complete ` +
        `an OAuth flow — every tool call to a blocking server will fail silently.`;
    } else if (blocking.length > 0) {
      detail =
        `${blocking.length} load-bearing MCP server(s) (${displayList(blockerNames)}) ` +
        `need interactive re-auth. Unattended sessions cannot complete an OAuth flow — ` +
        `every tool call to these servers will fail, burning tokens with no progress.`;
    } else {
      detail =
        `${advisory.length} MCP server(s) (${displayList(advisoryNames)}) ` +
        `need re-auth. These are not currently called by unattended sessions, ` +
        `but interactive runs will fail until re-authenticated.`;
    }
    if (unsupported.length > 0) detail += ` ${manualActionNote(unsupported)}`;

    let action: string;
    if (safeAll.length === 0) {
      // Nothing can be expressed as a command — say so plainly instead of
      // handing over a line that would not do what it looks like it does.
      action = `No copy-paste command is offered. ${manualActionNote(unsupported)}`;
    } else if (safeBlockers.length > 0) {
      action =
        `Run the re-auth commands interactively BEFORE your next automated run, then add the ` +
        `pre-flight GATE to your CI/cron entrypoint to fail fast on future expired tokens.` +
        `\n\nRe-auth:\n${buildReauthCommands(safeBlockers)}`;
    } else {
      action = `Run \`claude mcp auth <server>\` interactively for each flagged server: ${displayList(safeAll)}.`;
    }
    if (safeAll.length > 0 && unsupported.length > 0) action += `\n\n${manualActionNote(unsupported)}`;

    const fixSnippet =
      blocking.length > 0
        ? `${buildReauthCommands(safeAll)}\n\n${buildGateSnippet(safeBlockers, blockerNames.length - safeBlockers.length)}`
        : buildReauthCommands(safeAll);

    // No safely representable name ⇒ no executable fix at all (#3213).
    const fix =
      safeAll.length === 0
        ? undefined
        : {
            target: 'command' as const,
            label: blocking.length > 0 ? 'Copy re-auth + gate' : 'Copy re-auth commands',
            note:
              (blocking.length > 0
                ? 'Run re-auth interactively, then add the gate to CI/cron before launching claude.'
                : 'Run interactively for each flagged MCP server.') +
              (unsupported.length > 0 ? ` ${manualActionNote(unsupported)}` : ''),
            // Every server argument clears the canonical name grammar AND is
            // POSIX shell-quoted, so each line parses as exactly one inert
            // argument (#3212/#3213).
            fixKind: 'validated' as const,
            snippet: fixSnippet,
          };

    return {
      id: 'reliability.mcp-needs-auth',
      category: 'reliability',
      severity,
      title:
        blocking.length > 0
          ? `${blocking.length} blocking MCP server(s) need re-auth — unattended runs will fail`
          : `${totalServers} MCP server(s) need re-auth`,
      detail,
      action,
      affected: totalServers,
      unattended: blocking.length > 0,
      evidence: allNames.map((n) =>
        isSupportedMcpServerName(n)
          ? `claude mcp auth ${shellQuote(n)}`
          : `unsupported MCP server name — re-authenticate manually: ${displayServerName(n)}`
      ),
      ...(fix ? { fix } : {}),
    };
  },
};
