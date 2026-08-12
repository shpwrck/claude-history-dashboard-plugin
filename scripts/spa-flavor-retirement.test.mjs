import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

test('the upload-only deployment is retired with explicit one-merge CI aliases', () => {
  const packageJson = JSON.parse(read('package.json'));
  const viteConfig = read('vite.config.ts');
  const budgets = JSON.parse(read('bundle-budget.json'));
  const coldLoadBudgets = JSON.parse(read('cold-load-budget.json'));
  const retiredBuildCommand = ['build', 'spa'].join(':');
  const retiredGateCommand = ['gate', 'spa-no-node-fs'].join(':');
  const retiredGateTestCommand = ['test', 'spa-no-node-fs'].join(':');

  assert.equal(packageJson.scripts[retiredBuildCommand], 'npm run build:sample');
  assert.equal(packageJson.scripts[retiredGateCommand], 'node scripts/check-sample-no-node-fs.mjs');
  assert.equal(packageJson.scripts[retiredGateTestCommand], 'npm run test:sample-no-node-fs');
  assert.equal(packageJson.scripts['build:sample'], 'vite build --mode sample');
  assert.ok(packageJson.scripts['gate:sample-boundary']);
  assert.match(budgets.spa['//'], /TRANSITION ONLY/);
  assert.equal(coldLoadBudgets.spa, undefined);
  assert.ok(coldLoadBudgets.sample);
  assert.doesNotMatch(viteConfig, /mode === ['"]spa['"]/);
  assert.match(viteConfig, /mode === ['"]sample['"]/);

  for (const path of [
    ['.github/workflows/pages-publish-', 'edge.yml'].join(''),
    ['Dockerfile', '.spa'].join(''),
    ['docker-compose', '.spa.yml'].join(''),
    'nginx.spa.conf.template',
    'scripts/spa-healthcheck.test.mjs',
    ['scripts/check-', 'spa-no-node-fs.mjs'].join(''),
    ['scripts/check-', 'spa-no-node-fs.test.mjs'].join(''),
  ]) {
    assert.equal(existsSync(join(ROOT, path)), false, `${path} must be deleted`);
  }
});

test('the sample build inherits the public no-server boundary in CI and publishing', () => {
  const ci = read('.github/workflows/ci.yml');
  const stablePublish = read('.github/workflows/pages-publish-stable.yml');
  const buildMode = read('src/lib/build-mode.ts');
  const app = read('src/App.tsx');

  assert.match(ci, /^  sample-boundary:$/m);
  assert.match(ci, /run: npm run build:sample/);
  assert.match(ci, /run: npm run gate:sample-boundary/);
  assert.match(stablePublish, /npm run gate:sample-boundary/);
  assert.match(stablePublish, /Release predates gate:sample-boundary/);
  assert.match(stablePublish, /grep -rnE/);
  assert.doesNotMatch(buildMode, /UPLOAD_APP_URL|edge-coach/);
  assert.doesNotMatch(app, /UPLOAD_APP_URL|edge-coach/);
});
