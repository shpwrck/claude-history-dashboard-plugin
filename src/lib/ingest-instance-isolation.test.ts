import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function globalIngestApiKeys(): string[] {
  const source = readFileSync(join(repoRoot, 'scripts', 'server.mjs'), 'utf8');
  const start = source.indexOf('const GLOBAL_INGEST_API = {');
  const end = source.indexOf('\n};', start);
  if (start < 0 || end < start) throw new Error('GLOBAL_INGEST_API not found');
  return [...source.slice(start, end).matchAll(/^ {2}([A-Za-z_$][\w$]*),$/gm)]
    .map((match) => match[1])
    .sort();
}

function transcript(prompt: string): string {
  return [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: `/repo/${prompt}`,
      message: { role: 'user', content: prompt },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        id: `${prompt}-assistant`,
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
  ].join('\n');
}

function writeSession(root: string, sessionId: string, prompt: string): void {
  const project = join(root, '.claude', 'projects', 'project-a');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${sessionId}.jsonl`), `${transcript(prompt)}\n`);
}

describe('createIngest instance isolation (#3678)', () => {
  it('keeps every mutable owner and SQLite initialization inside the factory', () => {
    const source = readFileSync(join(repoRoot, 'scripts', 'ingest.mjs'), 'utf8');
    const factoryStart = source.indexOf('function createIngestInstance(');
    const factoryEnd = source.indexOf(
      '/** Construct one isolated ingest state owner',
      factoryStart
    );
    expect(factoryStart).toBeGreaterThan(0);
    expect(factoryEnd).toBeGreaterThan(factoryStart);

    const modulePrelude = source.slice(0, factoryStart);
    const instanceBody = source.slice(factoryStart, factoryEnd);
    expect(modulePrelude).not.toMatch(/^let /m);
    expect(modulePrelude).not.toContain('new DatabaseSync(');
    expect(instanceBody).toContain('const db = new DatabaseSync(DB_PATH);');
    for (const binding of [
      'nextAssemblyDocGitTimesSnapshot',
      'sourceSignatureDocGitTimesSnapshot',
      'warnedIncompleteBundledDocGraph',
      'expectedDocGraphGitWorkingTreeSignature',
      'lastSourceSignatureDocGraphGitWorkingTreeSignature',
      'docIssueExpectedRefState',
      'docsMapGitDir',
      'docsMapMemo',
      'datasetSnapshotContentHash',
      'datasetSnapshotCapturedAt',
      'datasetSnapshotWorkflowProjection',
      'reviewEventsRefreshPromise',
      '_artifactParseCount',
      '_transcriptSourceReadCount',
      'transcriptIdentityBaseline',
      'transcriptRewriteEpochs',
      'liveSessionsCache',
    ]) {
      expect(instanceBody).toMatch(new RegExp(`^let ${binding}(?:\\s|$)`, 'm'));
    }
  });

  it('owns independent roots, SQLite state, source gates, and snapshots in one process', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'chd-3678-isolation-'));
    const defaultRoot = join(fixtureRoot, 'default');
    const rootA = join(fixtureRoot, 'a');
    const rootB = join(fixtureRoot, 'b');
    writeSession(rootA, 'session-a', 'alpha');
    writeSession(rootB, 'session-b', 'bravo');
    mkdirSync(join(defaultRoot, '.claude', 'projects'), { recursive: true });

    const code = `
      import { existsSync, statSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { createIngest } from './scripts/ingest.mjs';
      import { filesystemArtifactSource } from './src/lib/artifact-source.ts';

      const fixtureRoot = process.env.CHD_INGEST_INSTANCE_FIXTURE;
      const rootA = join(fixtureRoot, 'a');
      const rootB = join(fixtureRoot, 'b');

      function config(root, id) {
        const claude = join(root, '.claude');
        const projects = join(claude, 'projects');
        const source = {
          id,
          harness: 'claude-code',
          historyDir: projects,
          configFile: join(root, '.claude.json'),
        };
        const cacheDir = join(root, '.cache');
        return Object.freeze({
          dataSources: [source],
          defaultSource: source,
          projects,
          claude,
          defaultSourceProvenance: { sourceId: id, harness: 'claude-code' },
          claudeJson: source.configFile,
          claudeHome: root,
          cacheDir,
          scoped: true,
          projectConfigRoots: [],
          extraProjectRoots: [],
          projectSources: [{
            source,
            projectsRoot: projects,
            artifacts: filesystemArtifactSource(source),
          }],
          projectRoots: [projects],
          shadowCallsLedger: join(claude, 'shadow-calls', 'ledger.jsonl'),
          localCalibrationReport: join(claude, 'shadow-calls', 'calibration-report.json'),
          usageData: join(claude, 'usage-data'),
          repoMapDir: join(claude, 'usage-data', 'repo-map'),
          docHygieneDir: join(claude, 'usage-data', 'doc-hygiene'),
          dbPath: join(cacheDir, 'dashboard.db'),
          settingsGlobal: join(claude, 'settings.json'),
          settingsLocal: join(claude, 'settings.local.json'),
          claudeMdGlobal: join(claude, 'CLAUDE.md'),
          skillsDir: join(claude, 'skills'),
          agentsDir: join(claude, 'agents'),
          commandsDir: join(claude, 'commands'),
          pluginsRegistry: join(claude, 'plugins', 'installed_plugins.json'),
          pluginsCache: join(claude, 'plugins', 'cache'),
          tasksDir: join(claude, 'tasks'),
          teamsDir: join(claude, 'teams'),
          plansDir: join(claude, 'plans'),
          modelEvalResultsDir: join(claude, 'model-evals', 'results'),
          semanticIntentDir: join(claude, 'model-evals', 'semantic-intent'),
          lastUpdate: join(claude, '.last-update-result.json'),
          mcpAuth: join(claude, 'mcp-needs-auth-cache.json'),
          backupsDir: join(claude, 'backups'),
          reviewEventsCache: join(cacheDir, 'review-events', 'github-review-events.json'),
          docIssueCacheDir: join(cacheDir, 'doc-issues'),
        });
      }

      const expectedApi = JSON.parse(process.env.CHD_EXPECTED_INGEST_API);

      const a = createIngest({ config: config(rootA, 'fixture-a') });
      const b = createIngest({ config: config(rootB, 'fixture-b') });
      if (JSON.stringify(Object.keys(a).sort()) !== JSON.stringify(expectedApi)) {
        throw new Error('createIngest drifted from GLOBAL_INGEST_API');
      }

      const sourceA1 = a.sourceSignature();
      const sourceB1 = b.sourceSignature();
      if (!sourceA1.includes(join(rootA, '.claude', 'projects'))) {
        throw new Error('instance A source gate did not use root A');
      }
      if (!sourceB1.includes(join(rootB, '.claude', 'projects'))) {
        throw new Error('instance B source gate did not use root B');
      }
      if (sourceA1 === sourceB1) throw new Error('source signatures aliased');

      const buildA1 = a.ingest(sourceA1);
      const buildB1 = b.ingest(sourceB1);
      const datasetA1 = a.assembleDataset();
      const datasetB1 = b.assembleDataset();
      if (datasetA1.sourceId !== 'fixture-a' || datasetB1.sourceId !== 'fixture-b') {
        throw new Error('instance source provenance crossed');
      }
      if (datasetA1.entries.some((entry) => entry.sessionId === 'session-b')) {
        throw new Error('instance A observed instance B session state');
      }
      if (datasetB1.entries.some((entry) => entry.sessionId === 'session-a')) {
        throw new Error('instance B observed instance A session state');
      }

      const bSnapshot = JSON.stringify({
        entries: datasetB1.entries,
        tokenData: datasetB1.tokenData,
        recommendations: datasetB1.recommendations,
      });
      const secondSession = join(
        rootA,
        '.claude',
        'projects',
        'project-a',
        'session-a2.jsonl'
      );
      writeFileSync(
        secondSession,
        JSON.stringify({
          type: 'user',
          timestamp: '2026-01-02T00:00:00.000Z',
          cwd: '/repo/alpha-two',
          message: { role: 'user', content: 'alpha-two' },
        }) + '\\n'
      );

      const sourceA2 = a.sourceSignature();
      if (sourceA2 === sourceA1) throw new Error('instance A did not invalidate');
      if (b.sourceSignature() !== sourceB1) {
        throw new Error('instance A invalidation moved instance B source gate');
      }
      const buildA2 = a.ingest(sourceA2);
      const buildB2 = b.ingest(sourceB1);
      if (buildA2.contentHash === buildA1.contentHash) {
        throw new Error('instance A snapshot did not advance');
      }
      if (buildB2.contentHash !== buildB1.contentHash) {
        throw new Error('instance A mutation changed instance B content hash');
      }
      if (a.assembleDataset().entries.length !== 2) {
        throw new Error('instance A did not assemble its second session');
      }
      const datasetB2 = b.assembleDataset();
      const bSnapshotAfter = JSON.stringify({
        entries: datasetB2.entries,
        tokenData: datasetB2.tokenData,
        recommendations: datasetB2.recommendations,
      });
      if (bSnapshotAfter !== bSnapshot) {
        throw new Error('instance A mutation changed instance B assembled snapshot');
      }

      const dbA = join(rootA, '.cache', 'dashboard.db');
      const dbB = join(rootB, '.cache', 'dashboard.db');
      if (!existsSync(dbA) || !existsSync(dbB) || statSync(dbA).ino === statSync(dbB).ino) {
        throw new Error('instances did not own distinct SQLite files');
      }
      console.log(JSON.stringify({
        apiMembers: Object.keys(a).length,
        aSessions: a.assembleDataset().entries.length,
        bSessions: datasetB2.entries.length,
        independentContentHashes: true,
        independentDbFiles: true,
      }));
    `;

    const result = spawnSync(
      process.execPath,
      ['--import', './scripts/register-ts.mjs', '--input-type=module', '-e', code],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: defaultRoot,
          CLAUDE_DIR: join(defaultRoot, '.claude'),
          CLAUDE_HOME_DIR: defaultRoot,
          CHD_DB_PATH: join(defaultRoot, 'dashboard.db'),
          CHD_SCOPED_INGEST: '1',
          CHD_DOC_ISSUES: '',
          CLAUDE_HUB_PROJECTS_DIR: '',
          CLAUDE_HUB_DIR: '',
          DASHBOARD_HUB_PROJECTS_DIR: '',
          GIT_TERMINAL_PROMPT: '0',
          CHD_INGEST_INSTANCE_FIXTURE: fixtureRoot,
          CHD_EXPECTED_INGEST_API: JSON.stringify(globalIngestApiKeys()),
        },
      }
    );

    try {
      expect(result.status, result.stderr).toBe(0);
      const summary = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}');
      expect(summary).toEqual({
        apiMembers: 27,
        aSessions: 2,
        bSessions: 1,
        independentContentHashes: true,
        independentDbFiles: true,
      });
      expect(statSync(join(rootA, '.cache', 'dashboard.db')).size).toBeGreaterThan(0);
      expect(statSync(join(rootB, '.cache', 'dashboard.db')).size).toBeGreaterThan(0);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
