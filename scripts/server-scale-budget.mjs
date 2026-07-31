#!/usr/bin/env node
// Server-mode large-history load budget guard (#1139, umbrella #1099).
//
// Server mode is the primary path for real, growing ~/.claude histories. This
// gate builds a deterministic temporary ~/.claude corpus at 1000+ sessions
// spread across organization-shaped projects, users, and teams. It first boots
// the real server and loads the dataset route over HTTP, then exercises the
// ingest.mjs cache/readback path directly. It fails when server boot, cold
// dataset load, ingest, dataset assembly, serialization, unchanged re-ingest,
// retained memory growth, or dataset size budgets are exceeded. Override
// counts/budgets with the DASHBOARD_SCALE_* env vars when intentionally
// re-baselining.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { buildSampleCorpus } from './sample-data/build-corpus.mjs';
import { envNumber, EnvNumberError } from './lib/env-number.mjs';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(PROJECT_DIR, 'src', 'lib');
const DEFAULT_BUDGET_PATH = join(PROJECT_DIR, 'server-scale-budget.json');
const DATASET_API_PATH = ['api', 'dataset.json'].join('/');

const BUDGET_KEYS = [
  'sessions',
  'turnsPerSession',
  'projects',
  'users',
  'teams',
  // #3478: assembleSamples was documented (with a dated rationale) in
  // server-scale-budget.json but never listed here, so readBudgetFile filtered
  // it out and a hard-coded `?? 3` fallback silently governed instead — dead
  // config that looked live. It is a real budget key now.
  'assembleSamples',
  'serverBootBudgetMs',
  'serverDatasetLoadBudgetMs',
  'coldIngestBudgetMs',
  'assembleBudgetMs',
  'serializeBudgetMs',
  'warmIngestBudgetMs',
  'datasetBytesBudget',
  'heapGrowthBudgetBytes',
  'rssGrowthBudgetBytes',
];

function configError(message) {
  console.error(`::error::server-scale budget config: ${message}`);
  process.exit(2);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseArgs(argv) {
  let budgetPath = DEFAULT_BUDGET_PATH;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--budget') {
      const value = argv[i + 1];
      if (!value) configError('--budget requires a path');
      budgetPath = resolve(value);
      i += 1;
      continue;
    }
    if (arg.startsWith('--budget=')) {
      const value = arg.slice('--budget='.length);
      if (!value) configError('--budget requires a path');
      budgetPath = resolve(value);
      continue;
    }
    configError(`unknown argument ${arg}`);
  }
  return { budgetPath };
}

