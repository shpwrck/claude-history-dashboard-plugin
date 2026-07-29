/**
 * doc-issue-fetch.ts — SERVER-ONLY GitHub issue-state fetch, credential read,
 * cache, and single-flight refresh for the opt-in `docIssueSnapshot` (#2710).
 *
 * This is the NODE half of the snapshot carrier; the browser-safe schema,
 * validation, normalization, and freshness predicates live in
 * `doc-issue-snapshot.ts`. It is invoked from `scripts/server.mjs` (async
 * refresh, in the request preamble) and `scripts/ingest.mjs` (sync validated
 * cache read only — ingest NEVER makes a network call). It is NOT imported by
 * the SPA bundle (it uses `node:fs`/`node:crypto` and the credential path).
 *
 * Design mirrors `github-review-sync.ts` (the #1127 review-events fetcher):
 * env-driven config with an `enabled` gate, an SSRF-fixed host, a slug guard, a
 * timeout + streamed byte cap, and an atomic 0600 cache. It DIVERGES where
 * #2710 requires it: GraphQL POST (not REST), a file-first credential that is
 * NEVER logged/persisted/serialized/HASHED, and a two-tier (15m reuse / 24h
 * max-usable) fail-closed freshness policy where an incomplete refresh can never
 * replace a complete cache or prove absence.
 *
 * Issues: #2710 (epic #2256 — doc artifact hygiene)
 */
import { readTextFileCappedSync as cappedRead } from './capped-read';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  DOC_ISSUE_MAX_REFS as SNAPSHOT_MAX_REFS,
  DOC_ISSUE_REUSE_MS,
  canonicalRefSet,
  docIssueSnapshotIdentity,
  docIssueSnapshotUsableThroughMs,
  isValidRepoSlug,
  normalizeIssueOrPrState,
  validateDocIssueSnapshot,
  isDocIssueSnapshotReusable,
  isDocIssueSnapshotUsable,
  type DocIssueRecord,
  type DocIssueSnapshot,
} from './doc-issue-snapshot';

type Env = Record<string, string | undefined>;

/** FIXED GraphQL host — never env-configurable, so an SSRF cannot redirect it. */
export const DOC_ISSUE_GRAPHQL_URL = 'https://api.github.com/graphql';
/** Cap on the number of distinct issue refs a single snapshot may resolve. */
export const DOC_ISSUE_MAX_REFS = SNAPSHOT_MAX_REFS;
/** GraphQL aliases per batched request. */
export const DOC_ISSUE_ALIASES_PER_BATCH = 50;

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const TOKEN_MAX_BYTES = 8_192;
const TOKEN_MAX_CHARS = 512;
/** Bound retry-throttle memory even if a doc graph cycles through many ref sets. */
export const DOC_ISSUE_RETRY_IDENTITIES_MAX = 256;
/** Bound same-process tombstones; retired cache files are also removed. */
export const DOC_ISSUE_RETIRED_IDENTITIES_MAX = 1024;

export interface DocIssueConfig {
  enabled: boolean;
  disabledReason?: string;
  /** Lowercased, validated `owner/repo`. */
  repo: string;
  /** The bearer credential. NEVER logged, persisted, serialized, or hashed. */
  token: string;
  /** Directory the per-repo snapshot cache file lives in. */
  cacheDir: string;
  fetchTimeoutMs: number;
  maxResponseBytes: number;
  maxRefs: number;
  aliasesPerBatch: number;
}

export interface DocIssueConfigOptions {
  /** Absolute directory for the snapshot cache (e.g. `<CHD_CACHE_DIR>/doc-issues`). */
  cacheDir: string;
}

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal };
type FetchLike = (url: string, init: FetchInit) => Promise<Response>;

export interface DocIssueFetchOptions {
  fetchImpl?: FetchLike;
  nowMs?: number;
}

// ── Credential read (file-first, capped, trimmed, never leaked) ──────────────

