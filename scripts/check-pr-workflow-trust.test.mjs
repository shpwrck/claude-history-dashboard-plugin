import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { prWorkflowTrustReasons } from './check-pr-workflow-trust.mjs';

const REPO_ROOT = join(import.meta.dirname, '..');

function withWorkflowFixture(workflows, run) {
  const root = mkdtempSync(join(tmpdir(), 'pr-workflow-trust-'));
  const directory = join(root, '.github', 'workflows');
  mkdirSync(directory, { recursive: true });
  for (const [name, source] of Object.entries(workflows)) {
    writeFileSync(join(directory, name), source);
  }
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the live Stage B repository preserves hosted checks and the temporary ARC trust ceiling', () => {
  assert.deepEqual(prWorkflowTrustReasons(REPO_ROOT), []);
});

test('a new pull_request workflow cannot schedule an ARC job', () => {
  withWorkflowFixture(
    {
      'unsafe.yml': [
        'name: unsafe',
        'on:',
        '  pull_request:',
        'permissions:',
        '  contents: read',
        'jobs:',
        '  test:',
        '    runs-on: arc-runner-set',
        '    steps:',
        '      - run: npm test',
        '',
      ].join('\n'),
    },
    (root) => {
      assert.match(
        prWorkflowTrustReasons(root).join('\n'),
        /unsafe\.yml.*pull_request.*ARC/i
      );
    }
  );
});

test('pull_request jobs cannot evade hosted-only policy through hub, future-private, or reusable labels', () => {
  withWorkflowFixture(
    {
      'unsafe.yml': [
        'name: unsafe',
        'on: pull_request',
        'jobs:',
        '  hub-standard:',
        '    runs-on: arc-runner-set-hub',
        '    steps:',
        '      - run: npm test',
        '  hub-dind:',
        '    runs-on: arc-dind-hub',
        '    steps:',
        '      - run: npm test',
        '  future-private:',
        '    runs-on: private-runner-added-later',
        '    steps:',
        '      - run: npm test',
        '  local-reusable:',
        '    uses: ./.github/workflows/private-worker.yml',
        '',
      ].join('\n'),
      'private-worker.yml': [
        'name: private worker',
        'on: workflow_call',
        'jobs:',
        '  test:',
        '    runs-on: private-runner-added-later',
        '    steps:',
        '      - run: npm test',
        '',
      ].join('\n'),
    },
    (root) => {
      const reasons = prWorkflowTrustReasons(root).join('\n');
      assert.match(reasons, /unsafe\.yml.*hub-standard.*ubuntu-latest/i);
      assert.match(reasons, /unsafe\.yml.*hub-dind.*ubuntu-latest/i);
      assert.match(reasons, /unsafe\.yml.*future-private.*ubuntu-latest/i);
      assert.match(reasons, /unsafe\.yml.*local-reusable.*ubuntu-latest/i);
    }
  );
});

test('pull_request workflows cannot hide ARC behind expression-valued runners', () => {
  withWorkflowFixture(
    {
      'expression.yml': [
        'name: expression',
        'on: pull_request',
        'jobs:',
        '  test:',
        "    runs-on: ${{ 'arc-runner-set' }}",
        '    steps:',
        '      - run: npm test',
        '',
      ].join('\n'),
      'matrix.yml': [
        'name: matrix',
        'on: pull_request',
        'jobs:',
        '  test:',
        '    strategy:',
        '      matrix:',
        '        runner: [ubuntu-latest, arc-runner-set]',
        '    runs-on: ${{ matrix.runner }}',
        '    steps:',
        '      - run: npm test',
        '',
      ].join('\n'),
    },
    (root) => {
      const reasons = prWorkflowTrustReasons(root).join('\n');
      assert.match(reasons, /expression\.yml.*dynamic runs-on.*trust ceiling/i);
      assert.match(reasons, /matrix\.yml.*dynamic runs-on.*trust ceiling/i);
    }
  );
});

