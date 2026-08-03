// Tests for the CI supply-chain gate (#3306, #3307).
//
// Each case is written so it FAILS against the pre-fix tree: the mutable-tag and
// fetch-and-run fixtures are copied from the exact lines the audit cited, so a
// gate that stopped detecting them would go red here rather than quietly pass.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import {
  violationsIn,
  imageViolationsIn,
  poolViolationsIn,
  poolImageRefsIn,
  buildConfigImageFieldsIn,
  producerTagsIn,
  crossFileStampOffenders,
  containerImageAbsences,
  imageRefTag,
  imageRefName,
  imageRefRepository,
  unquote,
  imageRefProblem,
  logicalLines,
  listWorkflowFiles,
  listPublishedImageFiles,
  listRunnerImageFiles,
  listRunnerPoolFiles,
  publisherCapabilityReasons,
  inertnessReasons,
  scanRepository,
  workflowSecretReferences,
} from './check-action-pins.mjs';
import {
  inspectContainerImageManifest,
  publisherWorkflowDriftReasons,
  renderContainerPublishWorkflow,
} from './container-image-manifest.mjs';

/** The exact pre-fix line from all four scale-set values files (#3340). */
const LATEST_REF = 'image-registry.openshift-image-registry.svc:5000/arc-runners/chd-ci-runner';
const STAMP = 'v2026-07-29-87858e92';
/** The repository the in-cluster BuildConfig publishes to. */
const REPO = 'image-registry.openshift-image-registry.svc:5000/arc-runners/chd-ci-runner';

const buildConfigFrom = (value) =>
  ['spec:', '  strategy:', '    dockerStrategy:', '      from:', `        name: ${value}`, ''].join('\n');
const buildConfigOutput = (value) =>
  ['spec:', '  output:', '    to:', `      name: ${value}`, ''].join('\n');

function writeContainerManifest(root, images) {
  writeFileSync(
    join(root, 'container-images.json'),
    `${JSON.stringify({ schemaVersion: 1, images }, null, 2)}\n`
  );
}

function fixtureImage(overrides = {}) {
  return {
    id: 'server',
    image: 'example/dashboard',
    recipe: 'Dockerfile',
    context: '.',
    buildMode: 'server',
    ...overrides,
  };
}

function fixtureSpaImage(overrides = {}) {
  return {
    id: 'spa',
    image: 'example/dashboard-spa',
    recipe: 'Dockerfile.spa',
    context: '.',
    buildMode: 'spa',
    ...overrides,
  };
}

function fixtureImages(serverOverrides = {}, spaOverrides = {}) {
  return [fixtureImage(serverOverrides), fixtureSpaImage(spaOverrides)];
}

function writeFixtureRecipes(root) {
  writeFileSync(join(root, 'Dockerfile'), `FROM node@sha256:${'0'.repeat(64)}\n`);
  writeFileSync(join(root, 'Dockerfile.spa'), `FROM node@sha256:${'0'.repeat(64)}\n`);
}

function writeCanonicalPublisher(root) {
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(root, '.github', 'workflows', 'docker-publish.yml'), renderContainerPublishWorkflow(root));
}

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
    imageViolationsIn(buildConfigFrom('ghcr.io/actions/actions-runner:v2')).map((v) => v.rule),
    ['PIN']
  );
  assert.deepEqual(
    imageViolationsIn(buildConfigFrom(`ghcr.io/actions/actions-runner@sha256:${'0'.repeat(64)}`)),
    []
  );
  // A plain ImageStream name (not a tagged reference) is not mutable.
  assert.deepEqual(imageViolationsIn(buildConfigFrom('chd-ci-runner')), []);
  // A generic metadata name is not an image-bearing field.
  assert.deepEqual(imageViolationsIn('  name: arc-gha-rs-controller\n'), []);
});

test('#3509: alternate YAML spellings fail closed only at image-bearing BuildConfig paths', () => {
  const nextLineOutput = [
    'spec:',
    '  output:',
    '    to:',
    '      name:',
    '        chd-ci-runner:latest',
    '',
  ].join('\n');
  const nextLineFrom = [
    'spec:',
    '  strategy:',
    '    dockerStrategy:',
    '      from:',
    '        name:',
    '          ghcr.io/actions/actions-runner:v2',
    '',
  ].join('\n');
  for (const [source, rule] of [
    [nextLineOutput, 'STAMP'],
    [nextLineFrom, 'PIN'],
    [buildConfigOutput('!!str chd-ci-runner:latest'), 'STAMP'],
    [buildConfigFrom('&runner ghcr.io/actions/actions-runner:v2'), 'PIN'],
  ]) {
    const problems = imageViolationsIn(source);
    assert.deepEqual(problems.map((problem) => problem.rule), [rule]);
    assert.match(problems[0].detail, /cannot be checked|does not resolve/);
  }

  const metadataNextLine = ['metadata:', '  name:', '    chd-ci-runner', ''].join('\n');
  assert.deepEqual(buildConfigImageFieldsIn(metadataNextLine), { fields: [], problems: [] });
  assert.deepEqual(imageViolationsIn(metadataNextLine), []);
});