/** Bounded read of a doc-issue artifact; loop shared via capped-read (#3419). */
function readTextFileCappedSync(path: string, maxBytes: number): string {
  return cappedRead(path, maxBytes, (limit) =>
    new Error(`doc-issue read exceeds ${limit} byte limit`)
  );
}

/**
 * Read the credential FILE-FIRST: `CHD_DOC_ISSUES_TOKEN_FILE` (read capped +
 * trimmed) takes precedence over the inline `CHD_DOC_ISSUES_TOKEN`. An
 * unreadable/oversized file yields the empty string (→ suppressed), never a
 * throw. A token longer than 512 characters is rejected rather than silently
 * truncated into a different credential; it is never logged or hashed.
 */
export function readDocIssueToken(env: Env): string {
  const acceptToken = (raw: string): string => {
    const token = raw.trim();
    return token.length <= TOKEN_MAX_CHARS ? token : '';
  };
  const file = String(env.CHD_DOC_ISSUES_TOKEN_FILE ?? '').trim();
  if (file) {
    try {
      return acceptToken(readTextFileCappedSync(file, TOKEN_MAX_BYTES));
    } catch {
      return '';
    }
  }
  return acceptToken(String(env.CHD_DOC_ISSUES_TOKEN ?? ''));
}

/**
 * Parse the opt-in config. With `CHD_DOC_ISSUES` unset/invalid OR no credential,
 * `enabled` is false and NO request is ever made — the default deployment path
 * is byte-identical and makes zero external calls.
 */
export function parseDocIssueConfig(env: Env, opts: DocIssueConfigOptions): DocIssueConfig {
  const rawRepo = String(env.CHD_DOC_ISSUES ?? '').trim().toLowerCase();
  const repo = isValidRepoSlug(rawRepo) ? rawRepo : '';

  let disabledReason = '';
  if (!rawRepo) disabledReason = 'flag_unset';
  else if (!repo) disabledReason = 'invalid_repo';
  // The opt-out path must not touch a credential file at all: it may be a slow
  // secret mount, FIFO, or unavailable device. Validate the explicit repo flag
  // first, then read credentials only for a syntactically enabled feature.
  const token = disabledReason ? '' : readDocIssueToken(env);
  if (!disabledReason && !token) disabledReason = 'missing_credential';

  return {
    enabled: !disabledReason,
    ...(disabledReason ? { disabledReason } : {}),
    repo,
    token,
    cacheDir: opts.cacheDir,
    fetchTimeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
    maxRefs: DOC_ISSUE_MAX_REFS,
    aliasesPerBatch: DOC_ISSUE_ALIASES_PER_BATCH,
  };
}

// ── Fingerprint + cache path ────────────────────────────────────────────────

/** `sha256(repo + '\n' + sorted-ref-set)` — binds a snapshot to its exact refs. */
export function docIssueFingerprint(repo: string, refs: number[]): string {
  return createHash('sha256')
    .update(`${repo}\n${canonicalRefSet(refs).join(',')}`)
    .digest('hex');
}

/** Per-repo cache file path. The slug's `/` is replaced so it is one filename. */
export function docIssueCachePath(config: DocIssueConfig): string {
  return join(config.cacheDir, `${config.repo.replace(/\//g, '__')}.json`);
}

// ── GraphQL fetch ───────────────────────────────────────────────────────────

/** GraphQL alias for a number (aliases cannot start with a digit). */
function aliasFor(n: number): string {
  return `i${n}`;
}

function buildBatchQuery(repo: string, numbers: number[]): string {
  const [owner, name] = repo.split('/');
  const fields = numbers
    .map(
      (n) =>
        `${aliasFor(n)}: issueOrPullRequest(number: ${n}) { __typename ... on Issue { state } ... on PullRequest { state } }`
    )
    .join(' ');
  return `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} } }`;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('doc-issue fetch aborted');
}