test('a pull_request_target ARC workflow requires the canonical authorization broker', () => {
  withWorkflowFixture(
    {
      'unsafe.yml': [
        'name: unsafe',
        'on:',
        '  pull_request_target:',
        'permissions:',
        '  contents: read',
        'jobs:',
        '  test:',
        '    runs-on: arc-runner-set',
        '    steps:',
        '      - run: npm test',
        '',
      ].join('\n'),
    },
    (root) => {
      assert.match(
        prWorkflowTrustReasons(root).join('\n'),
        /unsafe\.yml.*authorize.*pr-trust\.yml/i
      );
    }
  );
});

test('pull_request_target hub scale sets cannot evade broker protection', () => {
  withWorkflowFixture(
    {
      'hub-standard.yml': [
        'name: unsafe hub standard',
        'on: pull_request_target',
        'jobs:',
        '  test:',
        '    runs-on: arc-runner-set-hub',
        '    steps:',
        '      - run: npm test',
        '',
      ].join('\n'),
      'hub-dind.yml': [
        'name: unsafe hub dind',
        'on: pull_request_target',
        'jobs:',
        '  test:',
        '    runs-on: arc-dind-hub',
        '    steps:',
        '      - run: npm test',
        '',
      ].join('\n'),
    },
    (root) => {
      const reasons = prWorkflowTrustReasons(root).join('\n');
      assert.match(reasons, /hub-standard\.yml.*authorize.*pr-trust\.yml/i);
      assert.match(reasons, /hub-dind\.yml.*authorize.*pr-trust\.yml/i);
    }
  );
});

test('hosted pull_request_target code and secrets still require broker protection', () => {
  withWorkflowFixture(
    {
      'hosted-danger.yml': [
        'name: unsafe hosted target',
        'on: pull_request_target',
        'permissions:',
        '  contents: write',
        'jobs:',
        '  deploy:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        '        with:',
        '          ref: ${{ github.event.pull_request.merge_commit_sha }}',
        '      - run: npm test',
        '        env:',
        '          DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}',
        '',
      ].join('\n'),
    },
    (root) => {
      assert.match(
        prWorkflowTrustReasons(root).join('\n'),
        /hosted-danger\.yml.*authorize.*pr-trust\.yml/i
      );
    }
  );
});

test('authorization receives only canonical fork metadata with no token permission', () => {
  withWorkflowFixture(
    {
      'unsafe.yml': [
        'name: unsafe',
        'on:',
        '  pull_request_target:',
        'permissions: {}',
        'jobs:',
        '  authorize:',
        '    uses: ./.github/workflows/pr-trust.yml',
        '    permissions:',
        '      contents: read',
        '    with:',
        '      head-repository: ${{ github.actor }}',
        '  test:',
        '    needs: authorize',
        "    if: needs.authorize.outputs.trusted == 'true'",
        '    runs-on: arc-runner-set',
        '    steps:',
        '      - run: npm test',
        '',
      ].join('\n'),
    },
    (root) => {
      const reasons = prWorkflowTrustReasons(root).join('\n');
      assert.match(reasons, /unsafe\.yml.*authorize.*permissions/i);
      assert.match(reasons, /unsafe\.yml.*head\.repo\.full_name/i);
    }
  );
});

test('every ARC job depends on authorization and the verified merge resolver', () => {
  withWorkflowFixture(
    {
      'unsafe.yml': [
        'name: unsafe',
        'on:',
        '  pull_request_target:',
        'permissions: {}',
        'jobs:',
        '  authorize:',
        '    permissions: {}',
        '    uses: ./.github/workflows/pr-trust.yml',
        '    with:',
        '      head-repository: ${{ github.event.pull_request.head.repo.full_name }}',
        '  direct-bypass:',
        '    runs-on: arc-runner-set',
        '    steps:',
        '      - run: npm test',
        '  alternate-bypass:',
        '    needs: authorize',
        "    if: github.actor == 'shpwrck'",
        '    runs-on: arc-dind',
        '    steps:',
        '      - run: npm test',
        '',
      ].join('\n'),
    },
    (root) => {
      const reasons = prWorkflowTrustReasons(root).join('\n');
      assert.match(reasons, /direct-bypass.*depend.*authorize/i);
      assert.match(reasons, /alternate-bypass.*verified merge output guard/i);
    }
  );
});

