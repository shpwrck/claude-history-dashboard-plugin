// Unit tests for backfill-release-notes.mjs (#716): regrouping a published
// Release body under the .github/release.yml categories without ever losing
// the previous body.
//
// node:test, no network — orchestration runs against a mocked fetch with
// fixture PR label lists. Run: npm run test:backfill-release-notes
//   (= node --test scripts/backfill-release-notes.test.mjs)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadReleaseConfig } from './label-milestone-prs.mjs';
import {
  backfillReleaseNotes,
  composeBody,
  PLACEHOLDER_SUMMARY,
  PRESERVED_MARKER,
  preserveBody,
  regroupChangelog,
  splitReleaseBody,
} from './backfill-release-notes.mjs';

const CONFIG = loadReleaseConfig();

// A faithful `--generate-notes` flat dump (the v0.1.1/v0.2.0 starting state).
const FLAT_BODY = [
  "## What's Changed",
  '* [#646] Surface the running version in the app by @x in https://github.com/o/r/pull/647',
  '* docs(releasing): two-phase release-gate model by @x in https://github.com/o/r/pull/648',
  '* [#652] Exempt patch releases from the gate by @x in https://github.com/o/r/pull/653',
  '',
  '## New Contributors',
  '* @x made their first contribution in https://github.com/o/r/pull/647',
  '',
  '**Full Changelog**: https://github.com/o/r/compare/v0.1.0...v0.1.1',
].join('\n');

// --- splitReleaseBody