/** Reject even when a test double/intermediary ignores the AbortSignal itself. */
function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onAbort?: () => void
): Promise<T> {
  if (signal.aborted) {
    try {
      onAbort?.();
    } catch {
      /* cancellation is best effort; the abort rejection still wins */
    }
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', handleAbort);
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        onAbort?.();
      } catch {
        /* cancellation is best effort; the abort rejection still wins */
      }
      reject(abortError(signal));
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}

async function responseTextBounded(
  response: Response,
  maxBytes: number,
  signal: AbortSignal
): Promise<string> {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await raceWithAbort(response.text(), signal);
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`doc-issue response exceeds ${maxBytes} byte limit`);
    }
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await raceWithAbort(reader.read(), signal, () => {
      void reader.cancel().catch(() => undefined);
    });
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      void reader.cancel().catch(() => undefined);
      throw new Error(`doc-issue response exceeds ${maxBytes} byte limit`);
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

/**
 * Resolve one batch of numbers. Returns the resolved records, or `null` when the
 * batch is INCOMPLETE for any reason — a non-200, a byte-cap/timeout/network
 * failure, unparseable JSON, ANY GraphQL `errors` entry, a null `repository`, a
 * missing alias, or a malformed node state. An incomplete batch fails the whole
 * refresh: it can never prove absence.
 */
async function fetchBatch(
  config: DocIssueConfig,
  fetchImpl: FetchLike,
  numbers: number[],
  signal: AbortSignal
): Promise<DocIssueRecord[] | null> {
  let text: string;
  try {
    if (signal.aborted) return null;
    const response = await raceWithAbort(
      fetchImpl(DOC_ISSUE_GRAPHQL_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
          'user-agent': 'claude-history-dashboard',
        },
        body: JSON.stringify({ query: buildBatchQuery(config.repo, numbers) }),
        signal,
      }),
      signal
    );
    // The GraphQL contract is one complete 200 response. Do not accept other
    // nominally-successful 2xx statuses (for example 202 or 206), whose body may
    // represent deferred or partial evidence.
    if (response.status !== 200) return null;
    text = await responseTextBounded(response, config.maxResponseBytes, signal);
  } catch {
    return null; // timeout, network error, or response-cap breach
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  const hasOwn = (object: object, key: PropertyKey): boolean =>
    Object.prototype.hasOwnProperty.call(object, key);
  // ANY GraphQL error invalidates the batch — a partial `data` alongside errors
  // is never trusted (a null alias there may be an error, not a real absence).
  if (hasOwn(root, 'errors') && (!Array.isArray(root.errors) || root.errors.length !== 0)) return null;
  if (!hasOwn(root, 'data')) return null;
  const data = root.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (!hasOwn(data, 'repository')) return null;
  const repository = (data as Record<string, unknown>).repository;
  if (!repository || typeof repository !== 'object' || Array.isArray(repository)) return null;
  const repoObject = repository as Record<string, unknown>;

  const expectedAliases = new Set(numbers.map(aliasFor));
  if (
    Object.keys(repoObject).length !== expectedAliases.size ||
    Object.keys(repoObject).some((alias) => !expectedAliases.has(alias))
  ) {
    return null;
  }

  const records: DocIssueRecord[] = [];
  for (const n of numbers) {
    const alias = aliasFor(n);
    if (!hasOwn(repoObject, alias)) return null; // missing/inherited alias → incomplete
    const node = repoObject[alias];
    if (node === null) {
      records.push({ number: n, state: 'not-found' }); // explicit null → proven absence
      continue;
    }
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    const obj = node as Record<string, unknown>;
    if (!hasOwn(obj, '__typename') || !hasOwn(obj, 'state')) return null;
    const state = normalizeIssueOrPrState(obj.__typename, obj.state);
    if (state === null) return null; // malformed node → incomplete
    records.push({ number: n, state });
  }
  return records;
}

/**
 * Fetch a COMPLETE snapshot for `refs`, or `null` when incomplete. Over the ref
 * cap is incomplete (never truncate). Every batch must succeed; a single
 * incomplete batch fails the whole snapshot so absence is never half-proven.
 */