test('the first executable job also requires the verified merge output', () => {
  withWorkflowFixture(
    {
      'unsafe.yml': [
        'name: unsafe',
        'on:',
        '  pull_request_target:',
        'concurrency:',
        '  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}',
        'permissions: {}',
        'jobs:',
        '  authorize:',
        '    permissions: {}',
        '    uses: ./.github/workflows/pr-trust.yml',
        '    with:',
        '      head-repository: ${{ github.event.pull_request.head.repo.full_name }}',
        '  test:',
        '    needs: authorize',
        "    if: needs.authorize.outputs.trusted == 'true'",
        '    runs-on: arc-runner-set',
        '    steps:',
        '      - run: npm test',
        '',
      ].join('\n'),
    },
    (root) => {
      assert.match(
        prWorkflowTrustReasons(root).join('\n'),
        /unsafe\.yml.*test.*verified merge output guard/i
      );
    }
  );
});

test('protected workflows must resolve one immutable merge SHA after authorization', () => {
  withWorkflowFixture(
    {
      'unsafe.yml': [
        'name: unsafe',
        'on: pull_request_target',
        'concurrency:',
        '  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}',
        'permissions: {}',
        'jobs:',
        '  authorize:',
        '    permissions: {}',
        '    uses: ./.github/workflows/pr-trust.yml',
        '    with:',
        '      head-repository: ${{ github.event.pull_request.head.repo.full_name }}',
        '  test:',
        '    needs: authorize',
        "    if: needs.authorize.outputs.trusted == 'true' && github.event.pull_request.merge_commit_sha != null",
        '    runs-on: arc-runner-set',
        '    steps:',
        '      - run: npm test',
        '',
      ].join('\n'),
    },
    (root) => {
      assert.match(
        prWorkflowTrustReasons(root).join('\n'),
        /unsafe\.yml.*resolve-merge.*pr-merge-sha\.yml/i
      );
    }
  );
});

test('the reusable merge resolver is hosted, read-only, and contract-closed', () => {
  withWorkflowFixture(
    {
      'pr-merge-sha.yml': [
        'name: unsafe resolver',
        'on: workflow_call',
        'permissions:',
        '  contents: write',
        'jobs:',
        '  resolve:',
        '    runs-on: arc-dind',
        '    permissions:',
        '      contents: write',
        '    steps:',
        '      - run: echo merge-sha=forged >> "$GITHUB_OUTPUT"',
        '',
      ].join('\n'),
    },
    (root) => {
      const reasons = prWorkflowTrustReasons(root).join('\n');
      assert.match(reasons, /pr-merge-sha\.yml.*workflow_call.*input.*output/i);
      assert.match(reasons, /pr-merge-sha\.yml.*workflow permissions.*\{\}/i);
      assert.match(reasons, /pr-merge-sha\.yml.*ubuntu-latest/i);
      assert.match(reasons, /pr-merge-sha\.yml.*timeout.*2/i);
      assert.match(reasons, /pr-merge-sha\.yml.*contents.*pull-requests.*read/i);
    }
  );
});