// --- #3340: the ARC runner pool -------------------------------------------

test('imageRefTag: a registry PORT is not mistaken for the tag', () => {
  // The whole reason this needs its own function: the host carries `:5000`.
  assert.equal(imageRefTag(`${LATEST_REF}:latest`), 'latest');
  assert.equal(imageRefTag(`${LATEST_REF}:${STAMP}`), STAMP);
  assert.equal(imageRefTag(LATEST_REF), null);
  assert.equal(imageRefTag('image-registry.openshift-image-registry.svc:5000/a/b'), null);
});

test('STAMP: the exact pre-fix scale-set line is rejected', () => {
  // Copied verbatim from deploy/arc/dind-scale-set-values.yaml:78 pre-fix. If the
  // gate stopped catching this, #3340 would have silently regressed.
  const problems = poolViolationsIn(`        image: ${LATEST_REF}:latest\n`);
  assert.deepEqual(problems.map((p) => p.rule), ['STAMP']);
  assert.match(problems[0].detail, /mutable tag `latest`/);
});

test('STAMP: a version-stamped tag is accepted', () => {
  assert.deepEqual(poolViolationsIn(`        image: ${LATEST_REF}:${STAMP}\n`), []);
});

test('STAMP: a digest stays acceptable — the stronger rung is never rejected', () => {
  // The dind sidecar is genuinely digest-pinned; the new rule must not flag it.
  assert.deepEqual(poolViolationsIn(`        image: docker@sha256:${'0'.repeat(64)}\n`), []);
});

test('STAMP: an untagged reference is rejected, because it resolves to :latest', () => {
  // The invisible spelling of the same defect — a denylist of mutable NAMES
  // would pass this.
  const problems = poolViolationsIn(`        image: ${LATEST_REF}\n`);
  assert.deepEqual(problems.map((p) => p.rule), ['STAMP']);
  assert.match(problems[0].detail, /names no tag/);
});

test('STAMP: a block-scalar `image:` fails closed rather than being skipped', () => {
  // YAML allows the value on the next line. A scanner that required an inline
  // value would skip this silently — a one-newline bypass of the whole rule.
  const problems = poolViolationsIn(`        image:\n          ${LATEST_REF}:latest\n`);
  assert.deepEqual(problems.map((p) => p.rule), ['STAMP']);
  assert.match(problems[0].detail, /not on the same line/);
});

test('STAMP: keys merely ENDING in `image` are not image references', () => {
  assert.deepEqual(poolViolationsIn('  runnerImage: whatever:latest\n'), []);
  assert.deepEqual(poolViolationsIn('  dindImage:\n'), []);
});

test('STAMP: other mutable tags are rejected, not just `latest`', () => {
  for (const tag of ['main', 'stable', 'v1', 'prod', 'edge', '2026-07-29', 'vlatest']) {
    assert.deepEqual(
      poolViolationsIn(`        image: ${LATEST_REF}:${tag}\n`).map((p) => p.rule),
      ['STAMP'],
      `tag \`${tag}\` must be rejected`
    );
  }
});

test('STAMP: the stamp grammar rejects near-misses', () => {
  // An allowlist is only worth having if it is actually narrow.
  for (const tag of [
    'v2026-07-29',              // no commit
    'v2026-07-29-',             // empty commit
    'v2026-07-29-zzzzzzz',      // not hex
    'v2026-07-29-abc',          // too short to identify a commit
    'v26-07-29-87858e92',       // two-digit year
    'x2026-07-29-87858e92',     // wrong prefix
  ]) {
    assert.deepEqual(
      poolViolationsIn(`        image: ${LATEST_REF}:${tag}\n`).map((p) => p.rule),
      ['STAMP'],
      `near-miss \`${tag}\` must be rejected`
    );
  }
  assert.equal(imageRefProblem(`${LATEST_REF}:v2026-07-29-87858e92b2302b4c39db6103874b3d4ba2d967b7`), null);
});

test('STAMP: the BuildConfig OUTPUT tag is checked, not only the base image', () => {
  // Fixing only the values files would leave the producer writing `:latest` —
  // the bug relocated one layer down rather than closed.
  const problems = imageViolationsIn(buildConfigOutput('chd-ci-runner:latest'));
  assert.deepEqual(problems.map((p) => p.rule), ['STAMP']);
  assert.deepEqual(imageViolationsIn(buildConfigOutput(`chd-ci-runner:${STAMP}`)), []);
  // Ordinary object names are still not images.
  assert.deepEqual(imageViolationsIn('  name: chd-ci-runner\n'), []);
  assert.deepEqual(imageViolationsIn('  name: arc-gha-rs-controller\n'), []);
  assert.deepEqual(imageViolationsIn('  name: arc-runners\n'), []);
});

// --- #3493: a DELETED image: line takes the chart's :latest default ----------