export async function fetchDocIssueSnapshot(
  config: DocIssueConfig,
  refs: number[],
  opts: DocIssueFetchOptions = {}
): Promise<DocIssueSnapshot | null> {
  if (!config.enabled) return null;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!fetchImpl) return null;
  const sorted = canonicalRefSet(refs);
  if (sorted.length > Math.min(config.maxRefs, DOC_ISSUE_MAX_REFS)) return null;
  if (
    !Number.isInteger(config.aliasesPerBatch) ||
    config.aliasesPerBatch <= 0 ||
    config.aliasesPerBatch > DOC_ISSUE_ALIASES_PER_BATCH
  ) {
    return null;
  }
  const nowMs = opts.nowMs ?? Date.now();

  // One deadline covers every serial GraphQL batch, response headers, and body
  // byte. Twenty batches at the ref cap must still take at most one timeout.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('doc-issue aggregate fetch deadline exceeded')),
    config.fetchTimeoutMs
  );
  const records: DocIssueRecord[] = [];
  try {
    for (let i = 0; i < sorted.length; i += config.aliasesPerBatch) {
      const batch = sorted.slice(i, i + config.aliasesPerBatch);
      const resolved = await fetchBatch(config, fetchImpl, batch, controller.signal);
      if (resolved === null) return null; // any incomplete batch fails the snapshot
      records.push(...resolved);
    }
  } finally {
    clearTimeout(timer);
  }

  return {
    repo: config.repo,
    refs: sorted,
    records,
    asOf: new Date(nowMs).toISOString(),
    complete: true,
    fingerprint: docIssueFingerprint(config.repo, sorted),
  };
}

// ── Cache (atomic write; ref-set-bound read) ────────────────────────────────

export interface DocIssueCacheRead {
  snapshot: DocIssueSnapshot;
  mtimeMs: number;
}

/**
 * Read the cached snapshot for the CURRENT ref set. Returns `null` unless a
 * validated complete snapshot exists whose `repo` matches this repo and whose
 * fingerprint matches its recomputed repo/ref digest. When `refs` is supplied,
 * the snapshot must additionally match that exact canonical ref set. Omitting refs
 * is safe for source-signature/cache-gate callers that need validated snapshot
 * identity without rebuilding the doc graph.
 */
export function readDocIssueCache(
  config: DocIssueConfig,
  refs?: readonly number[]
): DocIssueCacheRead | null {
  if (!config.enabled) return null;
  const path = docIssueCachePath(config);
  if (!existsSync(path)) return null;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    const text = readTextFileCappedSync(path, config.maxResponseBytes);
    const snapshot = validateDocIssueSnapshot(JSON.parse(text));
    if (!snapshot) return null;
    if (snapshot.refs.length > Math.min(config.maxRefs, DOC_ISSUE_MAX_REFS)) return null;
    const recomputedFingerprint = docIssueFingerprint(snapshot.repo, snapshot.refs);
    const expectedRefs = refs === undefined ? snapshot.refs : canonicalRefSet(refs);
    if (expectedRefs.length > Math.min(config.maxRefs, DOC_ISSUE_MAX_REFS)) return null;
    const bound = validateDocIssueSnapshot(snapshot, {
      repo: config.repo,
      refs: expectedRefs,
      fingerprint: recomputedFingerprint,
    });
    return bound ? { snapshot: bound, mtimeMs: stat.mtimeMs } : null;
  } catch {
    return null;
  }
}

// Once this process has observed a particular persisted snapshot beyond its
// inclusive 24-hour boundary, a backward wall-clock correction must not make
// that same evidence trustworthy again. Key by cache path as well as canonical
// claim identity so independent repos/tests cannot alias. Removing the expired
// cache persists the retirement across restart; the bounded in-memory set
// closes same-process ABA races even if removal fails.
const retiredSnapshotIdentities = new Set<string>();

function retiredSnapshotKey(
  config: DocIssueConfig,
  snapshot: DocIssueSnapshot
): string {
  return `${docIssueCachePath(config)}\n${docIssueSnapshotIdentity(snapshot)}`;
}