test('post-resolver jobs cannot bypass the verified output guard or exact checkout', () => {
  withWorkflowFixture(
    {
      'unsafe.yml': [
        'name: unsafe',
        'on: pull_request_target',
        'concurrency:',
        '  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}',
        'permissions: {}',
        'jobs:',
        '  authorize:',
        '    permissions: {}',
        '    uses: ./.github/workflows/pr-trust.yml',
        '    with:',
        '      head-repository: ${{ github.event.pull_request.head.repo.full_name }}',
        '  resolve-merge:',
        '    needs: authorize',
        "    if: needs.authorize.outputs.trusted == 'true'",
        '    permissions:',
        '      contents: read',
        '      pull-requests: read',
        '    uses: ./.github/workflows/pr-merge-sha.yml',
        '    with:',
        '      pr-number: ${{ github.event.pull_request.number }}',
        '      expected-head-sha: ${{ github.event.pull_request.head.sha }}',
        '      expected-base-sha: ${{ github.event.pull_request.base.sha }}',
        '  test:',
        '    needs: resolve-merge',
        "    if: needs.resolve-merge.outputs.merge-sha != '' || true",
        '    runs-on: arc-runner-set',
        '    steps:',
        '      - uses: actions/checkout@0123456789012345678901234567890123456789',
        '        with:',
        '          ref: ${{ github.event.pull_request.merge_commit_sha }}',
        '',
      ].join('\n'),
    },
    (root) => {
      const reasons = prWorkflowTrustReasons(root).join('\n');
      assert.match(reasons, /unsafe\.yml.*test.*verified merge.*guard/i);
      assert.match(reasons, /unsafe\.yml.*test.*checkout.*resolve-merge.*merge-sha/i);
    }
  );
});

test('protected workflows isolate concurrency and checkout the verified merge SHA', () => {
  withWorkflowFixture(
    {
      'unsafe.yml': [
        'name: unsafe',
        'on:',
        '  pull_request_target:',
        'concurrency:',
        '  group: ${{ github.workflow }}-${{ github.ref }}',
        '  cancel-in-progress: true',
        'permissions: {}',
        'jobs:',
        '  authorize:',
        '    permissions: {}',
        '    uses: ./.github/workflows/pr-trust.yml',
        '    with:',
        '      head-repository: ${{ github.event.pull_request.head.repo.full_name }}',
        '  test:',
        '    needs: authorize',
        "    if: needs.authorize.outputs.trusted == 'true'",
        '    runs-on: arc-runner-set',
        '    steps:',
        '      - uses: Actions/Checkout@0123456789012345678901234567890123456789',
        '        with:',
        '          ref: ${{ github.event.pull_request.head.sha }}',
        '',
      ].join('\n'),
    },
    (root) => {
      const reasons = prWorkflowTrustReasons(root).join('\n');
      assert.match(reasons, /unsafe\.yml.*concurrency.*pull_request\.number/i);
      assert.match(reasons, /unsafe\.yml.*checkout.*resolve-merge.*merge-sha/i);
    }
  );
});

test('the reusable trust broker is hosted and has no token permissions', () => {
  withWorkflowFixture(
    {
      'protected.yml': [
        'name: protected',
        'on:',
        '  pull_request_target:',
        'concurrency:',
        '  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}',
        'permissions: {}',
        'jobs:',
        '  authorize:',
        '    permissions: {}',
        '    uses: ./.github/workflows/pr-trust.yml',
        '    with:',
        '      head-repository: ${{ github.event.pull_request.head.repo.full_name }}',
        '  test:',
        '    needs: authorize',
        "    if: needs.authorize.outputs.trusted == 'true'",
        '    runs-on: arc-runner-set',
        '    steps:',
        '      - run: npm test',
        '',
      ].join('\n'),
      'pr-trust.yml': [
        'name: PR trust broker',
        'on:',
        '  workflow_call:',
        'permissions:',
        '  contents: read',
        'jobs:',
        '  authorize:',
        '    permissions: {}',
        '    runs-on: arc-runner-set',
        '    steps:',
        '      - run: echo no',
        '',
      ].join('\n'),
    },
    (root) => {
      const reasons = prWorkflowTrustReasons(root).join('\n');
      assert.match(reasons, /pr-trust\.yml.*permissions.*\{\}/i);
      assert.match(reasons, /pr-trust\.yml.*GitHub-hosted.*ubuntu-latest/i);
    }
  );
});

