/**
 * Single server chokepoint (#324) — the SERVER build.
 *
 * Every call the frontend makes to the dashboard's own backend lives here and
 * NOWHERE else: each server URL literal (`/api/...`, `/history.jsonl`) and the
 * dataset Web Worker are owned by this module. That centralization is what makes
 * the SPA build's hard boundary provable — `vite build --mode spa` aliases this
 * module to `api-client.spa.ts` (a no-op stub with no URL literals and no
 * worker import), so server-touching code is physically *absent* from the SPA
 * bundle rather than merely disabled. The CI guard greps the emitted `spa`
 * `dist/` for these literals and fails if any survive.
 *
 * `SERVER_AVAILABLE` is the build-target flag consumers read to gate server-only
 * UI (Live widget, Policy write-back, transcript drill-in, the "Reload from
 * disk" control). It is `true` here and `false` in the stub.
 *
 * Completeness signals (#1621): the artifact fetchers below distinguish
 * "artifact is empty" from "artifact could not be read" so views can render a
 * cause-and-remedy empty state instead of a bare blank. The conventions are:
 *   - Collection fetchers (`fetchMemories`, `fetchWorkflows`, `fetchRemoteSessions`)
 *     never reject; a down/absent backend collapses to an empty collection (and,
 *     for remote sessions, `configured: false`) — an empty array means "no such
 *     artifact yet", which the consumer explains and points at how to populate.
 *   - Per-session fetchers (`fetchSessionTimeline`, `fetchTranscriptContent`, …)
 *     return `null` on a 404 — the session has no stored transcript/debug log —
 *     so the caller can name that specific missing artifact.
 *   - `fetchAuditRun` carries an explicit `status` + `reason`, the completeness
 *     signal for the opt-in tier-3 audit (ran / skipped / failed).
 */
import type { DailyDigest, HistoryEntry } from '../types';
import type { Usage } from './usage';
import type { MemoriesResponse } from './parse-memories';
import type { WorkflowsResponse } from './parse-workflows';
import type { AuditFinding } from './audit/types';
import type { AdoptionReceipt } from './adoption-receipts';
import type { RejectReason } from './reject-reason';
import type { SteerRuleTelemetry } from './steer-telemetry-types';
import type { SessionTimeline } from './parse-timeline';
import type { ToolUsageData } from './parse-tools';
import type { HybridSearchResponse } from './hybrid-search';
import type { LocalAnalyzeResult } from './local-analyze';
import type { CheckpointAnswerRecord } from './checkpoint-instrumentation';
import { parseHistoryJsonl } from './parse-history';

/** True in the server build; the SPA stub exports `false`. */
export const SERVER_AVAILABLE = true;

export type AuditRunStatus = 'ran' | 'skipped' | 'failed';

export interface AuditRunResponse {
  status: AuditRunStatus;
  reason?: string;
  findings: AuditFinding[];
}

const ENTERPRISE_AUTH_TOKEN_KEY =
  'claude-history-dashboard:enterprise-auth-token';

let enterpriseDatasetCacheKeyHint: string | null = null;

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

/** Normalized result of a policy write-back. */
export interface PolicyWriteResult {
  ok: boolean;
  addedCount?: number;
  backup?: string | null;
  error?: string;
}

