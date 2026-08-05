import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolvePrMergeSha } from './resolve-pr-merge-sha.mjs';

const REPOSITORY = 'owner/repo';
const PR_NUMBER = 42;
const HEAD_SHA = 'a'.repeat(40);
const CREATION_BASE_SHA = 'b'.repeat(40);
const CURRENT_BASE_SHA = 'e'.repeat(40);
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

// base.sha stays frozen at the PR-creation value in every payload GitHub
// serves, so the fixtures pin it to a STALE sha on purpose: resolution must
// succeed without ever matching it.
function pull(overrides = {}) {
  return {
    head: { sha: HEAD_SHA },
    base: { ref: 'master', sha: CREATION_BASE_SHA, ...overrides.base },
    mergeable: true,
    merge_commit_sha: MERGE_SHA,
    ...overrides,
  };
}

function mergeCommit(overrides = {}) {
  return {
    sha: MERGE_SHA,
    parents: [{ sha: CURRENT_BASE_SHA }, { sha: HEAD_SHA }],
    ...overrides,
  };
}

function baseRef(overrides = {}) {
  return {
    ref: 'refs/heads/master',
    object: { sha: CURRENT_BASE_SHA, type: 'commit' },
    ...overrides,
  };
}

function options(fetchImpl, overrides = {}) {
  return {
    apiBaseUrl: 'https://api.github.test',
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    expectedHeadSha: HEAD_SHA,
    expectedBaseRef: 'master',
    token: 'test-token',
    fetchImpl,
    sleep: async () => {},
    attempts: 3,
    pollIntervalMs: 0,
    ...overrides,
  };
}

test('a PR whose base branch advanced after creation still resolves its test merge', async () => {
  // Regression fixture for #3635: the event/base payload sha is stale
  // (CREATION_BASE_SHA) while the test merge binds head + CURRENT_BASE_SHA.
  // The pre-fix resolver required parents to include the stale sha and could
  // never resolve once the base branch moved.
  const requestedUrls = [];
  const responses = [
    response(pull()),
    response(mergeCommit()),
    response(baseRef()),
    response(pull()),
  ];
  const fetchImpl = async (url) => {
    requestedUrls.push(String(url));
    assert.notEqual(responses.length, 0, 'unexpected API request');
    return responses.shift();
  };

  const mergeSha = await resolvePrMergeSha(options(fetchImpl));

  assert.equal(mergeSha, MERGE_SHA);
  assert.match(
    requestedUrls[2],
    /\/repos\/owner\/repo\/git\/ref\/heads\/master$/u,
    'the base binding must come from a live base branch ref read'
  );
});

test('a transient null merge SHA is polled until one immutable test merge is verified', async () => {
  let sleeps = 0;
  const fetchImpl = queuedFetch(
    response(pull({ mergeable: null, merge_commit_sha: null })),
    response(pull()),
    response(mergeCommit()),
    response(baseRef()),
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
    response(baseRef()),
    response(pull({ head: { sha: 'd'.repeat(40) } }))
  );

  await assert.rejects(
    resolvePrMergeSha(options(fetchImpl)),
    /head SHA changed while resolving/i
  );
});

test('a base branch retarget before resolution starts fails closed', async () => {
  // The expected base ref comes from the base-controlled triggering event;
  // a PR retargeted after authorization must never bind a merge at all.
  const fetchImpl = queuedFetch(
    response(pull({ base: { ref: 'release', sha: CREATION_BASE_SHA } }))
  );

  await assert.rejects(
    resolvePrMergeSha(options(fetchImpl, { attempts: 1 })),
    /base branch changed after its triggering event/i
  );
});

test('a base branch retarget during merge resolution fails closed', async () => {
  const fetchImpl = queuedFetch(
    response(pull()),
    response(mergeCommit()),
    response(baseRef()),
    response(pull({ base: { ref: 'release', sha: CREATION_BASE_SHA } }))
  );

  await assert.rejects(
    resolvePrMergeSha(options(fetchImpl)),
    /base branch changed after its triggering event/i
  );
});

test('a pull payload without a base branch ref fails closed', async () => {
  const fetchImpl = queuedFetch(response(pull({ base: { ref: '' } })));

  await assert.rejects(
    resolvePrMergeSha(options(fetchImpl, { attempts: 1 })),
    /base branch changed after its triggering event/i
  );
});

test('a stale merge commit whose parents do not bind the expected head is never emitted', async () => {
  const fetchImpl = queuedFetch(
    response(pull()),
    response(
      mergeCommit({
        parents: [{ sha: CURRENT_BASE_SHA }, { sha: 'd'.repeat(40) }],
      })
    )
  );

  await assert.rejects(
    resolvePrMergeSha(options(fetchImpl, { attempts: 1 })),
    /no immutable test-merge SHA resolved/i
  );
});

test('a merge whose base parent is not the live base branch head is never emitted', async () => {
  // The merge was computed against a base state that is no longer (or never
  // was) the base branch tip; the resolver must keep polling instead of
  // trusting it.
  const fetchImpl = queuedFetch(
    response(pull()),
    response(mergeCommit({ parents: [{ sha: 'f'.repeat(40) }, { sha: HEAD_SHA }] })),
    response(baseRef())
  );

  await assert.rejects(
    resolvePrMergeSha(options(fetchImpl, { attempts: 1 })),
    /no immutable test-merge SHA resolved/i
  );
});

test('a degenerate merge commit with two head parents is never emitted', async () => {
  const fetchImpl = queuedFetch(
    response(pull()),
    response(mergeCommit({ parents: [{ sha: HEAD_SHA }, { sha: HEAD_SHA }] }))
  );

  await assert.rejects(
    resolvePrMergeSha(options(fetchImpl, { attempts: 1 })),
    /no immutable test-merge SHA resolved/i
  );
});

test('a base ref that resolves to a non-commit object is never trusted', async () => {
  const fetchImpl = queuedFetch(
    response(pull()),
    response(mergeCommit()),
    response(baseRef({ object: { sha: CURRENT_BASE_SHA, type: 'tag' } }))
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

test('a slashed base branch name is encoded per segment in the ref request', async () => {
  const requestedUrls = [];
  const responses = [
    response(pull({ base: { ref: 'release/v0.6#x', sha: CREATION_BASE_SHA } })),
    response(mergeCommit()),
    response(baseRef({ ref: 'refs/heads/release/v0.6#x' })),
    response(pull({ base: { ref: 'release/v0.6#x', sha: CREATION_BASE_SHA } })),
  ];
  const fetchImpl = async (url) => {
    requestedUrls.push(String(url));
    assert.notEqual(responses.length, 0, 'unexpected API request');
    return responses.shift();
  };

  const mergeSha = await resolvePrMergeSha(
    options(fetchImpl, { expectedBaseRef: 'release/v0.6#x' })
  );

  assert.equal(mergeSha, MERGE_SHA);
  assert.match(
    requestedUrls[2],
    /\/git\/ref\/heads\/release\/v0\.6%23x$/u,
    'ref path segments must be URI-encoded without encoding the separators'
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
