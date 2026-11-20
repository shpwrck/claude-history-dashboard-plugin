/**
 * Single server chokepoint (#324) — the public-sample build stub.
 *
 * `vite build --mode sample` aliases `@api-client` to THIS module instead of
 * `api-client.ts`. It mirrors the real client's exported surface exactly, but
 * contains NO server URL literals, NO `fetch`, and NO dataset-worker import — so
 * the public bundle is provably free of server-touching code. With
 * `SERVER_AVAILABLE === false`, every consumer gates its server-only UI off.
 */
import type { DailyDigest, HistoryEntry } from '../types';
import type { Usage } from './usage';
import type { MemoriesResponse } from './parse-memories';
import type { WorkflowsResponse } from './parse-workflows';
import type { AuditFinding } from './audit/types';
import type { AdoptionReceipt } from './adoption-receipts';
import type { SteerRuleTelemetry } from './steer-telemetry-types';
import type { SessionTimeline } from './parse-timeline';
import type { ToolUsageData } from './parse-tools';
import type { HybridSearchResponse } from './hybrid-search';
import type { LocalAnalyzeResult } from './local-analyze';
import type { CheckpointAnswerRecord } from './checkpoint-instrumentation';
import type {
  RecommendationSurfaceRequest,
  RecommendationSurfaceResponse,
} from './recommendation-surface';

/** False in the public sample build — gates all server-only UI off. */
export const SERVER_AVAILABLE = false;

export type AuditRunStatus = 'ran' | 'skipped' | 'failed';

export interface AuditRunResponse {
  status: AuditRunStatus;
  reason?: string;
  findings: AuditFinding[];
}

export type EnterpriseRole = 'admin' | 'member' | 'viewer';

export interface EnterprisePrincipal {
  userId: string;
  email?: string;
  name: string;
  role: EnterpriseRole;
  orgId: string;
  orgName: string;
  teamId?: string;
  teamName?: string;
  scopes: string[];
  dataRootConfigured?: boolean;
}

/**
 * The `/api/auth/session` response (#3832, epic #3743). A single-user server
 * answers `mode: 'single-user'`, `authRequired: false`, no principal or
 * organization, and its capability map. The server no longer returns the
 * enterprise shape (#3839); narrowing this type is tracked in #3904.
 */
export interface ServerSession {
  mode: 'single-user' | 'enterprise';
  authRequired: boolean;
  authenticated: boolean;
  configured: boolean;
  configError?: string;
  principal: EnterprisePrincipal | null;
  organization: { id: string; name: string } | null;
  capabilities: Record<string, boolean>;
  error?: string;
}

export interface PolicyWriteResult {
  ok: boolean;
  addedCount?: number;
  backup?: string | null;
  error?: string;
}

const UNAVAILABLE = 'Not available in the public sample';

export async function fetchAuthSession(): Promise<ServerSession> {
  return {
    mode: 'single-user',
    authRequired: false,
    authenticated: true,
    configured: true,
    principal: null,
    organization: null,
    capabilities: {},
  };
}

// The SPA has no server; this stub never resolves. (The real client's #1015
// onFresh stale-while-revalidate param is optional, so the SPA's no-arg call
// site and App's callback call site both type-check against the real signature.)
export function fetchDataset(): Promise<unknown> {
  return Promise.reject(new Error(UNAVAILABLE));
}

export async function fetchUsage(): Promise<Usage> {
  return { available: false, reason: 'spa-build' };
}

export async function fetchLive(): Promise<unknown> {
  return null;
}

export async function serverFetch(): Promise<Response> {
  throw new Error('serverFetch is unavailable in the sample build');
}

export async function fetchMemories(): Promise<MemoriesResponse> {
  return { projects: [] };
}

export async function fetchWorkflows(
  signal?: AbortSignal
): Promise<WorkflowsResponse | null> {
  void signal;
  return { runs: [] };
}

export async function fetchDigest(date: string): Promise<DailyDigest> {
  return {
    schemaVersion: '1',
    date,
    generatedAt: '',
    total: {
      date,
      sessionCount: 0,
      messageCount: 0,
      toolCallCount: 0,
      categories: [],
    },
    projects: [],
  };
}

export async function fetchHybridSearch(): Promise<HybridSearchResponse> {
  return { mode: 'fts', semanticAvailable: false, results: [] };
}

export async function fetchAuditRun(): Promise<AuditRunResponse> {
  return {
    status: 'skipped',
    reason: 'spa_unsupported',
    findings: [],
  };
}

export async function fetchAuditFindings(): Promise<AuditFinding[]> {
  return (await fetchAuditRun()).findings;
}

export async function fetchAdoptionReceipts(): Promise<AdoptionReceipt[]> {
  return [];
}

