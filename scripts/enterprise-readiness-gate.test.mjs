// Unit tests for the enterprise readiness gate (#1176).
//
// Run:
//   node scripts/enterprise-readiness-gate.test.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ENTERPRISE_READINESS_CHECKS,
  findSpaBoundaryOffenders,
  renderCheckList,
} from './enterprise-readiness-gate.mjs';

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${label}: ${err.message}`);
  }
}

check('receipt lists the enterprise readiness sub-checks', () => {
  const list = renderCheckList();
  assert.match(list, /test:enterprise-auth/);
  assert.match(list, /test:llm-egress-gate/);
  assert.match(list, /gate:llm-egress/);
  assert.match(list, /DASHBOARD_LLM_PUBLIC_EXPOSURE_MODE=multi-tenant/);
  assert.match(list, /gate:enterprise-routes/);
  assert.match(list, /gate:enterprise-posture/);
  assert.match(list, /npm run build/);
  assert.match(list, /check-bundle-size\.mjs --flavor server/);
  assert.match(list, /test:server-runtime-imports/);
  assert.match(list, /test:server-healthcheck/);
  assert.match(list, /test:compose-runtime-hardening/);
  assert.match(list, /test:server-http-timeouts/);
  assert.match(list, /gate:server-scale/);
  assert.match(list, /gate:repo-map/);
  assert.match(list, /npm run build:spa/);
  assert.match(list, /<internal>/);
  assert.match(list, /check-bundle-size\.mjs --flavor spa/);
});

check('gate keeps a stable ordered list for CTO-demo receipts', () => {
  assert.deepEqual(
    ENTERPRISE_READINESS_CHECKS.map((entry) => entry.name),
    [
      'Enterprise auth, authorization, posture, audit, and rate-limit contracts',
      'LLM egress gate unit checks',
      'LLM egress registry, call-site, generated-doc, and public-exposure gate',
      'LLM public-exposure gate in multi-tenant mode',
      'Enterprise data route inventory gate',
      'Enterprise CTO-demo security posture gate',
      'Server build and typecheck',
      'Server bundle-size budget',
      'Server runtime no-node_modules import guard',
      'Server production healthcheck contract',
      'Container runtime least-privilege contract',
      'Server HTTP listener timeout contract',
      'Server-mode large-history scale budget',
      'Repo-map scale and localization budget',
      'Upload-only SPA build',
      'SPA emitted bundle contains no server-touching strings',
      'SPA bundle-size budget',
    ]
  );
});

check('SPA boundary scanner reports forbidden emitted strings', () => {
  const root = mkdtempSync(join(tmpdir(), 'enterprise-gate-'));
  try {
    mkdirSync(join(root, 'dist', 'assets'), { recursive: true });
    writeFileSync(join(root, 'dist', 'index.html'), '<main></main>');
    writeFileSync(
      join(root, 'dist', 'assets', 'index-test.js'),
      'fetch("/api/dataset.json");\nconsole.log("ok");\n'
    );
    writeFileSync(
      join(root, 'dist', 'assets', 'style-test.css'),
      '.ok { color: black; }\n'
    );

    assert.deepEqual(findSpaBoundaryOffenders(root), [
      'dist/assets/index-test.js:1',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('SPA boundary scanner accepts clean emitted files', () => {
  const root = mkdtempSync(join(tmpdir(), 'enterprise-gate-'));
  try {
    mkdirSync(join(root, 'dist', 'assets'), { recursive: true });
    writeFileSync(join(root, 'dist', 'index.html'), '<main></main>');
    writeFileSync(
      join(root, 'dist', 'assets', 'index-test.js'),
      'console.log("clean");\n'
    );

    assert.deepEqual(findSpaBoundaryOffenders(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll enterprise readiness gate checks passed.');
