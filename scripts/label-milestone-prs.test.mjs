// Unit tests for label-milestone-prs.mjs (#716): the conservative classifier
// that backfills domain labels onto a release milestone's merged PRs so the
// .github/release.yml changelog categorization actually populates.
//
// node:test, no network — the orchestration is exercised with a mocked fetch.
// Run: npm run test:label-milestone-prs
//   (= node --test scripts/label-milestone-prs.test.mjs)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classify,
  classifyFromTitle,
  domainLabels,
  labelMilestonePrs,
  loadReleaseConfig,
  parseIssueRefs,
  parseReleaseConfig,
} from './label-milestone-prs.mjs';

// --- release.yml parsing: the script and the changelog share one source of truth.

test('parseReleaseConfig reads the real .github/release.yml shape', () => {
  const config = loadReleaseConfig();
  assert.deepEqual(config.exclude, ['meta', 'duplicate', 'invalid', 'wontfix']);
  assert.deepEqual(
    config.categories.map((c) => c.title),
    [
      'Security',
      'Features & enhancements',
      'Performance',
      'UI',
      'Bug fixes',
      'Documentation',
      'Infrastructure & build',
      'Tech debt & refactors',
      'Other changes',
    ],
  );
  // The catch-all stays a category but is not a domain label.
  assert.equal(config.categories.at(-1).labels.includes('*'), true);
  assert.deepEqual(domainLabels(config), [
    'security',
    'enhancement',
    'performance',
    'ui',
    'bug',
    'documentation',
    'infra',
    'tech-debt',
  ]);
});

test('parseReleaseConfig strips trailing comments and quotes', () => {
  const config = parseReleaseConfig(
    [
      'changelog:',
      '  exclude:',
      '    labels:',
      '      - meta        # a comment',
      '  categories:',
      '    - title: "Bug fixes"',
      '      labels:',
      '        - bug',
      '    - title: Other changes',
      '      labels:',
      '        - "*"',
    ].join('\n'),
  );
  assert.deepEqual(config.exclude, ['meta']);
  assert.deepEqual(config.categories, [
    { title: 'Bug fixes', labels: ['bug'] },
    { title: 'Other changes', labels: ['*'] },
  ]);
});

// --- title-prefix classification table.

test('classifyFromTitle maps the documented prefixes', () => {
  const table = [
    ['[feature] Sample data + UI wiring (#670)', 'enhancement'],
    ['feat: add thing', 'enhancement'],
    ['feat(parser)!: breaking add', 'enhancement'],
    ['fix: stop the leak', 'bug'],
    ['[fix] stop the leak', 'bug'],
    ['hotfix: emergency', 'bug'],
    ['docs(releasing): two-phase release-gate model (#648)', 'documentation'],
    ['[docs] explain it', 'documentation'],
    ['perf: faster ingest', 'performance'],
    ['[chore] Shared EmptyDataView wrapper (#684)', 'tech-debt'],
    ['refactor: extract module', 'tech-debt'],
    ['ci: cache npm', 'infra'],
    ['build: bump vite', 'infra'],
    ['[infra] compose hardening', 'infra'],
    ['[security] scrub egress', 'security'],
    ['[ui] align the cards', 'ui'],
  ];
  for (const [title, expected] of table) {
    assert.equal(classifyFromTitle(title), expected, title);
  }
});

test('classifyFromTitle never guesses: unknown prefixes and bare titles are null', () => {
  for (const title of [
    '[#652] Exempt patch releases from the gate (#653)', // issue-ref, not a type
    '[release] Bump version to 0.2.0 for the v0.2 cut (#715)',
    'Surface the running version in the app',
    'Pause on safety flag instead of switching models (#1428)',
    '',
    undefined,
  ]) {
    assert.equal(classifyFromTitle(title), null, String(title));
  }
});

// --- issue references: Closes #N in the body + the [#N] title convention.

test('parseIssueRefs collects closing keywords and the [#N] title prefix', () => {
  assert.deepEqual(
    parseIssueRefs(
      '[#646] Surface the running version (#647)',
      'Closes #646. Also fixes #12 and resolved #13.\ncloses: #14',
    ),
    [646, 12, 13, 14],
  );
  assert.deepEqual(parseIssueRefs('No refs here', 'see #99 for context'), []);
  assert.deepEqual(parseIssueRefs(undefined, undefined), []);
});

// --- the conservative decision rule.

const DOMAINS = domainLabels(loadReleaseConfig());

test('classify: exactly one linked-issue domain label wins over the title', () => {
  const r = classify({
    title: 'fix: something', // title says bug...
    linkedIssueLabels: ['backlog', 'ui', 'groomed'], // ...but the issue says ui
    domains: DOMAINS,
  });
  assert.deepEqual(r, { label: 'ui', source: 'issue-labels' });
});

test('classify: conflicting linked-issue domain labels are ambiguous, never guessed', () => {
  const r = classify({
    title: 'fix: something',
    linkedIssueLabels: ['ui', 'bug'],
    domains: DOMAINS,
  });
  assert.equal(r.label, null);
  assert.match(r.reason, /ambiguous/);
});

test('classify: falls back to the title prefix when issues carry no domain label', () => {
  const r = classify({
    title: '[chore] Extract config-loader.ts (#679)',
    linkedIssueLabels: ['backlog'],
    domains: DOMAINS,
  });
  assert.deepEqual(r, { label: 'tech-debt', source: 'title-prefix' });
});

test('classify: no signal at all -> unclassified with a reason', () => {
  const r = classify({ title: 'Mystery work (#1)', linkedIssueLabels: [], domains: DOMAINS });
  assert.equal(r.label, null);
  assert.match(r.reason, /no linked-issue domain label/);
});