test('#3493 STAMP: a container entry with NO image: line is caught structurally', () => {
  const source = [
    'template:',
    '  spec:',
    '    containers:',
    '      - name: runner',
    '        command: ["/home/runner/run.sh"]',
    '',
  ].join('\n');
  const problems = containerImageAbsences(source);
  assert.deepEqual(problems.map((p) => p.rule), ['STAMP']);
  assert.equal(problems[0].line, 4, 'reports the container list item, not the whole file');
  assert.match(problems[0].detail, /`containers` entry declares no `image:`/);
});

test('#3493 STAMP: a container WITH an image (inline or on a key line) is not flagged', () => {
  const keyLine = [
    'template:',
    '  spec:',
    '    containers:',
    '      - name: runner',
    `        image: ${LATEST_REF}:${STAMP}`,
    '',
  ].join('\n');
  assert.deepEqual(containerImageAbsences(keyLine), []);

  const inline = [
    'template:',
    '  spec:',
    '    containers:',
    `      - image: ${LATEST_REF}:${STAMP}`,
    '        command: ["/home/runner/run.sh"]',
    '',
  ].join('\n');
  assert.deepEqual(containerImageAbsences(inline), []);
});

test('#3493 STAMP: initContainers are checked too, and a nested env/args block is not a new entry', () => {
  const source = [
    'template:',
    '  spec:',
    '    initContainers:',
    '      - name: init-dind-externals',
    '        command: ["cp", "-r", "/x/.", "/y/"]', // no image -> defect
    '    containers:',
    '      - name: runner',
    `        image: ${LATEST_REF}:${STAMP}`,
    '        env:',
    '          - name: DOCKER_HOST',
    '            value: unix:///run/docker/docker.sock',
    '      - name: dind',
    `        image: docker@sha256:${'0'.repeat(64)}`,
    '        args:',
    '          - dockerd',
    '',
  ].join('\n');
  const problems = containerImageAbsences(source);
  assert.deepEqual(problems.map((p) => p.rule), ['STAMP']);
  assert.match(problems[0].detail, /`initContainers` entry declares no `image:`/);
  // The runner's nested `- name: DOCKER_HOST` env entry and the dind `args`
  // list must NOT be mistaken for image-less container entries.
});

test('#3493 STAMP: the four real values files declare every container image', () => {
  for (const absolute of listRunnerPoolFiles()) {
    assert.deepEqual(
      containerImageAbsences(readFileSync(absolute, 'utf8')),
      [],
      `${absolute} must declare an image for every container/initContainer`
    );
  }
});

