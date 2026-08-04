// Author-vendor detector classification (#3309).
//
// agent-cross-review.yml routes each PR to the OTHER vendor's reviewer, keyed
// on the co-author trailer domains in the PR's commits. That classification
// lives inline in the workflow's detect step (actions/github-script), so this
// suite extracts the exact shipped script from the YAML and executes it against
// a mocked `github` object whose commit listing serves multi-page fixtures.
// The load-bearing contract: the detector classifies from COMPLETE commit
// evidence or not at all. It must paginate every served page (a PR can carry
// >100 commits), and because GET /pulls/{n}/commits stops at 250 commits
// WITHOUT an error — so pagination alone cannot prove completeness — it must
// reconcile the listed count against the event payload's ground-truth commit
// count and classify `ambiguous` (no auto-review) on any shortfall, exactly as
// it does when listing fails outright. The pre-#3309 single-page call
// misclassified any >100-commit PR whose only deciding trailer sat after
// commit 100; the first-pass paginate fix still misclassified past the silent
// 250-commit cap. The mock below is cap-faithful so both regressions stay RED
// here.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { parse } from 'yaml';

const WORKFLOW_PATH = join(
  import.meta.dirname,
  '..',
  '.github',
  'workflows',
  'agent-cross-review.yml'
);

const CLAUDE_TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>';
const CODEX_TRAILER = 'Co-Authored-By: Codex <noreply@openai.com>';
const PLAIN_MESSAGE = 'Refactor internals\n\nNo co-author trailer here.';

// GET /pulls/{n}/commits lists at most 250 commits; at the cap it simply stops
// emitting a next page — no error, no truncation marker.
const LIST_COMMITS_API_CAP = 250;

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function detectScript() {
  const workflow = parse(readFileSync(WORKFLOW_PATH, 'utf8'));
  const step = (workflow?.jobs?.detect?.steps ?? []).find((s) => s?.id === 'd');
  assert.equal(
    typeof step?.with?.script,
    'string',
    'agent-cross-review.yml must keep the detect step (id: d) inline github-script'
  );
  return step.with.script;
}

function commitFixture(messages) {
  return messages.map((message, index) => ({
    sha: String(index).padStart(40, '0'),
    commit: { message: `${message}\n` },
  }));
}

/**
 * Mocked github-script surroundings. `github.rest.pulls.listCommits` serves
 * the fixture in per_page slices out of the first 250 commits ONLY (page 1
 * when no page is asked for — exactly what the pre-#3309 single-page call
 * observed), and `github.paginate` walks pages the way Octokit does: it stops
 * on the first short page, so past the cap it returns the truncated list
 * WITHOUT throwing, exactly like the live API. The event payload carries the
 * PR's true commit count (`payload.pull_request.commits`); `payloadCommits`
 * overrides it, and `null` omits the field. Both API surfaces exist so this
 * suite runs whatever the workflow actually ships and the assertions decide
 * correctness.
 */
function mockEnv(commits, { listCommitsError, payloadCommits } = {}) {
  const outputs = {};
  const warnings = [];
  const served = commits.slice(0, LIST_COMMITS_API_CAP);
  const listCommits = async (params) => {
    if (listCommitsError) throw listCommitsError;
    assert.equal(params.owner, 'shpwrck');
    assert.equal(params.repo, 'claude-history-dashboard');
    assert.equal(params.pull_number, 3309);
    const perPage = params.per_page ?? 30;
    const page = params.page ?? 1;
    return { data: served.slice((page - 1) * perPage, page * perPage) };
  };
  const github = {
    rest: { pulls: { listCommits } },
    paginate: async (fn, params) => {
      assert.equal(fn, listCommits, 'paginate must walk pulls.listCommits');
      const perPage = params.per_page ?? 30;
      const all = [];
      for (let page = 1; ; page += 1) {
        const { data } = await fn({ ...params, page });
        all.push(...data);
        if (data.length < perPage) return all;
      }
    },
  };
  const pullRequest = { number: 3309, commits: commits.length };
  if (payloadCommits === null) delete pullRequest.commits;
  else if (payloadCommits !== undefined) pullRequest.commits = payloadCommits;
  const context = {
    repo: { owner: 'shpwrck', repo: 'claude-history-dashboard' },
    payload: { pull_request: pullRequest },
  };
  const core = {
    info: () => {},
    warning: (message) => warnings.push(String(message)),
    setOutput: (name, value) => {
      outputs[name] = value;
    },
  };
  return { github, context, core, outputs, warnings };
}

async function runDetect(commits, options) {
  const env = mockEnv(commits, options);
  const run = new AsyncFunction('github', 'context', 'core', detectScript());
  await run(env.github, env.context, env.core);
  return env;
}