// --- orchestration against a mocked GitHub API.

function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function makeMockApi() {
  const posts = [];
  const routes = new Map();
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}`;
    if ((init.method || 'GET') === 'POST') {
      posts.push({ path: u.pathname, body: JSON.parse(init.body) });
      return jsonResponse([]);
    }
    if (u.pathname.endsWith('/milestones')) {
      return jsonResponse(routes.get('milestones') ?? []);
    }
    if (u.pathname.endsWith('/issues') && u.searchParams.get('milestone')) {
      return jsonResponse(routes.get('milestone-items') ?? []);
    }
    const issue = u.pathname.match(/\/issues\/(\d+)$/);
    if (issue) {
      const found = (routes.get('issues') ?? {})[issue[1]];
      if (!found) return { ok: false, status: 404, json: async () => ({}), text: async () => 'Not Found' };
      return jsonResponse(found);
    }
    throw new Error(`unexpected request: ${key}`);
  };
  return { fetchImpl, posts, routes };
}

const CONFIG = loadReleaseConfig();

test('labelMilestonePrs: labels from issue labels and title, skips labeled, lists unclassifiable', async () => {
  const { fetchImpl, posts, routes } = makeMockApi();
  routes.set('milestones', [{ title: 'v0.2', number: 7 }, { title: 'Future', number: 9 }]);
  routes.set('milestone-items', [
    // merged PR, no domain label, linked issue has one -> labeled enhancement
    { number: 101, title: '[#634] Parse slash commands (#667)', body: 'Closes #634',
      labels: [{ name: 'groomed' }], pull_request: { merged_at: '2025-09-01T00:00:00Z' } },
    // merged PR, already domain-labeled -> skipped, no POST
    { number: 102, title: '[feature] Already labeled', body: '',
      labels: [{ name: 'ui' }], pull_request: { merged_at: '2025-09-02T00:00:00Z' } },
    // merged PR, no issue refs, chore title -> tech-debt via title-prefix
    { number: 103, title: '[chore] Extract module (#681)', body: 'part of a slice series',
      labels: [], pull_request: { merged_at: '2025-09-03T00:00:00Z' } },
    // merged PR, nothing to go on -> unclassified, listed
    { number: 104, title: 'Mystery sweep (#684)', body: '',
      labels: [], pull_request: { merged_at: '2025-09-04T00:00:00Z' } },
    // closed but NOT merged PR -> ignored entirely
    { number: 105, title: 'fix: abandoned', body: '',
      labels: [], pull_request: { merged_at: null } },
    // a plain issue in the milestone -> ignored entirely
    { number: 106, title: 'An issue, not a PR', body: '', labels: [] },
  ]);
  routes.set('issues', {
    634: { number: 634, title: 'Parse slash commands', labels: [{ name: 'backlog' }, { name: 'enhancement' }] },
  });

  const result = await labelMilestonePrs({
    repo: 'o/r', milestoneTitle: 'v0.2', token: 't', fetchImpl, config: CONFIG, log: () => {},
  });

  assert.equal(result.merged, 4);
  assert.deepEqual(
    result.labeled.map((p) => [p.number, p.label, p.source]),
    [[101, 'enhancement', 'issue-labels'], [103, 'tech-debt', 'title-prefix']],
  );
  assert.deepEqual(result.skipped.map((p) => p.number), [102]);
  assert.deepEqual(result.unclassified.map((p) => p.number), [104]);
  // POSTs: one per applied label, additive labels endpoint.
  assert.deepEqual(posts, [
    { path: '/repos/o/r/issues/101/labels', body: { labels: ['enhancement'] } },
    { path: '/repos/o/r/issues/103/labels', body: { labels: ['tech-debt'] } },
  ]);
});

test('labelMilestonePrs: dry run (apply=false) never POSTs', async () => {
  const { fetchImpl, posts, routes } = makeMockApi();
  routes.set('milestones', [{ title: 'v0.2', number: 7 }]);
  routes.set('milestone-items', [
    { number: 103, title: '[chore] Extract module (#681)', body: '',
      labels: [], pull_request: { merged_at: '2025-09-03T00:00:00Z' } },
  ]);
  const result = await labelMilestonePrs({
    repo: 'o/r', milestoneTitle: 'v0.2', token: 't', fetchImpl, apply: false, config: CONFIG, log: () => {},
  });
  assert.deepEqual(result.labeled.map((p) => p.label), ['tech-debt']);
  assert.deepEqual(posts, []);
});

test('labelMilestonePrs: a 404 linked issue degrades to no-signal, run continues', async () => {
  const { fetchImpl, posts, routes } = makeMockApi();
  routes.set('milestones', [{ title: 'v0.2', number: 7 }]);
  routes.set('milestone-items', [
    { number: 110, title: '[#9999] Refers to a deleted issue', body: 'Closes #9999',
      labels: [], pull_request: { merged_at: '2025-09-05T00:00:00Z' } },
  ]);
  routes.set('issues', {}); // #9999 404s
  const result = await labelMilestonePrs({
    repo: 'o/r', milestoneTitle: 'v0.2', token: 't', fetchImpl, config: CONFIG, log: () => {},
  });
  assert.deepEqual(result.unclassified.map((p) => p.number), [110]);
  assert.deepEqual(posts, []);
});

test('labelMilestonePrs: unknown milestone fails loudly', async () => {
  const { fetchImpl, routes } = makeMockApi();
  routes.set('milestones', [{ title: 'v0.2', number: 7 }]);
  await assert.rejects(
    () => labelMilestonePrs({ repo: 'o/r', milestoneTitle: 'v0.9', token: 't', fetchImpl, config: CONFIG, log: () => {} }),
    /milestone "v0\.9" not found/,
  );
});
