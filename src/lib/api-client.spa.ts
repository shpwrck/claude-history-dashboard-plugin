/**
 * Single server chokepoint (#324) — the SPA build stub.
 *
 * `vite build --mode spa` aliases `@api-client` to THIS module instead of
 * `api-client.ts`. It mirrors the real client's exported surface exactly, but
 * contains NO server URL literals, NO `fetch`, and NO dataset-worker import — so
 * the SPA bundle is provably free of server-touching code (CI greps the emitted
 * `dist/` for `/api/`, `csrf-token`, `policy/write`, `EventSource`). The SPA is
 * upload-only: `SERVER_AVAILABLE === false` makes every consumer gate its
 * server-only UI off, and these functions are never called on the live path.
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

/** False in the SPA build — gates all server-only UI off. */
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

export interface EnterpriseSession {
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

export interface EnterpriseAuditEvent {
  timestamp: string;
  requestId?: string;
  type: string;
  outcome?: string;
  status?: number;
  method?: string;
  path?: string;
  reason?: string;
  principal?: {
    userId?: string;
    role?: EnterpriseRole;
    orgId?: string;
    teamId?: string;
  };
  tokenHash?: string;
  remoteAddress?: string;
}

export interface EnterpriseAuditActivitySummary {
  source: string;
  window: { start: string | null; end: string | null };
  events: {
    total: number;
    allowed: number;
    denied: number;
    skipped: number;
    other: number;
    rateLimited: number;
    serverErrors: number;
  };
  outcomes: Record<string, number>;
  principalRoles: Record<string, number>;
  topTypes: EnterpriseRollupNameCount[];
  privacy: {
    redacted: boolean;
    derivedFrom: string[];
    excludes: string[];
  };
}

export type EnterpriseSecurityControlState =
  | 'enabled'
  | 'disabled'
  | 'action-required';

export interface EnterpriseSecurityControl {
  id: string;
  label: string;
  state: EnterpriseSecurityControlState;
  summary: string;
  detail: string;
}

export interface EnterpriseSecurityPosture {
  generatedAt: string;
  controls: EnterpriseSecurityControl[];
  deploymentNotes: string[];
}

export interface EnterpriseTeamSummary {
  teamId?: string;
  teamName: string;
  principalCount: number;
  adminCount: number;
  memberCount: number;
  viewerCount: number;
  scopedDataRoots: number;
}

export interface EnterprisePrincipalPage {
  total: number;
  limit: number;
  offset: number;
  returned: number;
}

export interface EnterpriseIdentityCoverage {
  source: string;
  contributors: {
    total: number;
    withEmailAlias: number;
    withTeam: number;
    withScopedDataRoot: number;
    roles: Record<EnterpriseRole, number>;
  };
  teams: {
    total: number;
    mappedPrincipals: number;
    unassignedPrincipals: number;
    withScopedDataRoots: number;
  };
  aliases: {
    userId: number;
    email: number;
    team: number;
    total: number;
  };
  privacy: {
    redacted: boolean;
    derivedFrom: string[];
    excludes: string[];
  };
}

export interface EnterpriseRollupNameCount {
  name: string;
  count: number;
}

export interface EnterpriseOrganizationRollup {
  schemaVersion: string;
  mode: 'single-user' | 'enterprise';
  generatedAt: string;
  window: { start: string | null; end: string | null };
  organization: { id: string; name: string };
  requester: {
    userId?: string;
    email?: string;
    role?: EnterpriseRole;
  } | null;
  principals: {
    configured: number;
    roles: Record<EnterpriseRole, number>;
  };
  capabilities: Record<string, boolean>;
  counts: {
    sessions: number;
    projects: number;
    userMessages: number;
    tokenSessions: number;
    toolSessions: number;
    permissionSessions: number;
    apiErrors: number;
    unattendedSessions: number;
    bypassPermissionSessions: number;
    dangerousCommandSessions: number;
  };
  usage: {
    tokens: {
      input: number;
      output: number;
      cacheCreation: number;
      cacheRead: number;
      total: number;
    };
    estimatedCostUsd: number;
    models: EnterpriseRollupNameCount[];
    serviceTiers: EnterpriseRollupNameCount[];
  };
  tools: {
    totalCalls: number;
    errorCalls: number;
    errorRate: number;
    topTools: {
      toolName: string;
      count: number;
      errorCount: number;
      errorRate: number;
    }[];
  };
  safety: {
    permissionModes: {
      mode: string;
      entryCount: number;
      sessionCount: number;
    }[];
    dangerousCommands: {
      count: number;
      sessions: number;
      patterns: EnterpriseRollupNameCount[];
    };
    bypassPermissionSessions: number;
  };
  topProjects: {
    rank: number;
    label: string;
    projectKey: string;
    sessionCount: number;
    messageCount: number;
    estimatedCostUsd: number;
  }[];
  privacy: {
    redacted: boolean;
    projectKeys: string;
    excludes: string[];
  };
}

export interface EnterpriseOrganizationSummary {
  organization: { id: string; name: string };
  principals: EnterprisePrincipal[];
  principalPage: EnterprisePrincipalPage;
  teams: EnterpriseTeamSummary[];
  identityCoverage?: EnterpriseIdentityCoverage;
  rollup?: EnterpriseOrganizationRollup;
  securityPosture?: EnterpriseSecurityPosture;
  auditActivity?: EnterpriseAuditActivitySummary;
  auditEvents: EnterpriseAuditEvent[];
}

export interface EnterpriseReadinessReceipt {
  schemaVersion: string;
  generatedAt: string;
  status: 'ready' | 'review-required';
  mode: 'single-user' | 'enterprise';
  organization: { id: string; name: string };
  reviewer: {
    role?: EnterpriseRole;
    capabilities: Record<string, boolean>;
  } | null;
  summary: {
    actionRequiredControls: number;
    enabledControls: number;
    disabledControls: number;
    configuredPrincipals: number;
    teams: number;
    scopedDataRoots: number;
    sessions: number;
    projects: number;
    auditEvents: number;
    deniedAuditEvents: number;
    rateLimitedAuditEvents: number;
    serverErrorAuditEvents: number;
  };
  evidence: {
    posture: {
      generatedAt: string;
      controls: {
        total: number;
        enabled: number;
        disabled: number;
        actionRequired: number;
        other: number;
        actionRequiredIds: string[];
        states: {
          id: string;
          label: string;
          state: EnterpriseSecurityControlState;
        }[];
      };
    };
    identityCoverage?: EnterpriseIdentityCoverage;
    auditActivity?: EnterpriseAuditActivitySummary;
    rollup: {
      schemaVersion: string;
      generatedAt: string;
      window: { start: string | null; end: string | null };
      principals: EnterpriseOrganizationRollup['principals'];
      counts: EnterpriseOrganizationRollup['counts'];
      usage: EnterpriseOrganizationRollup['usage'];
      tools: Pick<
        EnterpriseOrganizationRollup['tools'],
        'totalCalls' | 'errorCalls' | 'errorRate'
      >;
      safety: EnterpriseOrganizationRollup['safety'];
      privacy: EnterpriseOrganizationRollup['privacy'];
    } | null;
    routeAccess: {
      inventoryGate: string;
      unclassifiedApiRoutesFailClosed: boolean;
      adminGlobalViews: boolean;
      scopedUserViewsRequireDataRoot: boolean;
      rawTranscriptRoutesHighestSensitivity: boolean;
      writesRequireAdminAndCsrf: boolean;
    };
    bounds: Record<string, number>;
  };
  privacy: {
    redacted: boolean;
    derivedFrom: string[];
    excludes: string[];
  };
}

export interface FetchEnterpriseOrganizationOptions {
  principalLimit?: number;
  principalOffset?: number;
}

export interface FetchEnterpriseAuditExportOptions {
  limit?: number;
}

export interface PolicyWriteResult {
  ok: boolean;
  addedCount?: number;
  backup?: string | null;
  error?: string;
}

const UNAVAILABLE = 'Not available in the upload-only build';

export function getEnterpriseAuthToken(): string | null {
  return null;
}

export function setEnterpriseAuthToken(): void {
  /* no server auth in the upload-only build */
}

export function clearEnterpriseAuthToken(): void {
  /* no server auth in the upload-only build */
}

export function clearEnterpriseBrowserSession(): Promise<void> {
  return Promise.resolve();
}

export async function fetchAuthSession(): Promise<EnterpriseSession> {
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

export async function createEnterpriseBrowserSession(): Promise<EnterpriseSession> {
  return fetchAuthSession();
}

export function fetchEnterpriseOrganization(
  _options: FetchEnterpriseOrganizationOptions = {}
): Promise<EnterpriseOrganizationSummary> {
  void _options;
  return Promise.reject(new Error(UNAVAILABLE));
}

export function fetchEnterpriseAuditExport(
  _options: FetchEnterpriseAuditExportOptions = {}
): Promise<string> {
  void _options;
  return Promise.reject(new Error(UNAVAILABLE));
}

export function fetchEnterpriseReadinessReceipt(): Promise<EnterpriseReadinessReceipt> {
  return Promise.reject(new Error(UNAVAILABLE));
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
  throw new Error('serverFetch is unavailable in the SPA build');
}

export async function fetchMemories(): Promise<MemoriesResponse> {
  return { projects: [] };
}

export async function fetchWorkflows(): Promise<WorkflowsResponse> {
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
// upload-only SPA has no server, so this returns empty (the scorecard renders
// its "no data" state).
export async function fetchSteerTelemetry(): Promise<SteerRuleTelemetry[]> {
  return [];
}

export async function fetchTranscriptContent(): Promise<unknown[] | null> {
  return null;
}

// Never called on the live SPA path: client-parsed timelines (uploads, the
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
// upload-only SPA has no server to persist it, so this no-ops.
export type RejectSignalWriteResult = { ok: true } | { ok: false; error: string };
export async function postRejectSignal(): Promise<RejectSignalWriteResult> {
  return { ok: false, error: UNAVAILABLE };
}

// Session provisioning (#1251) is a server-tier feature; the upload-only SPA cannot reach a cluster.
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
