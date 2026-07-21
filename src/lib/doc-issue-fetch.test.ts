import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DOC_ISSUE_ALIASES_PER_BATCH,
  DOC_ISSUE_GRAPHQL_URL,
  DOC_ISSUE_MAX_REFS,
  DOC_ISSUE_RETRY_IDENTITIES_MAX,
  docIssueCachePath,
  docIssueFingerprint,
  fetchDocIssueSnapshot,
  parseDocIssueConfig,
  readDocIssueCache,
  readDocIssueToken,
  refreshDocIssueSnapshot,
  writeDocIssueCache,
  type DocIssueConfig,
} from './doc-issue-fetch';
import {
  DOC_ISSUE_MAX_USABLE_MS,
  DOC_ISSUE_REUSE_MS,
  validateDocIssueSnapshot,
  type DocIssueSnapshot,
} from './doc-issue-snapshot';

const REPO = 'shpwrck/claude-history-dashboard';
const TOKEN = 'ghp_TESTTOKEN_do_not_leak_1234567890';

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'doc-issues-'));
});
afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

function cfg(env: Record<string, string | undefined>): DocIssueConfig {
  return parseDocIssueConfig(env, { cacheDir });
}
const enabled = () => cfg({ CHD_DOC_ISSUES: REPO, CHD_DOC_ISSUES_TOKEN: TOKEN });

/** A fetch stub that records calls and returns a JSON Response from a handler. */
function stubFetch(
  handler: (
    url: string,
    init: { body?: string; headers?: Record<string, string>; signal?: AbortSignal }
  ) => Response | Promise<Response>
) {
  const calls: {
    url: string;
    init: { body?: string; headers?: Record<string, string>; signal?: AbortSignal };
  }[] = [];
  const impl = async (
    url: string,
    init: { body?: string; headers?: Record<string, string>; signal?: AbortSignal }
  ) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { impl, calls };
}
const json = (obj: unknown, status = 200): Response =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

/** GraphQL "data" body: alias i<n> -> node ({__typename,state}) or null. */
function graphData(nodes: Record<number, { __typename: string; state: string } | null>): Response {
  const repository: Record<string, unknown> = {};
  for (const [n, node] of Object.entries(nodes)) repository[`i${n}`] = node;
  return json({ data: { repository } });
}

function buildSnapshot(config: DocIssueConfig, refs: number[], asOf: string): DocIssueSnapshot {
  return {
    repo: config.repo,
    refs: [...refs],
    records: refs.map((n) => ({ number: n, state: 'open' as const })),
    asOf,
    complete: true,
    fingerprint: docIssueFingerprint(config.repo, refs),
  };
}

// ── Config gates ────────────────────────────────────────────────────────────

describe('doc-issue-fetch — config gate (opt-in, off by default)', () => {
  it('is disabled with the flag unset', () => {
    const tokenFile = join(cacheDir, 'token-that-must-not-be-read');
    writeFileSync(tokenFile, TOKEN);
    const c = cfg({ CHD_DOC_ISSUES_TOKEN_FILE: tokenFile });
    expect(c.enabled).toBe(false);
    expect(c.disabledReason).toBe('flag_unset');
    expect(c.token).toBe('');
  });

  it('is disabled for an invalid repo slug', () => {
    const c = cfg({ CHD_DOC_ISSUES: 'not-a-slash', CHD_DOC_ISSUES_TOKEN: TOKEN });
    expect(c.disabledReason).toBe('invalid_repo');
    expect(c.token).toBe('');
  });

  it('is disabled when the repo is valid but no credential is supplied', () => {
    expect(cfg({ CHD_DOC_ISSUES: REPO }).disabledReason).toBe('missing_credential');
  });

  it('enables and lowercases a valid repo with a credential', () => {
    const c = cfg({ CHD_DOC_ISSUES: 'ShpWrck/Claude-History-Dashboard', CHD_DOC_ISSUES_TOKEN: TOKEN });
    expect(c.enabled).toBe(true);
    expect(c.repo).toBe('shpwrck/claude-history-dashboard');
  });
});