// Steer telemetry (#2203) is a server-tier read of a live ~/.claude log; the
// public sample has no server, so this returns empty (the scorecard renders
// its "no data" state).
export async function fetchSteerTelemetry(): Promise<SteerRuleTelemetry[]> {
  return [];
}

export async function fetchTranscriptContent(): Promise<unknown[] | null> {
  return null;
}

// Never called on the live sample path: client-parsed timelines (uploads, the
// sample corpus) are never slim, so SessionTimeline skips the lazy hydrate.
export async function fetchSessionTimeline(
  _sessionId?: string,
  _signal?: AbortSignal
): Promise<SessionTimeline | null> {
  void _sessionId;
  void _signal;
  return null;
}

export async function fetchSessionTools(
  _sessionId?: string,
  _signal?: AbortSignal
): Promise<ToolUsageData | null> {
  void _sessionId;
  void _signal;
  return null;
}

export async function fetchTranscriptThinking(): Promise<unknown[] | null> {
  return null;
}

export async function fetchSourceSessionJsonl(): Promise<string | null> {
  return null;
}

export async function fetchSourceHistoryJsonl(): Promise<string | null> {
  return null;
}

export async function writePolicy(): Promise<PolicyWriteResult> {
  return { ok: false, error: UNAVAILABLE };
}

// Recommendation reject-signal capture (#1294) is a server-tier write; the
// public sample has no server to persist it, so this no-ops.
export type RejectSignalWriteResult = { ok: true } | { ok: false; error: string };
export async function postRejectSignal(): Promise<RejectSignalWriteResult> {
  return { ok: false, error: UNAVAILABLE };
}

// Recommendation analysis (#2719) is computed by the server; the public sample
// has no server and does NOT run the detector catalog in the browser, so this
// twin returns the network-free `unavailable` viewer state — no server URL, no
// fetch, no detector import. Views degrade to the "run the local server for
// analysis" state. Signature mirrors the real reader so the alias swap is
// transparent.
export async function fetchRecommendationSurface(
  _request: RecommendationSurfaceRequest,
  _signal?: AbortSignal
): Promise<RecommendationSurfaceResponse> {
  void _request;
  void _signal;
  return { kind: 'unavailable' };
}

// Checkpoint answer persistence is server-tier. The public sample keeps the
// interactive preview but emits no network call and carries no server literal.
export type CheckpointAnswerWriteResult =
  | { ok: true; written: boolean }
  | { ok: false; error: string };
export async function postCheckpointAnswer(
  _record: CheckpointAnswerRecord
): Promise<CheckpointAnswerWriteResult> {
  void _record;
  return { ok: true, written: false };
}

// Tier A "Analyze locally" (#2319) needs the server (it fronts the local model);
// the public sample has no server, so this degrades to a deterministic result
// with no recommendations rather than erroring — matching the real client's
// graceful-degradation contract. Carries no `/api/` literal.
export async function analyzeLocal(
  _options: { project?: string | null; signal?: AbortSignal } = {}
): Promise<LocalAnalyzeResult> {
  void _options;
  return {
    source: 'deterministic',
    recommendations: [],
    analysis: null,
    model: null,
    reason: UNAVAILABLE,
    rankedFindingIds: null,
    repairRounds: 0,
    schemaValid: false,
  };
}

// Session provisioning (#1251) is a server-tier feature; the public sample cannot reach a cluster.
export interface RemoteSessionPod {
  name: string;
  phase: string;
  registeredEnvUrl: string;
  registeredEnvName: string;
}

export interface RemoteSessionStatus {
  name: string;
  displayName: string;
  repo: string;
  ref: string;
  poolSize: number;
  phase: string;
  reason: string;
  warmReady: number;
  url: string;
  podName: string;
  pods: RemoteSessionPod[];
  creationTimestamp: string;
}

export interface RemoteSessionsResult {
  ok: boolean;
  configured: boolean;
  cluster?: string;
  namespace?: string;
  sessions: RemoteSessionStatus[];
  error?: string;
}

export interface CreateRemoteSessionInput {
  repo: string;
  ref?: string;
  displayName?: string;
  poolSize?: number;
}

export interface CreateRemoteSessionResult {
  ok: boolean;
  alreadyProvisioned?: boolean;
  name?: string;
  session?: RemoteSessionStatus;
  error?: string;
}

export async function fetchRemoteSessions(): Promise<RemoteSessionsResult> {
  return { ok: true, configured: false, sessions: [] };
}

export async function createRemoteSession(): Promise<CreateRemoteSessionResult> {
  return { ok: false, error: UNAVAILABLE };
}

export async function deleteRemoteSession(): Promise<{ ok: boolean; error?: string }> {
  return { ok: false, error: UNAVAILABLE };
}

export async function loadDefaultHistory(): Promise<HistoryEntry[]> {
  return [];
}
