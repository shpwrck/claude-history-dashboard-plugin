// Tests for the CI supply-chain gate (#3306, #3307).
//
// Each case is written so it FAILS against the pre-fix tree: the mutable-tag and
// fetch-and-run fixtures are copied from the exact lines the audit cited, so a
// gate that stopped detecting them would go red here rather than quietly pass.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  violationsIn,
  imageViolationsIn,
  logicalLines,
  listWorkflowFiles,
  listRunnerImageFiles,
  scanRepository,
} from './check-action-pins.mjs';

const rulesFor = (source) => violationsIn(source).map((v) => v.rule);

test('PIN: a mutable major tag is rejected (the #3307 shape)', () => {
  const found = violationsIn('      - uses: actions/checkout@v6\n');
  assert.deepEqual(found.map((v) => v.rule), ['PIN']);
  assert.match(found[0].detail, /not pinned to a 40-character commit SHA/);
});

test('PIN: every mutable ref the audit cited is caught', () => {
  // Verbatim from the pre-fix workflows: agent-cross-review (github-script,
  // claude-code-action), browser-compat (upload-artifact), notify-ready (v9).
  for (const ref of [
    'actions/checkout@v6',
    'actions/setup-node@v6',
    'actions/github-script@v7',
    'actions/github-script@v9',
    'actions/upload-artifact@v4',
    'actions/upload-artifact@v7',
    'anthropics/claude-code-action@v1',
  ]) {
    assert.deepEqual(rulesFor(`        uses: ${ref}\n`), ['PIN'], `${ref} must be rejected`);
  }
});

test('PIN: a branch name, a short SHA, and a 40-char non-hex are all rejected', () => {
  assert.deepEqual(rulesFor('        uses: some/action@main\n'), ['PIN']);
  assert.deepEqual(rulesFor('        uses: some/action@d23441a\n'), ['PIN']);
  assert.deepEqual(rulesFor(`        uses: some/action@${'z'.repeat(40)}\n`), ['PIN']);
});

test('PIN: a full 40-hex commit SHA passes, with or without a version comment', () => {
  const sha = 'd23441a48e516b6c34aea4fa41551a30e30af803';
  assert.deepEqual(violationsIn(`        uses: actions/checkout@${sha}\n`), []);
  assert.deepEqual(violationsIn(`        uses: actions/checkout@${sha} # v6\n`), []);
  assert.deepEqual(violationsIn(`        uses: actions/cache/restore@${sha} # v4\n`), []);
});

test('PIN: local ./ refs are exempt — they are this commit, nothing mutable to pin', () => {
  assert.deepEqual(violationsIn('        uses: ./.github/actions/require-gh\n'), []);
});

test('PIN: a docker:// ref needs an image digest, not a tag', () => {
  assert.deepEqual(rulesFor('        uses: docker://alpine:3.20\n'), ['PIN']);
  assert.deepEqual(violationsIn(`        uses: docker://alpine@sha256:${'a'.repeat(64)}\n`), []);
});

test('PIN: a quoted ref is unwrapped before checking', () => {
  assert.deepEqual(rulesFor('        uses: "actions/checkout@v6"\n'), ['PIN']);
  assert.deepEqual(rulesFor("        uses: 'actions/checkout@v6'\n"), ['PIN']);
});

test('PIN: a `uses:` inside a YAML comment is not a live reference', () => {
  assert.deepEqual(violationsIn('      # uses: actions/checkout@v6 (historical note)\n'), []);
});

test('FETCH: the exact #3306 pipeline is caught, including across a line continuation', () => {
  // Copied from .github/actions/ensure-gh/action.yml:32-33 before the fix.
  const preFix = [
    '        tmp="$(mktemp -d)"',
    '        curl -fsSL "https://github.com/cli/cli/releases/download/v${ver}/gh_${ver}_linux_amd64.tar.gz" \\',
    '          | tar -xz -C "$tmp"',
    '',
  ].join('\n');
  assert.deepEqual(rulesFor(preFix), ['FETCH']);
});

test('FETCH: a single-line curl-into-tar is caught (the pages-publish-stable copy)', () => {
  const line =
    '          curl -fsSL "https://github.com/cli/cli/releases/download/v${ver}/gh.tar.gz" | tar -xz -C "$tmp"\n';
  assert.deepEqual(rulesFor(line), ['FETCH']);
});

test('FETCH: piping a download into a shell or another interpreter is caught', () => {
  for (const target of ['sh', 'bash', 'python3', 'node', 'unzip']) {
    assert.deepEqual(
      rulesFor(`          curl -fsSL https://example.test/x | ${target}\n`),
      ['FETCH'],
      `curl | ${target} must be rejected`
    );
  }
  assert.deepEqual(rulesFor('          wget -qO- https://example.test/x | sudo bash\n'), ['FETCH']);
});

test('FETCH: fetching DATA is untouched — the gate claims execution, not download', () => {
  // Reading release metadata is not running it; over-blocking here would push
  // authors into worse workarounds.
  assert.deepEqual(violationsIn('          curl -fsSL https://example.test/a.json | jq -r .tag_name\n'), []);
  assert.deepEqual(violationsIn('          curl -fsSL -o out.tgz https://example.test/a.tgz\n'), []);
});

test('FETCH: piping local text into bash is not a download (docker-publish.yml shape)', () => {
  assert.deepEqual(
    violationsIn(`          printf '%s\\n' "$TAGS" | bash scripts/docker-push-retry.sh\n`),
    []
  );
});