test('an opposite-vendor trailer after commit 100 makes the PR ambiguous, not single-vendor', async () => {
  // 120 commits: page one is uniformly Claude-authored; the ONLY Codex trailer
  // sits on the second page. A first-page-only read sees anthropic && !openai
  // and routes Codex to review a PR Codex co-authored — the #3309 bug.
  const messages = Array.from({ length: 120 }, (_, i) =>
    i === 119 ? `Land follow-up\n\n${CODEX_TRAILER}` : `Commit ${i}\n\n${CLAUDE_TRAILER}`
  );
  const { outputs } = await runDetect(commitFixture(messages));
  assert.equal(outputs.vendor, 'ambiguous');
});

test('a Claude trailer only on a later page still classifies the PR as claude', async () => {
  const messages = Array.from({ length: 150 }, (_, i) =>
    i === 130 ? `Wrap up\n\n${CLAUDE_TRAILER}` : PLAIN_MESSAGE
  );
  const { outputs, warnings } = await runDetect(commitFixture(messages));
  assert.equal(outputs.vendor, 'claude');
  assert.deepEqual(warnings, []);
});

test('a Codex trailer only on a later page still classifies the PR as codex', async () => {
  const messages = Array.from({ length: 101 }, (_, i) =>
    i === 100 ? `Wrap up\n\n${CODEX_TRAILER}` : PLAIN_MESSAGE
  );
  const { outputs, warnings } = await runDetect(commitFixture(messages));
  assert.equal(outputs.vendor, 'codex');
  assert.deepEqual(warnings, []);
});

test('single-page classification behavior is unchanged', async () => {
  const cases = [
    [[`A\n\n${CLAUDE_TRAILER}`, PLAIN_MESSAGE], 'claude'],
    [[`A\n\n${CODEX_TRAILER}`, PLAIN_MESSAGE], 'codex'],
    [[`A\n\n${CLAUDE_TRAILER}`, `B\n\n${CODEX_TRAILER}`], 'ambiguous'],
    [[PLAIN_MESSAGE, PLAIN_MESSAGE], 'ambiguous'],
    [[], 'ambiguous'],
  ];
  for (const [messages, expected] of cases) {
    const { outputs } = await runDetect(commitFixture(messages));
    assert.equal(outputs.vendor, expected, `messages=${JSON.stringify(messages)}`);
  }
});

test('an exactly-100-commit PR classifies from its full first page', async () => {
  const messages = Array.from({ length: 100 }, (_, i) =>
    i === 99 ? `Tail\n\n${CLAUDE_TRAILER}` : PLAIN_MESSAGE
  );
  const { outputs } = await runDetect(commitFixture(messages));
  assert.equal(outputs.vendor, 'claude');
});

test('an exactly-250-commit PR (the list API cap, three pages) still classifies its vendor', async () => {
  // Every commit is listable, so complete evidence exists and the vendor must
  // NOT be spuriously downgraded to ambiguous by the count reconciliation.
  const messages = Array.from({ length: 250 }, (_, i) =>
    i === 249 ? `Tail\n\n${CODEX_TRAILER}` : PLAIN_MESSAGE
  );
  const { outputs, warnings } = await runDetect(commitFixture(messages));
  assert.equal(outputs.vendor, 'codex');
  assert.deepEqual(warnings, []);
});

test('a PR beyond the 250-commit list cap classifies ambiguous, never single-vendor', async () => {
  // 300 commits: the listable first 250 are uniformly Claude-authored; the
  // ONLY Codex trailer sits past the cap, where the API silently stops (no
  // error for the fetch fallback to catch). Incomplete evidence must fail
  // closed to ambiguous instead of routing Codex to review its own PR.
  const messages = Array.from({ length: 300 }, (_, i) =>
    i === 299 ? `Land follow-up\n\n${CODEX_TRAILER}` : `Commit ${i}\n\n${CLAUDE_TRAILER}`
  );
  const { outputs, warnings } = await runDetect(commitFixture(messages));
  assert.equal(outputs.vendor, 'ambiguous');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /250 of 300/);
  assert.match(warnings[0], /ambiguous/i);
});

test('a missing payload commit count classifies from the listed commits without warning', async () => {
  const messages = Array.from({ length: 120 }, (_, i) =>
    i === 110 ? `Wrap up\n\n${CLAUDE_TRAILER}` : PLAIN_MESSAGE
  );
  const { outputs, warnings } = await runDetect(commitFixture(messages), {
    payloadCommits: null,
  });
  assert.equal(outputs.vendor, 'claude');
  assert.deepEqual(warnings, []);
});

test('an empty PR classifies ambiguous without an incompleteness warning', async () => {
  const { outputs, warnings } = await runDetect(commitFixture([]));
  assert.equal(outputs.vendor, 'ambiguous');
  assert.deepEqual(warnings, []);
});

test('commit evidence that cannot be listed classifies ambiguous instead of routing a reviewer', async () => {
  const { outputs, warnings } = await runDetect(
    commitFixture([`A\n\n${CLAUDE_TRAILER}`]),
    { listCommitsError: new Error('boom: API unavailable') }
  );
  assert.equal(outputs.vendor, 'ambiguous');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ambiguous/i);
});