test('the trust broker contract cannot drift to alternate metadata or extra work', () => {
  withWorkflowFixture(
    {
      'protected.yml': [
        'name: protected',
        'on:',
        '  pull_request_target:',
        'concurrency:',
        '  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}',
        'permissions: {}',
        'jobs:',
        '  authorize:',
        '    permissions: {}',
        '    uses: ./.github/workflows/pr-trust.yml',
        '    with:',
        '      head-repository: ${{ github.event.pull_request.head.repo.full_name }}',
        '  test:',
        '    needs: authorize',
        "    if: needs.authorize.outputs.trusted == 'true'",
        '    runs-on: arc-runner-set',
        '    steps:',
        '      - run: npm test',
        '',
      ].join('\n'),
      'pr-trust.yml': [
        'name: PR trust broker',
        'on:',
        '  workflow_call:',
        '    inputs:',
        '      head-repository:',
        '        required: true',
        '        type: string',
        '    outputs:',
        '      trusted:',
        '        value: ${{ jobs.authorize.outputs.trusted }}',
        'permissions: {}',
        'defaults:',
        '  run:',
        "    shell: bash -c 'echo trusted=true >> \"$GITHUB_OUTPUT\"; bash {0}'",
        'jobs:',
        '  authorize:',
        '    permissions:',
        '      contents: read',
        '    runs-on: ubuntu-latest',
        '    container: attacker.invalid/forged-broker:latest',
        '    outputs:',
        '      trusted: ${{ steps.same-repo.outputs.trusted }}',
        '    steps:',
        '      - id: same-repo',
        '        env:',
        '          TRUSTED: ${{ inputs.head-repository == github.actor }}',
        '        run: echo "trusted=$TRUSTED" >> "$GITHUB_OUTPUT"',
        '  extra:',
        '    runs-on: arc-runner-set',
        '    steps:',
        '      - run: npm test',
        '',
      ].join('\n'),
    },
    (root) => {
      const reasons = prWorkflowTrustReasons(root).join('\n');
      assert.match(reasons, /pr-trust\.yml.*authorize.*permissions.*\{\}/i);
      assert.match(reasons, /pr-trust\.yml.*head-repository.*github\.repository/i);
      assert.match(reasons, /pr-trust\.yml.*exactly one.*authorize/i);
      assert.match(reasons, /pr-trust\.yml.*workflow.*only canonical keys/i);
      assert.match(reasons, /pr-trust\.yml.*authorize.*only canonical keys/i);
    }
  );
});

test('the trust broker input cannot gain a default or alternate data channel', () => {
  withWorkflowFixture(
    {
      'protected.yml': [
        'name: protected',
        'on:',
        '  pull_request_target:',
        'concurrency:',
        '  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}',
        'permissions: {}',
        'jobs:',
        '  authorize:',
        '    permissions: {}',
        '    uses: ./.github/workflows/pr-trust.yml',
        '    with:',
        '      head-repository: ${{ github.event.pull_request.head.repo.full_name }}',
        '  test:',
        '    needs: authorize',
        "    if: needs.authorize.outputs.trusted == 'true'",
        '    runs-on: arc-runner-set',
        '    steps:',
        '      - run: echo safe',
        '',
      ].join('\n'),
      'pr-trust.yml': [
        'name: PR trust broker',
        'on:',
        '  workflow_call:',
        '    inputs:',
        '      head-repository:',
        '        description: Repository that owns the pull request head branch',
        '        required: true',
        '        type: string',
        '        default: attacker-controlled',
        '    outputs:',
        '      trusted:',
        '        description: same repository',
        '        value: ${{ jobs.authorize.outputs.trusted }}',
        'permissions: {}',
        'jobs:',
        '  authorize:',
        '    runs-on: ubuntu-latest',
        '    permissions: {}',
        '    outputs:',
        '      trusted: ${{ steps.same-repo.outputs.trusted }}',
        '    steps:',
        '      - name: Classify pull request ownership',
        '        id: same-repo',
        '        env:',
        '          TRUSTED: ${{ inputs.head-repository == github.repository }}',
        '        run: echo "trusted=$TRUSTED" >> "$GITHUB_OUTPUT"',
        '',
      ].join('\n'),
    },
    (root) => {
      assert.match(
        prWorkflowTrustReasons(root).join('\n'),
        /pr-trust\.yml.*workflow_call.*only required string head-repository/i
      );
    }
  );
});

