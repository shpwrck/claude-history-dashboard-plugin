/**
 * Parser for `~/.claude/mcp-needs-auth-cache.json` (issue #567, epic #539 P4 Devi).
 *
 * The file is written by Claude Code to record which MCP servers currently need
 * interactive re-auth (expired OAuth tokens, revoked refresh tokens, 401s, etc.).
 * It is transient: `{}` means all servers are clear. When a server needs auth,
 * its key maps to an object with at minimum `{ needsAuth: true, reason: string }`.
 *
 * An unattended (sdk-*, CI/cron) session CANNOT complete an OAuth flow, so any
 * load-bearing server in this state will fail every tool call — burning tokens
 * silently. The mcp-needs-auth detector (#567) surfaces this as a pre-flight gate.
 *
 * Pure + text-in (mirrors other parse-*.ts). Malformed JSON or absent file yields
 * an empty/clear state so the detector emits nothing rather than false-positives.
 */

/** Shape of one entry in mcp-needs-auth-cache.json. */
export interface McpAuthEntry {
  needsAuth: boolean;
  reason?: string;
  lastCheckedAt?: string;
  serverType?: string;
  transport?: string;
}

/** Parsed state of the MCP auth cache. */
export interface McpAuthState {
  /** Names of MCP servers whose `needsAuth` flag is `true`. */
  serversNeedingAuth: string[];
  /** Full entry details for each server needing auth, keyed by server name. */
  entries: Record<string, McpAuthEntry>;
}

/** A server classified as blocking vs advisory, with call-count context. */
export interface ClassifiedServer {
  name: string;
  reason: string;
  calls30d: number;
  /** True when unattended runs actually depend on this server. */
  blocking: boolean;
}

const EMPTY_STATE: McpAuthState = { serversNeedingAuth: [], entries: {} };

/**
 * Parse the raw text of `~/.claude/mcp-needs-auth-cache.json`.
 *
 * Tolerates:
 *  - `{}` (clear / all good) → returns empty state
 *  - Malformed JSON → returns empty state (safe fallback)
 *  - Entries where `needsAuth` is falsy → filtered out
 */
export function parseMcpAuthCache(text: string): McpAuthState {
  if (!text || !text.trim()) return EMPTY_STATE;

  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    return EMPTY_STATE;
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_STATE;

  const map = raw as Record<string, unknown>;
  const serversNeedingAuth: string[] = [];
  const entries: Record<string, McpAuthEntry> = {};

  for (const [name, val] of Object.entries(map)) {
    if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
    const entry = val as Record<string, unknown>;
    if (!entry.needsAuth) continue; // falsy = clear, skip

    const parsed: McpAuthEntry = {
      needsAuth: true,
      reason:
        typeof entry.reason === 'string' ? entry.reason : 'unknown',
      lastCheckedAt:
        typeof entry.lastCheckedAt === 'string' ? entry.lastCheckedAt : undefined,
      serverType:
        typeof entry.serverType === 'string' ? entry.serverType : undefined,
      transport:
        typeof entry.transport === 'string' ? entry.transport : undefined,
    };
    serversNeedingAuth.push(name);
    entries[name] = parsed;
  }

  return { serversNeedingAuth, entries };
}

/**
 * Classify servers needing auth as blocking vs advisory, given a per-server
 * unattended-call-count map derived from transcript tool-call frequency over
 * `isUnattendedEntrypoint` sessions.
 *
 * A server is **blocking** when unattended sessions actively call it (calls30d > 0).
 * It is **advisory** otherwise — still worth fixing but won't immediately
 * break automation.
 *
 * @param state    Parsed auth cache state.
 * @param callMap  Map of server name → call count in the last ~30d of unattended sessions.
 *                 If omitted, all servers are classified as advisory (safe fallback).
 */
export function classifyAuthServers(
  state: McpAuthState,
  callMap: Record<string, number> = {}
): { blocking: ClassifiedServer[]; advisory: ClassifiedServer[] } {
  const blocking: ClassifiedServer[] = [];
  const advisory: ClassifiedServer[] = [];

  for (const name of state.serversNeedingAuth) {
    const entry = state.entries[name];
    const calls30d = callMap[name] ?? 0;
    const isBlocking = calls30d > 0;
    const classified: ClassifiedServer = {
      name,
      reason: entry?.reason ?? 'unknown',
      calls30d,
      blocking: isBlocking,
    };
    if (isBlocking) {
      blocking.push(classified);
    } else {
      advisory.push(classified);
    }
  }

  // Sort blocking by call count descending (highest-volume first)
  blocking.sort((a, b) => b.calls30d - a.calls30d);
  advisory.sort((a, b) => b.calls30d - a.calls30d);

  return { blocking, advisory };
}
