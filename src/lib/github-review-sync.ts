/**
 * Server-only GitHub review-event sync (#1127).
 *
 * The exported dataset is intentionally transcript-free: it contains PR ids,
 * reviewer logins, request state, and timestamps, never prompt or transcript
 * content. The dashboard server calls this module from scripts/ingest.mjs; it is
 * not imported by the SPA bundle.
 */
import { readTextFileCappedSync as cappedRead } from './capped-read';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type {
  OrganizationReviewEventsDataset,
  PullRequestReviewRequest,
} from './organization-review-events';

type Env = Record<string, string | undefined>;
type Obj = Record<string, unknown>;

export const GITHUB_REVIEW_SYNC_SOURCE = 'github-review-sync';

const DEFAULT_API_BASE_URL = 'https://api.github.com';
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_REPOS_MAX_BYTES = 8_192;
const DEFAULT_MAX_REPOS = 25;
const DEFAULT_MAX_PULLS_PER_REPO = 100;
const DEFAULT_MAX_TIMELINE_REQUESTS = 100;
const DEFAULT_TIMELINE_CONCURRENCY = 4;
const DEFAULT_SYNC_DEADLINE_MS = 15_000;
const DEFAULT_MAX_TIMELINE_EVENTS_PER_PR = 100;
const DEFAULT_MAX_RECORDS = 5_000;

export interface GitHubReviewRepo {
  owner: string;
  name: string;
  fullName: string;
}

export interface GitHubReviewSyncConfig {
  enabled: boolean;
  disabledReason?: string;
  source: typeof GITHUB_REVIEW_SYNC_SOURCE;
  apiBaseUrl: string;
  token: string;
  repos: GitHubReviewRepo[];
  cachePath: string;
  cacheTtlMs: number;
  fetchTimeoutMs: number;
  maxResponseBytes: number;
  reposMaxBytes: number;
  maxRepos: number;
  maxPullsPerRepo: number;
  maxTimelineRequests: number;
  timelineConcurrency: number;
  syncDeadlineMs: number;
  maxTimelineEventsPerPr: number;
  maxRecords: number;
  configHash: string;
}

export interface GitHubReviewSyncConfigOptions {
  cachePath: string;
}

export interface GitHubReviewSyncFetchOptions {
  fetchImpl?: FetchLike;
  nowMs?: number;
}

export interface GitHubReviewEventsCacheRead {
  dataset: OrganizationReviewEventsDataset;
  mtimeMs: number;
  size: number;
}

type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};
type FetchLike = (url: string, init: FetchInit) => Promise<Response>;

interface CacheEnvelope {
  schemaVersion: 1;
  source: typeof GITHUB_REVIEW_SYNC_SOURCE;
  configHash: string;
  dataset: OrganizationReviewEventsDataset;
}

