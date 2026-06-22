import { distillToolInput } from './parse-tools';
import { parseJsonl, parseMessage, type RawSessionEntry } from './parse-utils';

/**
 * Per-session catalog-utilization view: which tools were available to the
 * session vs which the model actually invoked.
 *
 * The "available" set is reconstructed from `attachment.type ===
 * 'deferred_tools_delta'` lines emitted by Claude Code as MCP servers and
 * other lazy-loaded tools come and go during the session. Each delta carries
 * `addedNames`, `removedNames`, and `readdedNames`; we union the adds + readds
 * and subtract any names that ended up removed and never readded.
 *
 * Built-in always-on tools (Bash/Read/Edit/Grep/Glob/Write/Task/Skill/…) are
 * NOT in any manifest line on the wire, so they aren't counted here — they're
 * always available, and rolling them into the denominator would mask the
 * actual signal (loaded MCP/deferred tools the user paid context for but
 * never invoked).
 *
 * Skills, registered via `attachment.type === 'skill_listing'`, are folded in
 * the same way: present in the manifest, presumed available, only counted as
 * "used" when invoked through the `Skill` tool with that `skill` arg.
 */
export interface ToolInventory {
  sessionId: string;
  toolsAvailable: string[];
  toolsUsed: string[];
  unusedTools: string[];
  utilizationPct: number;
}

interface AttachmentEntry extends RawSessionEntry {
  attachment?: {
    type?: string;
    addedNames?: unknown;
    removedNames?: unknown;
    readdedNames?: unknown;
    names?: unknown;
  };
}

function stringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === 'string' && v.length > 0) out.push(v);
  }
  return out;
}

export function parseToolInventory(
  text: string,
  fileName: string
): ToolInventory | null {
  const sessionId = fileName.replace(/\.jsonl$/, '');

  const available = new Set<string>();
  const used = new Set<string>();
  let sawManifest = false;

  for (const entry of parseJsonl(text) as AttachmentEntry[]) {
    if (entry.type === 'attachment') {
      const att = entry.attachment;
      if (!att || typeof att !== 'object') continue;

      if (att.type === 'deferred_tools_delta') {
        sawManifest = true;
        for (const name of stringArray(att.addedNames)) available.add(name);
        for (const name of stringArray(att.readdedNames)) available.add(name);
        for (const name of stringArray(att.removedNames)) available.delete(name);
      } else if (att.type === 'skill_listing') {
        sawManifest = true;
        for (const name of stringArray(att.names)) available.add(`Skill:${name}`);
      }
    } else if (entry.type === 'assistant') {
      const msg = parseMessage(entry.message);
      if (!msg || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block?.type !== 'tool_use') continue;
        used.add(block.name ?? 'unknown');
        if (block.name === 'Skill') {
          const input = distillToolInput(block.input);
          if (input.skill) used.add(`Skill:${input.skill}`);
        }
      }
    }
  }

  if (!sawManifest) return null;

  const toolsAvailable = Array.from(available).sort();
  const usedAndAvailable = new Set<string>();
  for (const name of used) {
    if (available.has(name)) usedAndAvailable.add(name);
  }
  const toolsUsed = Array.from(usedAndAvailable).sort();
  const unusedTools = toolsAvailable.filter((n) => !usedAndAvailable.has(n));
  const utilizationPct =
    toolsAvailable.length === 0
      ? 0
      : (usedAndAvailable.size / toolsAvailable.length) * 100;

  return {
    sessionId,
    toolsAvailable,
    toolsUsed,
    unusedTools,
    utilizationPct,
  };
}

// ---------------------------------------------------------------------------
// Duplicate / redundant MCP servers (#1920)
// ---------------------------------------------------------------------------
// The MCP tool-schema block is part of the fixed per-turn prefix, paid as
// cache-write once + cache-read on every later turn. Two servers exposing the
// same tool set (e.g. `github` + `githubmcp`) re-pay that schema tax for zero
// added capability. We size each server's loaded tool set and flag duplicate
// groups whose tool BASENAMES (the part after `mcp__<server>__`) overlap
// heavily — a safe, high-confidence removal lever distinct from "docs too long".

/** Default overlap thresholds for calling two servers duplicates. */
export const MCP_DUP_OVERLAP_THRESHOLD = 0.7;
export const MCP_DUP_MIN_SHARED_TOOLS = 5;

