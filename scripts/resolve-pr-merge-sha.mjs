#!/usr/bin/env node

import { appendFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const FULL_SHA = /^[0-9a-f]{40}$/u;
const DEFAULT_ATTEMPTS = 12;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredSha(value, name) {
  const sha = requiredString(value, name).toLowerCase();
  if (!FULL_SHA.test(sha)) {
    throw new Error(`${name} must be a full 40-character commit SHA`);
  }
  return sha;
}

function assertPullBinding(pull, expectedHeadSha, expectedBaseRef) {
  const headSha = String(pull?.head?.sha ?? '').toLowerCase();
  if (headSha !== expectedHeadSha) {
    throw new Error('pull request head SHA changed while resolving its test merge');
  }
  if (String(pull?.base?.ref ?? '') !== expectedBaseRef) {
    throw new Error(
      'pull request base branch changed after its triggering event; no test-merge SHA is safe to run'
    );
  }
  if (pull?.mergeable === false) {
    throw new Error('pull request is not mergeable; no test-merge SHA is safe to run');
  }
}

// The event payload's base SHA is frozen at PR creation, while GitHub
// recomputes merge_commit_sha against the CURRENT base branch head — so the
// binding target is the non-head parent of the test merge, verified below
// against a live read of the base branch ref. The branch NAME (unlike its
// SHA) stays fixed under legitimate base advancement, so it is bound to the
// base-controlled triggering event via expectedBaseRef: a PR retargeted
// after authorization fails closed instead of adopting the new base.
function mergeBaseParent(commit, mergeSha, headSha) {
  const parents = Array.isArray(commit?.parents)
    ? commit.parents.map((parent) => String(parent?.sha ?? '').toLowerCase())
    : [];
  if (
    String(commit?.sha ?? '').toLowerCase() !== mergeSha ||
    parents.length !== 2 ||
    !parents.includes(headSha)
  ) {
    return null;
  }
  const base = parents.find((parent) => parent !== headSha);
  return base && FULL_SHA.test(base) ? base : null;
}

async function requestJson(
  url,
  token,
  fetchImpl,
  requestTimeoutMs,
  setTimeoutImpl,
  clearTimeoutImpl
) {
  const controller = new AbortController();
  const timeout = setTimeoutImpl(
    () => controller.abort(),
    requestTimeoutMs
  );
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
      redirect: 'error',
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      throw new Error('request completed after its deadline');
    }
    if (!response?.ok) {
      throw new Error(`GitHub API request failed with HTTP ${response?.status ?? 'unknown'}`);
    }
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `GitHub API request timed out after ${requestTimeoutMs}ms`,
        { cause: error }
      );
    }
    throw error;
  } finally {
    clearTimeoutImpl(timeout);
  }
}

export async function resolvePrMergeSha({
  apiBaseUrl,
  repository,
  prNumber,
  expectedHeadSha,
  expectedBaseRef,
  token,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  attempts = DEFAULT_ATTEMPTS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
}) {
  const apiUrl = new URL(requiredString(apiBaseUrl, 'apiBaseUrl'));
  if (apiUrl.protocol !== 'https:') {
    throw new Error('apiBaseUrl must use HTTPS');
  }
  const repo = requiredString(repository, 'repository');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) {
    throw new Error('repository must be an owner/name pair');
  }
  const number = Number(prNumber);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error('prNumber must be a positive integer');
  }
  const headSha = requiredSha(expectedHeadSha, 'expectedHeadSha');
  const baseRef = requiredString(expectedBaseRef, 'expectedBaseRef');
  const bearerToken = requiredString(token, 'token');
  if (!Number.isSafeInteger(attempts) || attempts <= 0) {
    throw new Error('attempts must be a positive integer');
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error('pollIntervalMs must be a non-negative integer');
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error('requestTimeoutMs must be a positive integer');
  }

  const [owner, name] = repo.split('/').map(encodeURIComponent);
  const root = apiUrl.href.replace(/\/$/u, '');
  const pullUrl = `${root}/repos/${owner}/${name}/pulls/${number}`;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const pull = await requestJson(
      pullUrl,
      bearerToken,
      fetchImpl,
      requestTimeoutMs,
      setTimeoutImpl,
      clearTimeoutImpl
    );
    assertPullBinding(pull, headSha, baseRef);
    const mergeSha = String(pull?.merge_commit_sha ?? '').toLowerCase();

    if (pull?.mergeable === true && FULL_SHA.test(mergeSha)) {
      const commit = await requestJson(
        `${root}/repos/${owner}/${name}/git/commits/${mergeSha}`,
        bearerToken,
        fetchImpl,
        requestTimeoutMs,
        setTimeoutImpl,
        clearTimeoutImpl
      );
      const mergeBaseSha = mergeBaseParent(commit, mergeSha, headSha);
      if (mergeBaseSha) {
        const encodedBaseRef = baseRef
          .split('/')
          .map(encodeURIComponent)
          .join('/');
        const liveBase = await requestJson(
          `${root}/repos/${owner}/${name}/git/ref/heads/${encodedBaseRef}`,
          bearerToken,
          fetchImpl,
          requestTimeoutMs,
          setTimeoutImpl,
          clearTimeoutImpl
        );
        const liveBaseSha = String(liveBase?.object?.sha ?? '').toLowerCase();
        if (
          liveBase?.object?.type === 'commit' &&
          liveBaseSha === mergeBaseSha
        ) {
          const confirmation = await requestJson(
            pullUrl,
            bearerToken,
            fetchImpl,
            requestTimeoutMs,
            setTimeoutImpl,
            clearTimeoutImpl
          );
          assertPullBinding(confirmation, headSha, baseRef);
          if (
            confirmation?.mergeable === true &&
            String(confirmation?.merge_commit_sha ?? '').toLowerCase() ===
              mergeSha
          ) {
            return mergeSha;
          }
        }
      }
    }

    if (attempt < attempts) await sleep(pollIntervalMs);
  }

  throw new Error(
    `no immutable test-merge SHA resolved after ${attempts} attempts`
  );
}

async function main() {
  const mergeSha = await resolvePrMergeSha({
    apiBaseUrl: process.env.GITHUB_API_URL,
    repository: process.env.GITHUB_REPOSITORY,
    prNumber: process.env.PR_NUMBER,
    expectedHeadSha: process.env.EXPECTED_HEAD_SHA,
    expectedBaseRef: process.env.EXPECTED_BASE_REF,
    token: process.env.GITHUB_TOKEN,
  });
  const outputPath = requiredString(process.env.GITHUB_OUTPUT, 'GITHUB_OUTPUT');
  appendFileSync(outputPath, `merge-sha=${mergeSha}\n`, { encoding: 'utf8' });
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`PR merge-SHA resolution failed: ${error.message}`);
    process.exitCode = 1;
  });
}
