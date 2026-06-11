import type { Detector } from '../types';
import { aggregateInventory } from '../../parse-tool-inventory';
import type { ReclaimClaim } from '../../reclaim';

// MCP tools loaded across many sessions but never invoked — each adds ~50-200
// tokens to the tool manifest on every turn of every session that loads it. (#416)
const MIN_NEVER_USED_SESSIONS = 3;

/** Bare server name from an `mcp__<server>__<tool>` manifest entry. */
function mcpServer(toolName: string): string | null {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(toolName);
  return m ? m[1] : null;
}

/** Flag never-invoked MCP tools loaded in 3+ sessions. (#416) */
export const detector: Detector = {
  id: 'cost.idle-mcp-tools',
  category: 'cost',
  dataDeps: ['toolInventories', 'liveConfig'],
  rule(input) {
    const inv = input.toolInventories;
    if (!inv || inv.length === 0) return null;
    let idle = aggregateInventory(inv).unusedByFrequency.filter(
      (r) => r.toolName.startsWith('mcp__') && r.usedIn === 0 && r.neverUsed >= MIN_NEVER_USED_SESSIONS
    );
    if (idle.length === 0) return null;

    // Stale-input reconciliation (#1102): the idle tools are HISTORICAL. The
    // remediation ("remove the MCP server") only applies to servers still
    // present in the current config — advising removal of a server already gone
    // from ~/.claude.json is a stale, misleading fix. When the bundle is
    // readable, keep only idle tools whose backing server is still configured;
    // if that empties the set, the user has already remediated → suppress.
    // `null` liveConfig means "can't tell" → don't filter (don't hide a real
    // finding on an unreadable config).
    const configReadable = input.liveConfig != null;
    const currentServers = new Set((input.liveConfig?.mcpServers ?? []).map((s) => s.id));
    if (configReadable) {
      idle = idle.filter((r) => {
        const srv = mcpServer(r.toolName);
        return srv != null && currentServers.has(srv);
      });
      if (idle.length === 0) return null;
    }

    const servers = Array.from(
      new Set(idle.map((r) => mcpServer(r.toolName)).filter((s): s is string => Boolean(s)))
    );
    // Flag-only in the closed PR1 cascade: the wasted tokens are tool-manifest
    // re-reads that the dashboard cannot map to a priced `(scope,pool)` cell
    // deterministically (no per-turn manifest-token ledger). Books $0; carries
    // the idle-tool count as evidence for per-category coverage.
    const reclaim: ReclaimClaim = {
      leverId: 'cost.idle-mcp-tools',
      category: 'cost',
      orderKey: 85,
      ownedPools: [],
      scopeKeys: [],
      counterfactual: { kind: 'flag-only' },
      evidenceTokens: 0,
    };
    return {
      id: 'cost.idle-mcp-tools',
      category: 'cost',
      severity: 'info',
      title: 'Remove MCP tools loaded but never invoked',
      detail: `${idle.length} MCP tool(s) were loaded in ${MIN_NEVER_USED_SESSIONS}+ sessions yet invoked zero times; each adds ~50-200 tokens to the tool manifest on every turn of every session that loads it.`,
      action:
        'Disable or remove the MCP server(s) backing the never-used tool(s) from ~/.claude.json (or scope them to the projects that need them).',
      reclaim,
      affected: idle.length,
      evidence: idle.slice(0, 5).map((r) => `${r.toolName} — loaded in ${r.loadedIn}, used 0`),
      provenance: {
        observations: [
          {
            claim: `${idle.length} MCP tool(s) loaded in ${MIN_NEVER_USED_SESSIONS}+ sessions, invoked 0 times`,
            source: 'parse-tool-inventory',
            field: 'aggregateInventory().unusedByFrequency (usedIn === 0)',
            value: idle.length,
          },
          {
            claim: configReadable
              ? `backing server(s) still configured: ${servers.join(', ') || '(none)'}`
              : 'current MCP config could not be read; server list not reconciled',
            source: '~/.claude.json',
            field: 'mcpServers[].id',
          },
        ],
        inference:
          'Each idle tool adds ~50-200 tokens to the tool manifest on every turn of every session that loads it; removing the still-configured backing server(s) recovers that overhead.',
      },
      view: 'tools',
      fix: {
        target: 'command',
        label: 'Disable idle MCP servers',
        note: `Remove or scope these mcpServers in ~/.claude.json (or move them into a per-project .mcp.json). Servers with no invoked tools: ${servers.join(', ') || '(see evidence)'}.`,
        snippet: servers.length
          ? `# In ~/.claude.json, delete the "mcpServers" entries for:\n${servers.map((s) => `#   - ${s}`).join('\n')}`
          : '# In ~/.claude.json, delete the unused "mcpServers" entries (see the tool names above).',
      },
    };
  },
};