function asObj(value: unknown): Obj {
  return value && typeof value === 'object' ? (value as Obj) : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseNonNegativeIntEnv(env: Env, name: string, fallback: number): number {
  const raw = String(env[name] ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function replaceControlChars(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    out += code <= 31 || code === 127 ? ' ' : char;
  }
  return out;
}

function boundedString(value: unknown, maxChars: number): string | undefined {
  const text = replaceControlChars(stringValue(value)).trim();
  if (!text) return undefined;
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function normalizeReviewerKey(login: string): string {
  return login.trim().toLowerCase();
}

function parseRepoList(raw: string, maxBytes: number, maxRepos: number): GitHubReviewRepo[] {
  if (!raw || Buffer.byteLength(raw, 'utf8') > maxBytes) return [];
  const repos: GitHubReviewRepo[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[\n,]+/)) {
    if (repos.length >= maxRepos) break;
    const text = part.trim();
    const match = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(text);
    if (!match) continue;
    const fullName = `${match[1]}/${match[2]}`;
    const key = fullName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    repos.push({ owner: match[1], name: match[2], fullName });
  }
  return repos;
}

function normalizeApiBaseUrl(raw: string): string {
  const text = raw.trim() || DEFAULT_API_BASE_URL;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' || url.username || url.password) return '';
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

function configHashFor(config: {
  apiBaseUrl: string;
  token: string;
  repos: GitHubReviewRepo[];
  maxPullsPerRepo: number;
  maxTimelineRequests: number;
  timelineConcurrency: number;
  syncDeadlineMs: number;
  maxTimelineEventsPerPr: number;
  maxRecords: number;
}): string {
  const tokenFingerprint = createHash('sha256')
    .update(config.token)
    .digest('hex')
    .slice(0, 24);
  return createHash('sha256')
    .update(
      JSON.stringify({
        apiBaseUrl: config.apiBaseUrl,
        tokenFingerprint,
        repos: config.repos.map((repo) => repo.fullName.toLowerCase()).sort(),
        maxPullsPerRepo: config.maxPullsPerRepo,
        maxTimelineRequests: config.maxTimelineRequests,
        timelineConcurrency: config.timelineConcurrency,
        syncDeadlineMs: config.syncDeadlineMs,
        maxTimelineEventsPerPr: config.maxTimelineEventsPerPr,
        maxRecords: config.maxRecords,
      })
    )
    .digest('hex')
    .slice(0, 24);
}

export function parseGitHubReviewSyncConfig(
  env: Env = {},
  opts: GitHubReviewSyncConfigOptions
): GitHubReviewSyncConfig {
  const source = String(env.DASHBOARD_REVIEW_EVENTS_SOURCE ?? '').trim().toLowerCase();
  const token = String(env.DASHBOARD_GITHUB_REVIEW_TOKEN ?? '').trim();
  const reposMaxBytes = clampInt(
    parseNonNegativeIntEnv(
      env,
      'DASHBOARD_GITHUB_REVIEW_REPOS_MAX_BYTES',
      DEFAULT_REPOS_MAX_BYTES
    ),
    128,
    1_048_576
  );
  const maxRepos = clampInt(
    parseNonNegativeIntEnv(env, 'DASHBOARD_GITHUB_REVIEW_MAX_REPOS', DEFAULT_MAX_REPOS),
    1,
    1_000
  );
  const repos = parseRepoList(
    String(env.DASHBOARD_GITHUB_REVIEW_REPOS ?? ''),
    reposMaxBytes,
    maxRepos
  );
  const apiBaseUrl = normalizeApiBaseUrl(
    String(env.DASHBOARD_GITHUB_REVIEW_API_BASE ?? DEFAULT_API_BASE_URL)
  );
  const cacheTtlMs = clampInt(
    parseNonNegativeIntEnv(env, 'DASHBOARD_GITHUB_REVIEW_CACHE_TTL_MS', DEFAULT_CACHE_TTL_MS),
    0,
    86_400_000
  );
  const fetchTimeoutMs = clampInt(
    parseNonNegativeIntEnv(
      env,
      'DASHBOARD_GITHUB_REVIEW_FETCH_TIMEOUT_MS',
      DEFAULT_FETCH_TIMEOUT_MS
    ),
    100,
    60_000
  );
  const maxResponseBytes = clampInt(
    parseNonNegativeIntEnv(
      env,
      'DASHBOARD_GITHUB_REVIEW_MAX_RESPONSE_BYTES',
      DEFAULT_MAX_RESPONSE_BYTES
    ),
    1_024,
    16_777_216
  );
  const maxPullsPerRepo = clampInt(
    parseNonNegativeIntEnv(
      env,
      'DASHBOARD_GITHUB_REVIEW_MAX_PULLS_PER_REPO',
      DEFAULT_MAX_PULLS_PER_REPO
    ),
    1,
    100
  );
  const maxTimelineRequests = clampInt(
    parseNonNegativeIntEnv(
      env,
      'DASHBOARD_GITHUB_REVIEW_MAX_TIMELINE_REQUESTS',
      DEFAULT_MAX_TIMELINE_REQUESTS
    ),
    1,
    10_000
  );
  const timelineConcurrency = clampInt(
    parseNonNegativeIntEnv(
      env,
      'DASHBOARD_GITHUB_REVIEW_TIMELINE_CONCURRENCY',
      DEFAULT_TIMELINE_CONCURRENCY
    ),
    1,
    16
  );
  const syncDeadlineMs = clampInt(
    parseNonNegativeIntEnv(
      env,
      'DASHBOARD_GITHUB_REVIEW_SYNC_DEADLINE_MS',
      DEFAULT_SYNC_DEADLINE_MS
    ),
    100,
    300_000
  );
  const maxTimelineEventsPerPr = clampInt(
    parseNonNegativeIntEnv(
      env,
      'DASHBOARD_GITHUB_REVIEW_MAX_TIMELINE_EVENTS_PER_PR',
      DEFAULT_MAX_TIMELINE_EVENTS_PER_PR
    ),
    1,
    100
  );
  const maxRecords = clampInt(
    parseNonNegativeIntEnv(env, 'DASHBOARD_GITHUB_REVIEW_MAX_RECORDS', DEFAULT_MAX_RECORDS),
    1,
    100_000
  );
  const hash = configHashFor({
    apiBaseUrl,
    token,
    repos,
    maxPullsPerRepo,
    maxTimelineRequests,
    timelineConcurrency,
    syncDeadlineMs,
    maxTimelineEventsPerPr,
    maxRecords,
  });

  let disabledReason = '';
  if (source !== 'github') disabledReason = 'source_not_github';
  else if (!apiBaseUrl) disabledReason = 'invalid_api_base';
  else if (!token) disabledReason = 'missing_token';
  else if (repos.length === 0) disabledReason = 'missing_repos';

  return {
    enabled: !disabledReason,
    ...(disabledReason ? { disabledReason } : {}),
    source: GITHUB_REVIEW_SYNC_SOURCE,
    apiBaseUrl,
    token,
    repos,
    cachePath: opts.cachePath,
    cacheTtlMs,
    fetchTimeoutMs,
    maxResponseBytes,
    reposMaxBytes,
    maxRepos,
    maxPullsPerRepo,
    maxTimelineRequests,
    timelineConcurrency,
    syncDeadlineMs,
    maxTimelineEventsPerPr,
    maxRecords,
    configHash: hash,
  };
}

function apiUrl(config: GitHubReviewSyncConfig, path: string, params: Record<string, string>): string {
  const url = new URL(`${config.apiBaseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function authHeaders(config: GitHubReviewSyncConfig): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${config.token}`,
    'user-agent': 'claude-history-dashboard',
    'x-github-api-version': '2022-11-28',
  };
}

async function fetchWithTimeout<T>(
  fetchImpl: FetchLike,
  url: string,
  init: FetchInit,
  timeoutMs: number,
  syncSignal: AbortSignal | undefined,
  consumeResponse: (response: Response) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const abortForSync = () => controller.abort(syncSignal?.reason);
  if (syncSignal?.aborted) abortForSync();
  else syncSignal?.addEventListener('abort', abortForSync, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    return await consumeResponse(response);
  } finally {
    clearTimeout(timer);
    syncSignal?.removeEventListener('abort', abortForSync);
  }
}

async function responseTextBounded(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`GitHub response exceeds ${maxBytes} byte limit`);
    }
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw new Error(`GitHub response exceeds ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function fetchJsonArray(
  config: GitHubReviewSyncConfig,
  fetchImpl: FetchLike,
  url: string,
  syncSignal?: AbortSignal
): Promise<unknown[]> {
  return await fetchWithTimeout(
    fetchImpl,
    url,
    { method: 'GET', headers: authHeaders(config) },
    config.fetchTimeoutMs,
    syncSignal,
    async (response) => {
      const text = await responseTextBounded(response, config.maxResponseBytes);
      if (!response.ok) {
        throw new Error(`GitHub review sync request failed with ${response.status}`);
      }
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [];
    }
  );
}

function currentRequestedReviewers(pull: Obj): string[] {
  const reviewers = Array.isArray(pull.requested_reviewers)
    ? pull.requested_reviewers
    : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const reviewer of reviewers) {
    const login = boundedString(asObj(reviewer).login, 256);
    if (!login) continue;
    const key = normalizeReviewerKey(login);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(login);
  }
  return out;
}

function reviewRequestTimesByReviewer(
  timeline: unknown[],
  pendingReviewerKeys: Set<string>
): Map<string, string> {
  const requestedAtByReviewer = new Map<string, string>();
  for (const entry of timeline) {
    const event = asObj(entry);
    if (event.event !== 'review_requested') continue;
    const login = boundedString(asObj(event.requested_reviewer).login, 256);
    const createdAt = boundedString(event.created_at, 64);
    if (!login || !createdAt) continue;
    const key = normalizeReviewerKey(login);
    if (!pendingReviewerKeys.has(key)) continue;
    const ms = Date.parse(createdAt);
    if (!Number.isFinite(ms)) continue;
    requestedAtByReviewer.set(key, new Date(ms).toISOString());
  }
  return requestedAtByReviewer;
}

function requestRecord(
  repo: GitHubReviewRepo,
  pull: Obj,
  reviewerId: string,
  requestedAt: string
): PullRequestReviewRequest | null {
  const number = Number(pull.number);
  if (!Number.isInteger(number) || number <= 0) return null;
  return {
    id: `github:${repo.fullName}#${number}:review-request:${normalizeReviewerKey(reviewerId)}:${requestedAt}`,
    repository: repo.fullName,
    pullRequestNumber: number,
    pullRequestTitle: boundedString(pull.title, 512),
    pullRequestUrl: boundedString(pull.html_url, 2_048),
    pullRequestState: 'open',
    authorId: boundedString(asObj(pull.user).login, 256),
    reviewerId,
    reviewerDisplayName: reviewerId,
    requestedAt,
    state: 'pending',
  };
}

async function fetchRepoReviewRequests(
  config: GitHubReviewSyncConfig,
  fetchImpl: FetchLike,
  repo: GitHubReviewRepo,
  remainingRecords: number,
  remainingTimelineRequests: number,
  syncSignal: AbortSignal
): Promise<{ records: PullRequestReviewRequest[]; timelineRequests: number }> {
  const pullsUrl = apiUrl(
    config,
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pulls`,
    {
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: String(config.maxPullsPerRepo),
    }
  );
  const pulls = await fetchJsonArray(config, fetchImpl, pullsUrl, syncSignal);
  const records: PullRequestReviewRequest[] = [];
  const jobs: Array<{
    pull: Obj;
    pendingReviewers: string[];
    pendingKeys: Set<string>;
    timelineUrl: string;
  }> = [];
  for (const rawPull of pulls.slice(0, config.maxPullsPerRepo)) {
    if (jobs.length >= remainingTimelineRequests) break;
    const pull = asObj(rawPull);
    const pendingReviewers = currentRequestedReviewers(pull);
    if (!pendingReviewers.length) continue;
    const number = Number(pull.number);
    if (!Number.isInteger(number) || number <= 0) continue;
    // perf-index-contract: github-pending-reviewers always-consumed: every scheduled timeline immediately queries this complete reviewer membership set
    const pendingKeys = new Set(pendingReviewers.map(normalizeReviewerKey));
    const timelineUrl = apiUrl(
      config,
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/issues/${number}/timeline`,
      { per_page: String(config.maxTimelineEventsPerPr) }
    );
    jobs.push({ pull, pendingReviewers, pendingKeys, timelineUrl });
  }

  const timelines: unknown[][] = new Array(jobs.length);
  let nextJobIndex = 0;
  const worker = async () => {
    while (nextJobIndex < jobs.length) {
      const jobIndex = nextJobIndex;
      nextJobIndex += 1;
      timelines[jobIndex] = await fetchJsonArray(
        config,
        fetchImpl,
        jobs[jobIndex].timelineUrl,
        syncSignal
      );
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(config.timelineConcurrency, jobs.length) },
      worker
    )
  );

  for (let jobIndex = 0; jobIndex < jobs.length; jobIndex += 1) {
    const job = jobs[jobIndex];
    const requestedAtByReviewer = reviewRequestTimesByReviewer(
      timelines[jobIndex],
      job.pendingKeys
    );
    for (const reviewerId of job.pendingReviewers) {
      if (records.length >= remainingRecords) break;
      const requestedAt = requestedAtByReviewer.get(
        normalizeReviewerKey(reviewerId)
      );
      if (!requestedAt) continue;
      const record = requestRecord(repo, job.pull, reviewerId, requestedAt);
      if (record) records.push(record);
    }
    if (records.length >= remainingRecords) break;
  }
  return { records, timelineRequests: jobs.length };
}

