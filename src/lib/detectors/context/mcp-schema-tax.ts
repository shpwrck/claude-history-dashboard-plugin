import type { Detector } from '../types';
import type { SessionTokenData } from '../../../types';
import { MIN_SAVINGS_USD } from '../shared';
import { getModelPricing } from '../../pricing';
import {
  duplicateMcpServers,
  parseMcpToolName,
  MCP_DUP_OVERLAP_THRESHOLD,
  type McpServerToolStats,
} from '../../parse-tool-inventory';

/**
 * `context.mcp-schema-tax` (#1920) — size and dollarize the MCP tool-schema
 * share of the fixed per-turn prefix, and flag duplicate/redundant MCP servers
 * as a safe removal lever.
 *
 * The MCP tool-schema block is paid as cache-write once + cache-read on every
 * later turn of every session that loads it. Two servers exposing the same tool
 * set (the live example: `github` + `githubmcp`, ~80 overlapping tools) re-pay
 * that schema tax for zero added capability. Sibling to `bloated-claude-md`,
 * which covers the prose-doc portion of the prefix only.
 *
 * AUDITABILITY: tool *schemas* are not captured on the wire — only tool names —
 * so the per-tool schema size is a documented PROXY (`TOKENS_PER_TOOL_SCHEMA`,
 * the same ~50–200 token range `cost.idle-mcp-tools` cites). The dollar figure is
 * therefore a `tier-0-estimate`; the duplicate-server detection itself is exact.
 */

/**
 * Proxy for an MCP tool's schema token cost in the per-turn prefix. Schemas
 * aren't captured (names only), so this is an estimate; `cost.idle-mcp-tools`
 * uses the same ~50–200 token range. Mid-range, deliberately conservative.
 */
const TOKENS_PER_TOOL_SCHEMA = 120;

/** Pick the model that carries the most cache-read in a session (cost-representative). */
function dominantModel(d: SessionTokenData): string {
  let best = 'unknown';
  let bestCacheRead = -1;
  for (const e of d.entries) {
    if (e.cacheReadTokens > bestCacheRead) {
      bestCacheRead = e.cacheReadTokens;
      best = e.model || 'unknown';
    }
  }
  return best;
}