export function isDocIssueSnapshotRetired(
  config: DocIssueConfig,
  snapshot: DocIssueSnapshot
): boolean {
  return retiredSnapshotIdentities.has(retiredSnapshotKey(config, snapshot));
}

export function retireDocIssueSnapshot(
  config: DocIssueConfig,
  snapshot: DocIssueSnapshot
): void {
  const key = retiredSnapshotKey(config, snapshot);
  retiredSnapshotIdentities.delete(key);
  while (
    retiredSnapshotIdentities.size >= DOC_ISSUE_RETIRED_IDENTITIES_MAX
  ) {
    const oldest = retiredSnapshotIdentities.values().next().value as
      | string
      | undefined;
    if (oldest === undefined) break;
    retiredSnapshotIdentities.delete(oldest);
  }
  retiredSnapshotIdentities.add(key);

  // Do not unlink a concurrently replaced fresh snapshot. Re-read and compare
  // the complete canonical identity immediately before removing the cache.
  const current = readDocIssueCache(config);
  if (
    !current ||
    docIssueSnapshotIdentity(current.snapshot) !==
      docIssueSnapshotIdentity(snapshot)
  ) {
    return;
  }
  try {
    unlinkSync(docIssueCachePath(config));
  } catch {
    // The in-memory tombstone still prevents same-process resurrection.
  }
}