export async function fetchGitHubReviewEvents(
  config: GitHubReviewSyncConfig,
  opts: GitHubReviewSyncFetchOptions = {}
): Promise<OrganizationReviewEventsDataset | null> {
  if (!config.enabled) return null;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new Error('fetch is unavailable for GitHub review sync');
  const syncController = new AbortController();
  const deadline = setTimeout(
    () =>
      syncController.abort(
        new Error(
          `GitHub review synchronization exceeded ${config.syncDeadlineMs} ms deadline`
        )
      ),
    config.syncDeadlineMs
  );
  try {
    const reviewRequests: PullRequestReviewRequest[] = [];
    let timelineRequests = 0;
    for (const repo of config.repos) {
      if (reviewRequests.length >= config.maxRecords) break;
      if (timelineRequests >= config.maxTimelineRequests) break;
      const remaining = config.maxRecords - reviewRequests.length;
      const result = await fetchRepoReviewRequests(
        config,
        fetchImpl,
        repo,
        remaining,
        config.maxTimelineRequests - timelineRequests,
        syncController.signal
      );
      timelineRequests += result.timelineRequests;
      const records = result.records;
      reviewRequests.push(...records);
    }
    // perf-index-contract: github-review-record-order always-consumed: every successful synchronization immediately returns the complete deterministically sorted review-request list
    reviewRequests.sort(
      (a, b) =>
        a.repository.localeCompare(b.repository) ||
        a.pullRequestNumber - b.pullRequestNumber ||
        a.reviewerId.localeCompare(b.reviewerId)
    );
    return {
      source: GITHUB_REVIEW_SYNC_SOURCE,
      generatedAt: new Date(opts.nowMs ?? Date.now()).toISOString(),
      reviewRequests,
    };
  } finally {
    clearTimeout(deadline);
    if (!syncController.signal.aborted) {
      syncController.abort(
        new Error('GitHub review synchronization settled')
      );
    }
  }
}

