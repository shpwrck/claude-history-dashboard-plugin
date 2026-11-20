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