describe('doc-issue-fetch — credential read (file-first, capped, never leaked)', () => {
  it('prefers the token FILE over the inline env var', () => {
    const file = join(cacheDir, 'tok');
    writeFileSync(file, `  ${TOKEN}\n`);
    expect(readDocIssueToken({ CHD_DOC_ISSUES_TOKEN_FILE: file, CHD_DOC_ISSUES_TOKEN: 'inline' })).toBe(
      TOKEN
    );
  });

  it('suppresses (empty) rather than throwing on an unreadable or oversized token file', () => {
    expect(readDocIssueToken({ CHD_DOC_ISSUES_TOKEN_FILE: join(cacheDir, 'missing') })).toBe('');
    const big = join(cacheDir, 'big');
    writeFileSync(big, 'x'.repeat(9000)); // > TOKEN_MAX_BYTES
    expect(readDocIssueToken({ CHD_DOC_ISSUES_TOKEN_FILE: big })).toBe('');
  });

  it('rejects rather than truncates a readable token file above 512 characters', () => {
    const file = join(cacheDir, 'too-long-token');
    writeFileSync(file, 'x'.repeat(513));
    expect(readDocIssueToken({ CHD_DOC_ISSUES_TOKEN_FILE: file })).toBe('');
  });

  it('trims a valid inline token and rejects one above 512 characters', () => {
    expect(readDocIssueToken({ CHD_DOC_ISSUES_TOKEN: `  ${TOKEN}  ` })).toBe(TOKEN);
    expect(readDocIssueToken({ CHD_DOC_ISSUES_TOKEN: 'y'.repeat(512) })).toHaveLength(512);
    expect(readDocIssueToken({ CHD_DOC_ISSUES_TOKEN: 'y'.repeat(513) })).toBe('');
  });
});

// ── Fetch: happy path, host/method, batching ────────────────────────────────