export function getEnterpriseAuthToken(): string | null {
  try {
    return sessionStorage.getItem(ENTERPRISE_AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setEnterpriseAuthToken(token: string): void {
  try {
    sessionStorage.setItem(ENTERPRISE_AUTH_TOKEN_KEY, token);
  } catch {
    /* sessionStorage may be disabled */
  }
}

export function clearEnterpriseAuthToken(): void {
  try {
    sessionStorage.removeItem(ENTERPRISE_AUTH_TOKEN_KEY);
  } catch {
    /* sessionStorage may be disabled */
  }
}

function rememberEnterpriseSessionForCache(session: EnterpriseSession): void {
  if (session.authRequired && session.authenticated && session.principal) {
    enterpriseDatasetCacheKeyHint = `${session.principal.orgId}\u001f${session.principal.userId}`;
  } else if (session.authRequired) {
    enterpriseDatasetCacheKeyHint = null;
  }
}

/**
 * The shared request primitive every backend call goes through — exported so
 * satellite seam modules (lazy-chunk clients like `@shadow-experiments-client`)
 * delegate here instead of re-implementing auth/header/failure behavior. This
 * keeps api-client the single owner of HOW requests are made even when a URL
 * literal lives in a lazy seam for shell-budget reasons (ADR 0016, #2371).
 */
export function serverFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  token: string | null = getEnterpriseAuthToken()
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(input, { ...init, credentials: 'same-origin', headers });
}

function isEnterpriseSession(value: unknown): value is EnterpriseSession {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const session = value as Record<string, unknown>;
  const capabilities = session.capabilities;
  const modeIsValid =
    session.mode === 'single-user' || session.mode === 'enterprise';
  const modeMatchesAuth =
    (session.mode === 'single-user' && session.authRequired === false) ||
    (session.mode === 'enterprise' && session.authRequired === true);
  const principalIsValid =
    session.principal === null ||
    (typeof session.principal === 'object' && !Array.isArray(session.principal));
  const organizationIsValid =
    session.organization === null ||
    (typeof session.organization === 'object' &&
      !Array.isArray(session.organization));
  const capabilitiesAreValid =
    capabilities != null &&
    typeof capabilities === 'object' &&
    !Array.isArray(capabilities) &&
    Object.values(capabilities).every((allowed) => typeof allowed === 'boolean');
  return (
    modeIsValid &&
    modeMatchesAuth &&
    typeof session.authenticated === 'boolean' &&
    typeof session.configured === 'boolean' &&
    principalIsValid &&
    organizationIsValid &&
    capabilitiesAreValid &&
    (session.configError === undefined ||
      typeof session.configError === 'string') &&
    (session.error === undefined || typeof session.error === 'string')
  );
}

function isEnterpriseAuthStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status === 503;
}

const AUTH_FAILURE_MESSAGE_MAX_LENGTH = 2_000;

function rejectedAuthMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, AUTH_FAILURE_MESSAGE_MAX_LENGTH);
}

function rejectedAuthSession(
  body: unknown,
  status: number,
  authRequired: boolean
): EnterpriseSession {
  const envelope =
    body != null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  const error = rejectedAuthMessage(envelope?.error);
  const configError = rejectedAuthMessage(envelope?.configError);

  return {
    mode: authRequired ? 'enterprise' : 'single-user',
    authRequired,
    authenticated: false,
    configured: status !== 503,
    ...(configError === undefined ? {} : { configError }),
    principal: null,
    organization: null,
    capabilities: {},
    ...(error === undefined && configError === undefined
      ? { error: `Auth check failed (HTTP ${status})` }
      : error === undefined
        ? {}
        : { error }),
  };
}

export async function fetchAuthSession(
  token: string | null = getEnterpriseAuthToken()
): Promise<EnterpriseSession> {
  try {
    const res = await serverFetch(
      '/api/auth/session',
      { headers: { Accept: 'application/json' } },
      token
    );
    const body = (await res.json().catch(() => null)) as unknown;
    if (res.ok && isEnterpriseSession(body)) {
      rememberEnterpriseSessionForCache(body);
      return body;
    }
    return rejectedAuthSession(
      body,
      res.status,
      isEnterpriseAuthStatus(res.status)
    );
  } catch {
    return {
      mode: 'single-user',
      authRequired: false,
      authenticated: true,
      configured: true,
      principal: null,
      organization: null,
      capabilities: {},
      error: 'Could not reach the dashboard server',
    };
  }
}

export async function createEnterpriseBrowserSession(
  token: string
): Promise<EnterpriseSession> {
  try {
    const res = await serverFetch(
      '/api/auth/session',
      {
        method: 'POST',
        headers: { Accept: 'application/json' },
      },
      token
    );
    const body = (await res.json().catch(() => null)) as unknown;
    if (res.ok && isEnterpriseSession(body)) {
      rememberEnterpriseSessionForCache(body);
      return body;
    }
    return rejectedAuthSession(body, res.status, true);
  } catch {
    return {
      mode: 'enterprise',
      authRequired: true,
      authenticated: false,
      configured: true,
      principal: null,
      organization: null,
      capabilities: {},
      error: 'Could not reach the dashboard server',
    };
  }
}