test('FETCH: a fetch and an unrelated pipe in one continuation chain do not join into a false positive', () => {
  // Both statements are safe, but they land on ONE logical line once the `\`
  // continuations are joined. Before FETCH_EXEC_RE was anchored to a single
  // command, the `curl` on the first line paired with the `| bash` on the third
  // and failed the exact download-then-verify shape this gate encourages.
  const safe = [
    '    curl -fsSL https://example.test/x.tgz -o /tmp/x.tgz; \\',
    "    printf '%s\\n' \"$TAGS\" | bash scripts/docker-push-retry.sh; \\",
    '    tar -xzf /tmp/x.tgz -C /tmp',
    '',
  ].join('\n');
  assert.deepEqual(violationsIn(safe), []);
  assert.deepEqual(imageViolationsIn(safe), []);
});

test('FETCH: sha256sum between the fetch and the extract is not mistaken for `sh`', () => {
  // `sha256sum` starts with `sh`; the word boundary is what keeps the real
  // runner-image fix from tripping its own gate.
  const verified =
    '    curl -fsSL https://example.test/n.tgz -o /tmp/n.tgz; echo "abc  /tmp/n.tgz" | sha256sum -c -; tar -xzf /tmp/n.tgz\n';
  assert.deepEqual(imageViolationsIn(verified), []);
});

test('logicalLines: strips trailing comments but keeps the original line number', () => {
  const lines = logicalLines('a: 1\n# whole-line comment\nb: 2 # trailing\n');
  assert.deepEqual(
    lines.map((l) => [l.number, l.text.trim()]).filter(([, text]) => text !== ''),
    [
      [1, 'a: 1'],
      [3, 'b: 2'],
    ]
  );
});

test('the gate walks real workflow AND composite-action files', () => {
  const files = listWorkflowFiles();
  assert.ok(files.length > 10, 'expected the repo workflow set');
  assert.ok(
    files.some((f) => f.includes(join('.github', 'actions'))),
    'composite actions must be scanned — .github/actions/require-gh is the #3306 site'
  );
});

// --- runner-image rules ------------------------------------------------------
// #3306 was fixed by deleting the workflow-side gh installer and trusting the
// baked runner image. These cases exist so that decision cannot quietly become
// "the same download, one layer down".

test('IMAGE/FETCH: the pre-fix runner-image gh install is caught verbatim', () => {
  // deploy/arc/runner-image/Dockerfile:38 before the fix.
  const preFix =
    '    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" | tar -xz -C /tmp; \\\n';
  assert.deepEqual(imageViolationsIn(preFix).map((v) => v.rule), ['FETCH']);
});

test('IMAGE/FETCH: download-to-file then verify then extract is accepted', () => {
  const fixed = [
    '    curl -fsSL "https://example.test/gh.tar.gz" -o /tmp/gh.tgz; \\',
    '    echo "${GH_SHA256}  /tmp/gh.tgz" | sha256sum -c -; \\',
    '    tar -xzf /tmp/gh.tgz -C /tmp; \\',
    '',
  ].join('\n');
  assert.deepEqual(imageViolationsIn(fixed), []);
});

test('IMAGE/PIN: a tagged base image is rejected, a digest-pinned one accepted', () => {
  assert.deepEqual(
    imageViolationsIn('FROM ghcr.io/actions/actions-runner:latest\n').map((v) => v.rule),
    ['PIN']
  );
  assert.deepEqual(
    imageViolationsIn(`FROM ghcr.io/actions/actions-runner@sha256:${'0'.repeat(64)}\n`),
    []
  );
  assert.deepEqual(imageViolationsIn('FROM scratch\n'), []);
});

test('IMAGE/PIN: a BuildConfig `from.name` registry ref must carry a digest', () => {
  assert.deepEqual(
    imageViolationsIn('        name: ghcr.io/actions/actions-runner:v2\n').map((v) => v.rule),
    ['PIN']
  );
  assert.deepEqual(
    imageViolationsIn(`        name: ghcr.io/actions/actions-runner@sha256:${'0'.repeat(64)}\n`),
    []
  );
  // A plain YAML name (not a registry reference) is not an image.
  assert.deepEqual(imageViolationsIn('        name: chd-ci-runner\n'), []);
  assert.deepEqual(imageViolationsIn('  name: arc-gha-rs-controller\n'), []);
});

test('the runner-image build is actually in the scanned set', () => {
  const files = listRunnerImageFiles().map((f) => f.split('/').pop());
  assert.ok(files.includes('Dockerfile'), 'runner-image Dockerfile must be scanned');
  assert.ok(files.includes('buildconfig.yaml'), 'in-cluster build copy must be scanned');
});

test('a synthetic pre-fix repo trips the gate; the real repo is clean', () => {
  const root = mkdtempSync(join(tmpdir(), 'action-pins-'));
  try {
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'workflows', 'ci.yml'),
      ['jobs:', '  a:', '    steps:', '      - uses: actions/checkout@v6', ''].join('\n')
    );
    const offenders = scanRepository(root);
    assert.deepEqual(offenders.map((o) => o.rule), ['PIN']);
    assert.equal(offenders[0].file, '.github/workflows/ci.yml');
    assert.equal(offenders[0].line, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // The live repository must satisfy the gate it ships.
  assert.deepEqual(scanRepository(), []);
});
