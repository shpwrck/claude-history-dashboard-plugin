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

function buildGateSnippet(blockerNames: string[]): string {
  const nameList = blockerNames.join(', ');
  return [
    '# Add to the top of your CI/cron entrypoint, before launching claude:',
    'MCP_AUTH_STATUS=$(claude mcp auth --check 2>/dev/null; echo $?)',
    'if [ "$MCP_AUTH_STATUS" = "1" ]; then',
    `  echo "::error::MCP re-auth required (${nameList}) — run claude mcp auth interactively, then retry"`,
    '  exit 1   # fail fast instead of a silent zero-progress run',
    'fi',
  ].join('\n');
}

function buildReauthCommands(blockerNames: string[]): string {
  return blockerNames.map((n) => `claude mcp auth ${n}`).join('\n');
}

export const detector: Detector = {
  id: 'reliability.mcp-needs-auth',
  category: 'reliability',
  dataDeps: ['attribution', 'sessions'],

  rule(input: RecommendationInput) {
    // Access mcpAuth via the optional extension pattern (keeps RecommendationInput
    // pristine — the ingest layer adds the field without touching types.ts).
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

    const severity = blocking.length > 0 ? 'critical' : 'warning';

    let detail: string;
    if (blocking.length > 0 && advisory.length > 0) {
      detail =
        `${blocking.length} blocking MCP server(s) (${blockerNames.join(', ')}) ` +
        `and ${advisory.length} advisory server(s) (${advisoryNames.join(', ')}) ` +
        `need interactive re-auth. Unattended (CI/cron/sdk) sessions cannot complete ` +
        `an OAuth flow — every tool call to a blocking server will fail silently.`;
    } else if (blocking.length > 0) {
      detail =
        `${blocking.length} load-bearing MCP server(s) (${blockerNames.join(', ')}) ` +
        `need interactive re-auth. Unattended sessions cannot complete an OAuth flow — ` +
        `every tool call to these servers will fail, burning tokens with no progress.`;
    } else {
      detail =
        `${advisory.length} MCP server(s) (${advisoryNames.join(', ')}) ` +
        `need re-auth. These are not currently called by unattended sessions, ` +
        `but interactive runs will fail until re-authenticated.`;
    }

    const action =
      blocking.length > 0
        ? `Run the re-auth commands interactively BEFORE your next automated run, then add the pre-flight GATE to your CI/cron entrypoint to fail fast on future expired tokens.\n\nRe-auth:\n${buildReauthCommands(blockerNames)}`
        : `Run \`claude mcp auth <server>\` interactively for each flagged server: ${advisoryNames.join(', ')}.`;

    const fixSnippet =
      blocking.length > 0
        ? `${buildReauthCommands(allNames)}\n\n${buildGateSnippet(blockerNames)}`
        : buildReauthCommands(allNames);

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
      evidence: [...blockerNames, ...advisoryNames].map((n) => `claude mcp auth ${n}`),
      fix: {
        target: 'command',
        label: blocking.length > 0 ? 'Copy re-auth + gate' : 'Copy re-auth commands',
        note:
          blocking.length > 0
            ? 'Run re-auth interactively, then add the gate to CI/cron before launching claude.'
            : 'Run interactively for each flagged MCP server.',
        snippet: fixSnippet,
      },
    };
  },
};
