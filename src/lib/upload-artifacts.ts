import type {
  LiveConfig,
} from '../types';
import { parseLastUpdate, type UpdateResult } from './parse-last-update';
import { parseMcpAuthCache, type McpAuthState } from './parse-mcp-auth';
import { parseStatsCache, type StatsCache } from './parse-stats-cache';
import type { LoadedFile } from './unzip-upload';

type TaskStatus = 'pending' | 'in_progress' | 'completed';

interface TaskRecord {
  id: string;
  subject: string;
  description: string;
  activeForm: string;
  owner: string;
  status: TaskStatus;
  blocks: string[];
  blockedBy: string[];
  pr?: string;
  sessionId: string;
  mtimeMs: number;
}

interface TeamMessage {
  from: string;
  text: string;
  timestamp: string;
  type: string;
  read: boolean;
}

interface TaskAssignmentPayload {
  type: 'task_assignment';
  taskId: string;
  subject: string;
  description?: string;
  assignedBy?: string;
  timestamp?: string;
}

interface TeamAssignment {
  agent: string;
  from: string;
  timestamp: string;
  read: boolean;
  payload: TaskAssignmentPayload;
}

interface DroppedAssignment {
  agent: string;
  taskId: string;
  subject: string;
  ageMinutes: number;
}

interface StalledAgent {
  agent: string;
  unreadCount: number;
}

interface TeamSummary {
  teamId: string;
  totalAssignments: number;
  droppedCount: number;
  droppedPct: number;
  droppedAssignments: DroppedAssignment[];
  stalledAgents: StalledAgent[];
}

interface SessionRegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  procStart: string;
  version: string;
  peerProtocol: number;
  kind: string;
  entrypoint: string;
}

interface TelemetryEnvFingerprint {
  node_version: string;
  terminal: string;
  wsl_version: string;
  linux_distro_id: string;
  arch: string;
  build_time: string;
}

interface TelemetryEvent {
  event_name: string;
  client_timestamp: string;
  model: string;
  betas: string;
  session_id: string;
  attempt: number;
  elapsed_ms: number;
  env: TelemetryEnvFingerprint;
}

interface ModelLatencySample {
  session_id: string;
  model: string;
  apiDurationMs: number;
  toolDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  client_timestamp: string;
}

interface DebugSessionMetrics {
  sessionId: string;
  ttfbP50: number;
  ttfbP90: number;
  ttfbMax: number;
  ttfbSampleCount: number;
  maxRetryAttempt: number;
  slowFirstByteCount: number;
  fastModeLostCount: number;
  isSdkCli?: boolean;
}

interface FileHistorySession {
  sessionId: string;
  churn: number;
  spanMin: number;
  burstRate: number;
  reworkScore: number;
  firstMs: number;
  lastMs: number;
}

interface PlanSignature {
  name: string;
  id: string;
  sections: number;
  fileRefs: number;
  words: number;
  hasVerification: boolean;
}

type DriftKind =
  | 'trust-flip'
  | 'enable-all-flip'
  | 'server-disabled'
  | 'server-enabled'
  | 'repo-server-appeared'
  | 'repo-server-vanished'
  | 'global-churn';

interface DriftEvent {
  kind: DriftKind;
  project?: string;
  server?: string;
  from: boolean | string | undefined;
  to: boolean | string | undefined;
  timestamp: number;
  severity: 'warning' | 'info';
}

export interface UploadedArtifacts {
  tasks: TaskRecord[];
  teams: TeamSummary[];
  sessionRegistry: SessionRegistryEntry[];
  telemetry: TelemetryEvent[];
  modelLatency: ModelLatencySample[];
  debugLogs: DebugSessionMetrics[];
  statsCache: StatsCache | null;
  fileHistory: FileHistorySession[];
  plans: PlanSignature[];
  updateResults: UpdateResult[];
  mcpAuth: McpAuthState | null;
  configBackups: DriftEvent[];
  liveConfig: LiveConfig | null;
}

interface CollectOptions {
  nowMs?: number;
}

const EMPTY: UploadedArtifacts = {
  tasks: [],
  teams: [],
  sessionRegistry: [],
  telemetry: [],
  modelLatency: [],
  debugLogs: [],
  statsCache: null,
  fileHistory: [],
  plans: [],
  updateResults: [],
  mcpAuth: null,
  configBackups: [],
  liveConfig: null,
};