/** Bounded read of the review-events cache; loop shared via capped-read (#3419). */
function readTextFileCappedSync(path: string, maxBytes: number): string {
  return cappedRead(path, maxBytes, (limit) =>
    new Error(`Review events cache exceeds ${limit} byte limit`)
  );
}

function isReviewRequest(value: unknown): value is PullRequestReviewRequest {
  const record = asObj(value);
  return (
    typeof record.repository === 'string' &&
    typeof record.pullRequestNumber === 'number' &&
    typeof record.reviewerId === 'string' &&
    typeof record.requestedAt === 'string' &&
    record.state === 'pending'
  );
}

function isReviewEventsDataset(value: unknown): value is OrganizationReviewEventsDataset {
  const dataset = asObj(value);
  return Array.isArray(dataset.reviewRequests) && dataset.reviewRequests.every(isReviewRequest);
}

function parseCacheEnvelope(raw: unknown): CacheEnvelope | null {
  const envelope = asObj(raw);
  if (envelope.schemaVersion !== 1) return null;
  if (envelope.source !== GITHUB_REVIEW_SYNC_SOURCE) return null;
  if (typeof envelope.configHash !== 'string') return null;
  if (!isReviewEventsDataset(envelope.dataset)) return null;
  return envelope as unknown as CacheEnvelope;
}