describe('doc-issue-fetch — fetch', () => {
  it('returns null and makes zero requests when disabled', async () => {
    const f = stubFetch(() => graphData({}));
    expect(await fetchDocIssueSnapshot(cfg({}), [1], { fetchImpl: f.impl })).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  it('resolves issue/PR/not-found states over the fixed GraphQL host with a POST + Bearer', async () => {
    const f = stubFetch(() =>
      graphData({
        1: { __typename: 'Issue', state: 'OPEN' },
        2: { __typename: 'PullRequest', state: 'MERGED' },
        3: null,
      })
    );
    const snap = await fetchDocIssueSnapshot(enabled(), [3, 1, 2], { fetchImpl: f.impl, nowMs: 0 });
    expect(snap).not.toBeNull();
    expect(snap!.refs).toEqual([1, 2, 3]);
    expect(snap!.records).toEqual([
      { number: 1, state: 'open' },
      { number: 2, state: 'closed' }, // merged PR -> closed
      { number: 3, state: 'not-found' }, // explicit null alias -> proven absence
    ]);
    expect(f.calls[0].url).toBe(DOC_ISSUE_GRAPHQL_URL);
    expect(f.calls[0].init.headers?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('batches large ref sets by the alias cap', async () => {
    const refs = Array.from({ length: DOC_ISSUE_ALIASES_PER_BATCH + 10 }, (_, i) => i + 1);
    const f = stubFetch((_url, init) => {
      const query = JSON.parse(init.body ?? '{}').query as string;
      const nodes: Record<number, { __typename: string; state: string }> = {};
      for (const n of refs) if (query.includes(`i${n}:`)) nodes[n] = { __typename: 'Issue', state: 'OPEN' };
      return graphData(nodes);
    });
    const snap = await fetchDocIssueSnapshot(enabled(), refs, { fetchImpl: f.impl });
    expect(f.calls).toHaveLength(2); // 50 + 10
    expect(snap!.records).toHaveLength(refs.length);
  });

  it('refuses (incomplete) an over-cap ref set without any request', async () => {
    const f = stubFetch(() => graphData({}));
    const refs = Array.from({ length: DOC_ISSUE_MAX_REFS + 1 }, (_, i) => i + 1);
    expect(await fetchDocIssueSnapshot(enabled(), refs, { fetchImpl: f.impl })).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  it('rejects an injected batch size above the hard 50-alias request cap', async () => {
    const f = stubFetch(() => graphData({}));
    const config = {
      ...enabled(),
      aliasesPerBatch: DOC_ISSUE_ALIASES_PER_BATCH + 1,
    };
    expect(await fetchDocIssueSnapshot(config, [1], { fetchImpl: f.impl })).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  it('keeps the aggregate deadline active while a response body is stalled and cancels it', async () => {
    vi.useFakeTimers();
    try {
      const config = { ...enabled(), fetchTimeoutMs: 100 };
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      });
      const f = stubFetch(() => new Response(body, { status: 200 }));
      const pending = fetchDocIssueSnapshot(config, [1], { fetchImpl: f.impl });

      await vi.advanceTimersByTimeAsync(100);

      expect(await pending).toBeNull();
      expect(cancelled).toBe(true);
      expect(f.calls[0].init.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses one deadline across every batch instead of resetting it per request', async () => {
    vi.useFakeTimers();
    try {
      const config = { ...enabled(), fetchTimeoutMs: 100, aliasesPerBatch: 1 };
      let call = 0;
      const f = stubFetch(
        () =>
          call++ === 0
            ? new Promise<Response>((resolve) => {
                setTimeout(
                  () => resolve(graphData({ 1: { __typename: 'Issue', state: 'OPEN' } })),
                  75
                );
              })
            : new Promise<Response>(() => undefined)
      );
      const pending = fetchDocIssueSnapshot(config, [1, 2], { fetchImpl: f.impl });

      await vi.advanceTimersByTimeAsync(75);
      expect(f.calls).toHaveLength(2);
      expect(f.calls[0].init.signal).toBe(f.calls[1].init.signal);
      await vi.advanceTimersByTimeAsync(25);

      expect(await pending).toBeNull();
      expect(f.calls[1].init.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Fetch: fail-closed — never fabricate not-found, never partial ───────────

describe('doc-issue-fetch — fail-closed incompleteness', () => {
  const badCases: Array<[string, () => Response]> = [
    ['a non-200 response', () => json({ data: { repository: {} } }, 502)],
    [
      'a parseable partial-content response',
      () =>
        json(
          {
            data: {
              repository: {
                i1: { __typename: 'Issue', state: 'OPEN' },
              },
            },
          },
          206
        ),
    ],
    [
      'ANY GraphQL error (even with a null alias present)',
      () => json({ data: { repository: { i1: null } }, errors: [{ message: 'rate limited' }] }),
    ],
    ['a malformed non-array errors object', () => json({ data: { repository: { i1: null } }, errors: {} })],
    ['a present null errors value', () => json({ data: { repository: { i1: null } }, errors: null })],
    ['an array root', () => json([])],
    ['an array data object', () => json({ data: [] })],
    ['a null repository', () => json({ data: { repository: null } })],
    ['an array repository', () => json({ data: { repository: [] } })],
    ['a missing alias', () => json({ data: { repository: {} } })],
    [
      'an unexpected extra alias',
      () =>
        json({
          data: {
            repository: {
              i1: { __typename: 'Issue', state: 'OPEN' },
              i2: { __typename: 'Issue', state: 'OPEN' },
            },
          },
        }),
    ],
    ['an array node', () => json({ data: { repository: { i1: [] } } })],
    [
      'a malformed node state',
      () => graphData({ 1: { __typename: 'Issue', state: 'BOGUS' } }),
    ],
    ['a thrown (timeout/network) error', () => { throw new Error('ETIMEDOUT'); }],
  ];

  for (const [label, handler] of badCases) {
    it(`returns null (never not-found) on ${label}`, async () => {
      const f = stubFetch(handler);
      expect(await fetchDocIssueSnapshot(enabled(), [1], { fetchImpl: f.impl })).toBeNull();
    });
  }

  it('a null alias accompanied by errors is never recorded as not-found', async () => {
    const f = stubFetch(() =>
      json({ data: { repository: { i1: null } }, errors: [{ message: 'x' }] })
    );
    expect(await fetchDocIssueSnapshot(enabled(), [1], { fetchImpl: f.impl })).toBeNull();
  });

  it('accepts an explicitly empty GraphQL errors array', async () => {
    const f = stubFetch(() =>
      json({
        data: { repository: { i1: { __typename: 'Issue', state: 'OPEN' } } },
        errors: [],
      })
    );
    expect((await fetchDocIssueSnapshot(enabled(), [1], { fetchImpl: f.impl }))?.records).toEqual([
      { number: 1, state: 'open' },
    ]);
  });

  it('rejects a response body above the configured byte cap', async () => {
    const f = stubFetch(() =>
      graphData({ 1: { __typename: 'Issue', state: 'OPEN' } })
    );
    const config = { ...enabled(), maxResponseBytes: 8 };
    expect(await fetchDocIssueSnapshot(config, [1], { fetchImpl: f.impl })).toBeNull();
  });

  it('rejects the whole multi-batch result when a later batch is incomplete', async () => {
    let call = 0;
    const f = stubFetch(() =>
      call++ === 0
        ? graphData({ 1: { __typename: 'Issue', state: 'OPEN' } })
        : json({}, 502)
    );
    const config = { ...enabled(), aliasesPerBatch: 1 };
    expect(await fetchDocIssueSnapshot(config, [1, 2], { fetchImpl: f.impl })).toBeNull();
    expect(f.calls).toHaveLength(2);
  });

  it('requires aliases to be own properties rather than inherited values', async () => {
    Object.defineProperty(Object.prototype, 'i1', {
      configurable: true,
      value: { __typename: 'Issue', state: 'OPEN' },
    });
    try {
      const f = stubFetch(() => json({ data: { repository: {} } }));
      expect(await fetchDocIssueSnapshot(enabled(), [1], { fetchImpl: f.impl })).toBeNull();
    } finally {
      delete (Object.prototype as Record<string, unknown>).i1;
    }
  });
});

// ── Cache: ref-set identity + atomic write + non-leakage ────────────────────

describe('doc-issue-fetch — cache identity and atomicity', () => {
  it('reads a complete snapshot back only for the EXACT ref set that produced it', () => {
    const config = enabled();
    writeDocIssueCache(config, buildSnapshot(config, [1, 2, 3], '2026-07-20T00:00:00.000Z'));
    // Callers that only need canonical cache identity may omit the external refs;
    // the stored fingerprint is still recomputed and checked.
    expect(readDocIssueCache(config)?.snapshot.refs).toEqual([1, 2, 3]);
    expect(readDocIssueCache(config, [1, 2, 3])?.snapshot.refs).toEqual([1, 2, 3]);
    // Any ref removed or added shifts the fingerprint -> old cache is unusable.
    expect(readDocIssueCache(config, [1, 2])).toBeNull();
    expect(readDocIssueCache(config, [1, 2, 3, 4])).toBeNull();
  });

  it('rejects a cache whose lowercase fingerprint is not the recomputed repo/ref digest', () => {
    const config = enabled();
    const path = docIssueCachePath(config);
    writeDocIssueCache(config, buildSnapshot(config, [1], '2026-07-20T00:00:00.000Z'));
    const raw = JSON.parse(readFileSync(path, 'utf8')) as DocIssueSnapshot;
    writeFileSync(path, JSON.stringify({ ...raw, fingerprint: '0'.repeat(64) }));
    expect(readDocIssueCache(config)).toBeNull();
    expect(readDocIssueCache(config, [1])).toBeNull();
  });

  it('leaves the last-good cache untouched when asked to write an invalid snapshot', () => {
    const config = enabled();
    const path = docIssueCachePath(config);
    const valid = buildSnapshot(config, [1], '2026-07-20T00:00:00.000Z');
    writeDocIssueCache(config, valid);
    const lastGood = readFileSync(path, 'utf8');

    writeDocIssueCache(config, { ...valid, fingerprint: '0'.repeat(64) });
    expect(readFileSync(path, 'utf8')).toBe(lastGood);
    writeDocIssueCache(config, {
      ...valid,
      records: [{ number: 2, state: 'closed' }],
    });
    expect(readFileSync(path, 'utf8')).toBe(lastGood);

    const refs = Array.from({ length: DOC_ISSUE_MAX_REFS + 1 }, (_, index) => index + 1);
    writeDocIssueCache(config, {
      ...valid,
      refs,
      records: refs.map((number) => ({ number, state: 'open' as const })),
      fingerprint: docIssueFingerprint(config.repo, refs),
    });
    expect(readFileSync(path, 'utf8')).toBe(lastGood);
  });

  it('persists atomically (validates, leaves no .tmp) and never serializes the credential', async () => {
    const config = enabled();
    const f = stubFetch(() => graphData({ 1: { __typename: 'Issue', state: 'OPEN' } }));
    const snap = await refreshDocIssueSnapshot(config, [1], { fetchImpl: f.impl, nowMs: 0 });
    expect(snap).not.toBeNull();
    const path = docIssueCachePath(config);
    const text = readFileSync(path, 'utf8');
    expect(validateDocIssueSnapshot(JSON.parse(text))).not.toBeNull();
    expect(text).not.toContain(TOKEN); // credential never lands in the cache
    expect(readdirSync(cacheDir).some((f) => f.endsWith('.tmp'))).toBe(false);
  });
});

// ── Refresh: two-tier freshness + single-flight ─────────────────────────────

describe('doc-issue-fetch — refresh freshness policy', () => {
  const T = Date.parse('2026-07-20T00:00:00.000Z');

  it('reuses a complete cache younger than 15m without any request', async () => {
    const config = enabled();
    writeDocIssueCache(config, buildSnapshot(config, [1, 2, 3], new Date(T).toISOString()));
    const f = stubFetch(() => graphData({}));
    const snap = await refreshDocIssueSnapshot(config, [1, 2, 3], {
      fetchImpl: f.impl,
      nowMs: T + DOC_ISSUE_REUSE_MS - 1,
    });
    expect(snap!.asOf).toBe(new Date(T).toISOString());
    expect(f.calls).toHaveLength(0);
  });

  it('refreshes at >=15m and writes the new complete snapshot', async () => {
    const config = enabled();
    writeDocIssueCache(config, buildSnapshot(config, [1], new Date(T).toISOString()));
    const f = stubFetch(() => graphData({ 1: { __typename: 'Issue', state: 'CLOSED' } }));
    const now = T + DOC_ISSUE_REUSE_MS;
    const snap = await refreshDocIssueSnapshot(config, [1], { fetchImpl: f.impl, nowMs: now });
    expect(f.calls).toHaveLength(1);
    expect(snap!.asOf).toBe(new Date(now).toISOString());
    expect(snap!.records[0].state).toBe('closed');
  });

  it('treats a fresh result as failed when it cannot persist, then throttles retries', async () => {
    const config = enabled();
    writeDocIssueCache(config, buildSnapshot(config, [1], new Date(T).toISOString()));
    const f = stubFetch(() => {
      rmSync(cacheDir, { recursive: true, force: true });
      writeFileSync(cacheDir, 'blocks cache directory recreation');
      return graphData({ 1: { __typename: 'Issue', state: 'CLOSED' } });
    });
    const nowMs = T + DOC_ISSUE_REUSE_MS;

    const fallback = await refreshDocIssueSnapshot(config, [1], {
      fetchImpl: f.impl,
      nowMs,
    });
    expect(fallback?.records[0].state).toBe('open');
    expect(
      await refreshDocIssueSnapshot(config, [1], {
        fetchImpl: f.impl,
        nowMs: nowMs + 1,
      })
    ).toBeNull();
    expect(f.calls).toHaveLength(1);
  });

  it('falls back to the last complete cache when a refresh fails and it is still usable (<=24h)', async () => {
    const config = enabled();
    writeDocIssueCache(config, buildSnapshot(config, [1], new Date(T).toISOString()));
    const f = stubFetch(() => json({}, 500));
    const snap = await refreshDocIssueSnapshot(config, [1], {
      fetchImpl: f.impl,
      nowMs: T + DOC_ISSUE_MAX_USABLE_MS,
    });
    expect(snap!.asOf).toBe(new Date(T).toISOString()); // stale but usable
  });

  it('suppresses (null) when a refresh fails and the cache is older than 24h', async () => {
    const config = enabled();
    writeDocIssueCache(config, buildSnapshot(config, [1], new Date(T).toISOString()));
    const f = stubFetch(() => json({}, 500));
    const snap = await refreshDocIssueSnapshot(config, [1], {
      fetchImpl: f.impl,
      nowMs: T + DOC_ISSUE_MAX_USABLE_MS + 1,
    });
    expect(snap).toBeNull();
    expect(readDocIssueCache(config, [1])).toBeNull();
  });

  it('never revives a snapshot after observing expiry, even if the clock moves backward', async () => {
    const config = enabled();
    writeDocIssueCache(config, buildSnapshot(config, [1], new Date(T).toISOString()));
    const f = stubFetch(() => json({}, 500));

    expect(
      await refreshDocIssueSnapshot(config, [1], {
        fetchImpl: f.impl,
        nowMs: T + DOC_ISSUE_MAX_USABLE_MS + 1,
      })
    ).toBeNull();
    expect(readDocIssueCache(config, [1])).toBeNull();

    expect(
      await refreshDocIssueSnapshot(config, [1], {
        fetchImpl: f.impl,
        nowMs: T + DOC_ISSUE_MAX_USABLE_MS,
      })
    ).toBeNull();
    expect(f.calls).toHaveLength(2);
  });

  it('returns null when there is no cache and the refresh fails', async () => {
    const f = stubFetch(() => json({}, 500));
    expect(await refreshDocIssueSnapshot(enabled(), [1], { fetchImpl: f.impl })).toBeNull();
  });

  it('single-flights concurrent refreshes of the same ref set into one request', async () => {
    const config = enabled();
    let resolveFetch: ((r: Response) => void) | null = null;
    const f = stubFetch(
      () => new Promise<Response>((res) => { resolveFetch = () => res(graphData({ 1: { __typename: 'Issue', state: 'OPEN' } })); })
    );
    const a = refreshDocIssueSnapshot(config, [1], { fetchImpl: f.impl, nowMs: 0 });
    const b = refreshDocIssueSnapshot(config, [1], { fetchImpl: f.impl, nowMs: 0 });
    // let both calls reach the shared in-flight promise, then release the fetch
    await Promise.resolve();
    resolveFetch!();
    const [ra, rb] = await Promise.all([a, b]);
    expect(f.calls).toHaveLength(1);
    expect(ra!.records[0].state).toBe('open');
    expect(rb!.records[0].state).toBe('open');
  });

  it('never returns a shared fallback after any joining caller retires it', async () => {
    const config = enabled();
    writeDocIssueCache(config, buildSnapshot(config, [1], new Date(T).toISOString()));
    let resolveFetch: ((response: Response) => void) | null = null;
    const f = stubFetch(
      () => new Promise<Response>((resolve) => { resolveFetch = resolve; })
    );
    const atBoundary = refreshDocIssueSnapshot(config, [1], {
      fetchImpl: f.impl,
      nowMs: T + DOC_ISSUE_MAX_USABLE_MS,
    });
    await Promise.resolve();
    const afterBoundary = refreshDocIssueSnapshot(config, [1], {
      fetchImpl: f.impl,
      nowMs: T + DOC_ISSUE_MAX_USABLE_MS + 1,
    });
    const rolledBack = refreshDocIssueSnapshot(config, [1], {
      fetchImpl: f.impl,
      nowMs: T + DOC_ISSUE_MAX_USABLE_MS,
    });
    resolveFetch!(json({}, 502));

    expect(await atBoundary).toBeNull();
    expect(await afterBoundary).toBeNull();
    expect(await rolledBack).toBeNull();
    expect(f.calls).toHaveLength(1);
  });

  it('throttles sequential failed retries per identity for 15m, then retries at the boundary', async () => {
    const config = enabled();
    const f = stubFetch(() => json({}, 500));
    expect(await refreshDocIssueSnapshot(config, [1], { fetchImpl: f.impl, nowMs: T })).toBeNull();
    expect(
      await refreshDocIssueSnapshot(config, [1], {
        fetchImpl: f.impl,
        nowMs: T + DOC_ISSUE_REUSE_MS - 1,
      })
    ).toBeNull();
    expect(f.calls).toHaveLength(1);

    expect(
      await refreshDocIssueSnapshot(config, [1], {
        fetchImpl: f.impl,
        nowMs: T + DOC_ISSUE_REUSE_MS,
      })
    ).toBeNull();
    expect(f.calls).toHaveLength(2);
  });

  it('does not let a failed old ref identity delay an immediate changed-ref refresh', async () => {
    const config = enabled();
    const f = stubFetch(() => json({}, 500));
    await refreshDocIssueSnapshot(config, [1], { fetchImpl: f.impl, nowMs: T });
    await refreshDocIssueSnapshot(config, [2], { fetchImpl: f.impl, nowMs: T + 1 });
    expect(f.calls).toHaveLength(2);
  });

  it('checks a newly fresh cache before the failed-retry throttle', async () => {
    const config = enabled();
    const f = stubFetch(() => json({}, 500));
    await refreshDocIssueSnapshot(config, [7], { fetchImpl: f.impl, nowMs: T });
    writeDocIssueCache(config, buildSnapshot(config, [7], new Date(T + 1).toISOString()));

    const result = await refreshDocIssueSnapshot(config, [7], {
      fetchImpl: f.impl,
      nowMs: T + 2,
    });
    expect(result?.refs).toEqual([7]);
    expect(f.calls).toHaveLength(1);
  });

  it('bounds retry-throttle identities and evicts the oldest deterministically', async () => {
    const config = enabled();
    const f = stubFetch(() => json({}, 500));
    for (let index = 0; index <= DOC_ISSUE_RETRY_IDENTITIES_MAX; index += 1) {
      await refreshDocIssueSnapshot(config, [10_000 + index], {
        fetchImpl: f.impl,
        nowMs: T,
      });
    }
    expect(f.calls).toHaveLength(DOC_ISSUE_RETRY_IDENTITIES_MAX + 1);

    // The first identity was evicted when the bounded tracker filled, so it may
    // retry immediately; a still-tracked recent identity remains throttled.
    await refreshDocIssueSnapshot(config, [10_000], { fetchImpl: f.impl, nowMs: T + 1 });
    expect(f.calls).toHaveLength(DOC_ISSUE_RETRY_IDENTITIES_MAX + 2);
    await refreshDocIssueSnapshot(config, [10_002], { fetchImpl: f.impl, nowMs: T + 1 });
    expect(f.calls).toHaveLength(DOC_ISSUE_RETRY_IDENTITIES_MAX + 2);
  });
});