export async function clearEnterpriseBrowserSession(): Promise<void> {
  enterpriseDatasetCacheKeyHint = null;
  clearEnterpriseAuthToken();
  await serverFetch('/api/auth/session', { method: 'DELETE' }, null).catch(() => undefined);
}

function appendPositiveIntegerParam(
  params: URLSearchParams,
  name: string,
  value: number | undefined
): void {
  if (value == null || !Number.isFinite(value)) return;
  params.set(name, String(Math.max(0, Math.floor(value))));
}

export async function fetchEnterpriseOrganization(
  options: FetchEnterpriseOrganizationOptions = {}
): Promise<EnterpriseOrganizationSummary> {
  const params = new URLSearchParams();
  appendPositiveIntegerParam(params, 'principalLimit', options.principalLimit);
  appendPositiveIntegerParam(params, 'principalOffset', options.principalOffset);
  const query = params.toString();
  const res = await serverFetch(`/api/enterprise/organization${query ? `?${query}` : ''}`, {
    headers: { Accept: 'application/json' },
  });
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok || !body || typeof body !== 'object') {
    throw new Error(`Enterprise organization request failed (HTTP ${res.status})`);
  }
  return body as EnterpriseOrganizationSummary;
}

export async function fetchEnterpriseAuditExport(
  options: FetchEnterpriseAuditExportOptions = {}
): Promise<string> {
  const params = new URLSearchParams();
  appendPositiveIntegerParam(params, 'limit', options.limit);
  const query = params.toString();
  const res = await serverFetch(
    `/api/enterprise/audit-export.ndjson${query ? `?${query}` : ''}`,
    {
      headers: { Accept: 'application/x-ndjson, text/plain;q=0.9, */*;q=0.1' },
    }
  );
  if (!res.ok) {
    throw new Error(`Enterprise audit export request failed (HTTP ${res.status})`);
  }
  return res.text();
}

export async function fetchEnterpriseReadinessReceipt(): Promise<EnterpriseReadinessReceipt> {
  const res = await serverFetch('/api/enterprise/readiness-receipt', {
    headers: { Accept: 'application/json' },
  });
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok || !body || typeof body !== 'object') {
    throw new Error(`Enterprise readiness receipt request failed (HTTP ${res.status})`);
  }
  return body as EnterpriseReadinessReceipt;
}

async function stableDatasetCacheKey(source: string): Promise<string | null> {
  try {
    if (!globalThis.crypto?.subtle) return null;
    const bytes = new TextEncoder().encode(source);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    const hex = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `auth:${hex.slice(0, 24)}`;
  } catch {
    return null;
  }
}

export async function datasetCacheKey(token: string | null): Promise<string | null> {
  if (token) return stableDatasetCacheKey(`bearer:${token}`);
  if (enterpriseDatasetCacheKeyHint) {
    return stableDatasetCacheKey(`session:${enterpriseDatasetCacheKeyHint}`);
  }
  return 'live';
}

// Fetch + parse the dataset in a Web Worker so the ~8 MB JSON.parse runs off the
// main thread (#162) — the spinner stays smooth and the parse doesn't compete
// with the React commit. Resolves the parsed dataset; rejects on fetch/parse
// failure (the caller's try/catch falls back to manual upload). The worker is
// one-shot and terminated as soon as it replies. This is the ONLY importer of
// dataset-worker.ts, so the worker chunk is absent from the SPA bundle.
async function fetchDatasetViaWorker(
  url: string,
  onFresh?: (data: unknown) => void
): Promise<unknown> {
  const token = getEnterpriseAuthToken();
  const cacheKey = await datasetCacheKey(token);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./dataset-worker.ts', import.meta.url), {
      type: 'module',
    });
    let resolved = false;
    worker.onmessage = (
      e: MessageEvent<{ type?: string; data?: unknown; error?: string }>
    ) => {
      const msg = e.data;
      switch (msg.type) {
        case 'cached':
          // Stale-while-revalidate (#1015): resolve with the cached dataset for
          // an instant paint; the worker keeps running to revalidate and a
          // changed dataset arrives via onFresh.
          if (!resolved) {
            resolved = true;
            resolve(msg.data);
          }
          break;
        case 'fresh':
          if (!resolved) {
            resolved = true;
            resolve(msg.data);
          } else {
            onFresh?.(msg.data);
          }
          worker.terminate();
          break;
        case 'unchanged':
          // 304 — the cached dataset we already resolved is current.
          worker.terminate();
          break;
        default:
          worker.terminate();
          if (!resolved) reject(new Error(msg.error ?? 'dataset worker failed'));
          break;
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      if (!resolved) {
        reject(e.error instanceof Error ? e.error : new Error('dataset worker failed'));
      }
    };
    worker.postMessage({
      url,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cacheKey,
    });
  });
}