function normalizePath(file: LoadedFile): string {
  return (file.path ?? file.name).replace(/\\/g, '/').replace(/^\/+/, '');
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function status(v: unknown): TaskStatus | null {
  return v === 'pending' || v === 'in_progress' || v === 'completed' ? v : null;
}

function parseTask(file: LoadedFile, nowMs: number): TaskRecord | null {
  const match = normalizePath(file).match(/(^|\/)tasks\/([^/]+)\/([^/]+)\.json$/);
  if (!match) return null;
  const raw = obj(json(file.text));
  if (!raw) return null;
  const taskStatus = status(raw.status);
  if (!taskStatus) return null;
  const metadata = obj(raw.metadata);
  const pr = metadata && typeof metadata.pr === 'string' && metadata.pr ? metadata.pr : undefined;
  return {
    id: str(raw.id, match[3]),
    subject: str(raw.subject),
    description: str(raw.description),
    activeForm: str(raw.activeForm),
    owner: str(raw.owner),
    status: taskStatus,
    blocks: strArray(raw.blocks),
    blockedBy: strArray(raw.blockedBy),
    pr,
    sessionId: match[2],
    mtimeMs: file.lastModified ?? nowMs,
  };
}

function safeAssignmentPayload(text: string): TaskAssignmentPayload | null {
  const parsed = obj(json(text));
  return parsed && parsed.type === 'task_assignment'
    ? (parsed as unknown as TaskAssignmentPayload)
    : null;
}

function parseTeamInbox(file: LoadedFile): { teamId: string; assignments: TeamAssignment[] } | null {
  const match = normalizePath(file).match(/(^|\/)teams\/([^/]+)\/inboxes\/([^/]+)\.json$/);
  if (!match) return null;
  const parsed = json(file.text);
  if (!Array.isArray(parsed)) return { teamId: match[2], assignments: [] };
  const agent = match[3];
  const assignments = parsed.flatMap((raw): TeamAssignment[] => {
    const message = obj(raw) as TeamMessage | null;
    if (!message) return [];
    const payload = safeAssignmentPayload(message.text);
    if (!payload) return [];
    return [{
      agent,
      from: str(message.from),
      timestamp: str(message.timestamp),
      read: message.read === true,
      payload,
    }];
  });
  return { teamId: match[2], assignments };
}

function analyzeTeams(
  teamAssignments: Map<string, TeamAssignment[]>,
  nowMs: number,
  graceMinutes = 10
): TeamSummary[] {
  const summaries: TeamSummary[] = [];
  for (const [teamId, assignments] of teamAssignments) {
    if (assignments.length === 0) continue;
    const byAgent = new Map<string, TeamAssignment[]>();
    for (const assignment of assignments) {
      const bucket = byAgent.get(assignment.agent) ?? [];
      bucket.push(assignment);
      byAgent.set(assignment.agent, bucket);
    }
    const droppedAssignments: DroppedAssignment[] = [];
    const stalledAgents: StalledAgent[] = [];
    for (const [agent, agentAssignments] of byAgent) {
      if (agentAssignments.every((a) => !a.read)) {
        stalledAgents.push({ agent, unreadCount: agentAssignments.length });
      }
      for (const assignment of agentAssignments) {
        const ageMinutes = Math.floor((nowMs - Date.parse(assignment.timestamp || '0')) / 60_000);
        if (!assignment.read && ageMinutes >= graceMinutes) {
          droppedAssignments.push({
            agent,
            taskId: str(assignment.payload.taskId),
            subject: str(assignment.payload.subject),
            ageMinutes,
          });
        }
      }
    }
    const droppedCount = droppedAssignments.length;
    summaries.push({
      teamId,
      totalAssignments: assignments.length,
      droppedCount,
      droppedPct: Math.round((droppedCount / assignments.length) * 100),
      droppedAssignments,
      stalledAgents,
    });
  }
  return summaries;
}

function parseSessionRegistry(file: LoadedFile): SessionRegistryEntry | null {
  if (!/(^|\/)sessions\/[^/]+\.json$/.test(normalizePath(file))) return null;
  const raw = obj(json(file.text));
  if (!raw) return null;
  if (
    typeof raw.pid !== 'number' ||
    typeof raw.sessionId !== 'string' ||
    typeof raw.cwd !== 'string' ||
    typeof raw.startedAt !== 'number' ||
    typeof raw.entrypoint !== 'string' ||
    typeof raw.kind !== 'string'
  ) {
    return null;
  }
  return {
    pid: raw.pid,
    sessionId: raw.sessionId,
    cwd: raw.cwd,
    startedAt: raw.startedAt,
    procStart: typeof raw.procStart === 'string' ? raw.procStart : String(raw.procStart ?? ''),
    version: str(raw.version),
    peerProtocol: num(raw.peerProtocol),
    kind: raw.kind,
    entrypoint: raw.entrypoint,
  };
}

function decodeBase64Json(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const decoded =
      typeof atob === 'function'
        ? atob(raw)
        : Buffer.from(raw, 'base64').toString('utf8');
    return obj(JSON.parse(decoded)) ?? {};
  } catch {
    return {};
  }
}

