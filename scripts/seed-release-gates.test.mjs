// Unit tests for seed-release-gates.mjs (#721): the seed half of the
// release-gate contract, mirroring check-release-gate.test.mjs /
// ensure-pr-milestone.test.mjs as a standalone script check (the Vitest suite
// covers src/ only). Run:
//   node --test scripts/seed-release-gates.test.mjs   (npm run test:seed-release-gates)
//
// All GitHub traffic goes through a mocked fetch — nothing here touches the
// network. Covers: the full 3-epic set for >= v0.3 and the 2-epic set before,
// idempotent skipping of already-present domains (open OR closed), the
// non-vX.Y / patch no-ops, and the workflow_dispatch backfill path resolving
// `v0.4` against a milestone named `v0.4.0` (#1045 cut-name drift).

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifySeedTarget,
  expectedGateDomains,
  findMilestone,
  gateEpicBody,
  GATE_DOMAINS,
  missingGateDomains,
  releaseAuditScopeSection,
  seedReleaseGates,
  usesIncrementalReleaseAudit,
} from './seed-release-gates.mjs';

const TOKEN = 'test-token';
const REPO = 'owner/repo';

// Mocked GitHub API: serves the given milestones + existing gate issues and
// records every issue-create POST. Issue numbers count up from 9000.
function fakeGitHub({ milestones = [], gateIssues = [] } = {}) {
  const created = [];
  let nextNumber = 9000;
  const fetchImpl = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    const respond = (body) => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (pathname === `/repos/${REPO}/milestones` && (init.method || 'GET') === 'GET') {
      assert.equal(searchParams.get('state'), 'all');
      return respond(milestones);
    }
    if (pathname === `/repos/${REPO}/issues` && (init.method || 'GET') === 'GET') {
      assert.equal(searchParams.get('labels'), 'release-gate');
      assert.equal(searchParams.get('state'), 'all');
      const wantMilestone = Number(searchParams.get('milestone'));
      return respond(gateIssues.filter((i) => i.milestoneNumber === wantMilestone));
    }
    if (pathname === `/repos/${REPO}/issues` && init.method === 'POST') {
      const payload = JSON.parse(init.body);
      const issue = { number: nextNumber++, ...payload };
      created.push(issue);
      return respond(issue);
    }
    throw new Error(`unexpected fetch: ${init.method || 'GET'} ${url}`);
  };
  return { fetchImpl, created };
}

function seed(target, github, extra = {}) {
  return seedReleaseGates(target, {
    fetchImpl: github.fetchImpl,
    token: TOKEN,
    repo: REPO,
    log: () => {},
    ...extra,
  });
}

// A release-gate issue fixture carrying the gate label + a domain label.
function gateIssue(domainLabel, milestoneNumber, state = 'open') {
  return {
    number: 100,
    state,
    milestoneNumber,
    labels: [{ name: 'epic' }, { name: 'release-gate' }, { name: domainLabel }],
  };
}

test('seeds the full 3-epic set for a >= v0.3 milestone', async () => {
  const github = fakeGitHub({ milestones: [{ title: 'v0.4', number: 7 }] });
  const result = await seed('v0.4', github);

  assert.equal(result.seeded, true);
  assert.equal(result.milestone, 'v0.4');
  assert.deepEqual(result.created.map((c) => c.domain), ['performance', 'architecture', 'security']);
  assert.equal(github.created.length, 3);
  for (const issue of github.created) {
    assert.equal(issue.milestone, 7);
    assert.ok(issue.labels.includes('epic'));
    assert.ok(issue.labels.includes('release-gate'));
  }
  assert.deepEqual(
    github.created.map((i) => i.labels.find((l) => !['epic', 'release-gate'].includes(l))),
    ['performance', 'tech-debt', 'security'],
  );
  assert.deepEqual(
    github.created.map((i) => i.title),
    ['Performance review for v0.4', 'Architecture review for v0.4', 'Security review for v0.4'],
  );
});

test('seeds only the perf+architecture pair for a < v0.3 milestone', async () => {
  const github = fakeGitHub({ milestones: [{ title: 'v0.2', number: 2 }] });
  const result = await seed('v0.2', github);

  assert.equal(result.seeded, true);
  assert.deepEqual(result.created.map((c) => c.domain), ['performance', 'architecture']);
  assert.equal(github.created.length, 2);
  assert.ok(!github.created.some((i) => i.labels.includes('security')));
});

test('seeds the full 4-epic set for a >= v0.6 milestone (#2130)', async () => {
  const github = fakeGitHub({ milestones: [{ title: 'v0.6', number: 9 }] });
  const result = await seed('v0.6', github);

  assert.equal(result.seeded, true);
  assert.deepEqual(
    result.created.map((c) => c.domain),
    ['performance', 'architecture', 'security', 'data-integrity'],
  );
  assert.equal(github.created.length, 4);
  assert.deepEqual(
    github.created.map((i) => i.labels.find((l) => !['epic', 'release-gate'].includes(l))),
    ['performance', 'tech-debt', 'security', 'data-integrity'],
  );
  assert.deepEqual(
    github.created.map((i) => i.title),
    [
      'Performance review for v0.6',
      'Architecture review for v0.6',
      'Security review for v0.6',
      'Data-integrity review for v0.6',
    ],
  );
});