/**
 * Load the pre-aggregated dataset from the live backend. Resolves with the first
 * available data — the IndexedDB-cached dataset for an instant repeat load, else
 * the freshly fetched one. When a cached dataset is painted first, `onFresh` is
 * called later with the revalidated data if the server's dataset changed.
 * Rejects only when there is no data to show at all.
 */
export function fetchDataset(
  onFresh?: (data: unknown) => void
): Promise<unknown> {
  return fetchDatasetViaWorker('/api/dataset.json', onFresh);
}

/**
 * Fetch the live plan usage. Resolves to a typed `Usage`; never rejects — a
 * network failure or non-OK response collapses to `{ available: false }` so the
 * BudgetGauge degrades quietly.
 */
export async function fetchUsage(): Promise<Usage> {
  try {
    const res = await serverFetch('/api/usage');
    if (!res.ok) {
      return { available: false, reason: 'client-error' };
    }
    const data = (await res.json()) as Usage;
    if (data && (data.available === true || data.available === false)) {
      return data;
    }
    return { available: false, reason: 'client-error' };
  } catch {
    return { available: false, reason: 'client-error' };
  }
}

/**
 * Poll the in-flight live session. Resolves the raw `/api/live` payload
 * (`{ active: false }` or the active shape); never rejects — a transient
 * failure resolves to `null` so the widget hides rather than freezing.
 */