test('a transitive ARC job cannot override a skipped authorization ancestor', () => {
  withWorkflowFixture(
    {
      'unsafe.yml': [
        'name: unsafe',
        'on:',
        '  pull_request_target:',
        'concurrency:',
        '  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}',
        'permissions: {}',
        'jobs:',
        '  authorize:',
        '    permissions: {}',
        '    uses: ./.github/workflows/pr-trust.yml',
        '    with:',
        '      head-repository: ${{ github.event.pull_request.head.repo.full_name }}',
        '  gate:',
        '    needs: authorize',
        "    if: needs.authorize.outputs.trusted == 'true'",
        '    runs-on: arc-runner-set',
        '    steps:',
        '      - run: echo safe',
        '  bypass:',
        '    needs: gate',
        '    if: always()',
        '    runs-on: arc-dind',
        '    steps:',
        '      - run: npm test',
        '  success-bypass:',
        '    needs: gate',
        '    if: success() || true',
        '    runs-on: arc-runner-set',
        '    steps:',
        '      - run: npm test',
        '',
      ].join('\n'),
    },
    (root) => {
      const reasons = prWorkflowTrustReasons(root).join('\n');
      assert.match(reasons, /unsafe\.yml.*bypass.*status function.*authorization/i);
      assert.match(reasons, /unsafe\.yml.*success-bypass.*status function.*authorization/i);
    }
  );
});

test('forks cannot schedule a hosted secret-bearing job beside the ARC graph', () => {
  withWorkflowFixture(
    {
      'unsafe.yml': [
        'name: unsafe',
        'on:',
        '  pull_request_target:',
        'concurrency:',
        '  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}',
        'permissions: {}',
        'jobs:',
        '  authorize:',
        '    permissions: {}',
        '    uses: ./.github/workflows/pr-trust.yml',
        '    with:',
        '      head-repository: ${{ github.event.pull_request.head.repo.full_name }}',
        '  arc:',
        '    needs: authorize',
        "    if: needs.authorize.outputs.trusted == 'true'",
        '    runs-on: arc-runner-set',
        '    steps:',
        '      - run: echo safe',
        '  secret-bypass:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - env:',
        '          TOKEN: ${{ secrets.DEPLOY_TOKEN }}',
        '        run: echo no',
        '',
      ].join('\n'),
    },
    (root) => {
      assert.match(
        prWorkflowTrustReasons(root).join('\n'),
        /unsafe\.yml.*secret-bypass.*depend.*authorize/i
      );
    }
  );
});

test('an inventoried temporary target workflow cannot evade the gate by moving off ARC', () => {
  withWorkflowFixture(
    {
      'stage-b-target-ci.yml': [
        'name: TEMP ARC Lint and build',
        'on:',
        '  pull_request_target:',
        'permissions: {}',
        'jobs:',
        '  bypass:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: npm test',
        '',
      ].join('\n'),
    },
    (root) => {
      assert.match(
        prWorkflowTrustReasons(root).join('\n'),
        /stage-b-target-ci\.yml.*authorize.*pr-trust\.yml/i
      );
    }
  );
});

