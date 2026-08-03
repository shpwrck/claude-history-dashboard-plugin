import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { arcDindSandboxReasons } from './check-arc-dind-sandbox.mjs';
import { PROJECT_DIR, runGate } from './lib/gate-harness.mjs';

const CHECK = join(PROJECT_DIR, 'scripts', 'check-arc-dind-sandbox.mjs');

function values(securityContext) {
  return [
    'template:',
    '  spec:',
    '    securityContext:',
    '      runAsUser: 0',
    '      runAsGroup: 0',
    '    containers:',
    '      - name: runner',
    '        image: example.test/runner:v1',
    '        securityContext:',
    ...securityContext.map((line) => `          ${line}`),
    '      - name: dind',
    '        image: example.test/dind:v1',
    '        securityContext:',
    '          privileged: true',
    '',
  ].join('\n');
}

const REQUIRED_CONTEXT = [
  'capabilities:',
  '  add:',
  '    - SYS_ADMIN',
  '    - SETFCAP',
  '    - NET_ADMIN',
  'seLinuxOptions:',
  '  type: spc_t',
];

function withFixture(spokeContext, hubContext, run) {
  const root = mkdtempSync(join(tmpdir(), 'arc-dind-sandbox-'));
  mkdirSync(join(root, 'deploy', 'arc', 'hub'), { recursive: true });
  writeFileSync(
    join(root, 'deploy', 'arc', 'dind-scale-set-values.yaml'),
    values(spokeContext),
  );
  writeFileSync(
    join(root, 'deploy', 'arc', 'hub', 'dind-scale-set-values.yaml'),
    values(hubContext),
  );
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the live spoke and hub dind pools keep the proven bubblewrap context', () => {
  assert.deepEqual(arcDindSandboxReasons(PROJECT_DIR), []);

  const result = runGate(CHECK);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /ARC dind sandbox capability check passed/);
});

test('the gate rejects a missing namespace capability', () => {
  withFixture(
    REQUIRED_CONTEXT.filter((line) => line !== '    - SETFCAP'),
    REQUIRED_CONTEXT,
    (root) => {
      const reasons = arcDindSandboxReasons(root);
      assert.equal(reasons.length, 1);
      assert.match(reasons[0], /spoke.*NET_ADMIN, SETFCAP, and SYS_ADMIN/i);

      const result = runGate(CHECK, [root]);
      assert.equal(result.code, 1, result.out);
      assert.match(result.out, /ARC dind sandbox capability check FAILED/);
    },
  );
});

test('the gate rejects a runner that cannot configure its isolated loopback', () => {
  withFixture(
    REQUIRED_CONTEXT.filter((line) => line !== '    - NET_ADMIN'),
    REQUIRED_CONTEXT,
    (root) => {
      const reasons = arcDindSandboxReasons(root);
      assert.equal(reasons.length, 1);
      assert.match(reasons[0], /spoke.*NET_ADMIN, SETFCAP, and SYS_ADMIN/i);
    },
  );
});

test('duplicate capabilities cannot impersonate the complete required pair', () => {
  withFixture(
    REQUIRED_CONTEXT.map((line) =>
      line === '    - SETFCAP' ? '    - SYS_ADMIN' : line,
    ),
    REQUIRED_CONTEXT,
    (root) => {
      const reasons = arcDindSandboxReasons(root);
      assert.equal(reasons.length, 1);
      assert.match(reasons[0], /spoke.*NET_ADMIN, SETFCAP, and SYS_ADMIN/i);
    },
  );
});

test('the gate rejects SELinux drift that would block the devpts mount', () => {
  withFixture(
    REQUIRED_CONTEXT,
    REQUIRED_CONTEXT.map((line) =>
      line === '  type: spc_t' ? '  type: container_t' : line,
    ),
    (root) => {
      const reasons = arcDindSandboxReasons(root);
      assert.equal(reasons.length, 1);
      assert.match(reasons[0], /hub.*SELinux type spc_t/i);
    },
  );
});

test('the gate rejects broad runner privilege instead of accepting a looser substitute', () => {
  withFixture(
    [...REQUIRED_CONTEXT, 'privileged: true'],
    REQUIRED_CONTEXT,
    (root) => {
      const reasons = arcDindSandboxReasons(root);
      assert.equal(reasons.length, 1);
      assert.match(reasons[0], /spoke.*exact security context/i);
    },
  );
});