export async function fetchLive(): Promise<unknown> {
  try {
    const res = await serverFetch('/api/live');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Fetch per-project agent memories (#458). Resolves the raw `/api/memories`
 * payload (project-grouped raw markdown); never rejects — a transient failure
 * collapses to `{ projects: [] }` so the view shows its empty state.
 */
export async function fetchMemories(): Promise<MemoriesResponse> {
  try {
    const res = await serverFetch('/api/memories');
    if (!res.ok) return { projects: [] };
    return (await res.json()) as MemoriesResponse;
  } catch {
    return { projects: [] };
  }
}

/**
 * Fetch the Workflow-tool run ledger (#435). Resolves the raw `/api/workflows`
 * payload (server-projected runs); never rejects — a transient failure collapses
 * to `{ runs: [] }` so the view shows its empty state.
 */
export async function fetchWorkflows(): Promise<WorkflowsResponse> {
  try {
    const res = await serverFetch('/api/workflows');
    if (!res.ok) return { runs: [] };
    return (await res.json()) as WorkflowsResponse;
  } catch {
    return { runs: [] };
  }
}

/** Fetch the server-projected daily digest for one local date. */
export async function fetchDigest(date: string): Promise<DailyDigest> {
  const query = new URLSearchParams({ date });
  const res = await serverFetch(`/api/digest?${query.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Digest request failed (HTTP ${res.status})`);
  return (await res.json()) as DailyDigest;
}

export async function fetchHybridSearch(
  searchQuery: string,
  options: { project?: string; limit?: number; signal?: AbortSignal } = {}
): Promise<HybridSearchResponse> {
  const params = new URLSearchParams({ q: searchQuery });
  if (options.project) params.set('project', options.project);
  if (options.limit) params.set('limit', String(options.limit));
  const res = await serverFetch(`/api/search?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    signal: options.signal,
  });
  if (!res.ok) throw new Error(`Search request failed (HTTP ${res.status})`);
  return (await res.json()) as HybridSearchResponse;
}

/** Run opt-in tier-3 judge/audit checks. Never called on dataset load. */
export async function fetchAuditRun(): Promise<AuditRunResponse> {
  const res = await serverFetch('/api/audit.json', {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Audit request failed (HTTP ${res.status})`);
  const body = (await res.json()) as {
    status?: unknown;
    reason?: unknown;
    disabled?: unknown;
    findings?: unknown;
  };
  const findings = Array.isArray(body.findings)
    ? (body.findings as AuditFinding[])
    : [];
  const status =
    body.status === 'ran' ||
    body.status === 'skipped' ||
    body.status === 'failed'
      ? body.status
      : body.disabled === true
        ? 'skipped'
        : 'ran';
  return {
    status,
    ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
    findings,
  };
}

/** Fetch opt-in tier-3 judge/audit findings. Never called on dataset load. */
export async function fetchAuditFindings(): Promise<AuditFinding[]> {
  return (await fetchAuditRun()).findings;
}

/**
 * Read the append-only recs adoption receipts (#575/#577). Returns the
 * sanitized `SURFACED`/`SUPPRESSED` records the Adoption Scorecard joins. Never
 * called on dataset load; the server route is read-only.
 */
export async function fetchAdoptionReceipts(): Promise<AdoptionReceipt[]> {
  const res = await serverFetch('/api/adoption/receipts', {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Adoption receipts request failed (HTTP ${res.status})`);
  }
  const body = (await res.json()) as { receipts?: unknown };
  return Array.isArray(body.receipts)
    ? (body.receipts as AdoptionReceipt[])
    : [];
}

/**
 * Read the per-rule PreToolUse-steer telemetry rollup (#2203): fire-count +
 * followed/ignored + misfire tags, aggregated from the existing steer log. The
 * server route is read-only; never called on dataset load. The `/api/steer-telemetry`
 * literal is owned here so the SPA build (aliased to api-client.spa.ts) carries
 * no server string — the spa-boundary gate depends on it.
 */
export async function fetchSteerTelemetry(): Promise<SteerRuleTelemetry[]> {
  const res = await serverFetch('/api/steer-telemetry', {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Steer telemetry request failed (HTTP ${res.status})`);
  }
  const body = (await res.json()) as { records?: unknown };
  return Array.isArray(body.records) ? (body.records as SteerRuleTelemetry[]) : [];
}

/**
 * Fetch one session's FULL timeline (#1035/#1284). The bulk dataset ships slim
 * timelines (`summary` stripped); the SessionTimeline detail
 * view hydrates the selected session through this lazy endpoint. null = the
 * server has no row for the session (404).
 */
export async function fetchSessionTimeline(
  sessionId: string,
  signal?: AbortSignal
): Promise<SessionTimeline | null> {
  const resp = await serverFetch(
    `/api/session/${encodeURIComponent(sessionId)}/timeline.json`,
    signal ? { signal } : {}
  );
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()) as SessionTimeline;
}

/** Fetch one session's FULL tool calls, including Bash `input.command`. */
export async function fetchSessionTools(
  sessionId: string,
  signal?: AbortSignal
): Promise<ToolUsageData | null> {
  const resp = await serverFetch(
    `/api/session/${encodeURIComponent(sessionId)}/tools.json`,
    signal ? { signal } : {}
  );
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()) as ToolUsageData;
}

/** Fetch the stored assistant transcript content blocks (null = none / 404). */
export async function fetchTranscriptContent(
  sessionId: string,
  signal?: AbortSignal
): Promise<unknown[] | null> {
  const resp = await serverFetch(
    `/api/transcript/${encodeURIComponent(sessionId)}`,
    signal ? { signal } : {}
  );
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()) as unknown[];
}

/** Fetch the stored thinking blocks for a session (null = none / 404). */
export async function fetchTranscriptThinking(
  sessionId: string
): Promise<unknown[] | null> {
  const resp = await serverFetch(
    `/api/transcript/${encodeURIComponent(sessionId)}/thinking`
  );
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()) as unknown[];
}