/** Split an `mcp__<server>__<tool>` manifest entry into server + tool basename. */
export function parseMcpToolName(
  toolName: string
): { server: string; basename: string } | null {
  if (!toolName.startsWith('mcp__')) return null;
  const parts = toolName.split('__');
  // ['mcp', '<server>', ...'<tool parts>'] — server names never contain `__`,
  // but tool basenames can, so re-join the tail.
  if (parts.length < 3) return null;
  const server = parts[1];
  const basename = parts.slice(2).join('__');
  if (!server || !basename) return null;
  return { server, basename };
}

/** Per-MCP-server tool footprint across the analysed sessions. */
export interface McpServerToolStats {
  server: string;
  /** Distinct tool basenames the server exposed (loaded). */
  toolCount: number;
  /** Sessions in which the server was loaded. */
  sessionIds: string[];
}

/** A redundant server in a duplicate group, with its overlap breakdown. */
export interface RedundantMcpServer {
  server: string;
  /** Total distinct tool basenames the redundant server exposes. */
  toolCount: number;
  /** Tools also exposed by `keep` (reclaimed schemas if removed). */
  sharedWithKeep: number;
  /**
   * Tools NOT exposed by `keep` — capability that would be LOST on removal. The
   * threshold allows up to `(1 - overlapThreshold)` of a redundant server's
   * tools to be unique, so this can be > 0; callers MUST disclose it rather than
   * claim removal is loss-free.
   */
  uniqueToKeep: number;
}

/** A set of MCP servers exposing largely-overlapping tool sets. */
export interface DuplicateMcpServerGroup {
  /** The server kept (most tools); a tie breaks lexicographically. */
  keep: string;
  /** Redundant servers whose tool sets are ≥threshold covered by `keep`. */
  redundant: RedundantMcpServer[];
  /** Reclaimable tool schemas = sum of the redundant servers' tool counts. */
  redundantToolCount: number;
}

export interface DuplicateMcpServers {
  /** Per-server tool count + sessions loaded (MCP servers only). */
  servers: McpServerToolStats[];
  /** Total distinct MCP tool schemas loaded across all servers. */
  totalMcpToolCount: number;
  /** Detected duplicate groups (each with ≥1 redundant server). */
  groups: DuplicateMcpServerGroup[];
}

/**
 * Detect duplicate/redundant MCP servers from the per-session tool inventories.
 *
 * Builds each server's loaded tool-basename set, then flags unordered server
 * pairs whose basename sets overlap by ≥`overlapThreshold` of the smaller set
 * (and share ≥`minShared` tools), unioning them into connected groups. Within a
 * group the server with the most tools is `keep`; every other server that is
 * ≥`overlapThreshold` covered by `keep` is `redundant`. Removal reclaims the
 * shared schemas but loses any tools unique to the redundant server (up to
 * `1 - overlapThreshold` of its set) — `RedundantMcpServer.uniqueToKeep` carries
 * that count so callers can disclose it rather than claim a loss-free removal.
 * Pure over the distilled inventories, so it runs on the free/local path per
 * ADR 0005.
 */
