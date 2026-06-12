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
 * UI (Live widget, Policy write-back, Insights regenerate, transcript drill-in,
 * the "Reload from disk" control). It is `true` here and `false` in the stub.
 */
import type { HistoryEntry } from '../types';
import type { Usage } from './usage';
import type { MemoriesResponse } from './parse-memories';
import type { WorkflowsResponse } from './parse-workflows';
import type { AuditFinding } from './audit/types';
import type { AdoptionReceipt } from './adoption-receipts';
import type { SessionTimeline } from './parse-timeline';
import { parseHistoryJsonl } from './parse-history';

/** True in the server build; the SPA stub exports `false`. */
export const SERVER_AVAILABLE = true;

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

function serverFetch(
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
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as EnterpriseSession).authRequired === 'boolean' &&
    typeof (value as EnterpriseSession).authenticated === 'boolean'
  );
}

function isEnterpriseAuthStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 503;
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
    if (isEnterpriseSession(body)) {
      rememberEnterpriseSessionForCache(body);
      return body;
    }
    const authRequired = isEnterpriseAuthStatus(res.status);
    return {
      mode: authRequired ? 'enterprise' : 'single-user',
      authRequired,
      authenticated: res.ok,
      configured: res.status !== 503,
      principal: null,
      organization: null,
      capabilities: {},
      error: `Auth check failed (HTTP ${res.status})`,
    };
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
    if (isEnterpriseSession(body)) {
      rememberEnterpriseSessionForCache(body);
      return body;
    }
    return {
      mode: 'enterprise',
      authRequired: true,
      authenticated: false,
      configured: res.status !== 503,
      principal: null,
      organization: null,
      capabilities: {},
      error: `Auth check failed (HTTP ${res.status})`,
    };
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

async function datasetCacheKey(token: string | null): Promise<string | null> {
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

/** Fetch opt-in tier-3 judge/audit findings. Never called on dataset load. */
export async function fetchAuditFindings(): Promise<AuditFinding[]> {
  const res = await serverFetch('/api/audit.json', {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Audit request failed (HTTP ${res.status})`);
  const body = (await res.json()) as { findings?: unknown };
  return Array.isArray(body.findings) ? (body.findings as AuditFinding[]) : [];
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