function envFingerprint(raw: unknown): TelemetryEnvFingerprint {
  const env = obj(raw) ?? {};
  return {
    node_version: str(env.node_version),
    terminal: str(env.terminal),
    wsl_version: str(env.wsl_version),
    linux_distro_id: str(env.linux_distro_id),
    arch: str(env.arch),
    build_time: str(env.build_time),
  };
}

function parseTelemetryLine(line: string): TelemetryEvent | null {
  if (!line.trim()) return null;
  const raw = obj(json(line));
  const data = obj(raw?.event_data);
  if (!data) return null;
  const eventName = str(data.event_name);
  if (!eventName) return null;
  const metadata = decodeBase64Json(data.additional_metadata);
  return {
    event_name: eventName,
    client_timestamp: str(data.client_timestamp),
    model: str(data.model),
    betas: str(data.betas),
    session_id: str(data.session_id),
    attempt: num(metadata.attempt, 1),
    elapsed_ms: num(metadata.elapsed_ms),
    env: envFingerprint(data.env),
  };
}

function parseTelemetry(file: LoadedFile): TelemetryEvent[] {
  if (!/(^|\/)telemetry\/1p_failed_events[^/]*\.json$/.test(normalizePath(file))) return [];
  return file.text.split('\n').flatMap((line) => {
    const event = parseTelemetryLine(line);
    return event ? [event] : [];
  });
}

function parseTelemetryLatencyLine(line: string): ModelLatencySample | null {
  if (!line.trim()) return null;
  const raw = obj(json(line));
  const data = obj(raw?.event_data);
  if (!data || str(data.event_name) !== 'tengu_exit') return null;
  const metadata = decodeBase64Json(data.additional_metadata);
  const apiDurationMs = num(metadata.last_session_api_duration);
  if (apiDurationMs <= 0) return null;
  return {
    session_id: str(data.session_id),
    model: str(data.model),
    apiDurationMs,
    toolDurationMs: Math.max(0, num(metadata.last_session_tool_duration)),
    inputTokens: Math.max(0, num(metadata.last_session_total_input_tokens)),
    outputTokens: Math.max(0, num(metadata.last_session_total_output_tokens)),
    client_timestamp: str(data.client_timestamp),
  };
}