export function readGitHubReviewEventsCache(
  config: GitHubReviewSyncConfig
): GitHubReviewEventsCacheRead | null {
  if (!config.enabled || !config.cachePath || !existsSync(config.cachePath)) return null;
  try {
    const stat = statSync(config.cachePath);
    if (!stat.isFile()) return null;
    const text = readTextFileCappedSync(config.cachePath, config.maxResponseBytes);
    const envelope = parseCacheEnvelope(JSON.parse(text));
    if (!envelope || envelope.configHash !== config.configHash) return null;
    return {
      dataset: envelope.dataset,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  } catch {
    return null;
  }
}

export function writeGitHubReviewEventsCache(
  config: GitHubReviewSyncConfig,
  dataset: OrganizationReviewEventsDataset
): void {
  if (!config.enabled || !config.cachePath) return;
  const envelope: CacheEnvelope = {
    schemaVersion: 1,
    source: GITHUB_REVIEW_SYNC_SOURCE,
    configHash: config.configHash,
    dataset,
  };
  const body = JSON.stringify(envelope);
  if (Buffer.byteLength(body, 'utf8') > config.maxResponseBytes) {
    throw new Error(`Review events cache exceeds ${config.maxResponseBytes} byte limit`);
  }
  const dir = dirname(config.cachePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best effort on non-POSIX filesystems */
  }
  writeFileSync(config.cachePath, body, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(config.cachePath, 0o600);
  } catch {
    /* best effort */
  }
}

export async function refreshGitHubReviewEvents(
  config: GitHubReviewSyncConfig,
  opts: GitHubReviewSyncFetchOptions = {}
): Promise<OrganizationReviewEventsDataset | null> {
  if (!config.enabled) return null;
  const nowMs = opts.nowMs ?? Date.now();
  const cached = readGitHubReviewEventsCache(config);
  if (cached && config.cacheTtlMs > 0 && nowMs - cached.mtimeMs <= config.cacheTtlMs) {
    return cached.dataset;
  }
  try {
    const dataset = await fetchGitHubReviewEvents(config, { ...opts, nowMs });
    if (dataset) writeGitHubReviewEventsCache(config, dataset);
    return dataset;
  } catch {
    return cached?.dataset ?? null;
  }
}

export function gitHubReviewEventsCacheSignature(config: GitHubReviewSyncConfig): string {
  if (!config.enabled) {
    return `disabled:${config.disabledReason ?? 'disabled'}`;
  }
  try {
    const stat = statSync(config.cachePath);
    return `${config.configHash}:${Math.floor(stat.mtimeMs)}:${stat.size}`;
  } catch {
    return `${config.configHash}:absent`;
  }
}