/** Fetch a raw source-scoped session JSONL blob (null = missing / 404). */
export async function fetchSourceSessionJsonl(
  sourceId: string,
  project: string,
  file: string,
  signal?: AbortSignal
): Promise<string | null> {
  const resp = await serverFetch(
    `/api/sources/${encodeURIComponent(sourceId)}/sessions/${encodeURIComponent(project)}/${encodeURIComponent(file)}`,
    signal ? { signal } : {}
  );
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

/** Fetch a raw source-scoped history JSONL blob (null = missing / 404). */
export async function fetchSourceHistoryJsonl(
  sourceId: string,
  signal?: AbortSignal
): Promise<string | null> {
  const resp = await serverFetch(
    `/api/sources/${encodeURIComponent(sourceId)}/history.jsonl`,
    signal ? { signal } : {}
  );
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

/**
 * Write a permissions diff to the global `~/.claude/settings.json`. Fetches the
 * per-process CSRF token (#308) then POSTs the payload with it. Both the
 * `/api/csrf-token` and `/api/policy/write` literals are owned here. Resolves a
 * normalized result; never rejects.
 */
export async function writePolicy(payload: unknown): Promise<PolicyWriteResult> {
  let token: string;
  try {
    const tokenRes = await serverFetch('/api/csrf-token', {
      headers: { Accept: 'application/json' },
    });
    const tokenBody = (await tokenRes.json().catch(() => null)) as
      | { token?: string }
      | null;
    if (!tokenRes.ok || !tokenBody?.token) {
      return {
        ok: false,
        error: `Could not obtain auth token (HTTP ${tokenRes.status})`,
      };
    }
    token = tokenBody.token;
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : 'Network error while obtaining auth token',
    };
  }
  try {
    const res = await serverFetch('/api/policy/write', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
      },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => null)) as PolicyWriteResult | null;
    if (!res.ok || !body?.ok) {
      return { ok: false, error: body?.error || `Write failed (HTTP ${res.status})` };
    }
    return {
      ok: true,
      addedCount: body.addedCount,
      backup: body.backup ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : 'Network error while writing settings.json',
    };
  }
}

/** Client-facing outcome of writing a recommendation reject signal (#1294). */
export type RejectSignalWriteResult = { ok: true } | { ok: false; error: string };

/**
 * Record that the user rejected a recommendation, with a reason
 * (`dismiss` / `wrong` / `not-relevant`). Fetches the per-process CSRF token
 * then POSTs to the capture route. The `/api/recommendations/reject` literal is
 * owned here so the SPA build (aliased to api-client.spa.ts, which no-ops this)
 * carries no server string — the spa-boundary gate depends on it. Resolves a
 * normalized result; never rejects.
 */
export async function postRejectSignal(
  findingId: string,
  reason: RejectReason
): Promise<RejectSignalWriteResult> {
  const token = await csrfToken();
  if (!token) return { ok: false, error: 'Could not obtain auth token' };
  try {
    const res = await serverFetch('/api/recommendations/reject', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
      },
      body: JSON.stringify({ findingId, reason }),
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!res.ok || !body?.ok) {
      return { ok: false, error: body?.error || `Reject failed (HTTP ${res.status})` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Network error while recording reject signal',
    };
  }
}

/** Client-facing outcome of persisting checkpoint answer-time instrumentation. */
export type CheckpointAnswerWriteResult =
  | { ok: true; written: true }
  | { ok: false; error: string };

/**
 * Persist one sanitized checkpoint answer through the CSRF-protected server
 * route. The SPA alias no-ops this method and contains no server-route literal.
 * Resolves a normalized result and never rejects.
 */
export async function postCheckpointAnswer(
  record: CheckpointAnswerRecord
): Promise<CheckpointAnswerWriteResult> {
  const token = await csrfToken();
  if (!token) return { ok: false, error: 'Could not obtain auth token' };
  try {
    const response = await serverFetch('/api/checkpoint/answers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
      },
      body: JSON.stringify(record),
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
    } | null;
    if (!response.ok || !body?.ok) {
      return {
        ok: false,
        error: body?.error || `Checkpoint answer write failed (HTTP ${response.status})`,
      };
    }
    return { ok: true, written: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error
        ? error.message
        : 'Network error while recording checkpoint answer',
    };
  }
}