export const detector: Detector = {
  id: 'context.mcp-schema-tax',
  category: 'context',
  dataDeps: ['toolInventories', 'liveConfig', 'tokenData'],
  rule(input) {
    const inv = input.toolInventories;
    if (!inv || inv.length === 0) return null;

    const dup = duplicateMcpServers(inv);
    if (dup.groups.length === 0) return null;

    const statsByServer = new Map<string, McpServerToolStats>(
      dup.servers.map((s) => [s.server, s])
    );

    // Stale-input reconciliation (#1102): only advise removing a redundant
    // server that is STILL configured. When the bundle is readable, drop
    // redundant servers already gone from ~/.claude.json; if a group empties, it
    // was already remediated. `null` liveConfig means "can't tell" → don't filter.
    const configReadable = input.liveConfig != null;
    const currentServers = new Set(
      (input.liveConfig?.mcpServers ?? []).map((s) => s.id)
    );
    const redundantServers = new Set<string>();
    const groupRows: string[] = [];
    let totalUniqueToolsLost = 0;
    for (const g of dup.groups) {
      const redundant = configReadable
        ? g.redundant.filter((r) => currentServers.has(r.server))
        : g.redundant;
      if (redundant.length === 0) continue;
      let redundantTools = 0;
      let uniqueTools = 0;
      const names: string[] = [];
      for (const r of redundant) {
        redundantServers.add(r.server);
        redundantTools += r.toolCount;
        uniqueTools += r.uniqueToKeep;
        names.push(r.server);
      }
      totalUniqueToolsLost += uniqueTools;
      const uniqueNote =
        uniqueTools > 0 ? `, ${uniqueTools} unique tool(s) lost on removal — verify first` : '';
      groupRows.push(
        `${names.join(', ')} duplicate(s) of ${g.keep} — ${redundantTools} redundant tool schema(s) (~${(
          (redundantTools * TOKENS_PER_TOOL_SCHEMA) / 1000
        ).toFixed(1)}k tokens/turn${uniqueNote})`
      );
    }
    if (redundantServers.size === 0) return null;

    // Size the schema block (proxy) and dollarize the cache-compounded tail over
    // the sessions where the redundant server(s) were actually loaded.
    const redundantList = [...redundantServers];
    const redundantToolCount = redundantList.reduce(
      (sum, s) => sum + (statsByServer.get(s)?.toolCount ?? 0),
      0
    );
    const redundantSchemaTokens = redundantToolCount * TOKENS_PER_TOOL_SCHEMA;
    const totalMcpSchemaTokens = dup.totalMcpToolCount * TOKENS_PER_TOOL_SCHEMA;

    // No token data means nothing to bill; return before building any per-session
    // index so the constructions below are only ever built on a path that reads
    // them. (An empty-tokenData call already yields estSavingsUsd 0 -> null.)
    if (!input.tokenData || input.tokenData.length === 0) return null;

    // Per-(session, server) distinct MCP tool count from each session's OWN
    // inventory (#3184). A server can expose different tool subsets across
    // sessions, so charging every session the cross-session UNION count
    // (`McpServerToolStats.toolCount`) over-bills sessions that never loaded the
    // full set. Bill each session for the schemas IT actually loaded.
    // perf-index-contract: mcp-per-session-server-tool-count always-consumed: the token-billing loop below reads this map for every token-data session to size estSavingsUsd
    const perSessionServerToolCount = new Map<string, Map<string, number>>();
    for (const i of inv) {
      // perf-index-contract: mcp-inventory-server-tools always-consumed: this per-inventory map is iterated immediately below to fold each server tool count into the session totals
      const byServer = new Map<string, Set<string>>();
      for (const name of i.toolsAvailable) {
        const parsed = parseMcpToolName(name);
        if (!parsed) continue;
        let tools = byServer.get(parsed.server);
        if (!tools) {
          // perf-index-contract: mcp-server-tool-basenames always-consumed: this set dedupes each server basenames and its size is read a few lines below when folding counts
          tools = new Set<string>();
          byServer.set(parsed.server, tools);
        }
        tools.add(parsed.basename);
      }
      // Fold repeated inventories for the same session into one count map.
      // perf-index-contract: mcp-session-counts always-consumed: this per-session count map is populated then stored into perSessionServerToolCount and read by the billing loop
      const existing = perSessionServerToolCount.get(i.sessionId);
      const counts = existing ?? new Map<string, number>();
      for (const [server, tools] of byServer) {
        counts.set(server, Math.max(counts.get(server) ?? 0, tools.size));
      }
      if (!existing) perSessionServerToolCount.set(i.sessionId, counts);
    }

    let estSavingsUsd = 0;
    const affectedSessions = new Set<string>();
    for (const d of input.tokenData ?? []) {
      // Redundant servers loaded in THIS session × the schemas THIS session saw.
      const sessionCounts = perSessionServerToolCount.get(d.sessionId);
      if (!sessionCounts) continue;
      let sessionRedundantTokens = 0;
      for (const s of redundantList) {
        const perSessionToolCount = sessionCounts.get(s) ?? 0;
        if (perSessionToolCount > 0) {
          sessionRedundantTokens += perSessionToolCount * TOKENS_PER_TOOL_SCHEMA;
        }
      }
      if (sessionRedundantTokens <= 0) continue;
      const turns = d.entries.length;
      if (turns <= 0) continue;
      const rates = getModelPricing(dominantModel(d));
      // Cache-write once + cache-read on later turns (never a read on turn 1).
      const usd =
        (sessionRedundantTokens / 1_000_000) *
        (rates.cacheWrite5m + rates.cacheRead * Math.max(0, turns - 1));
      estSavingsUsd += usd;
      affectedSessions.add(d.sessionId);
    }

    if (estSavingsUsd < MIN_SAVINGS_USD) return null;

    const sharePct =
      totalMcpSchemaTokens > 0
        ? Math.round((redundantSchemaTokens / totalMcpSchemaTokens) * 100)
        : 0;

    return {
      id: 'context.mcp-schema-tax',
      category: 'context',
      severity: 'info',
      title: 'Remove duplicate MCP servers from the per-turn prefix',
      detail:
        `${redundantServers.size} redundant MCP server(s) expose tool sets that largely overlap (≥${Math.round(
          MCP_DUP_OVERLAP_THRESHOLD * 100
        )}%) another server, ` +
        `adding ~${redundantToolCount} duplicate tool schemas (~${Math.round(
          redundantSchemaTokens
        ).toLocaleString()} tokens, ${sharePct}% of the ~${Math.round(
          totalMcpSchemaTokens
        ).toLocaleString()}-token MCP schema prefix) that are written once and cache-read on later turns of ${affectedSessions.size} session(s). ` +
        (totalUniqueToolsLost > 0
          ? `Note: ${totalUniqueToolsLost} tool(s) are unique to the redundant server(s) and would be lost on removal — verify before removing. `
          : '') +
        `Schema size is proxied at ~${TOKENS_PER_TOOL_SCHEMA} tokens/tool (schemas aren't captured on the wire).`,
      action:
        'Remove the duplicate MCP server(s) from ~/.claude.json (keep one of each overlapping pair), or scope them to the projects that need them, so the prefix loads each tool schema once. First confirm the redundant server exposes no tool the kept server lacks.',
      estSavingsUsd,
      savingsAttribution: {
        interventionKey: 'context.mcp-schema-tax',
        signatureId: 'mcp-duplicate-servers',
        tier: 'tier-0-estimate',
        predictedSavingsUsd: estSavingsUsd,
        confidence: 'medium',
      },
      affected: redundantServers.size,
      evidence: groupRows.slice(0, 5),
      view: 'tools',
      provenance: {
        observations: [
          {
            claim: `${dup.groups.length} duplicate MCP server group(s); ${redundantServers.size} redundant server(s): ${redundantList.join(', ')}`,
            source: 'parse-tool-inventory',
            field: 'toolInventories[].toolsAvailable (mcp__<server>__<tool>)',
            value: redundantServers.size,
          },
          {
            claim: `${redundantToolCount} redundant tool schemas across ${affectedSessions.size} session(s); MCP schema prefix proxied at ${TOKENS_PER_TOOL_SCHEMA} tokens/tool`,
            source: 'parse-tool-inventory',
            field: 'duplicateMcpServers().groups[].redundantToolCount',
            value: redundantToolCount,
          },
          {
            claim: configReadable
              ? `redundant server(s) still configured in ~/.claude.json: ${redundantList.join(', ')}`
              : 'current MCP config could not be read; redundant server list not reconciled against ~/.claude.json',
            source: '~/.claude.json',
            field: 'mcpServers[].id',
          },
        ],
        inference:
          `Duplicate servers re-pay the same tool-schema block: it is written once (cache-write) and cache-read on later turns; removing all but one of each overlapping group recovers that recurring prefix cost. Each session is billed only for the schema count IT loaded (per-session toolInventories), not the cross-session union. Servers are flagged at ≥${Math.round(
            MCP_DUP_OVERLAP_THRESHOLD * 100
          )}% tool overlap, so a redundant server may still expose a few unique tools (disclosed above) that would be lost on removal. The dollar figure is a token-proxy estimate (tier-0) because tool schemas are not captured on the wire.`,
      },
      fix: {
        target: 'command',
        label: 'Remove duplicate MCP servers',
        note: `In ~/.claude.json, delete the redundant "mcpServers" entries (keep one per overlapping group): ${redundantList.join(', ')}.`,
        fixKind: 'manual',
        snippet: `# In ~/.claude.json, delete these duplicate "mcpServers" entries:\n${redundantList
          .map((s) => `#   - ${s}`)
          .join('\n')}`,
      },
    };
  },
};
