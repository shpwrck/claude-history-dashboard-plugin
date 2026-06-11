import type { ToolUsageData } from './parse-tools';
import { parseJsonl, parseMessage, type RawSessionEntry } from './parse-utils';

export interface AgentStat {
  subagentType: string;
  invocations: number;
  sessionCount: number;
}

export interface SkillStat {
  skill: string;
  invocations: number;
  sessionCount: number;
}

/**
 * Per-session attribution counts derived from the native `attributionAgent`,
 * `attributionSkill`, `attributionMcpServer`/`attributionMcpTool` fields that
 * Claude Code stamps onto assistant transcript lines.
 *
 * These are first-class and far more reliable than inferring agents/skills
 * from Task/Skill tool-call inputs, so the UI prefers them when present and
 * falls back to the tool-call heuristic otherwise.
 */
export interface SessionAttribution {
  sessionId: string;
  /** invocations + token cost keyed by agent name. */
  agents: Record<string, AttributionCount>;
  /** invocations + token cost keyed by skill name. */
  skills: Record<string, AttributionCount>;
  /**
   * invocations keyed by slash-command name (leading `/` stripped). Unlike the
   * others these are NOT a native `attribution*` field — Claude Code does not
   * stamp command attribution — so they're parsed from the `<command-name>`
   * marker on the user message that invoked the command (#634). outputTokens is
   * always 0 (a user message carries no usage).
   */
  commands: Record<string, AttributionCount>;
  /** invocations + token cost keyed by "server" (server-level rollup). */
  mcpServers: Record<string, AttributionCount>;
  /** invocations + token cost keyed by "server/tool". */
  mcpTools: Record<string, AttributionCount>;
}

export interface AttributionCount {
  invocations: number;
  /** output_tokens attributed to these lines (cost proxy), 0 when unknown. */
  outputTokens: number;
}

/** Aggregated attribution row surfaced to the UI. */
export interface AttributionStat {
  name: string;
  invocations: number;
  outputTokens: number;
  sessionCount: number;
}

/** Aggregated MCP server row, with its top tools. */
export interface McpServerStat {
  server: string;
  invocations: number;
  outputTokens: number;
  sessionCount: number;
  tools: AttributionStat[];
}

export interface AgentSettingEvent {
  sessionId: string;
  timestamp: string;
  name: string;
  value: string;
}

const MAX_VALUE_LEN = 200;
/**
 * Synthetic bucket for Task/Skill invocations missing `subagent_type` / `skill`.
 * Exported so UI components can map this sentinel to a friendly display label.
 */
export const UNSPECIFIED_BUCKET = '_unspecified';

// Adds agent-setting-specific fields on top of the shared wire shape.
type AgentSessionEntry = RawSessionEntry & {
  name?: unknown;
  value?: unknown;
  setting?: unknown;
  settingName?: unknown;
  settingValue?: unknown;
  agentSetting?: unknown;
};

// Adds the native attribution fields on top of the shared wire shape.
type AttributionSessionEntry = RawSessionEntry & {
  attributionAgent?: unknown;
  attributionSkill?: unknown;
  attributionMcpServer?: unknown;
  attributionMcpTool?: unknown;
};

function bump(
  rec: Record<string, AttributionCount>,
  key: string,
  outputTokens: number
): void {
  const e = rec[key] ?? { invocations: 0, outputTokens: 0 };
  e.invocations += 1;
  e.outputTokens += outputTokens;
  rec[key] = e;
}

// A slash-command invocation is a user message whose content carries
// `<command-name>/foo</command-name>` (the CLI injects it). Capture the name
// without the leading slash. Built-in commands (e.g. /exit) are captured too but
// only ever matched against installed `lc.commands` ids downstream, so they're
// harmless. See issue #634.
const COMMAND_NAME_RE = /<command-name>\s*\/?\s*([^<\s]+)\s*<\/command-name>/;

function commandNameOf(entry: AttributionSessionEntry): string | null {
  if (entry.type !== 'user') return null;
  const msg = parseMessage(entry.message) as { content?: unknown } | null;
  const content = msg?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((c) =>
              c && typeof c === 'object' && 'text' in c
                ? String((c as { text?: unknown }).text ?? '')
                : ''
            )
            .join('\n')
        : '';
  const m = text.match(COMMAND_NAME_RE);
  return m ? m[1] : null;
}

function outputTokensOf(entry: AttributionSessionEntry): number {
  const msg = parseMessage(entry.message) as
    | { usage?: { output_tokens?: unknown } }
    | null;
  const raw = msg?.usage?.output_tokens;
  return typeof raw === 'number' && isFinite(raw) ? raw : 0;
}