/**
 * Tier A "Analyze locally" (#2319, ADR 0018). POST the current recommendation
 * scope to the server, which runs a LOCAL model over the SAME deterministic
 * recommendation call sites. The `/api/analyze/local` literal is owned ONLY here
 * so the SPA build (aliased to api-client.spa.ts) carries no server string — the
 * spa-boundary gate depends on it.
 *
 * Governance: the server route's only egress is a loopback local model; there is
 * NO Anthropic fallback. Never rejects — a down server or an unreachable local
 * model both collapse to a `source: 'deterministic'` result so the surface
 * degrades gracefully instead of erroring.
 */
export async function analyzeLocal(
  options: { project?: string | null; signal?: AbortSignal } = {}
): Promise<LocalAnalyzeResult> {
  try {
    const res = await serverFetch('/api/analyze/local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ project: options.project ?? null }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!res.ok) {
      return {
        source: 'deterministic',
        recommendations: [],
        analysis: null,
        model: null,
        reason: `Analyze request failed (HTTP ${res.status})`,
      };
    }
    return (await res.json()) as LocalAnalyzeResult;
  } catch (err) {
    return {
      source: 'deterministic',
      recommendations: [],
      analysis: null,
      model: null,
      reason: err instanceof Error ? err.message : 'Network error while analyzing',
    };
  }
}

// --- Session provisioning (#1251, Slice 1) -------------------------------------------------------
// The `/api/sessions` literals are owned ONLY here so the SPA build (aliased to api-client.spa.ts)
// carries no server strings — the spa-boundary gate depends on it.

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

// List dispatched sessions. Never rejects: a down/absent backend resolves to configured:false.
export async function fetchRemoteSessions(): Promise<RemoteSessionsResult> {
  try {
    const res = await serverFetch('/api/sessions', { headers: { Accept: 'application/json' } });
    const body = (await res.json().catch(() => null)) as RemoteSessionsResult | null;
    if (!res.ok || !body) {
      return { ok: false, configured: false, sessions: [], error: `HTTP ${res.status}` };
    }
    return { ...body, sessions: body.sessions ?? [], configured: body.configured ?? false };
  } catch (err) {
    return {
      ok: false,
      configured: false,
      sessions: [],
      error: err instanceof Error ? err.message : 'Network error',
    };
  }
}

async function csrfToken(): Promise<string | null> {
  try {
    const res = await serverFetch('/api/csrf-token', { headers: { Accept: 'application/json' } });
    const body = (await res.json().catch(() => null)) as { token?: string } | null;
    return res.ok && body?.token ? body.token : null;
  } catch {
    return null;
  }
}

// Create (provision) a session pool. Never rejects.
export async function createRemoteSession(
  input: CreateRemoteSessionInput
): Promise<CreateRemoteSessionResult> {
  const token = await csrfToken();
  if (!token) return { ok: false, error: 'Could not obtain auth token' };
  try {
    const res = await serverFetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => null)) as CreateRemoteSessionResult | null;
    if (!res.ok || !body?.ok) {
      return { ok: false, error: body?.error || `Provision failed (HTTP ${res.status})` };
    }
    return body;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

// Delete a session pool by name. Never rejects.
export async function deleteRemoteSession(name: string): Promise<{ ok: boolean; error?: string }> {
  const token = await csrfToken();
  if (!token) return { ok: false, error: 'Could not obtain auth token' };
  try {
    const res = await serverFetch(`/api/sessions/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!res.ok || !body?.ok) {
      return { ok: false, error: body?.error || `Delete failed (HTTP ${res.status})` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

/** Legacy `/history.jsonl` fallback fetch (unused by the live flow; kept here so
 * the literal lives only in the aliased-away module). Resolves [] on failure. */
export async function loadDefaultHistory(): Promise<HistoryEntry[]> {
  try {
    const resp = await serverFetch('/history.jsonl');
    if (!resp.ok) return [];
    const text = await resp.text();
    return parseHistoryJsonl(text);
  } catch {
    return [];
  }
}