export function duplicateMcpServers(
  inventories: ToolInventory[],
  overlapThreshold = MCP_DUP_OVERLAP_THRESHOLD,
  minShared = MCP_DUP_MIN_SHARED_TOOLS
): DuplicateMcpServers {
  const toolsByServer = new Map<string, Set<string>>();
  const sessionsByServer = new Map<string, Set<string>>();
  for (const inv of inventories) {
    for (const name of inv.toolsAvailable) {
      const parsed = parseMcpToolName(name);
      if (!parsed) continue;
      let tools = toolsByServer.get(parsed.server);
      if (!tools) {
        tools = new Set<string>();
        toolsByServer.set(parsed.server, tools);
      }
      tools.add(parsed.basename);
      let sessions = sessionsByServer.get(parsed.server);
      if (!sessions) {
        sessions = new Set<string>();
        sessionsByServer.set(parsed.server, sessions);
      }
      sessions.add(inv.sessionId);
    }
  }

  const servers: McpServerToolStats[] = Array.from(toolsByServer.entries())
    .map(([server, tools]) => ({
      server,
      toolCount: tools.size,
      sessionIds: Array.from(sessionsByServer.get(server) ?? []).sort(),
    }))
    .sort((a, b) => b.toolCount - a.toolCount || a.server.localeCompare(b.server));

  const totalMcpToolCount = servers.reduce((s, r) => s + r.toolCount, 0);

  // Pairwise overlap → adjacency, then connected components.
  const names = servers.map((s) => s.server);
  const sharedBetween = (a: string, b: string): number => {
    const sa = toolsByServer.get(a)!;
    const sb = toolsByServer.get(b)!;
    const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
    let shared = 0;
    for (const t of small) if (large.has(t)) shared += 1;
    return shared;
  };
  const adj = new Map<string, Set<string>>(names.map((n) => [n, new Set<string>()]));
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i];
      const b = names[j];
      const shared = sharedBetween(a, b);
      if (shared < minShared) continue;
      const minSize = Math.min(toolsByServer.get(a)!.size, toolsByServer.get(b)!.size);
      if (minSize === 0) continue;
      if (shared / minSize >= overlapThreshold) {
        adj.get(a)!.add(b);
        adj.get(b)!.add(a);
      }
    }
  }

  const groups: DuplicateMcpServerGroup[] = [];
  const visited = new Set<string>();
  for (const start of names) {
    if (visited.has(start) || adj.get(start)!.size === 0) continue;
    // BFS the connected component.
    const component: string[] = [];
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      component.push(cur);
      for (const nb of adj.get(cur)!) {
        if (!visited.has(nb)) {
          visited.add(nb);
          queue.push(nb);
        }
      }
    }
    if (component.length < 2) continue;
    // Keep the server with the most tools (tie → lexicographic).
    component.sort(
      (a, b) => toolsByServer.get(b)!.size - toolsByServer.get(a)!.size || a.localeCompare(b)
    );
    const keep = component[0];
    const keepTools = toolsByServer.get(keep)!;
    const redundant: RedundantMcpServer[] = [];
    let redundantToolCount = 0;
    for (const other of component.slice(1)) {
      const otherTools = toolsByServer.get(other)!;
      let covered = 0;
      for (const t of otherTools) if (keepTools.has(t)) covered += 1;
      if (otherTools.size > 0 && covered / otherTools.size >= overlapThreshold) {
        redundant.push({
          server: other,
          toolCount: otherTools.size,
          sharedWithKeep: covered,
          uniqueToKeep: otherTools.size - covered,
        });
        redundantToolCount += otherTools.size;
      }
    }
    if (redundant.length === 0) continue;
    redundant.sort((a, b) => a.server.localeCompare(b.server));
    groups.push({ keep, redundant, redundantToolCount });
  }
  groups.sort((a, b) => b.redundantToolCount - a.redundantToolCount);

  return { servers, totalMcpToolCount, groups };
}

export interface AggregateInventory {
  sessionsAnalyzed: number;
  totalAvailableSlots: number;
  totalUsedSlots: number;
  utilizationPct: number;
  /** Tools that were available in ≥1 session, in descending order of how
   *  often they were loaded but never invoked. */
  unusedByFrequency: { toolName: string; loadedIn: number; usedIn: number; neverUsed: number }[];
}

export function aggregateInventory(
  inventories: ToolInventory[]
): AggregateInventory {
  const loadedCounts = new Map<string, number>();
  const usedCounts = new Map<string, number>();
  let totalAvailable = 0;
  let totalUsed = 0;

  for (const inv of inventories) {
    totalAvailable += inv.toolsAvailable.length;
    totalUsed += inv.toolsUsed.length;
    const usedSet = new Set(inv.toolsUsed);
    for (const name of inv.toolsAvailable) {
      loadedCounts.set(name, (loadedCounts.get(name) ?? 0) + 1);
      if (usedSet.has(name)) {
        usedCounts.set(name, (usedCounts.get(name) ?? 0) + 1);
      }
    }
  }

  const unusedByFrequency = Array.from(loadedCounts.entries())
    .map(([toolName, loadedIn]) => {
      const usedIn = usedCounts.get(toolName) ?? 0;
      return {
        toolName,
        loadedIn,
        usedIn,
        neverUsed: loadedIn - usedIn,
      };
    })
    .filter((row) => row.usedIn < row.loadedIn)
    .sort((a, b) => {
      if (b.neverUsed !== a.neverUsed) return b.neverUsed - a.neverUsed;
      return b.loadedIn - a.loadedIn;
    });

  return {
    sessionsAnalyzed: inventories.length,
    totalAvailableSlots: totalAvailable,
    totalUsedSlots: totalUsed,
    utilizationPct:
      totalAvailable === 0 ? 0 : (totalUsed / totalAvailable) * 100,
    unusedByFrequency,
  };
}
