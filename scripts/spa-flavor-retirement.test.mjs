import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

test('the upload-only deployment and its one-merge CI aliases are retired', () => {
  const packageJson = JSON.parse(read('package.json'));
  const viteConfig = read('vite.config.ts');
  const budgets = JSON.parse(read('bundle-budget.json'));
  const coldLoadBudgets = JSON.parse(read('cold-load-budget.json'));
  const retiredBuildCommand = ['build', 'spa'].join(':');
  const retiredGateCommand = ['gate', 'spa-no-node-fs'].join(':');
  const retiredGateTestCommand = ['test', 'spa-no-node-fs'].join(':');

  assert.equal(packageJson.scripts[retiredBuildCommand], undefined);
  assert.equal(packageJson.scripts[retiredGateCommand], undefined);
  assert.equal(packageJson.scripts[retiredGateTestCommand], undefined);
  assert.equal(packageJson.scripts['build:sample'], 'vite build --mode sample');
  assert.ok(packageJson.scripts['gate:sample-boundary']);
  assert.equal(budgets.spa, undefined);
  assert.equal(coldLoadBudgets.spa, undefined);
  assert.ok(coldLoadBudgets.sample);
  assert.doesNotMatch(viteConfig, /mode === ['"]spa['"]/);
  assert.match(viteConfig, /mode === ['"]sample['"]/);

  const retiredFlavor = ['s', 'p', 'a'].join('');
  const budgetResult = spawnSync(
    process.execPath,
    ['scripts/check-bundle-size.mjs', '--flavor', retiredFlavor],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(budgetResult.status, 2);
  assert.match(budgetResult.stderr, /--flavor must be "server"/);

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
  const pluginPublish = read('.github/workflows/pages-publish-plugin.yml');
  const buildMode = read('src/lib/build-mode.ts');
  const app = read('src/App.tsx');

  assert.match(ci, /^  sample-boundary:$/m);
  assert.match(ci, /run: npm run build:sample/);
  assert.match(ci, /run: npm run gate:sample-boundary/);
  assert.match(stablePublish, /npm run gate:sample-boundary/);
  assert.match(stablePublish, /Release predates gate:sample-boundary/);
  assert.match(stablePublish, /grep -rnE/);
  assert.doesNotMatch(pluginPublish, /SPA flavor/);
  assert.match(pluginPublish, /public sample target/);
  assert.doesNotMatch(buildMode, /UPLOAD_APP_URL|edge-coach/);
  assert.doesNotMatch(app, /UPLOAD_APP_URL|edge-coach/);
});