/** Persist a complete snapshot atomically (temp file + rename), 0600. */
export function writeDocIssueCache(config: DocIssueConfig, snapshot: DocIssueSnapshot): boolean {
  if (!config.enabled) return false;
  const path = docIssueCachePath(config);
  let body: string;
  try {
    const structurallyValid = validateDocIssueSnapshot(snapshot);
    if (!structurallyValid) return false;
    if (structurallyValid.refs.length > Math.min(config.maxRefs, DOC_ISSUE_MAX_REFS)) return false;
    const validated = validateDocIssueSnapshot(structurallyValid, {
      repo: config.repo,
      refs: structurallyValid.refs,
      fingerprint: docIssueFingerprint(structurallyValid.repo, structurallyValid.refs),
    });
    if (!validated) return false;
    body = JSON.stringify(validated);
  } catch {
    return false; // malformed/proxied input must preserve any last-good cache
  }
  if (Buffer.byteLength(body, 'utf8') > config.maxResponseBytes) return false;
  mkdirSync(config.cacheDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(config.cacheDir, 0o700);
  } catch {
    /* best effort on non-POSIX filesystems */
  }
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* best effort */
  }
  try {
    renameSync(tmp, path);
    return true;
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

// ── Single-flight refresh with two-tier freshness ───────────────────────────

/** In-process single-flight: at most one live refresh per (repo, ref-set). */
const inflight = new Map<string, Promise<DocIssueSnapshot | null>>();
/** Last failed attempt per cache/ref identity, bounded and expiry-pruned. */
const failedRefreshAt = new Map<string, number>();

function pruneFailedRefreshes(nowMs: number): void {
  for (const [key, attemptedAt] of failedRefreshAt) {
    if (
      !Number.isFinite(attemptedAt) ||
      !Number.isFinite(nowMs) ||
      nowMs < attemptedAt ||
      nowMs - attemptedAt >= DOC_ISSUE_REUSE_MS
    ) {
      failedRefreshAt.delete(key);
    }
  }
}

function rememberFailedRefresh(key: string, nowMs: number): void {
  pruneFailedRefreshes(nowMs);
  failedRefreshAt.delete(key); // refresh insertion order for deterministic eviction
  while (failedRefreshAt.size >= DOC_ISSUE_RETRY_IDENTITIES_MAX) {
    const oldest = failedRefreshAt.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    failedRefreshAt.delete(oldest);
  }
  failedRefreshAt.set(key, nowMs);
}

function usableRefreshSnapshot(
  config: DocIssueConfig,
  snapshot: DocIssueSnapshot | null,
  nowMs: number
): DocIssueSnapshot | null {
  if (!snapshot) return null;
  if (isDocIssueSnapshotRetired(config, snapshot)) {
    // A replacement with the same canonical identity is indistinguishable from
    // the retired evidence under a rolled-back clock. Keep the conservative
    // tombstone authoritative and remove that persisted copy too.
    retireDocIssueSnapshot(config, snapshot);
    return null;
  }
  const usableThrough = docIssueSnapshotUsableThroughMs(snapshot);
  if (usableThrough !== null && nowMs > usableThrough) {
    retireDocIssueSnapshot(config, snapshot);
    return null;
  }
  return isDocIssueSnapshotUsable(snapshot, nowMs) ? snapshot : null;
}

/**
 * Return a usable snapshot for `refs`, refreshing when eligible:
 *  - A complete cache younger than 15m is reused as-is (no request).
 *  - Otherwise ONE single-flight refresh is attempted (concurrent callers share
 *    it). Sequential failures for the same cache/ref identity are retried at
 *    most once per 15m; a changed ref identity may retry immediately. A
 *    complete result is cached and returned.
 *  - If the refresh fails, the last complete cache is returned only while it is
 *    still usable (<= 24h); past that it is null. An incomplete refresh NEVER
 *    replaces the complete cache and never proves absence.
 * Suppressed (null) when disabled or over the ref cap.
 */
export async function refreshDocIssueSnapshot(
  config: DocIssueConfig,
  refs: number[],
  opts: DocIssueFetchOptions = {}
): Promise<DocIssueSnapshot | null> {
  if (!config.enabled) return null;
  const sorted = canonicalRefSet(refs);
  if (sorted.length > Math.min(config.maxRefs, DOC_ISSUE_MAX_REFS)) return null;
  const nowMs = opts.nowMs ?? Date.now();

  let cached = readDocIssueCache(config, sorted);
  if (cached && !usableRefreshSnapshot(config, cached.snapshot, nowMs)) cached = null;
  if (cached && isDocIssueSnapshotReusable(cached.snapshot, nowMs)) {
    return cached.snapshot;
  }

  const fingerprint = docIssueFingerprint(config.repo, sorted);
  const key = `${docIssueCachePath(config)}\n${fingerprint}`;
  const liveFlight = inflight.get(key);
  // Concurrent callers always share the live attempt, even if a previous
  // sequential attempt for this identity is still inside its retry window.
  if (liveFlight) {
    const shared = await liveFlight;
    const completionNowMs = opts.nowMs ?? Date.now();
    return usableRefreshSnapshot(config, shared, completionNowMs);
  }

  pruneFailedRefreshes(nowMs);
  const attemptedAt = failedRefreshAt.get(key);
  if (
    attemptedAt !== undefined &&
    nowMs >= attemptedAt &&
    nowMs - attemptedAt < DOC_ISSUE_REUSE_MS
  ) {
    const completionNowMs = opts.nowMs ?? Date.now();
    return usableRefreshSnapshot(config, cached?.snapshot ?? null, completionNowMs);
  }

  const flight = (async () => {
    let fresh: DocIssueSnapshot | null = null;
    try {
      fresh = await fetchDocIssueSnapshot(config, sorted, { ...opts, nowMs });
    } catch {
      /* fail closed and apply the same bounded retry policy */
    }
    if (fresh) {
      let persisted = false;
      try {
        persisted = writeDocIssueCache(config, fresh);
      } catch {
        /* persistence failure follows the bounded failed-refresh path below */
      }
      if (persisted) {
        failedRefreshAt.delete(key);
        return fresh;
      }
    }
    rememberFailedRefresh(key, nowMs);
    // Refresh failed: fall back to the last complete cache only while usable.
    return usableRefreshSnapshot(config, cached?.snapshot ?? null, nowMs);
  })().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, flight);
  const resolved = await flight;
  const completionNowMs = opts.nowMs ?? Date.now();
  return usableRefreshSnapshot(config, resolved, completionNowMs);
}