test('keeps the 3-epic set for v0.3–v0.5 — no data-integrity epic before v0.6', async () => {
  const github = fakeGitHub({ milestones: [{ title: 'v0.5', number: 8 }] });
  const result = await seed('v0.5', github);

  assert.deepEqual(result.created.map((c) => c.domain), ['performance', 'architecture', 'security']);
  assert.equal(github.created.length, 3);
  assert.ok(!github.created.some((i) => i.labels.includes('data-integrity')));
});

test('epic bodies are dormant concern buckets, not decomposed specs', async () => {
  const github = fakeGitHub({ milestones: [{ title: 'v0.5', number: 9 }] });
  await seed('v0.5', github);

  for (const issue of github.created) {
    const { body } = issue;
    assert.match(body, /## Why/);
    assert.match(body, /## Concerns raised during the release/);
    assert.match(body, /## Scope/);
    assert.match(body, /## Acceptance/);
    assert.match(body, /\*\*dormant\*\*/);
    assert.match(body, /do \*\*not\*\* decompose/);
    assert.match(body, /- \[ \] _\(none yet\)_/); // empty checklist seed
    assert.match(body, /v0\.5/);
  }
});

test('skips domains whose gate epic already exists — open or closed', async () => {
  const github = fakeGitHub({
    milestones: [{ title: 'v0.4', number: 7 }],
    gateIssues: [gateIssue('performance', 7, 'closed'), gateIssue('security', 7, 'open')],
  });
  const result = await seed('v0.4', github);

  assert.deepEqual(result.created.map((c) => c.domain), ['architecture']);
  assert.deepEqual(result.existing.sort(), ['performance', 'security']);
  assert.equal(github.created.length, 1);
  assert.ok(github.created[0].labels.includes('tech-debt'));
});

test('re-running on a fully seeded milestone is a no-op', async () => {
  const github = fakeGitHub({
    milestones: [{ title: 'v0.4', number: 7 }],
    gateIssues: [
      gateIssue('performance', 7, 'closed'),
      gateIssue('tech-debt', 7, 'open'),
      gateIssue('security', 7, 'open'),
    ],
  });
  const result = await seed('v0.4', github);

  assert.equal(result.seeded, true);
  assert.deepEqual(result.created, []);
  assert.equal(github.created.length, 0);
});

test('one multi-labelled gate cannot satisfy multiple standing domains', async () => {
  const stacked = gateIssue('performance', 9, 'closed');
  stacked.labels.push(
    { name: 'tech-debt' },
    { name: 'security' },
    { name: 'data-integrity' },
  );
  const github = fakeGitHub({
    milestones: [{ title: 'v0.6', number: 9 }],
    gateIssues: [stacked],
  });

  const result = await seed('v0.6', github);

  assert.equal(result.created.length, 3);
  assert.equal(result.existing.length, 1);
  assert.deepEqual(
    result.created.map((created) => created.domain).sort(),
    ['architecture', 'data-integrity', 'security'],
  );
});

test('non-vX.Y milestone names are a logged no-op, never an API call', async () => {
  const logs = [];
  const result = await seedReleaseGates('Future', {
    fetchImpl: () => {
      throw new Error('must not hit the network for a non-release milestone');
    },
    token: TOKEN,
    repo: REPO,
    log: (m) => logs.push(m),
  });

  assert.equal(result.seeded, false);
  assert.equal(result.reason, 'not-release');
  assert.deepEqual(result.created, []);
  assert.ok(logs.some((l) => l.includes('not a release milestone') && l.includes('skipping')));
});

test('patch milestones (x.y.z, z>0) are skipped — per-minor-cycle gate (#652)', async () => {
  const result = await seedReleaseGates('v0.4.1', {
    fetchImpl: () => {
      throw new Error('must not hit the network for a patch milestone');
    },
    token: TOKEN,
    repo: REPO,
    log: () => {},
  });
  assert.equal(result.seeded, false);
  assert.equal(result.reason, 'patch');
});

test('dispatch backfill resolves v0.4 against a milestone titled v0.4.0 (#1045)', async () => {
  const github = fakeGitHub({
    milestones: [
      { title: 'Future', number: 1 },
      { title: 'v0.4.0', number: 11 },
    ],
    gateIssues: [gateIssue('performance', 11, 'open')],
  });
  const result = await seed('v0.4', github);

  assert.equal(result.seeded, true);
  assert.equal(result.milestone, 'v0.4.0');
  assert.deepEqual(result.created.map((c) => c.domain), ['architecture', 'security']);
  // Epics land in the resolved milestone and are titled after its real name.
  assert.ok(github.created.every((i) => i.milestone === 11));
  assert.ok(github.created.every((i) => i.title.endsWith('for v0.4.0')));
});

test('backfill against a missing milestone fails loudly', async () => {
  const github = fakeGitHub({ milestones: [{ title: 'v0.3', number: 5 }] });
  await assert.rejects(() => seed('v0.4', github), /Milestone "v0\.4" not found/);
});

test('classifySeedTarget separates minors, patches, and non-release buckets', () => {
  assert.deepEqual(classifySeedTarget('v0.4'), { seed: true, title: 'v0.4' });
  assert.deepEqual(classifySeedTarget(' v0.4.0 '), { seed: true, title: 'v0.4.0' });
  assert.equal(classifySeedTarget('v0.4.1').reason, 'patch');
  assert.equal(classifySeedTarget('Future').reason, 'not-release');
  assert.equal(classifySeedTarget('0.4').reason, 'not-release'); // milestones are v-prefixed
  assert.equal(classifySeedTarget('').reason, 'not-release');
  assert.equal(classifySeedTarget(undefined).reason, 'not-release');
});

test('expectedGateDomains delegates the security + data-integrity cutoffs to check-release-gate', () => {
  assert.deepEqual(expectedGateDomains('v0.2').map((d) => d.key), ['performance', 'architecture']);
  assert.deepEqual(
    expectedGateDomains('v0.3').map((d) => d.key),
    ['performance', 'architecture', 'security'],
  );
  assert.deepEqual(
    expectedGateDomains('v0.5').map((d) => d.key),
    ['performance', 'architecture', 'security'],
  );
  assert.deepEqual(
    expectedGateDomains('v0.6').map((d) => d.key),
    ['performance', 'architecture', 'security', 'data-integrity'],
  );
  assert.equal(expectedGateDomains('v1.0').length, GATE_DOMAINS.length);
});

test('missingGateDomains ignores PRs and non-gate issues', () => {
  const issues = [
    // A PR carrying the labels must not satisfy the gate.
    { labels: [{ name: 'release-gate' }, { name: 'performance' }], pull_request: {} },
    // A domain label WITHOUT the gate label does not count either.
    { labels: [{ name: 'tech-debt' }] },
  ];
  assert.deepEqual(
    missingGateDomains(issues, 'v0.4').map((d) => d.key),
    ['performance', 'architecture', 'security'],
  );
});

test('findMilestone prefers exact title, never matches a patch milestone', () => {
  const ms = [
    { title: 'v0.4.1', number: 12 },
    { title: 'v0.4.0', number: 11 },
    { title: 'v0.4', number: 10 },
  ];
  assert.equal(findMilestone(ms, 'v0.4').number, 10);
  assert.equal(findMilestone(ms, 'v0.4.0').number, 11);
  // No exact match -> minor-cycle fallback skips the patch milestone.
  assert.equal(findMilestone([{ title: 'v0.4.1', number: 12 }, { title: 'v0.4.0', number: 11 }], 'v0.4').number, 11);
  assert.equal(findMilestone([{ title: 'Future', number: 1 }], 'v0.4'), null);
});

test('gateEpicBody names the milestone and the domain concern', () => {
  const security = GATE_DOMAINS.find((d) => d.key === 'security');
  const body = gateEpicBody(security, 'v0.6');
  assert.match(body, /security-review gate for v0\.6/);
  assert.match(body, /security-review pass/);
});

test('gateEpicBody frames the data-integrity gate as provable + faultless (#2130)', () => {
  const dataIntegrity = GATE_DOMAINS.find((d) => d.key === 'data-integrity');
  const body = gateEpicBody(dataIntegrity, 'v0.6');
  assert.match(body, /data-integrity-review gate for v0\.6/);
  assert.match(body, /provable/);
  assert.match(body, /faultless/);
  assert.match(body, /docs\/adding-a-recommendation\.md/);
});

test('v0.7+ gate bodies pin incremental scope while v0.6 stays historical', () => {
  assert.equal(usesIncrementalReleaseAudit('v0.6.0'), false);
  assert.equal(usesIncrementalReleaseAudit('v0.7.0'), true);
  assert.equal(usesIncrementalReleaseAudit('v1.0.0'), true);
  assert.deepEqual(releaseAuditScopeSection('Future'), []);

  const performance = GATE_DOMAINS.find((domain) => domain.key === 'performance');
  const historical = gateEpicBody(performance, 'v0.6.0');
  const incremental = gateEpicBody(performance, 'v0.7.0');
  assert.doesNotMatch(historical, /release-audit-scope/);
  assert.match(incremental, /release-audit-scope\.mjs/);
  assert.match(incremental, /--previous-tag/);
  assert.match(incremental, /--head/);
  assert.match(incremental, /direct TS\/JS static-relative importers/);
  assert.match(incremental, /exact old\/new path/);
  assert.match(incremental, /--add <path> --reason <why>/);
  assert.match(incremental, /--full-audit/);
  assert.match(incremental, /v070-/);
  assert.match(incremental, /do not reinterpret.*v0\.6 receipts/);
});