test('splitReleaseBody: flat generated notes -> no summary, entries, tail kept', () => {
  const r = splitReleaseBody(FLAT_BODY);
  assert.equal(r.summary, '');
  assert.deepEqual(r.entries.map((e) => e.number), [647, 648, 653]);
  assert.match(r.tail, /^## New Contributors/);
  assert.match(r.tail, /\*\*Full Changelog\*\*: https:\/\/github\.com\/o\/r\/compare\/v0\.1\.0\.\.\.v0\.1\.1$/);
  assert.equal(r.preserved, null);
});

test('splitReleaseBody: a hand-written summary above the changelog is preserved', () => {
  const r = splitReleaseBody(`This patch hardens the release process.\nSecond line.\n\n${FLAT_BODY}`);
  assert.equal(r.summary, 'This patch hardens the release process.\nSecond line.');
  assert.equal(r.entries.length, 3);
});

test('splitReleaseBody: already-categorized bodies are flattened back to entries', () => {
  const categorized = [
    'Summary prose.',
    '',
    "## What's Changed",
    '### Bug fixes',
    '* fix one by @x in https://github.com/o/r/pull/10',
    '### Other changes',
    '* misc by @x in https://github.com/o/r/pull/11',
    '',
    '**Full Changelog**: https://github.com/o/r/compare/a...b',
  ].join('\n');
  const r = splitReleaseBody(categorized);
  assert.equal(r.summary, 'Summary prose.');
  assert.deepEqual(r.entries.map((e) => e.number), [10, 11]);
  assert.match(r.tail, /^\*\*Full Changelog\*\*/);
});

test('splitReleaseBody: a body with no changelog heading is all summary', () => {
  const r = splitReleaseBody('Just prose, no generated notes.');
  assert.equal(r.summary, 'Just prose, no generated notes.');
  assert.deepEqual(r.entries, []);
});

// --- regroupChangelog with fixture PR label lists

test('regroupChangelog: buckets by label in release.yml category order', () => {
  const entries = [
    { number: 1, line: '* sec fix in https://github.com/o/r/pull/1', labels: ['security'] },
    { number: 2, line: '* feature in https://github.com/o/r/pull/2', labels: ['enhancement', 'backlog'] },
    { number: 3, line: '* bug fix in https://github.com/o/r/pull/3', labels: ['bug'] },
    { number: 4, line: '* unlabeled in https://github.com/o/r/pull/4', labels: [] },
    { number: 5, line: '* docs in https://github.com/o/r/pull/5', labels: ['documentation'] },
  ];
  const { sections, excluded } = regroupChangelog(entries, CONFIG);
  assert.deepEqual(
    sections.map((s) => [s.title, s.lines.length]),
    [
      ['Security', 1],
      ['Features & enhancements', 1],
      ['Bug fixes', 1],
      ['Documentation', 1],
      ['Other changes', 1],
    ],
  );
  assert.equal(excluded.length, 0);
  // Empty categories are omitted entirely (no "Performance" heading above).
  assert.equal(sections.some((s) => s.title === 'Performance'), false);
});

test('regroupChangelog: multi-label PR lands in the FIRST matching category (GitHub behavior)', () => {
  const entries = [
    { number: 6, line: '* both in https://github.com/o/r/pull/6', labels: ['tech-debt', 'security'] },
  ];
  const { sections } = regroupChangelog(entries, CONFIG);
  assert.deepEqual(sections.map((s) => s.title), ['Security']);
});

test('regroupChangelog: exclude labels (meta etc.) drop the entry and report it', () => {
  const entries = [
    { number: 7, line: '* meta in https://github.com/o/r/pull/7', labels: ['meta', 'enhancement'] },
    { number: 8, line: '* real in https://github.com/o/r/pull/8', labels: ['enhancement'] },
  ];
  const { sections, excluded } = regroupChangelog(entries, CONFIG);
  assert.deepEqual(excluded.map((e) => e.number), [7]);
  assert.deepEqual(sections, [
    { title: 'Features & enhancements', lines: ['* real in https://github.com/o/r/pull/8'] },
  ]);
});

// --- composition: summary handling + previous-body preservation

test('composeBody: no summary -> loud placeholder; previous body kept under the marker', () => {
  const { sections } = regroupChangelog(
    [{ number: 1, line: '* a in https://github.com/o/r/pull/1', labels: ['bug'] }],
    CONFIG,
  );
  const { body, usedPlaceholder } = composeBody({
    summary: '', sections, tail: '**Full Changelog**: x', originalBody: FLAT_BODY, preserved: null,
  });
  assert.equal(usedPlaceholder, true);
  assert.equal(body.startsWith(PLACEHOLDER_SUMMARY), true);
  assert.match(body, /### Bug fixes\n\n\* a in https:\/\/github\.com\/o\/r\/pull\/1/);
  assert.equal(body.includes(`<!-- ${PRESERVED_MARKER}`), true);
  // The original flat dump is inside the comment, verbatim.
  assert.equal(body.includes('* docs(releasing): two-phase release-gate model by @x in https://github.com/o/r/pull/648'), true);
});

test('composeBody: existing summary is used verbatim, no placeholder', () => {
  const { body, usedPlaceholder } = composeBody({
    summary: 'Hand-written words.', sections: [], tail: '', originalBody: 'old', preserved: null,
  });
  assert.equal(usedPlaceholder, false);
  assert.equal(body.startsWith('Hand-written words.'), true);
  assert.equal(body.includes(PLACEHOLDER_SUMMARY), false);
});

test('composeBody: an unreplaced placeholder summary stays flagged on re-run', () => {
  const { body, usedPlaceholder } = composeBody({
    summary: PLACEHOLDER_SUMMARY, sections: [], tail: '', originalBody: 'old', preserved: null,
  });
  assert.equal(usedPlaceholder, true);
  assert.equal(body.startsWith(PLACEHOLDER_SUMMARY), true);
});

test('preserveBody escapes the comment terminator so the block cannot be cut short', () => {
  const block = preserveBody('text with --> a terminator');
  assert.equal(block.includes('--\\>'), true);
  assert.equal(block.indexOf('-->'), block.length - 3); // only the closing one
});

test('re-run does not nest preserved blocks and re-preserves the CURRENT body', () => {
  const first = composeBody({
    summary: '', sections: [], tail: '', originalBody: 'THE ORIGINAL',
  }).body;
  const reparsed = splitReleaseBody(first);
  assert.ok(reparsed.preserved, 'first run output carries a preserved block');
  // Maintainer hand-edits the published body after run 1...
  const handEdited = `${first}\n\nHand-added notes after backfill.`;
  const second = composeBody({
    summary: 'Now hand-written.', sections: [], tail: '',
    originalBody: handEdited,
  }).body;
  const markers = second.split(`<!-- ${PRESERVED_MARKER}`).length - 1;
  assert.equal(markers, 1, 'blocks never nest');
  // ...and run 2's marker holds the CURRENT (edited) body, so post-backfill
  // edits survive in the body itself, not only in the prior run's log.
  assert.equal(second.includes('Hand-added notes after backfill.'), true);
});

test('prose written around an unreplaced placeholder line is kept, not clobbered', () => {
  const summaryWithProse = `Real summary the maintainer wrote.\n\n${PLACEHOLDER_SUMMARY}`;
  const { body, usedPlaceholder } = composeBody({
    summary: summaryWithProse, sections: [], tail: '', originalBody: 'X',
  });
  assert.equal(usedPlaceholder, false);
  assert.equal(body.includes('Real summary the maintainer wrote.'), true);
  assert.equal(body.includes('_Summary pending'), false);
});

// --- orchestration against a mocked GitHub API

function jsonResponse(data) {
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
}

function makeMockApi({ release, labelsByPr }) {
  const patches = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    if (method === 'PATCH') {
      patches.push({ path: u.pathname, body: JSON.parse(init.body) });
      return jsonResponse({ ...release, body: JSON.parse(init.body).body });
    }
    if (u.pathname.match(/\/releases\/tags\//)) return jsonResponse(release);
    const issue = u.pathname.match(/\/issues\/(\d+)$/);
    if (issue) {
      return jsonResponse({ number: Number(issue[1]), labels: (labelsByPr[issue[1]] ?? []).map((name) => ({ name })) });
    }
    throw new Error(`unexpected request: ${method} ${u.pathname}`);
  };
  return { fetchImpl, patches };
}

test('backfillReleaseNotes: dry run composes but never PATCHes', async () => {
  const { fetchImpl, patches } = makeMockApi({
    release: { id: 55, body: FLAT_BODY },
    labelsByPr: { 647: ['enhancement'], 648: ['documentation'], 653: [] },
  });
  const r = await backfillReleaseNotes({
    repo: 'o/r', tag: 'v0.1.1', token: 't', fetchImpl, config: CONFIG, log: () => {},
  });
  assert.equal(r.applied, false);
  assert.deepEqual(patches, []);
  assert.equal(r.usedPlaceholder, true);
  assert.deepEqual(r.sections, [
    { title: 'Features & enhancements', count: 1 },
    { title: 'Documentation', count: 1 },
    { title: 'Other changes', count: 1 },
  ]);
  assert.equal(r.originalBody, FLAT_BODY);
});

test('backfillReleaseNotes: --apply PATCHes the composed body to the release id', async () => {
  const { fetchImpl, patches } = makeMockApi({
    release: { id: 55, body: `Existing summary.\n\n${FLAT_BODY}` },
    labelsByPr: { 647: ['enhancement'], 648: ['documentation'], 653: ['infra'] },
  });
  const r = await backfillReleaseNotes({
    repo: 'o/r', tag: 'v0.1.1', token: 't', fetchImpl, apply: true, config: CONFIG, log: () => {},
  });
  assert.equal(r.applied, true);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].path, '/repos/o/r/releases/55');
  const sent = patches[0].body.body;
  assert.equal(sent.startsWith('Existing summary.'), true);
  assert.equal(r.usedPlaceholder, false);
  assert.match(sent, /### Infrastructure & build/);
  assert.equal(sent.includes(`<!-- ${PRESERVED_MARKER}`), true);
});

test('backfillReleaseNotes: a body with no PR bullets fails loudly instead of wiping', async () => {
  const { fetchImpl, patches } = makeMockApi({
    release: { id: 55, body: 'prose only' },
    labelsByPr: {},
  });
  await assert.rejects(
    () => backfillReleaseNotes({ repo: 'o/r', tag: 'v0.1.1', token: 't', fetchImpl, apply: true, config: CONFIG, log: () => {} }),
    /no PR bullet lines/,
  );
  assert.deepEqual(patches, []);
});