function parseTelemetryLatency(file: LoadedFile): ModelLatencySample[] {
  if (!/(^|\/)telemetry\/1p_failed_events[^/]*\.json$/.test(normalizePath(file))) return [];
  return file.text.split('\n').flatMap((line) => {
    const sample = parseTelemetryLatencyLine(line);
    return sample ? [sample] : [];
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function parseDebugLog(file: LoadedFile): DebugSessionMetrics | null {
  const match = normalizePath(file).match(/(^|\/)debug\/([^/]+)\.txt$/);
  if (!match) return null;
  const ttfbs: number[] = [];
  let pendingReqTs: number | null = null;
  let maxRetryAttempt = 0;
  let slowFirstByteCount = 0;
  let fastModeLostCount = 0;
  let isSdkCli: boolean | undefined = undefined;
  for (const line of file.text.split('\n')) {
    const ts = Date.parse(line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)?.[1] ?? '');
    if (/cc_entrypoint=sdk-cli/.test(line) || /\[API REQUEST\] \/v1\/messages[^\n]*source=sdk(?:\b|_)/.test(line)) {
      isSdkCli = true;
    }
    if (/\[API REQUEST\] \/v1\/messages/.test(line)) {
      pendingReqTs = Number.isNaN(ts) ? null : ts;
      continue;
    }
    if (/Stream started - received first chunk/.test(line)) {
      if (pendingReqTs !== null && !Number.isNaN(ts) && ts >= pendingReqTs) {
        ttfbs.push(ts - pendingReqTs);
      }
      pendingReqTs = null;
      continue;
    }
    const attempt = /API error \(attempt (\d+)\/\d+\)/.exec(line);
    if (attempt) maxRetryAttempt = Math.max(maxRetryAttempt, Number(attempt[1]) || 0);
    if (/Slow first byte: no stream chunk/.test(line)) slowFirstByteCount++;
    if (/Fast mode unavailable/.test(line)) fastModeLostCount++;
  }
  ttfbs.sort((a, b) => a - b);
  return {
    sessionId: match[2],
    ttfbP50: percentile(ttfbs, 0.5),
    ttfbP90: percentile(ttfbs, 0.9),
    ttfbMax: ttfbs[ttfbs.length - 1] ?? 0,
    ttfbSampleCount: ttfbs.length,
    maxRetryAttempt,
    slowFirstByteCount,
    fastModeLostCount,
    isSdkCli,
  };
}

function scoreFileHistory(churn: number, firstMs: number, lastMs: number) {
  const spanMin = Math.max(0, (lastMs - firstMs) / 60_000);
  const burstRate = churn / Math.max(1, spanMin);
  return {
    spanMin: +spanMin.toFixed(1),
    burstRate: +burstRate.toFixed(2),
    reworkScore: +(churn * (1 + burstRate)).toFixed(1),
  };
}

function parseFileHistory(files: LoadedFile[], nowMs: number): FileHistorySession[] {
  const bySession = new Map<string, number[]>();
  for (const file of files) {
    const match = normalizePath(file).match(/(^|\/)file-history\/([^/]+)\/[^/]+@v2$/);
    if (!match) continue;
    const mtimes = bySession.get(match[2]) ?? [];
    mtimes.push(file.lastModified ?? nowMs);
    bySession.set(match[2], mtimes);
  }
  return [...bySession.entries()].map(([sessionId, mtimes]) => {
    const firstMs = Math.min(...mtimes);
    const lastMs = Math.max(...mtimes);
    const churn = mtimes.length;
    return { sessionId, churn, firstMs, lastMs, ...scoreFileHistory(churn, firstMs, lastMs) };
  });
}

function parsePlan(file: LoadedFile): PlanSignature | null {
  const match = normalizePath(file).match(/(^|\/)plans\/([^/]+)\.md$/);
  if (!match) return null;
  const name = match[2];
  return {
    name,
    id: name,
    sections: (file.text.match(/^##\s/gm) ?? []).length,
    fileRefs: (file.text.match(/^[0-9]+\.\s/gm) ?? []).length,
    words: (file.text.match(/\S+/g) ?? []).length,
    hasVerification: /^##\s+(verification|test)/im.test(file.text),
  };
}

function parseBackup(file: LoadedFile): { ts: number; globalMcpServerKeys: string[] } | null {
  const match = normalizePath(file).match(/(^|\/)backups\/\.claude\.json\.backup\.([0-9]+)$/);
  if (!match) return null;
  const raw = obj(json(file.text));
  if (!raw) return null;
  return {
    ts: Number(match[2]),
    globalMcpServerKeys: Object.keys(obj(raw.mcpServers) ?? {}),
  };
}

function diffGlobalBackups(files: LoadedFile[]): DriftEvent[] {
  const snapshots = files
    .map(parseBackup)
    .filter((x): x is NonNullable<ReturnType<typeof parseBackup>> => x !== null)
    .sort((a, b) => a.ts - b.ts);
  const events: DriftEvent[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const previous = new Set(snapshots[i - 1].globalMcpServerKeys);
    const current = new Set(snapshots[i].globalMcpServerKeys);
    const churn =
      [...current].filter((k) => !previous.has(k)).length +
      [...previous].filter((k) => !current.has(k)).length;
    if (churn > 0) {
      events.push({
        kind: 'global-churn',
        from: String(previous.size),
        to: String(current.size),
        timestamp: snapshots[i].ts,
        severity: 'info',
      });
    }
  }
  return events;
}

export function collectUploadArtifacts(
  files: LoadedFile[],
  options: CollectOptions = {}
): UploadedArtifacts {
  const nowMs = options.nowMs ?? Date.now();
  const out: UploadedArtifacts = {
    ...EMPTY,
    tasks: files.flatMap((file) => {
      const task = parseTask(file, nowMs);
      return task ? [task] : [];
    }),
    sessionRegistry: files.flatMap((file) => {
      const entry = parseSessionRegistry(file);
      return entry ? [entry] : [];
    }),
    telemetry: files.flatMap(parseTelemetry),
    modelLatency: files.flatMap(parseTelemetryLatency),
    debugLogs: files.flatMap((file) => {
      const metrics = parseDebugLog(file);
      return metrics ? [metrics] : [];
    }),
    fileHistory: parseFileHistory(files, nowMs),
    plans: files.flatMap((file) => {
      const plan = parsePlan(file);
      return plan ? [plan] : [];
    }).sort((a, b) => a.name.localeCompare(b.name)),
    updateResults: files.flatMap((file) => {
      if (!/(^|\/)\.last-update-result\.json$/.test(normalizePath(file))) return [];
      const result = parseLastUpdate(file.text);
      return result ? [result] : [];
    }),
    configBackups: diffGlobalBackups(files),
  };

  const teams = new Map<string, TeamAssignment[]>();
  for (const file of files) {
    const parsed = parseTeamInbox(file);
    if (!parsed) continue;
    teams.set(parsed.teamId, [...(teams.get(parsed.teamId) ?? []), ...parsed.assignments]);
  }
  out.teams = analyzeTeams(teams, nowMs);

  const statsFile = files.find((file) => /(^|\/)stats-cache\.json$/.test(normalizePath(file)));
  out.statsCache = statsFile ? parseStatsCache(statsFile.text) : null;

  const authFile = files.find((file) => /(^|\/)mcp-needs-auth-cache\.json$/.test(normalizePath(file)));
  out.mcpAuth = authFile ? parseMcpAuthCache(authFile.text) : null;

  return out;
}
