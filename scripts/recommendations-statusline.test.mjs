#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  buildStatusline,
  parseArgs,
  recommendationApiUrl,
} from './recommendations-statusline.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

function check(label, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result
        .then(() => {
          console.log(`  ok  ${label}`);
        })
        .catch((error) => {
          failures += 1;
          console.error(`  FAIL ${label}: ${error.message}`);
        });
    }
    console.log(`  ok  ${label}`);
    return Promise.resolve();
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${label}: ${error.message}`);
    return Promise.resolve();
  }
}

const fixture = [
  {
    id: 'workflow.repeated-commands',
    category: 'workflow',
    severity: 'warning',
    title: 'Repeated shell commands',
    action: 'Wrap the repeated commands in a script or a hook.',
    view: 'tools',
  },
  {
    id: 'activity.stale-projects',
    category: 'activity',
    severity: 'info',
    title: 'Stale projects',
    action: 'Archive or restart dormant projects.',
  },
];

await check('buildStatusline formats the top ranked recommendation', () => {
  const summary = buildStatusline(fixture, { maxChars: 220 });
  assert.equal(summary.status, 'ok');
  assert.equal(summary.count, 2);
  assert.equal(summary.id, 'workflow.repeated-commands');
  assert.equal(
    summary.text,
    'recs warning workflow: Repeated shell commands (tools) -> Wrap the repeated commands in a script or a hook.'
  );
});

await check('buildStatusline handles empty recommendation arrays', () => {
  const summary = buildStatusline([]);
  assert.equal(summary.status, 'empty');
  assert.equal(summary.text, 'recs: no active recommendations');
});

await check('buildStatusline truncates long statusline output', () => {
  const summary = buildStatusline(fixture, { maxChars: 60 });
  assert.equal(summary.text.length <= 60, true);
  assert.match(summary.text, /\.\.\.$/);
});

await check('parseArgs accepts env default and explicit overrides', () => {
  const options = parseArgs(['--json', '--max-chars', '180', '--timeout-ms', '12000'], {
    CODING_AGENT_DASHBOARD_URL: 'http://localhost:6000',
  });
  assert.equal(options.url, 'http://localhost:6000');
  assert.equal(options.json, true);
  assert.equal(options.maxChars, 180);
  assert.equal(options.timeoutMs, 12000);
});

await check('parseArgs validates timeout bounds', () => {
  assert.throws(() => parseArgs(['--timeout-ms', '999']), /Invalid --timeout-ms/);
  assert.throws(() => parseArgs(['--timeout-ms', '60001']), /Invalid --timeout-ms/);
});

await check('recommendationApiUrl allows only local dashboard URLs', () => {
  assert.equal(
    recommendationApiUrl('http://127.0.0.1:5173').href,
    'http://127.0.0.1:5173/api/recommendations.json'
  );
  assert.equal(
    recommendationApiUrl('http://localhost:5173/api/recommendations.json?project=demo')
      .href,
    'http://localhost:5173/api/recommendations.json?project=demo'
  );
  assert.throws(
    () => recommendationApiUrl('https://example.com/api/recommendations.json'),
    /only reads a local dashboard URL/
  );
});

await check('script --input emits JSON summary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recs-statusline-'));
  try {
    const input = join(dir, 'recommendations.json');
    await writeFile(input, JSON.stringify(fixture), 'utf8');
    const result = spawnSync(
      process.execPath,
      ['scripts/recommendations-statusline.mjs', '--input', input, '--json'],
      { cwd: root, encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.id, 'workflow.repeated-commands');
    assert.equal(parsed.text.includes('Repeated shell commands'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await check('coding-agent-dashboard recs delegates to statusline formatter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recs-statusline-bin-'));
  try {
    const input = join(dir, 'recommendations.json');
    await writeFile(input, JSON.stringify(fixture), 'utf8');
    const result = spawnSync(
      process.execPath,
      ['bin/coding-agent-dashboard.mjs', 'recs', '--input', input],
      { cwd: root, encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^recs warning workflow: Repeated shell commands/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

if (failures > 0) {
  process.exitCode = 1;
}
