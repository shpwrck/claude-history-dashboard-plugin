#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildConfigRemovalSnippet } from '../src/lib/config-hygiene-actions.ts';
import { computeConfigHygiene } from '../src/lib/config-hygiene.ts';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, '..');
const REGISTER = './scripts/register-ts.mjs';
const SERVER = 'scripts/server.mjs';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitUp(base, proc) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (proc.exitCode !== null) return false;
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.status === 200) return true;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test('dataset and recommendation caches invalidate an affirmative removal verdict after a nested symlink escape (#3377)', { timeout: 30_000 }, async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'config-removal-cache-'));
  const claudeDir = join(testRoot, 'configured-root');
  const distDir = join(testRoot, 'dist');
  const cacheDir = join(testRoot, 'cache');
  const pluginsCache = join(claudeDir, 'plugins', 'cache');
  const pluginComponent = join(pluginsCache, 'marketplace', 'demo');
  const installPath = join(pluginComponent, '1.0.0');
  const outsideComponent = join(testRoot, 'outside', 'demo');
  const projectRoot = join(testRoot, 'project-demo');
  const projectSkillsRoot = join(projectRoot, '.claude', 'skills');
  const projectSkillPath = join(projectSkillsRoot, 'project-risk');
  const outsideSkillPath = join(testRoot, 'outside', 'project-risk');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  await mkdir(join(claudeDir, 'projects'), { recursive: true });
  await mkdir(join(claudeDir, 'projects', 'demo'), { recursive: true });
  await mkdir(join(installPath, 'skills', 'bundled-skill'), { recursive: true });
  await mkdir(
    join(outsideComponent, '1.0.0', 'skills', 'bundled-skill'),
    { recursive: true }
  );
  for (const skill of ['global-a', 'global-b', 'global-c']) {
    await mkdir(join(claudeDir, 'skills', skill), { recursive: true });
    await writeFile(
      join(claudeDir, 'skills', skill, 'SKILL.md'),
      `---\ndescription: ${skill}\n---\n`
    );
  }
  await mkdir(projectSkillPath, { recursive: true });
  await writeFile(
    join(projectSkillPath, 'SKILL.md'),
    '---\ndescription: project risk\n---\n'
  );
  await mkdir(outsideSkillPath, { recursive: true });
  await writeFile(
    join(outsideSkillPath, 'SKILL.md'),
    '---\ndescription: escaped project risk\n---\n'
  );
  await mkdir(distDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(distDir, 'index.html'), '<!doctype html><main>ok</main>');
  await writeFile(join(claudeDir, 'history.jsonl'), '');
  await writeFile(
    join(testRoot, '.claude.json'),
    JSON.stringify({ projects: { [projectRoot]: {} } })
  );
  await writeFile(
    join(claudeDir, 'projects', 'demo', 'session-1.jsonl'),
    [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-07-20T00:00:00.000Z',
        cwd: projectRoot,
        message: { role: 'user', content: 'observe plugin usage' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-20T00:00:01.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    ].join('\n') + '\n'
  );
  await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { demo: true } }));
  await writeFile(
    join(claudeDir, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      plugins: {
        demo: [{ scope: 'user', version: '1.0.0', installPath }],
      },
    })
  );

  let stdout = '';
  let stderr = '';
  const proc = spawn('node', ['--import', REGISTER, SERVER], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      HOME: testRoot,
      PORT: String(port),
      HOST: '127.0.0.1',
      CLAUDE_DIR: claudeDir,
      CLAUDE_HOME_DIR: testRoot,
      DIST_DIR: distDir,
      CHD_DB_PATH: join(cacheDir, 'dashboard.db'),
      ADOPTION_RECEIPTS_PATH: join(cacheDir, 'adoption-receipts.jsonl'),
      ENTERPRISE_AUDIT_LOG_PATH: join(cacheDir, 'enterprise-audit.jsonl'),
      ADOPTION_SPOOL_PATH: join(cacheDir, 'adoption-spool.jsonl'),
      DASHBOARD_REVIEW_EVENTS_CACHE_PATH: join(cacheDir, 'review-events.json'),
      DASHBOARD_ENABLE_SERVER_LLM_AUDITS: '',
      DASHBOARD_ENABLE_SERVER_USAGE_GAUGE: '',
      DASHBOARD_REVIEW_EVENTS_SOURCE: '',
      DASHBOARD_GITHUB_REVIEW_TOKEN: '',
      DASHBOARD_GITHUB_REVIEW_REPOS: '',
      ANTHROPIC_API_KEY: '',
      POLICY_WRITE_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  proc.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  try {
    assert.equal(
      await waitUp(base, proc),
      true,
      [stdout, stderr].filter(Boolean).join('\n').slice(-4_000)
    );

    const firstResponse = await fetch(`${base}/api/dataset.json`);
    assert.equal(firstResponse.status, 200);
    const firstDataset = await firstResponse.json();
    const firstPlugin = firstDataset.liveConfig.plugins.find((plugin) => plugin.id === 'demo');
    assert.equal(firstPlugin?.removalSafety?.canonicalPathContained, true);
    const firstRecommendationsResponse = await fetch(
      `${base}/api/recommendations.json`
    );
    assert.equal(firstRecommendationsResponse.status, 200);
    const firstRecommendations = await firstRecommendationsResponse.json();
    const firstPluginRecommendation = firstRecommendations.find(
      (recommendation) => recommendation.id === 'workflow.unused-installed-plugins'
    );
    assert.match(firstPluginRecommendation?.fix?.snippet ?? '', /rm -rf/);
    const firstSkillRecommendation = firstRecommendations.find(
      (recommendation) => recommendation.id === 'workflow.unused-installed-skills'
    );
    assert.match(
      firstSkillRecommendation?.fix?.snippet ?? '',
      new RegExp(`rm -rf -- '${projectSkillPath}'`),
      'the primed recommendation must carry the project skill affirmative verdict'
    );

    const rootMtimeBefore = (await stat(pluginsCache)).mtimeMs;
    const projectSkillsRootStat = await stat(projectSkillsRoot);
    await rm(projectSkillPath, { recursive: true, force: true });
    await symlink(outsideSkillPath, projectSkillPath, 'dir');
    await utimes(
      projectSkillsRoot,
      projectSkillsRootStat.atimeMs / 1_000,
      (Math.floor(projectSkillsRootStat.mtimeMs) + 0.5) / 1_000
    );
    assert.equal(
      Math.floor((await stat(projectSkillsRoot)).mtimeMs),
      Math.floor(projectSkillsRootStat.mtimeMs),
      'the project skill escape must survive restoration of the stat-gate mtime'
    );

    const secondRecommendationsResponse = await fetch(
      `${base}/api/recommendations.json`
    );
    assert.equal(secondRecommendationsResponse.status, 200);
    assert.equal(
      secondRecommendationsResponse.headers.get('x-recommendations-cache'),
      'miss',
      'canonical-containment drift must hard-miss instead of serving SWR'
    );
    const secondRecommendations = await secondRecommendationsResponse.json();
    const secondSkillRecommendation = secondRecommendations.find(
      (recommendation) => recommendation.id === 'workflow.unused-installed-skills'
    );
    assert.ok(secondSkillRecommendation, 'unused skill recommendation exists');
    assert.doesNotMatch(
      secondSkillRecommendation.fix?.snippet ?? '',
      new RegExp(`rm -rf -- '${projectSkillPath}'`)
    );
    assert.match(
      secondSkillRecommendation.fix?.snippet ?? '',
      /Refusing to generate an automatic recursive delete for skill project-risk/
    );

    const secondResponse = await fetch(`${base}/api/dataset.json`);
    assert.equal(secondResponse.status, 200);
    const secondIngest = secondResponse.headers.get('x-ingest');
    const secondDataset = await secondResponse.json();
    const secondPlugin = secondDataset.liveConfig.plugins.find((plugin) => plugin.id === 'demo');
    const secondProjectSkill = secondDataset.liveConfig.skills.find(
      (skill) => skill.id === 'project-risk' && skill.projectPath === projectRoot
    );
    assert.notEqual(secondIngest, 'skipped=true;cached=true');
    assert.equal(secondPlugin?.removalSafety?.canonicalPathContained, true);
    assert.equal(
      secondProjectSkill?.removalSafety?.canonicalPathContained,
      false
    );

    await rm(pluginComponent, { recursive: true, force: true });
    await symlink(outsideComponent, pluginComponent, 'dir');
    assert.equal(
      (await stat(pluginsCache)).mtimeMs,
      rootMtimeBefore,
      'the nested replacement must leave the existing top-level stat gate unchanged'
    );

    const thirdRecommendationsResponse = await fetch(
      `${base}/api/recommendations.json`
    );
    assert.equal(thirdRecommendationsResponse.status, 200);
    assert.equal(
      thirdRecommendationsResponse.headers.get('x-recommendations-cache'),
      'miss',
      'plugin canonical-containment drift must also hard-miss instead of serving SWR'
    );
    const thirdRecommendations = await thirdRecommendationsResponse.json();
    const thirdPluginRecommendation = thirdRecommendations.find(
      (recommendation) => recommendation.id === 'workflow.unused-installed-plugins'
    );
    assert.doesNotMatch(thirdPluginRecommendation?.fix?.snippet ?? '', /rm -rf/);

    const thirdResponse = await fetch(`${base}/api/dataset.json`);
    assert.equal(thirdResponse.status, 200);
    const thirdIngest = thirdResponse.headers.get('x-ingest');
    const thirdDataset = await thirdResponse.json();
    const thirdPlugin = thirdDataset.liveConfig.plugins.find(
      (plugin) => plugin.id === 'demo'
    );
    assert.notEqual(thirdIngest, 'skipped=true;cached=true');
    assert.equal(thirdPlugin?.removalSafety?.canonicalPathContained, false);

    const now = Date.UTC(2026, 7, 1);
    const finding = computeConfigHygiene({
      liveConfig: thirdDataset.liveConfig,
      attribution: [],
      sessions: [{ sessionId: 'observed', startTime: now - 31 * 24 * 60 * 60 * 1_000 }],
      now,
    }).find((candidate) => candidate.resourceType === 'plugin' && candidate.resourceId === 'demo');
    assert.ok(finding, 'unused plugin finding exists');
    assert.doesNotMatch(buildConfigRemovalSnippet(finding), /rm -rf/);
  } finally {
    if (proc.exitCode === null) {
      proc.kill('SIGTERM');
      await new Promise((resolve) => proc.once('exit', resolve));
    }
    await rm(testRoot, { recursive: true, force: true });
  }
});