test('#3493 STAMP: a values file with a deleted image line trips the whole-repo scan', () => {
  const root = mkdtempSync(join(tmpdir(), 'action-pins-absent-'));
  try {
    mkdirSync(join(root, 'deploy', 'arc'), { recursive: true });
    // A producer so the cross-file check is anchored, isolating the absence.
    mkdirSync(join(root, 'deploy', 'arc', 'runner-image'), { recursive: true });
    writeFileSync(
      join(root, 'deploy', 'arc', 'runner-image', 'buildconfig.yaml'),
      ['  output:', '    to:', `      name: chd-ci-runner:${STAMP}`, ''].join('\n')
    );
    writeFileSync(
      join(root, 'deploy', 'arc', 'runner-scale-set-values.yaml'),
      ['template:', '  spec:', '    containers:', '      - name: runner', '        command: ["/x"]', ''].join(
        '\n'
      )
    );
    const offenders = scanRepository(root);
    assert.ok(
      offenders.some((o) => /declares no `image:`/.test(o.detail)),
      'a container with no image must fail the scan'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('all four scale-set values files are actually in the scanned set', () => {
  const files = listRunnerPoolFiles().map((f) => f.split('/').slice(-2).join('/'));
  for (const expected of [
    'arc/runner-scale-set-values.yaml',
    'arc/dind-scale-set-values.yaml',
    'hub/runner-scale-set-values.yaml',
    'hub/dind-scale-set-values.yaml',
  ]) {
    assert.ok(files.includes(expected), `${expected} must be scanned`);
  }
});

test('a scale set reverted to :latest trips the whole-repo scan', () => {
  const root = mkdtempSync(join(tmpdir(), 'action-pins-pool-'));
  try {
    mkdirSync(join(root, 'deploy', 'arc', 'hub'), { recursive: true });
    writeFileSync(
      join(root, 'deploy', 'arc', 'runner-scale-set-values.yaml'),
      ['template:', '  spec:', '    containers:', `      - image: ${LATEST_REF}:latest`, ''].join(
        '\n'
      )
    );
    const offenders = scanRepository(root);
    // Two independent reasons: the mutable tag itself, and no producer to anchor
    // it against (this fixture has no runner-image build).
    assert.deepEqual(offenders.map((o) => o.rule), ['STAMP', 'STAMP']);
    assert.equal(offenders[0].file, 'deploy/arc/runner-scale-set-values.yaml');
    assert.equal(offenders[0].line, 4);
    assert.match(offenders[0].detail, /mutable tag `latest`/);
    assert.match(offenders[1].detail, /no BuildConfig in this repo produces/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('imageRefName: producer and consumer spellings resolve to the same image', () => {
  assert.equal(imageRefName(`${LATEST_REF}:${STAMP}`), 'chd-ci-runner');
  assert.equal(imageRefName('chd-ci-runner:latest'), 'chd-ci-runner');
  assert.equal(imageRefName(`docker@sha256:${'0'.repeat(64)}`), 'docker');
});

test('STAMP/cross-file: a consumer left on the OLD stamp is caught', () => {
  // Codex P1. Both references are individually well-formed, so every per-line
  // rule passes -- and the pool ends up split across two tooling versions, or
  // pointed at a tag that was never built.
  const producers = [{ file: 'bc.yaml', line: 37, name: 'chd-ci-runner', tag: 'v2026-07-29-87858e92' }];
  const consumers = [
    { file: 'a.yaml', line: 43, name: 'chd-ci-runner', repository: REPO, tag: 'v2026-07-29-87858e92' },
    { file: 'b.yaml', line: 78, name: 'chd-ci-runner', repository: REPO, tag: 'v2026-06-13-6611d1ba' },
  ];
  const offenders = crossFileStampOffenders(producers, consumers);
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].file, 'b.yaml');
  assert.equal(offenders[0].line, 78);
  assert.match(offenders[0].detail, /one shared stamp/);
});

test('STAMP/cross-file: agreement is clean, and the producer is the anchor', () => {
  const producers = [{ file: 'bc.yaml', line: 37, name: 'chd-ci-runner', tag: STAMP }];
  const consumers = [
    { file: 'a.yaml', line: 43, name: 'chd-ci-runner', repository: REPO, tag: STAMP },
    { file: 'b.yaml', line: 78, name: 'chd-ci-runner', repository: REPO, tag: STAMP },
  ];
  assert.deepEqual(crossFileStampOffenders(producers, consumers), []);

  // A producer bumped alone is caught on EVERY stale consumer, not just one.
  const bumped = [{ file: 'bc.yaml', line: 37, name: 'chd-ci-runner', tag: 'v2026-08-01-deadbee' }];
  assert.equal(crossFileStampOffenders(bumped, consumers).length, 2);
});

test('STAMP/cross-file: an image no producer builds is rejected, not anchored to itself', () => {
  // Codex P1. The old fallback made the first consumer its own anchor, so
  // deleting or renaming the BuildConfig output made the check pass while
  // proving only that the consumers agree with each other.
  const consumers = [
    { file: 'a.yaml', line: 43, name: 'chd-ci-runner', repository: REPO, tag: STAMP },
    { file: 'b.yaml', line: 78, name: 'chd-ci-runner', repository: REPO, tag: STAMP },
  ];
  const offenders = crossFileStampOffenders([], consumers);
  assert.equal(offenders.length, 2, 'every unanchored consumer must be reported');
  assert.match(offenders[0].detail, /no BuildConfig in this repo produces/);
});

test('STAMP/cross-file: a matching basename in a FOREIGN repository is rejected', () => {
  // Codex P1. Identity must be the whole repository: a valid stamp on
  // ghcr.io/attacker/chd-ci-runner would otherwise pass both checks and
  // redirect privileged runners to an image this cluster never builds.
  const producers = [{ file: 'bc.yaml', line: 37, name: 'chd-ci-runner', tag: STAMP }];
  const consumers = [
    {
      file: 'a.yaml',
      line: 43,
      name: 'chd-ci-runner',
      repository: 'ghcr.io/attacker/chd-ci-runner',
      tag: STAMP,
    },
  ];
  const offenders = crossFileStampOffenders(producers, consumers);
  assert.equal(offenders.length, 1);
  assert.match(offenders[0].detail, /not the repository the BuildConfig publishes to/);
});

test('STAMP/cross-file: the real repo agrees producer-to-consumer', () => {
  // The live invariant the README promises operators.
  const producers = [];
  for (const absolute of listRunnerImageFiles()) {
    for (const p of producerTagsIn(readFileSync(absolute, 'utf8'))) {
      producers.push({ file: absolute, ...p });
    }
  }
  const consumers = [];
  for (const absolute of listRunnerPoolFiles()) {
    for (const c of poolImageRefsIn(readFileSync(absolute, 'utf8'))) {
      consumers.push({ file: absolute, ...c });
    }
  }
  const runners = consumers.filter((c) => c.name === 'chd-ci-runner');
  assert.equal(runners.length, 6, 'all six runner references must be seen');
  assert.ok(
    producers.some((p) => p.name === 'chd-ci-runner'),
    'the BuildConfig output tag must be seen'
  );
  assert.deepEqual(crossFileStampOffenders(producers, consumers), []);
});

test('INERT: an empty tree is reported, not silently passed', () => {
  // The gate's own green-but-inert guard: no files found means nothing was
  // verified, which must never read as success.
  const root = mkdtempSync(join(tmpdir(), 'action-pins-inert-'));
  try {
    assert.deepEqual(scanRepository(root), [], 'nothing to report...');
    const reasons = inertnessReasons(root);
    assert.ok(reasons.length >= 3, '...but the gate must refuse to call that a pass');
    assert.ok(reasons.some((r) => /deploy\/arc\//.test(r)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('INERT: consumers with no producer to anchor on are reported', () => {
  // The cross-file check degrades to "the consumers agree with themselves" when
  // the BuildConfig is absent. That is not a pass.
  const root = mkdtempSync(join(tmpdir(), 'action-pins-anchor-'));
  try {
    mkdirSync(join(root, 'deploy', 'arc'), { recursive: true });
    writeFileSync(
      join(root, 'deploy', 'arc', 'runner-scale-set-values.yaml'),
      `        image: ${LATEST_REF}:${STAMP}\n`
    );
    const reasons = inertnessReasons(root);
    assert.ok(
      reasons.some((r) => /nothing to anchor on/.test(r)),
      'an unanchored stamp check must be reported as inert'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('INERT: the real repository is NOT inert', () => {
  assert.deepEqual(inertnessReasons(), []);
});

test('#3064/#3513: the complete declared published-recipe inventory is scanned and pinned', () => {
  const files = listPublishedImageFiles();
  assert.deepEqual(files.map((absolute) => relative(process.cwd(), absolute)), [
    'Dockerfile',
    'Dockerfile.spa',
    'probaitio-operator/Dockerfile',
    'probaitio-operator/Dockerfile.dispatch',
  ]);
  for (const absolute of files) {
    assert.deepEqual(
      imageViolationsIn(readFileSync(absolute, 'utf8')),
      [],
      `${absolute} must pin every non-scratch FROM image by digest`
    );
  }
});

test('#3513: the live publisher and gate consume one valid four-image manifest', () => {
  const inspected = inspectContainerImageManifest();
  assert.deepEqual(inspected.reasons, []);
  assert.deepEqual(inspected.entries.map((entry) => entry.id), [
    'server',
    'spa',
    'dispatch',
    'operator-sdk',
  ]);
  assert.deepEqual(publisherWorkflowDriftReasons(), []);
  assert.deepEqual(publisherCapabilityReasons(), []);
  const workflow = readFileSync(join(process.cwd(), '.github', 'workflows', 'docker-publish.yml'), 'utf8');
  assert.match(workflow, /4 sequential dind jobs \(the former publisher used one job\)/);
  assert.match(workflow, /fail-fast: true\n\s+max-parallel: 1/);
});

test('#3513: manifest schema and reserved server/SPA publication modes fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'container-manifest-modes-'));
  try {
    writeFixtureRecipes(root);
    writeContainerManifest(root, fixtureImages());
    assert.deepEqual(inspectContainerImageManifest(root).reasons, []);

    writeFileSync(
      join(root, 'container-images.json'),
      `${JSON.stringify({ schemaVersion: 1, images: fixtureImages(), typo: true }, null, 2)}\n`
    );
    assert.match(
      inspectContainerImageManifest(root).reasons.join('\n'),
      /must contain exactly images, schemaVersion/,
      'unknown top-level keys must not silently survive a manifest typo'
    );

    writeContainerManifest(root, fixtureImages({ buildMode: 'plain' }));
    const demoted = inspectContainerImageManifest(root).reasons.join('\n');
    assert.match(demoted, /reserved id server must use buildMode server/);
    assert.match(demoted, /exactly one server buildMode \(found 0\)/);

    writeContainerManifest(root, fixtureImages({ buildMode: 'spa' }, { buildMode: 'server' }));
    const swapped = inspectContainerImageManifest(root).reasons.join('\n');
    assert.match(swapped, /reserved id server must use buildMode server/);
    assert.match(swapped, /reserved id spa must use buildMode spa/);

    writeFileSync(join(root, 'Dockerfile.extra'), 'FROM scratch\n');
    writeContainerManifest(root, [
      ...fixtureImages(),
      {
        id: 'extra-server',
        image: 'example/extra-server',
        recipe: 'Dockerfile.extra',
        context: '.',
        buildMode: 'server',
      },
    ]);
    assert.match(
      inspectContainerImageManifest(root).reasons.join('\n'),
      /exactly one server buildMode \(found 2\)/
    );

    writeContainerManifest(root, [fixtureImage()]);
    assert.match(
      inspectContainerImageManifest(root).reasons.join('\n'),
      /exactly one spa buildMode \(found 0\)/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#3513: a separate unknown-mechanism workflow cannot acquire publisher capability', () => {
  const root = mkdtempSync(join(tmpdir(), 'container-publisher-capability-'));
  const workflowDirectory = join(root, '.github', 'workflows');
  const shadowWorkflow = join(workflowDirectory, 'shadow-publisher.yml');
  try {
    mkdirSync(workflowDirectory, { recursive: true });
    writeFileSync(
      shadowWorkflow,
      [
        'name: shadow-publisher',
        'permissions:',
        '  packages: write',
        'jobs:',
        '  publish:',
        '    runs-on: arc-dind',
        '    steps:',
        '      - run: make publish-ghcr',
        '',
      ].join('\n')
    );
    const packageWriter = publisherCapabilityReasons(root).join('\n');
    assert.match(packageWriter, /mentions the reserved packages capability/);
    assert.doesNotMatch(packageWriter, /no explicit top-level permissions/);

    writeFileSync(
      shadowWorkflow,
      [
        'name: shadow-publisher',
        'jobs:',
        '  publish:',
        '    permissions:',
        '      contents: read',
        '    runs-on: arc-dind',
        '    steps:',
        '      - run: make publish-ghcr',
        '',
      ].join('\n')
    );
    assert.match(
      publisherCapabilityReasons(root).join('\n'),
      /no explicit top-level permissions: declaration/,
      'job-level or inherited permissions are not the required workflow ceiling'
    );

    writeFileSync(
      shadowWorkflow,
      [
        'name: shadow-publisher',
        'permissions: write-all',
        'jobs:',
        '  publish:',
        '    runs-on: arc-runner-set',
        '    steps:',
        '      - run: make publish-ghcr',
        '',
      ].join('\n')
    );
    assert.match(
      publisherCapabilityReasons(root).join('\n'),
      /unsupported permissions scalar write-all/,
      'write-all must not grant package authority without spelling packages'
    );

    writeFileSync(
      shadowWorkflow,
      [
        'name: shadow-publisher',
        'permissions:',
        '  "pack\\u0061ges": write',
        'jobs: {}',
        '',
      ].join('\n')
    );
    assert.match(
      publisherCapabilityReasons(root).join('\n'),
      /double-quoted escape this lexical capability boundary cannot resolve/,
      'YAML string escapes cannot hide the reserved permission key'
    );

    writeFileSync(
      shadowWorkflow,
      [
        'name: shadow-publisher',
        'permissions:',
        '  contents: read',
        'jobs:',
        '  publish:',
        '    runs-on: arc-runner-set',
        '    steps:',
        '      - env:',
        '          TOKEN: ${{ Secrets.CODEX_TRIGGER_PAT }}',
        '        run: make publish-ghcr',
        '',
      ].join('\n')
    );
    assert.match(
      publisherCapabilityReasons(root).join('\n'),
      /references unapproved secret CODEX_TRIGGER_PAT/,
      'a mixed-case dot context cannot let a new workflow borrow an existing credential'
    );

    writeFileSync(
      shadowWorkflow,
      [
        'name: shadow-publisher',
        'permissions:',
        '  contents: read',
        'jobs:',
        '  publish:',
        '    runs-on: arc-runner-set',
        '    steps:',
        '      - env:',
        '          TOKEN: ${{ sEcReTs["CODEX_TRIGGER_PAT"] }}',
        '        run: make publish-ghcr',
        '',
      ].join('\n')
    );
    assert.match(
      publisherCapabilityReasons(root).join('\n'),
      /references unapproved secret CODEX_TRIGGER_PAT/,
      'a mixed-case bracket context cannot let a new workflow borrow an existing credential'
    );

    writeFileSync(join(workflowDirectory, 'target.txt'), 'permissions:\n  contents: read\n');
    rmSync(shadowWorkflow);
    symlinkSync('target.txt', shadowWorkflow);
    assert.match(
      publisherCapabilityReasons(root).join('\n'),
      /shadow-publisher\.yml is a symbolic link/,
      'a workflow symlink cannot redirect the capability scan'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#3513: dynamic secret contexts fail closed instead of escaping the pairing inventory', () => {
  assert.deepEqual(
    workflowSecretReferences(
      'env:\n  DOT: ${{ Secrets.Known_Dot }}\n  BRACKET: ${{ sEcReTs["Known_Bracket"] }}\n'
    ),
    {
      references: ['KNOWN_DOT', 'KNOWN_BRACKET'],
      ambiguous: false,
    }
  );
  assert.deepEqual(workflowSecretReferences('env:\n  TOKEN: ${{ secrets.KNOWN }}\n'), {
    references: ['KNOWN'],
    ambiguous: false,
  });
  assert.equal(workflowSecretReferences('secrets: inherit\n').ambiguous, true);
  assert.equal(workflowSecretReferences('env:\n  TOKEN: ${{ SeCrEtS[matrix.name] }}\n').ambiguous, true);
});

test('#3513: unknown publisher mechanisms and path redirects are generic workflow drift', () => {
  const root = mkdtempSync(join(tmpdir(), 'container-publisher-drift-'));
  try {
    writeFixtureRecipes(root);
    writeContainerManifest(root, fixtureImages());
    writeCanonicalPublisher(root);
    const canonical = readFileSync(join(root, '.github', 'workflows', 'docker-publish.yml'), 'utf8');

    writeContainerManifest(root, fixtureImages({ image: 'example/changed-dashboard' }));
    assert.match(
      publisherWorkflowDriftReasons(root).join('\n'),
      /differs from the canonical manifest-compiled publisher/,
      'changing the source manifest must require regenerating the workflow'
    );
    writeContainerManifest(root, fixtureImages());

    for (const mutation of [
      '\n      - run: make publish\n',
      '\n      - run: scripts/publish-wrapper.sh\n',
      '\n      - uses: ./.github/actions/publish-image\n',
      '\n        working-directory: elsewhere\n',
      '\n      - run: cd elsewhere && docker build .\n',
    ]) {
      writeFileSync(join(root, '.github', 'workflows', 'docker-publish.yml'), canonical + mutation);
      const reasons = publisherWorkflowDriftReasons(root);
      assert.equal(reasons.length, 1);
      assert.match(reasons[0], /differs from the canonical manifest-compiled publisher/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#3513: malformed, duplicate, missing, symlinked, and outside-context manifest paths fail closed', () => {
  const cases = [
    {
      name: 'malformed JSON',
      prepare(root) {
        writeFileSync(join(root, 'container-images.json'), '{ nope');
      },
      pattern: /not valid JSON/,
    },
    {
      name: 'duplicate declarations',
      prepare(root) {
        writeFixtureRecipes(root);
        writeContainerManifest(root, [...fixtureImages(), fixtureImage()]);
      },
      pattern: /duplicates/,
    },
    {
      name: 'missing recipe',
      prepare(root) {
        writeFixtureRecipes(root);
        writeContainerManifest(root, fixtureImages({ recipe: 'missing/Dockerfile', context: 'missing' }));
      },
      pattern: /does not exist/,
    },
    {
      name: 'symlinked manifest',
      prepare(root) {
        writeFileSync(join(root, 'manifest-target.json'), '{}\n');
        symlinkSync('manifest-target.json', join(root, 'container-images.json'));
      },
      pattern: /container-images\.json is a symbolic link/,
    },
    {
      name: 'symlinked context path',
      prepare(root) {
        writeFixtureRecipes(root);
        mkdirSync(join(root, 'real-context'));
        writeFileSync(join(root, 'real-context', 'Dockerfile'), 'FROM scratch\n');
        symlinkSync('real-context', join(root, 'linked-context'));
        writeContainerManifest(
          root,
          fixtureImages({ recipe: 'linked-context/Dockerfile', context: 'linked-context' })
        );
      },
      pattern: /linked-context is a symbolic link/,
    },
    {
      name: 'outside-root recipe',
      prepare(root) {
        writeFixtureRecipes(root);
        writeContainerManifest(root, fixtureImages({ recipe: '../Dockerfile' }));
      },
      pattern: /without `\.\.` traversal/,
    },
    {
      name: 'recipe outside declared context',
      prepare(root) {
        writeFixtureRecipes(root);
        mkdirSync(join(root, 'nested'));
        writeContainerManifest(root, fixtureImages({ context: 'nested' }));
      },
      pattern: /is not inside build context/,
    },
  ];

  for (const fixture of cases) {
    const root = mkdtempSync(join(tmpdir(), 'container-manifest-invalid-'));
    try {
      fixture.prepare(root);
      assert.match(inspectContainerImageManifest(root).reasons.join('\n'), fixture.pattern, fixture.name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('#3506 INERT: every image-input walker explicitly refuses symlinked scoped files', () => {
  const root = mkdtempSync(join(tmpdir(), 'action-pins-symlinks-'));
  try {
    writeFileSync(join(root, 'recipe-target'), 'FROM node:24-slim\n');
    symlinkSync('recipe-target', join(root, 'Dockerfile'));
    writeFileSync(join(root, 'Dockerfile.spa'), `FROM node@sha256:${'0'.repeat(64)}\n`);
    writeContainerManifest(root, [fixtureImage()]);

    const runnerDirectory = join(root, 'deploy', 'arc', 'runner-image');
    mkdirSync(runnerDirectory, { recursive: true });
    writeFileSync(join(runnerDirectory, 'recipe-target'), 'FROM node:24\n');
    symlinkSync('recipe-target', join(runnerDirectory, 'Dockerfile'));

    const poolDirectory = join(root, 'deploy', 'arc');
    writeFileSync(join(poolDirectory, 'pool-target.txt'), `image: ${LATEST_REF}:latest\n`);
    symlinkSync('pool-target.txt', join(poolDirectory, 'runner-scale-set-values.yaml'));

    const refusals = inertnessReasons(root).filter((reason) => /symbolic link/.test(reason));
    assert.equal(refusals.length, 3);
    assert.ok(refusals.some((reason) => /images\[0\]\.recipe Dockerfile is a symbolic link/.test(reason)));
    assert.ok(refusals.some((reason) => /runner-image\/Dockerfile is a symbolic link/.test(reason)));
    assert.ok(refusals.some((reason) => /runner-scale-set-values\.yaml is a symbolic link/.test(reason)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test('imageRefRepository: the whole repository, not the basename', () => {
  assert.equal(imageRefRepository(`${LATEST_REF}:${STAMP}`), REPO);
  assert.equal(imageRefRepository(`${LATEST_REF}@sha256:${'0'.repeat(64)}`), REPO);
  assert.equal(imageRefRepository('ghcr.io/attacker/chd-ci-runner:v2026-07-29-87858e92'),
    'ghcr.io/attacker/chd-ci-runner');
  assert.equal(imageRefRepository('chd-ci-runner:latest'), 'chd-ci-runner');
});

test('STAMP: a digest must consume the WHOLE reference', () => {
  // Codex P2. Unanchored, `...@sha256:<64 hex>:latest` read as digest-pinned and
  // skipped every further check -- success reported for a reference no registry
  // can resolve.
  const malformed = `${LATEST_REF}@sha256:${'0'.repeat(64)}:latest`;
  assert.deepEqual(poolViolationsIn(`        image: ${malformed}\n`).map((p) => p.rule), ['STAMP']);
  assert.deepEqual(poolViolationsIn(`        image: ${LATEST_REF}@sha256:${'0'.repeat(64)}\n`), []);
});

test('STAMP: YAML quoting is not a way out of the gate', () => {
  // Codex P1. A quoted scalar kept its quotes, so every pattern failed to match
  // and the reference passed unchecked.
  assert.equal(unquote('"chd-ci-runner:latest"'), 'chd-ci-runner:latest');
  assert.deepEqual(
    imageViolationsIn(buildConfigOutput('"chd-ci-runner:latest"')).map((p) => p.rule),
    ['STAMP']
  );
  assert.deepEqual(
    imageViolationsIn(buildConfigOutput("'chd-ci-runner:latest'")).map((p) => p.rule),
    ['STAMP']
  );
  assert.deepEqual(
    poolViolationsIn(`        image: "${LATEST_REF}:latest"\n`).map((p) => p.rule),
    ['STAMP']
  );
  // ...and a quoted VALID reference still passes.
  assert.deepEqual(poolViolationsIn(`        image: "${LATEST_REF}:${STAMP}"\n`), []);
  assert.deepEqual(imageViolationsIn(buildConfigOutput(`"chd-ci-runner:${STAMP}"`)), []);
});

test('a quoted BuildConfig output tag is still seen as the producer', () => {
  // Quoting must not hide the producer -- but only at spec.output.to.name; a
  // bare `name:` elsewhere is an input and deliberately is NOT a producer.
  const quoted = buildConfigOutput(`"chd-ci-runner:${STAMP}"`);
  const found = producerTagsIn(quoted);
  assert.equal(found.length, 1);
  assert.equal(found[0].tag, STAMP);
  assert.deepEqual(producerTagsIn(`      name: "chd-ci-runner:${STAMP}"\n`), []);
});

test('STAMP: YAML node properties fail closed instead of being skipped', () => {
  // Codex P1. An anchor or tag is a legitimate DRY idiom in Helm values, and the
  // extra token stopped the regex matching AT ALL -- so the consumer vanished
  // from both the per-line and the cross-file check and the gate went green.
  for (const value of [
    `&runner-image ghcr.io/attacker/chd-ci-runner:latest`,
    `!!str ${LATEST_REF}:latest`,
    `${LATEST_REF}:latest extra`,
  ]) {
    assert.deepEqual(
      poolViolationsIn(`        image: ${value}\n`).map((p) => p.rule),
      ['STAMP'],
      `\`${value}\` must be reported, not skipped`
    );
  }
  // ...and such a line is never counted as a verified consumer.
  assert.deepEqual(poolImageRefsIn(`        image: !!str ${LATEST_REF}:${STAMP}\n`), []);
});

test('producerTagsIn: only spec.output.to.name is the producer', () => {
  // Codex P1. An image-change trigger is ordinary BuildConfig configuration, and
  // a context-free `name:` match bound the producer to that INPUT. If it carried
  // the consumers' old stamp, the anchor agreed with the stale consumers and
  // reported no violation while the build produced something else.
  const bc = [
    'spec:',
    '  triggers:',
    '    - imageChange:',
    '        from:',
    '          kind: ImageStreamTag',
    '          name: chd-ci-runner:v2026-06-13-6611d1ba',
    '  output:',
    '    to:',
    '      kind: ImageStreamTag',
    `      name: chd-ci-runner:${STAMP}`,
    '  strategy:',
    '    dockerStrategy:',
    '      from:',
    '        kind: ImageStreamTag',
    '        name: chd-ci-runner:v2020-01-01-aaaaaaa',
    '',
  ].join('\n');
  const found = producerTagsIn(bc);
  assert.equal(found.length, 1, 'inputs must not be recorded as producers');
  assert.equal(found[0].tag, STAMP);
});

test('producerTagsIn: the inlined Dockerfile block is data, not structure', () => {
  // The real BuildConfig inlines the whole recipe under `dockerfile: |`. If its
  // contents moved the path stack, the output node could be mis-resolved.
  const real = readFileSync(listRunnerImageFiles().find((f) => f.endsWith('buildconfig.yaml')), 'utf8');
  const found = producerTagsIn(real);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'chd-ci-runner');
  assert.equal(found[0].tag, STAMP);
});

test('STAMP/cross-file: two build outputs for one image are ambiguous, not anchored', () => {
  const producers = [
    { file: 'bc.yaml', line: 37, name: 'chd-ci-runner', tag: STAMP },
    { file: 'bc2.yaml', line: 12, name: 'chd-ci-runner', tag: 'v2026-06-13-6611d1ba' },
  ];
  const consumers = [{ file: 'a.yaml', line: 43, name: 'chd-ci-runner', repository: REPO, tag: STAMP }];
  const offenders = crossFileStampOffenders(producers, consumers);
  assert.equal(offenders.length, 1);
  assert.match(offenders[0].detail, /more than one build output tag/);
});
