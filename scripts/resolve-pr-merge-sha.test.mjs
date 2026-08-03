import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolvePrMergeSha } from './resolve-pr-merge-sha.mjs';

const REPOSITORY = 'owner/repo';
const PR_NUMBER = 42;
const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const MERGE_SHA = 'c'.repeat(40);

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function queuedFetch(...responses) {
  const queue = [...responses];
  return async () => {
    assert.notEqual(queue.length, 0, 'unexpected API request');
    return queue.shift();
  };
}

function pull(overrides = {}) {
  return {
    head: { sha: HEAD_SHA },
    base: { sha: BASE_SHA },
    mergeable: true,
    merge_commit_sha: MERGE_SHA,
    ...overrides,
  };
}

function mergeCommit(overrides = {}) {
  return {
    sha: MERGE_SHA,
    parents: [{ sha: BASE_SHA }, { sha: HEAD_SHA }],
    ...overrides,
  };
}

function options(fetchImpl, overrides = {}) {
  return {
    apiBaseUrl: 'https://api.github.test',
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    expectedHeadSha: HEAD_SHA,
    expectedBaseSha: BASE_SHA,
    token: 'test-token',
    fetchImpl,
    sleep: async () => {},
    attempts: 3,
    pollIntervalMs: 0,
    ...overrides,
  };
}

test('a transient null merge SHA is polled until one immutable test merge is verified', async () => {
  let sleeps = 0;
  const fetchImpl = queuedFetch(
    response(pull({ mergeable: null, merge_commit_sha: null })),
    response(pull()),
    response(mergeCommit()),
    response(pull())
  );

  const mergeSha = await resolvePrMergeSha(
    options(fetchImpl, {
      sleep: async () => {
        sleeps += 1;
      },
    })
  );

  assert.equal(mergeSha, MERGE_SHA);
  assert.equal(sleeps, 1);
});

test('a head change during merge resolution fails closed without returning stale code', async () => {
  const fetchImpl = queuedFetch(
    response(pull()),
    response(mergeCommit()),
    response(pull({ head: { sha: 'd'.repeat(40) } }))
  );

  await assert.rejects(
    resolvePrMergeSha(options(fetchImpl)),
    /head SHA changed while resolving/i
  );
});

test('a stale merge commit whose parents do not bind the expected head and base is never emitted', async () => {
  const fetchImpl = queuedFetch(
    response(pull()),
    response(
      mergeCommit({
        parents: [{ sha: BASE_SHA }, { sha: 'd'.repeat(40) }],
      })
    )
  );

  await assert.rejects(
    resolvePrMergeSha(options(fetchImpl, { attempts: 1 })),
    /no immutable test-merge SHA resolved/i
  );
});

test('an unresolved null merge SHA exhausts the bounded poll and fails closed', async () => {
  const fetchImpl = queuedFetch(
    response(pull({ mergeable: null, merge_commit_sha: null })),
    response(pull({ mergeable: null, merge_commit_sha: null }))
  );

  await assert.rejects(
    resolvePrMergeSha(options(fetchImpl, { attempts: 2 })),
    /no immutable test-merge SHA resolved/i
  );
});

test('a never-resolving API request is aborted by its finite deadline', async () => {
  let observedSignal;
  let scheduledDelay;
  let cleared = false;
  const fetchImpl = async (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      observedSignal = signal;
      const rejectOnAbort = () => reject(signal.reason);
      if (signal.aborted) rejectOnAbort();
      else signal.addEventListener('abort', rejectOnAbort, { once: true });
    });

  await assert.rejects(
    resolvePrMergeSha(
      options(fetchImpl, {
        requestTimeoutMs: 25,
        setTimeoutImpl(callback, delay) {
          scheduledDelay = delay;
          queueMicrotask(callback);
          return 7;
        },
        clearTimeoutImpl(timeout) {
          assert.equal(timeout, 7);
          cleared = true;
        },
      })
    ),
    /GitHub API request timed out after 25ms/i
  );

  assert.equal(scheduledDelay, 25);
  assert.equal(observedSignal?.aborted, true);
  assert.equal(cleared, true);
});

test('the request deadline stays armed while a response body stalls', async () => {
  let observedSignal;
  let timeoutCallback;
  let timeoutActive = true;
  let bodyStartedResolve;
  const bodyStarted = new Promise((resolve) => {
    bodyStartedResolve = resolve;
  });
  const fetchImpl = async (_url, { signal }) => {
    observedSignal = signal;
    return {
      ok: true,
      status: 200,
      async json() {
        bodyStartedResolve();
        return new Promise((_resolve, reject) => {
          const rejectOnAbort = () => reject(signal.reason);
          if (signal.aborted) rejectOnAbort();
          else signal.addEventListener('abort', rejectOnAbort, { once: true });
        });
      },
    };
  };
  const pending = resolvePrMergeSha(
    options(fetchImpl, {
      requestTimeoutMs: 25,
      setTimeoutImpl(callback) {
        timeoutCallback = callback;
        return 9;
      },
      clearTimeoutImpl(timeout) {
        assert.equal(timeout, 9);
        timeoutActive = false;
      },
    })
  );

  await bodyStarted;
  assert.equal(
    timeoutActive,
    true,
    'the request deadline must not clear after headers but before JSON settles'
  );
  timeoutCallback();
  await assert.rejects(
    pending,
    /GitHub API request timed out after 25ms/i
  );
  assert.equal(observedSignal?.aborted, true);
  assert.equal(timeoutActive, false);
});