function readBudgetFile(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    configError(`could not read ${filePath}: ${errorMessage(error)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    configError(`could not parse ${filePath}: ${errorMessage(error)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    configError(`${filePath} must contain a JSON object`);
  }

  const budget = {};
  for (const key of BUDGET_KEYS) {
    const value = parsed[key];
    if (!Number.isInteger(value) || value < 1) {
      configError(`${filePath} must define positive integer "${key}"`);
    }
    budget[key] = value;
  }
  return budget;
}

const args = parseArgs(process.argv.slice(2));
const DEFAULTS = readBudgetFile(args.budgetPath);

// #3478: fail-closed env parsing via the canonical helper (#3076). The old
// implementation parseInt'd and silently FELL BACK on anything unusable, so
// `DASHBOARD_SCALE_SESSIONS=abc` (or `=0`) quietly benchmarked the default
// corpus and `=12g` quietly benchmarked one 100x smaller than asked — across
// all 14 budgets. Unset/empty still means the documented default; anything the
// operator actually SET must parse, or the run dies loudly before measuring.
function intEnv(name, fallback, min = 1) {
  try {
    return envNumber(name, { fallback, min, integer: true });
  } catch (error) {
    if (error instanceof EnvNumberError) configError(error.message);
    throw error;
  }
}

const cfg = {
  sessions: intEnv('DASHBOARD_SCALE_SESSIONS', DEFAULTS.sessions),
  turnsPerSession: intEnv('DASHBOARD_SCALE_TURNS', DEFAULTS.turnsPerSession),
  projects: intEnv('DASHBOARD_SCALE_PROJECTS', DEFAULTS.projects),
  users: intEnv('DASHBOARD_SCALE_USERS', DEFAULTS.users),
  teams: intEnv('DASHBOARD_SCALE_TEAMS', DEFAULTS.teams),
  serverBootBudgetMs: intEnv(
    'DASHBOARD_SCALE_SERVER_BOOT_BUDGET_MS',
    DEFAULTS.serverBootBudgetMs
  ),
  serverDatasetLoadBudgetMs: intEnv(
    'DASHBOARD_SCALE_SERVER_DATASET_LOAD_BUDGET_MS',
    DEFAULTS.serverDatasetLoadBudgetMs
  ),
  coldIngestBudgetMs: intEnv(
    'DASHBOARD_SCALE_COLD_INGEST_BUDGET_MS',
    DEFAULTS.coldIngestBudgetMs
  ),
  // How many timing samples to take of assembleDataset; the BEST is asserted.
  // 1 restores the old single-sample behaviour. The default comes from the
  // budget file's own assembleSamples key (now in BUDGET_KEYS, #3478).
  assembleSamples: intEnv(
    'DASHBOARD_SCALE_ASSEMBLE_SAMPLES',
    DEFAULTS.assembleSamples
  ),
  assembleBudgetMs: intEnv(
    'DASHBOARD_SCALE_ASSEMBLE_BUDGET_MS',
    DEFAULTS.assembleBudgetMs
  ),
  serializeBudgetMs: intEnv(
    'DASHBOARD_SCALE_SERIALIZE_BUDGET_MS',
    DEFAULTS.serializeBudgetMs
  ),
  warmIngestBudgetMs: intEnv(
    'DASHBOARD_SCALE_WARM_INGEST_BUDGET_MS',
    DEFAULTS.warmIngestBudgetMs
  ),
  datasetBytesBudget: intEnv(
    'DASHBOARD_SCALE_DATASET_BYTES_BUDGET',
    DEFAULTS.datasetBytesBudget
  ),
  heapGrowthBudgetBytes: intEnv(
    'DASHBOARD_SCALE_HEAP_GROWTH_BUDGET_BYTES',
    DEFAULTS.heapGrowthBudgetBytes
  ),
  rssGrowthBudgetBytes: intEnv(
    'DASHBOARD_SCALE_RSS_GROWTH_BUDGET_BYTES',
    DEFAULTS.rssGrowthBudgetBytes
  ),
};

// Built AFTER the config is validated, so a bad budget file or env var dies
// instantly instead of first synthesizing a corpus it will never use.
const SAMPLE_CORPUS = buildSampleCorpus();

function timestamp(sessionIndex, turnIndex, offsetMs = 0) {
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  return new Date(
    base + sessionIndex * 60_000 + turnIndex * 1000 + offsetMs
  ).toISOString();
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function pad(value, width) {
  return String(value).padStart(width, '0');
}

function projectSlug(project) {
  return project.replaceAll('/', '-');
}

function cloneJsonl(jsonl, fromSessionId, toSessionId, fromProject, toProject) {
  return jsonl
    .replaceAll(fromSessionId, toSessionId)
    .replaceAll(fromProject, toProject);
}

function scaleIdentity(sessionIndex) {
  const userIndex = sessionIndex % cfg.users;
  const teamIndex = userIndex % cfg.teams;
  const projectIndex = sessionIndex % cfg.projects;
  const userId = `user-${pad(userIndex, 4)}`;
  const teamId = `team-${pad(teamIndex, 3)}`;
  const projectId = `project-${pad(projectIndex, 4)}`;
  return {
    userId,
    teamId,
    projectId,
    project: `/workspace/org/${teamId}/${userId}/${projectId}`,
  };
}

function sessionJsonl(sessionIndex) {
  const sessionId = `scale-${String(sessionIndex).padStart(5, '0')}`;
  const identity = scaleIdentity(sessionIndex);
  const { project, projectId, teamId, userId } = identity;
  const sample =
    SAMPLE_CORPUS.sessions[sessionIndex % SAMPLE_CORPUS.sessions.length];
  let out = cloneJsonl(
    sample.jsonl,
    sample.sessionId,
    sessionId,
    sample.project.path,
    project
  );
  for (let turn = 0; turn < cfg.turnsPerSession; turn += 1) {
    const toolId = `tool-${sessionId}-${turn}`;
    out += jsonLine({
      type: 'user',
      timestamp: timestamp(sessionIndex, turn, 0),
      cwd: project,
      message: {
        role: 'user',
        content:
          `Scale fixture request ${sessionId}/${turn} for ${teamId}/${userId}` +
          `/${projectId}: inspect files, run checks, summarize outcome.`,
      },
    });
    out += jsonLine({
      type: 'assistant',
      timestamp: timestamp(sessionIndex, turn, 250),
      version: '2.1.0-scale-fixture',
      gitBranch:
        sessionIndex % 3 === 0
          ? 'master'
          : `feature/${teamId}/scale-${sessionIndex % 9}`,
      entrypoint: 'cli',
      message: {
        id: `msg-${sessionId}-${turn}`,
        model: turn % 2 === 0 ? 'claude-sonnet-4-5' : 'claude-opus-4-5',
        usage: {
          input_tokens: 900 + (sessionIndex % 17) * 20 + turn * 11,
          output_tokens: 120 + (sessionIndex % 13) * 5 + turn * 7,
          cache_creation_input_tokens: turn === 0 ? 64 : 0,
          cache_read_input_tokens: turn > 0 ? 128 : 0,
        },
        content: [
          {
            type: 'thinking',
            thinking: `Reasoning path for ${sessionId}/${turn} with bounded synthetic detail.`,
          },
          {
            type: 'text',
            text: `Completed scale fixture task ${sessionId}/${turn}; next step is verified.`,
          },
          {
            type: 'tool_use',
            id: toolId,
            name: turn % 2 === 0 ? 'Bash' : 'Read',
            input:
              turn % 2 === 0
                ? { command: `npm test -- --runInBand scale-${sessionIndex % 5}` }
                : { file_path: `${project}/src/module-${turn}.ts` },
          },
        ],
      },
      attributionAgent: sessionIndex % 5 === 0 ? 'reviewer' : undefined,
      attributionSkill: sessionIndex % 7 === 0 ? 'diagnostics' : undefined,
    });
    out += jsonLine({
      type: 'user',
      timestamp: timestamp(sessionIndex, turn, 500),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolId,
            is_error: sessionIndex % 31 === 0 && turn === 1,
            content: `Result payload for ${sessionId}/${turn}: ${'ok '.repeat(20)}`,
          },
        ],
      },
    });
  }
  return {
    sessionId,
    identity,
    project,
    projectSlug: projectSlug(project),
    jsonl: out,
  };
}