test('canonical hosted workflows cannot be converted early or regain ARC', () => {
  withWorkflowFixture(
    {
      'ci.yml': [
        'name: Lint and build',
        'on:',
        '  pull_request_target:',
        'jobs:',
        '  lint:',
        '    runs-on: arc-runner-set',
        '    steps:',
        '      - run: npm test',
        '',
      ].join('\n'),
    },
    (root) => {
      const reasons = prWorkflowTrustReasons(root).join('\n');
      assert.match(reasons, /ci\.yml.*canonical.*pull_request/i);
      assert.match(reasons, /ci\.yml.*canonical.*GitHub-hosted/i);
    }
  );
});

test('milestone guard remains permanently hosted', () => {
  withWorkflowFixture(
    {
      'milestone-guard.yml': [
        'name: Milestone guard',
        'on:',
        '  pull_request_target:',
        'jobs:',
        '  ensure:',
        '    runs-on: arc-runner-set',
        '    steps:',
        '      - run: echo unsafe',
        '',
      ].join('\n'),
    },
    (root) => {
      assert.match(
        prWorkflowTrustReasons(root).join('\n'),
        /milestone-guard\.yml.*permanently.*GitHub-hosted/i
      );
    }
  );
});

test('temporary workflows and jobs use distinct Stage B ARC check names', () => {
  withWorkflowFixture(
    {
      'stage-b-target-ci.yml': [
        'name: Lint and build',
        'on:',
        '  pull_request_target:',
        'jobs:',
        '  lint:',
        '    name: lint',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: npm test',
        '',
      ].join('\n'),
    },
    (root) => {
      const reasons = prWorkflowTrustReasons(root).join('\n');
      assert.match(reasons, /stage-b-target-ci\.yml.*workflow name.*TEMP ARC/i);
      assert.match(reasons, /stage-b-target-ci\.yml.*job lint.*TEMP ARC/i);
    }
  );
});

test('the repository cannot delete a protected workflow from the inventory', () => {
  withWorkflowFixture(
    {
      'ci.yml': ['name: CI', 'on: workflow_dispatch', 'jobs: {}', ''].join(
        '\n'
      ),
    },
    (root) => {
      writeFileSync(join(root, 'package.json'), '{}\n');
      assert.match(
        prWorkflowTrustReasons(root).join('\n'),
        /missing temporary target workflow stage-b-target-agent-cross-review\.yml/i
      );
    }
  );
});

test('malformed workflow YAML fails closed as a reported reason', () => {
  withWorkflowFixture(
    { 'broken.yml': 'on: [pull_request\njobs: {}\n' },
    (root) => {
      assert.match(
        prWorkflowTrustReasons(root).join('\n'),
        /broken\.yml.*parse/i
      );
    }
  );
});

test('the sandbox proof job must require namespaces and run only the hostile-canary test', () => {
  withWorkflowFixture(
    {
      'stage-b-target-test.yml': [
        'name: TEMP ARC Unit tests',
        'on:',
        '  pull_request_target:',
        'concurrency:',
        '  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}',
        'permissions: {}',
        'jobs:',
        '  authorize:',
        '    permissions: {}',
        '    uses: ./.github/workflows/pr-trust.yml',
        '    with:',
        '      head-repository: ${{ github.event.pull_request.head.repo.full_name }}',
        '  gate-2702-sandbox-proof:',
        '    needs: authorize',
        "    if: needs.authorize.outputs.trusted == 'true'",
        '    runs-on: arc-dind',
        '    permissions:',
        '      contents: read',
        '    steps:',
        '      - run: node --test scripts/gate-2702/run.test.mjs',
        '',
      ].join('\n'),
    },
    (root) => {
      const reasons = prWorkflowTrustReasons(root).join('\n');
      assert.match(reasons, /stage-b-target-test\.yml.*sandbox proof.*CHD_REQUIRE_GATE_2702_SANDBOX_PROBE/i);
      assert.match(reasons, /stage-b-target-test\.yml.*sandbox proof.*test-name-pattern/i);
    }
  );
});