/**
 * Parse the native attribution fields from a session's transcript lines.
 *
 * Each assistant line may carry `attributionAgent`, `attributionSkill`, and/or
 * `attributionMcpServer` + `attributionMcpTool`. We tally invocations and the
 * line's `output_tokens` (a cheap, always-present cost proxy) per agent, skill,
 * MCP server, and "server/tool". Returns `null` when the session has no native
 * attribution at all, so callers can fall back to the tool-call heuristic.
 */
export function parseAttribution(
  text: string,
  fileName: string
): SessionAttribution | null {
  const sessionId = fileName.replace(/\.jsonl$/, '');

  const out: SessionAttribution = {
    sessionId,
    agents: {},
    skills: {},
    commands: {},
    mcpServers: {},
    mcpTools: {},
  };
  let any = false;

  for (const entry of parseJsonl(text) as AttributionSessionEntry[]) {
    const agent =
      typeof entry.attributionAgent === 'string' && entry.attributionAgent
        ? entry.attributionAgent
        : null;
    const skill =
      typeof entry.attributionSkill === 'string' && entry.attributionSkill
        ? entry.attributionSkill
        : null;
    const server =
      typeof entry.attributionMcpServer === 'string' &&
      entry.attributionMcpServer
        ? entry.attributionMcpServer
        : null;
    const tool =
      typeof entry.attributionMcpTool === 'string' && entry.attributionMcpTool
        ? entry.attributionMcpTool
        : null;

    const command = commandNameOf(entry);

    if (!agent && !skill && !server && !tool && !command) continue;

    const ot = outputTokensOf(entry);
    if (agent) bump(out.agents, agent, ot);
    if (skill) bump(out.skills, skill, ot);
    if (command) {
      bump(out.commands, command, 0); // user message — no output tokens
      any = true;
    }
    if (server) {
      bump(out.mcpServers, server, ot);
      bump(out.mcpTools, `${server}/${tool ?? 'unknown'}`, ot);
      any = true;
    }
    if (agent || skill) any = true;
  }

  return any ? out : null;
}

// Fold a list of per-session attribution records into ranked stats for one
// dimension (agents / skills / mcpServers / mcpTools).
function foldAttribution(
  data: SessionAttribution[],
  pick: (s: SessionAttribution) => Record<string, AttributionCount>
): AttributionStat[] {
  const map = new Map<
    string,
    { invocations: number; outputTokens: number; sessions: Set<string> }
  >();
  for (const s of data) {
    for (const [name, c] of Object.entries(pick(s))) {
      const e =
        map.get(name) ??
        { invocations: 0, outputTokens: 0, sessions: new Set<string>() };
      e.invocations += c.invocations;
      e.outputTokens += c.outputTokens;
      e.sessions.add(s.sessionId);
      map.set(name, e);
    }
  }
  return Array.from(map.entries())
    .map(([name, { invocations, outputTokens, sessions }]) => ({
      name,
      invocations,
      outputTokens,
      sessionCount: sessions.size,
    }))
    .sort((a, b) => b.invocations - a.invocations);
}

/** Ranked native-attribution agents across all sessions. */
export function aggregateAttributionAgents(
  data: SessionAttribution[]
): AttributionStat[] {
  return foldAttribution(data, (s) => s.agents);
}

/** Ranked native-attribution skills across all sessions. */
export function aggregateAttributionSkills(
  data: SessionAttribution[]
): AttributionStat[] {
  return foldAttribution(data, (s) => s.skills);
}

/**
 * Ranked MCP servers (with nested top tools) across all sessions, derived from
 * the native `attributionMcpServer`/`attributionMcpTool` fields.
 */
export function aggregateMcpUsage(
  data: SessionAttribution[]
): McpServerStat[] {
  const servers = foldAttribution(data, (s) => s.mcpServers);
  const tools = foldAttribution(data, (s) => s.mcpTools);
  return servers.map((srv) => ({
    server: srv.name,
    invocations: srv.invocations,
    outputTokens: srv.outputTokens,
    sessionCount: srv.sessionCount,
    tools: tools
      .filter((t) => t.name.startsWith(`${srv.name}/`))
      .map((t) => ({ ...t, name: t.name.slice(srv.name.length + 1) })),
  }));
}