function writeSessionRegistryEntry(claude, session, sessionIndex) {
  const sessionsDir = join(claude, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const pid = 300_000 + sessionIndex;
  writeFileSync(
    join(sessionsDir, `${pid}.json`),
    `${JSON.stringify({
      pid,
      sessionId: session.sessionId,
      cwd: session.project,
      startedAt: Date.parse(timestamp(sessionIndex, 0, 0)),
      procStart: String(1_000_000 + sessionIndex),
      version: '2.1.0-scale-fixture',
      peerProtocol: 1,
      kind: 'interactive',
      entrypoint: sessionIndex % 4 === 0 ? 'sdk-cli' : 'cli',
    })}\n`,
    'utf8'
  );
}

function writeTeamFixtures(claude) {
  const assignmentsPerAgent = Math.min(
    12,
    Math.max(1, Math.ceil(cfg.users / cfg.teams))
  );
  for (let teamIndex = 0; teamIndex < cfg.teams; teamIndex += 1) {
    const teamId = `team-${pad(teamIndex, 3)}`;
    const inboxDir = join(claude, 'teams', teamId, 'inboxes');
    mkdirSync(inboxDir, { recursive: true });
    for (let agentIndex = 0; agentIndex < 2; agentIndex += 1) {
      const agentId = `agent-${pad(agentIndex, 2)}`;
      const messages = [];
      for (
        let assignmentIndex = 0;
        assignmentIndex < assignmentsPerAgent;
        assignmentIndex += 1
      ) {
        const assignmentTimestamp = timestamp(
          teamIndex * assignmentsPerAgent + assignmentIndex,
          agentIndex,
          0
        );
        messages.push({
          from: `lead-${teamId}`,
          text: JSON.stringify({
            type: 'task_assignment',
            taskId: `scale-${teamId}-${agentId}-${pad(assignmentIndex, 2)}`,
            subject: `Review scale fixture ${teamId} cohort ${pad(assignmentIndex, 2)}`,
            description:
              'Synthetic organization-scale work item for the server budget guard.',
            assignedBy: `lead-${teamId}`,
            timestamp: assignmentTimestamp,
          }),
          timestamp: assignmentTimestamp,
          type: 'message',
          read: assignmentIndex % 3 === 0,
        });
      }
      writeFileSync(
        join(inboxDir, `${agentId}.json`),
        JSON.stringify(messages),
        'utf8'
      );
    }
  }
}

function buildFixtureHome() {
  const home = join(tmpdir(), `chd-scale-${randomUUID()}`);
  const claude = join(home, '.claude');
  const projectsDir = join(claude, 'projects');
  mkdirSync(projectsDir, { recursive: true });

  let transcriptBytes = 0;
  const observedProjects = new Set();
  const observedProjectDirs = new Set();
  const observedUsers = new Set();
  const observedTeams = new Set();
  const historyEntries = [];
  for (let i = 0; i < cfg.sessions; i += 1) {
    const s = sessionJsonl(i);
    const dir = join(projectsDir, s.projectSlug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${s.sessionId}.jsonl`), s.jsonl, 'utf8');
    transcriptBytes += Buffer.byteLength(s.jsonl, 'utf8');
    observedProjects.add(s.identity.projectId);
    observedProjectDirs.add(s.project);
    observedUsers.add(s.identity.userId);
    observedTeams.add(s.identity.teamId);
    writeSessionRegistryEntry(claude, s, i);
    historyEntries.push({
      display: `Scale fixture request ${s.sessionId}`,
      pastedContents: {},
      timestamp: Date.parse(timestamp(i, 0, 0)),
      project: s.project,
      sessionId: s.sessionId,
    });
  }

  writeFileSync(
    join(claude, 'history.jsonl'),
    historyEntries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8'
  );
  writeTeamFixtures(claude);
  mkdirSync(join(claude, 'skills', 'scale-skill'), { recursive: true });
  writeFileSync(join(claude, 'skills', 'scale-skill', 'SKILL.md'), '# Scale skill\n', 'utf8');
  mkdirSync(join(claude, 'agents'), { recursive: true });
  writeFileSync(join(claude, 'agents', 'scale-agent.md'), '# Scale agent\n', 'utf8');
  mkdirSync(join(claude, 'commands'), { recursive: true });
  writeFileSync(join(claude, 'commands', 'scale-command.md'), '# Scale command\n', 'utf8');
  mkdirSync(join(claude, 'plugins', 'cache'), { recursive: true });
  writeFileSync(join(claude, 'plugins', 'installed_plugins.json'), '[]\n', 'utf8');
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ theme: 'system' }), 'utf8');

  return {
    home,
    claude,
    transcriptBytes,
    observedProjects: observedProjects.size,
    observedProjectDirs: observedProjectDirs.size,
    observedUsers: observedUsers.size,
    observedTeams: observedTeams.size,
  };
}

function timed(fn) {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

function assertBudget(label, actual, budget, unit = 'ms') {
  const ok = actual <= budget;
  const shownActual = unit === 'ms' ? `${actual.toFixed(1)} ms` : `${actual} B`;
  const shownBudget = unit === 'ms' ? `${budget} ms` : `${budget} B`;
  if (!ok) {
    console.error(`::error::${label} exceeded budget: ${shownActual} > ${shownBudget}`);
  }
  return ok;
}

function assertEqual(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) {
    console.error(`::error::${label} mismatch: ${actual} !== ${expected}`);
  }
  return ok;
}

function printMetric(label, value, budget, unit = 'ms') {
  const shownValue = unit === 'ms' ? `${value.toFixed(1)} ms` : `${value} B`;
  const shownBudget = unit === 'ms' ? `${budget} ms` : `${budget} B`;
  console.log(`  ${label.padEnd(26)} ${shownValue.padStart(12)} / ${shownBudget}`);
}

function forceGc() {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    globalThis.gc();
  }
}

function memorySnapshot() {
  const { heapUsed, rss } = process.memoryUsage();
  return { heapUsed, rss };
}

function memoryGrowthSince(snapshot, baseline) {
  return {
    heapGrowthBytes: Math.max(0, snapshot.heapUsed - baseline.heapUsed),
    rssGrowthBytes: Math.max(0, snapshot.rss - baseline.rss),
  };
}

function memoryCheckpoint(label, baseline) {
  forceGc();
  return {
    label,
    ...memoryGrowthSince(memorySnapshot(), baseline),
  };
}

function maxGrowth(checkpoints, key) {
  return Math.max(...checkpoints.map((checkpoint) => checkpoint[key]));
}

function printMemoryCheckpoint(checkpoint) {
  console.log(
    `  ${checkpoint.label.padEnd(26)} ` +
      `heap +${String(checkpoint.heapGrowthBytes).padStart(10)} B  ` +
      `rss +${String(checkpoint.rssGrowthBytes).padStart(10)} B`
  );
}

function delay(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function originForPort(port) {
  return `http://127.0.0.1:${port}/`;
}

async function freePort() {
  const server = createNetServer();
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}

function formatServerOutput(logs) {
  const trimmed = logs().trim();
  return trimmed ? `\nserver output:\n${trimmed}` : '';
}

async function waitForServerHealth(child, origin, logs) {
  const healthUrl = new URL('healthz', origin);
  const start = performance.now();
  const timeoutMs = Math.max(10_000, cfg.serverBootBudgetMs * 2);
  let lastError = null;
  while (performance.now() - start < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(
        `server exited before health check passed (${child.exitCode})` +
          formatServerOutput(logs)
      );
    }
    try {
      const res = await fetch(healthUrl);
      if (res.ok) return performance.now() - start;
      lastError = new Error(`health check returned HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(
    `server health check timed out after ${timeoutMs} ms: ${errorMessage(lastError)}` +
      formatServerOutput(logs)
  );
}

async function startScaleServer(fixture, dbPath) {
  const port = await freePort();
  const origin = originForPort(port);
  const child = spawn(
    process.execPath,
    [
      '--import',
      join(PROJECT_DIR, 'scripts', 'register-ts.mjs'),
      join(PROJECT_DIR, 'scripts', 'server.mjs'),
    ],
    {
      cwd: PROJECT_DIR,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        HOME: fixture.home,
        CLAUDE_DIR: fixture.claude,
        CHD_DB_PATH: dbPath,
        DIST_DIR: join(PROJECT_DIR, 'dist'),
        DASHBOARD_AUTH_MODE: '',
        DASHBOARD_USER: '',
        DASHBOARD_PASS: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  const logs = () => output;
  const bootMs = await waitForServerHealth(child, origin, logs);
  return { child, origin, bootMs, logs };
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolvePromise) => {
    child.once('exit', () => resolvePromise(true));
  });
  child.kill('SIGTERM');
  const stopped = await Promise.race([exited, delay(2_000).then(() => false)]);
  if (!stopped && child.exitCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function fetchServerDataset(origin) {
  const datasetUrl = new URL(DATASET_API_PATH, origin);
  const start = performance.now();
  const res = await fetch(datasetUrl, {
    headers: { 'Accept-Encoding': 'identity' },
  });
  const text = await res.text();
  const ms = performance.now() - start;
  if (!res.ok) {
    throw new Error(
      `dataset route returned HTTP ${res.status}: ${text.slice(0, 240)}`
    );
  }
  const parsed = JSON.parse(text);
  return {
    ms,
    bytes: Buffer.byteLength(text, 'utf8'),
    ingestHeader: res.headers.get('x-ingest') || '',
    entries: Array.isArray(parsed.entries) ? parsed.entries.length : -1,
    sessionRegistry: Array.isArray(parsed.sessionRegistry)
      ? parsed.sessionRegistry.length
      : -1,
  };
}

const { safeJsonStringify } = await import(join(LIB, 'json-safe.ts'));
const fixture = buildFixtureHome();
const { home, transcriptBytes } = fixture;
const serverDbPath = join(tmpdir(), `chd-scale-server-${randomUUID()}.db`);
const directDbPath = join(tmpdir(), `chd-scale-direct-${randomUUID()}.db`);
const origHome = process.env.HOME;
const origDbPath = process.env.CHD_DB_PATH;
let serverRun = null;
let serverBootMs = 0;

try {
  serverRun = await startScaleServer(fixture, serverDbPath);
  serverBootMs = serverRun.bootMs;
  const serverDataset = await fetchServerDataset(serverRun.origin);
  await stopServer(serverRun.child);
  serverRun = null;

  process.env.HOME = home;
  process.env.CHD_DB_PATH = directDbPath;

  const ingest = await import(`./ingest.mjs?scale=${randomUUID()}`);

  forceGc();
  const memoryBaseline = memorySnapshot();
  const coldIngest = timed(() => ingest.ingest());
  const afterColdIngestMemory = memoryCheckpoint('after cold ingest', memoryBaseline);
  const assemble = timed(() => ingest.assembleDataset());
  const afterAssembleMemory = memoryCheckpoint('after assembleDataset', memoryBaseline);
  const serialize = timed(() => safeJsonStringify(assemble.value));
  const datasetBytes = Buffer.byteLength(serialize.value, 'utf8');
  const afterSerializeMemory = memoryCheckpoint('after serialize JSON', memoryBaseline);
  const warmIngest = timed(() => ingest.ingest());
  const afterWarmIngestMemory = memoryCheckpoint('after warm ingest', memoryBaseline);

  // Extra assembleDataset TIMING samples (#3431). Taken here, AFTER every memory
  // checkpoint above, so repeating the call cannot perturb the heap/RSS growth
  // numbers — those still describe exactly one cold ingest + assemble +
  // serialize, as before.
  //
  // Why sample at all: this budget failed twice on 2026-07-28 (3112.9 ms and
  // 3454.6 ms against 3000 ms) on branches that provably could not have slowed
  // ingest — one changed only an offline eval module that nothing in the ingest
  // path imports. Measured locally on a quiet host the same code assembles in
  // ~1150 ms, so the ARC runner is ~3x slower and visibly variable under load,
  // and a single sample against a fixed ceiling fails on contention rather than
  // on regressions. A gate that needs a re-run once every eight PRs teaches
  // reviewers to re-run on red, which is how a real regression gets waved
  // through.
  //
  // Contention can only ever ADD time, so the minimum across samples is the
  // measurement least polluted by it, while a genuine slowdown raises every
  // sample and still fails. Even on a quiet host the FIRST sample runs ~30%
  // slower than the best (cold JIT, cold allocator), so a single sample was
  // always measuring the worst case: 1268.3 / 1045.1 / 920.6 ms locally.
  //
  // Only assembleDataset is resampled, and not because the other timings are
  // immune -- `server dataset load` tipped 12005.2 ms over a 12000 ms ceiling on
  // the same contended run, by 5 ms. It is that they cannot be resampled
  // HONESTLY: a second dataset fetch hits a warm server cache and a second cold
  // ingest is no longer cold, so repeating either measures something other than
  // what the budget is about. Where a ceiling is genuinely too tight for the
  // runner's spread the fix is a deliberate, dated raise in
  // server-scale-budget.json, not a fake resample.
  const assembleSamplesMs = [assemble.ms];
  for (let i = 1; i < cfg.assembleSamples; i += 1) {
    assembleSamplesMs.push(timed(() => ingest.assembleDataset()).ms);
  }
  const assembleBestMs = Math.min(...assembleSamplesMs);
  const memoryCheckpoints = [
    afterColdIngestMemory,
    afterAssembleMemory,
    afterSerializeMemory,
    afterWarmIngestMemory,
  ];
  const heapGrowthBytes = maxGrowth(memoryCheckpoints, 'heapGrowthBytes');
  const rssGrowthBytes = maxGrowth(memoryCheckpoints, 'rssGrowthBytes');

  const checks = [
    assertBudget('server boot', serverBootMs, cfg.serverBootBudgetMs),
    assertBudget(
      'server dataset load',
      serverDataset.ms,
      cfg.serverDatasetLoadBudgetMs
    ),
    assertEqual(
      'server dataset session registry rows',
      serverDataset.sessionRegistry,
      cfg.sessions
    ),
    assertBudget(
      'server dataset JSON bytes',
      serverDataset.bytes,
      cfg.datasetBytesBudget,
      'bytes'
    ),
    assertEqual('discovered sessions', coldIngest.value.total, cfg.sessions),
    assertEqual(
      'fixture project ids',
      fixture.observedProjects,
      Math.min(cfg.projects, cfg.sessions)
    ),
    assertEqual(
      'fixture users',
      fixture.observedUsers,
      Math.min(cfg.users, cfg.sessions)
    ),
    assertEqual(
      'fixture teams',
      fixture.observedTeams,
      Math.min(cfg.teams, cfg.users, cfg.sessions)
    ),
    assertEqual(
      'session registry rows',
      assemble.value.sessionRegistry.length,
      cfg.sessions
    ),
    assertEqual('team summaries', assemble.value.teams.length, cfg.teams),
    assertBudget('cold ingest', coldIngest.ms, cfg.coldIngestBudgetMs),
    assertBudget('assembleDataset', assembleBestMs, cfg.assembleBudgetMs),
    assertBudget('dataset serialization', serialize.ms, cfg.serializeBudgetMs),
    assertBudget('unchanged re-ingest', warmIngest.ms, cfg.warmIngestBudgetMs),
    assertBudget('dataset JSON bytes', datasetBytes, cfg.datasetBytesBudget, 'bytes'),
    assertBudget(
      'retained heap growth',
      heapGrowthBytes,
      cfg.heapGrowthBudgetBytes,
      'bytes'
    ),
    assertBudget(
      'retained RSS growth',
      rssGrowthBytes,
      cfg.rssGrowthBudgetBytes,
      'bytes'
    ),
  ];
  if (warmIngest.value.reparsed !== 0) {
    console.error(`::error::unchanged re-ingest reparsed ${warmIngest.value.reparsed} sessions; expected 0`);
    checks.push(false);
  }

  console.log('\nServer-mode scale budget guard');
  console.log(`  budget file: ${args.budgetPath}`);
  console.log('  fixture seed: scripts/sample-data/build-corpus.mjs');
  console.log(`  sessions: ${cfg.sessions}`);
  console.log(`  turns/session: ${cfg.turnsPerSession}`);
  console.log(
    `  project ids: ${fixture.observedProjects} observed (${cfg.projects} configured)`
  );
  console.log(
    `  project directories: ${fixture.observedProjectDirs} generated`
  );
  console.log(`  users: ${fixture.observedUsers} observed (${cfg.users} configured)`);
  console.log(`  teams: ${fixture.observedTeams} observed (${cfg.teams} configured)`);
  console.log(`  transcript bytes: ${transcriptBytes}`);
  console.log(
    `  cold ingest rows: total=${coldIngest.value.total}, ` +
      `reparsed=${coldIngest.value.reparsed}, ` +
      `skipped=${coldIngest.value.skippedSessions}`
  );
  console.log(
    `  dataset rows: entries=${assemble.value.entries.length}, ` +
      `tokenData=${assemble.value.tokenData.length}, ` +
      `toolData=${assemble.value.toolData.length}, teams=${assemble.value.teams.length}, ` +
      `sessionRegistry=${assemble.value.sessionRegistry.length}`
  );
  console.log(
    `  server route: entries=${serverDataset.entries}, ` +
      `sessionRegistry=${serverDataset.sessionRegistry}, ` +
      `bytes=${serverDataset.bytes}, x-ingest="${serverDataset.ingestHeader}"`
  );
  console.log('\nMemory growth from post-import baseline:');
  for (const checkpoint of memoryCheckpoints) {
    printMemoryCheckpoint(checkpoint);
  }
  console.log('\nBudgets:');
  printMetric('server boot', serverBootMs, cfg.serverBootBudgetMs);
  printMetric(
    'server dataset load',
    serverDataset.ms,
    cfg.serverDatasetLoadBudgetMs
  );
  printMetric('cold ingest', coldIngest.ms, cfg.coldIngestBudgetMs);
  printMetric('assembleDataset', assembleBestMs, cfg.assembleBudgetMs);
  // Print the spread so a threshold change is justified by recorded numbers
  // rather than guessed, and so a run that is merely slow is distinguishable
  // from one that is consistently over.
  if (assembleSamplesMs.length > 1) {
    console.log(
      `    (best of ${assembleSamplesMs.length}: ${assembleSamplesMs
        .map((ms) => ms.toFixed(1))
        .join(', ')} ms)`
    );
  }
  printMetric('serialize JSON', serialize.ms, cfg.serializeBudgetMs);
  printMetric('unchanged re-ingest', warmIngest.ms, cfg.warmIngestBudgetMs);
  printMetric('dataset JSON bytes', datasetBytes, cfg.datasetBytesBudget, 'bytes');
  printMetric('retained heap growth', heapGrowthBytes, cfg.heapGrowthBudgetBytes, 'bytes');
  printMetric('retained RSS growth', rssGrowthBytes, cfg.rssGrowthBudgetBytes, 'bytes');

  if (checks.every(Boolean)) {
    console.log('\nPASS server-mode scale budget');
  } else {
    process.exitCode = 1;
  }
} finally {
  if (serverRun) {
    try {
      await stopServer(serverRun.child);
    } catch {
      /* best-effort */
    }
  }
  if (origHome == null) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origDbPath == null) delete process.env.CHD_DB_PATH;
  else process.env.CHD_DB_PATH = origDbPath;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  try {
    rmSync(serverDbPath, { force: true });
  } catch {
    /* best-effort */
  }
  try {
    rmSync(directDbPath, { force: true });
  } catch {
    /* best-effort */
  }
}