function flattenValue(v: unknown): string {
  let s: string;
  if (typeof v === 'string') {
    s = v;
  } else if (v === undefined) {
    s = '';
  } else {
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
  }
  if (s == null) s = '';
  const flat = s.replace(/\r?\n/g, ' ');
  return flat.length > MAX_VALUE_LEN ? flat.slice(0, MAX_VALUE_LEN) : flat;
}

/**
 * Both 'Task' (historical name) and 'Agent' (current Claude CLI wire name) are
 * the same subagent-spawn tool. Real transcripts use 'Agent'; the tests and any
 * older JSONL snapshots may still carry 'Task'. Accept both so the counter is
 * non-zero on live data (#452).
 */
export const AGENT_SPAWN_TOOLS = new Set(['Task', 'Agent']);

export function aggregateAgentInvocations(data: ToolUsageData[]): AgentStat[] {
  const map = new Map<
    string,
    { invocations: number; sessions: Set<string> }
  >();

  for (const session of data) {
    for (const call of session.calls) {
      if (!AGENT_SPAWN_TOOLS.has(call.toolName)) continue;
      const input = call.input;
      if (!input || typeof input !== 'object') continue;
      const raw = (input as { subagent_type?: unknown }).subagent_type;
      const subagentType =
        typeof raw === 'string' && raw.length > 0 ? raw : UNSPECIFIED_BUCKET;

      const existing = map.get(subagentType) ?? {
        invocations: 0,
        sessions: new Set<string>(),
      };
      existing.invocations += 1;
      existing.sessions.add(session.sessionId);
      map.set(subagentType, existing);
    }
  }

  return Array.from(map.entries())
    .map(([subagentType, { invocations, sessions }]) => ({
      subagentType,
      invocations,
      sessionCount: sessions.size,
    }))
    .sort((a, b) => b.invocations - a.invocations);
}

export function aggregateSkillInvocations(data: ToolUsageData[]): SkillStat[] {
  const map = new Map<
    string,
    { invocations: number; sessions: Set<string> }
  >();

  for (const session of data) {
    for (const call of session.calls) {
      if (call.toolName !== 'Skill') continue;
      const input = call.input;
      if (!input || typeof input !== 'object') continue;
      const raw = (input as { skill?: unknown }).skill;
      const skill =
        typeof raw === 'string' && raw.length > 0 ? raw : UNSPECIFIED_BUCKET;

      const existing = map.get(skill) ?? {
        invocations: 0,
        sessions: new Set<string>(),
      };
      existing.invocations += 1;
      existing.sessions.add(session.sessionId);
      map.set(skill, existing);
    }
  }

  return Array.from(map.entries())
    .map(([skill, { invocations, sessions }]) => ({
      skill,
      invocations,
      sessionCount: sessions.size,
    }))
    .sort((a, b) => b.invocations - a.invocations);
}

export function parseAgentSettings(
  text: string,
  fileName: string
): AgentSettingEvent[] {
  const sessionId = fileName.replace(/\.jsonl$/, '');

  const out: AgentSettingEvent[] = [];

  for (const entry of parseJsonl(text) as AgentSessionEntry[]) {
    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : '';

    // Case 1: top-level entry of type 'agent-setting'
    if (entry.type === 'agent-setting') {
      // Look for { name, value } or { setting, value } or { settingName, settingValue }
      let name: string | null = null;
      let value: unknown = undefined;

      if (typeof entry.name === 'string' && entry.name.length > 0) {
        name = entry.name;
        value = entry.value;
      } else if (typeof entry.setting === 'string' && entry.setting.length > 0) {
        name = entry.setting;
        value = entry.value;
      } else if (
        typeof entry.settingName === 'string' &&
        entry.settingName.length > 0
      ) {
        name = entry.settingName;
        value = entry.settingValue;
      }

      if (name) {
        out.push({
          sessionId,
          timestamp,
          name,
          value: flattenValue(value),
        });
      }
    }

    // Case 2: any top-level `agentSetting` field on any entry
    const agentSetting = entry.agentSetting;
    if (agentSetting != null && typeof agentSetting === 'object') {
      const obj = agentSetting as Record<string, unknown>;
      // If it has a name/value shape, emit one event; otherwise emit one event per key.
      const rawName = obj.name;
      if (typeof rawName === 'string' && rawName.length > 0) {
        out.push({
          sessionId,
          timestamp,
          name: rawName,
          value: flattenValue(obj.value),
        });
      } else {
        for (const [k, v] of Object.entries(obj)) {
          out.push({
            sessionId,
            timestamp,
            name: k,
            value: flattenValue(v),
          });
        }
      }
    }
  }

  return out;
}
