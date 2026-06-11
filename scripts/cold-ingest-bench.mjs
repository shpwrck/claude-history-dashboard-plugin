// Prototype benchmark for a first-ever empty-cache ingest fan-out (#855).
//
// This intentionally stops before production wiring: workers read + parse
// per-session signal rows, then the parent process merges rows in deterministic
// session_id order. SQLite remains a single-writer concern for the later wiring
// slice. Run with:
//
//   npm run bench:ingest:cold
//
// Tuning:
//   CHD_COLD_INGEST_TARGET_MB=128
//   CHD_COLD_INGEST_WORKERS=4
//   CHD_COLD_INGEST_MIN_SPEEDUP=2

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { buildSampleCorpus } from './sample-data/build-corpus.mjs';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTER_TS = join(PROJECT_DIR, 'scripts', 'register-ts.mjs');
const RUN_ID = randomUUID();

function envInt(name, fallback, min, max) {
  const raw = process.env[name];
  const parsed = raw == null || raw === '' ? fallback : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function hrMs() {
  const [s, ns] = process.hrtime();
  return s * 1e3 + ns / 1e6;
}

function sha1(text) {
  return createHash('sha1').update(text).digest('hex');
}

function cloneJsonl(jsonl, fromSessionId, toSessionId, fromProject, toProject) {
  return jsonl
    .replaceAll(fromSessionId, toSessionId)
    .replaceAll(fromProject, toProject);
}

function buildLargeFixtureHome(targetBytes) {
  const home = join(tmpdir(), `chd-cold-ingest-${RUN_ID}`);
  const claude = join(home, '.claude');
  const projectsRoot = join(claude, 'projects');
  mkdirSync(projectsRoot, { recursive: true });

  const base = buildSampleCorpus();
  const history = [];
  let totalTranscriptBytes = 0;
  let clone = 0;

  while (totalTranscriptBytes < targetBytes) {
    for (const session of base.sessions) {
      const projectGroup = clone % 32;
      const sessionId = `${session.sessionId}-cold-${String(clone).padStart(5, '0')}`;
      const project = `${session.project}-cold-${projectGroup}`;
      const slug = `${session.slug}-cold-${projectGroup}`;
      const jsonl = cloneJsonl(
        session.jsonl,
        session.sessionId,
        sessionId,
        session.project,
        project
      );
      const projectDir = join(projectsRoot, slug);
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, `${sessionId}.jsonl`), jsonl, 'utf8');
      totalTranscriptBytes += Buffer.byteLength(jsonl, 'utf8');
      history.push({
        display: `Cold ingest fixture ${sessionId}`,
        pastedContents: {},
        timestamp: Date.UTC(2026, 5, 1) + clone * 1000,
        project,
        sessionId,
      });
      clone += 1;
      if (totalTranscriptBytes >= targetBytes) break;
    }
  }

  writeFileSync(
    join(claude, 'history.jsonl'),
    history.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8'
  );

  return {
    home,
    claude,
    sessionCount: clone,
    totalTranscriptBytes,
  };
}

function sortRows(rows) {
  return [...rows].sort((a, b) => String(a.session_id).localeCompare(String(b.session_id)));
}

function portableRowsForHash(rows) {
  return sortRows(rows).map((row) => ({
    ...row,
    sig: '<file-signature>',
  }));
}

function assembleTranscriptDataset(rows, sessionSignals) {
  const dataset = {
    tokenData: [],
    toolData: [],
    toolInventories: [],
    timelines: [],
    apiErrors: [],
    permissionRows: [],
    permissionChanges: [],
    agentSettings: [],
    attribution: [],
    runtimeEvents: [],
    churnGeometry: [],
    assistantFeatures: [],
    deceitSignals: [],
    taskSuccess: [],
    entries: [],
  };
  const out = {
    tokenData: dataset.tokenData,
    toolData: dataset.toolData,
    toolInventories: dataset.toolInventories,
    timelines: dataset.timelines,
    apiErrors: dataset.apiErrors,
    agentSettings: dataset.agentSettings,
    attribution: dataset.attribution,
    runtimeEvents: dataset.runtimeEvents,
    churnGeometry: dataset.churnGeometry,
    assistantFeatures: dataset.assistantFeatures,
    deceitSignals: dataset.deceitSignals,
    taskSuccess: dataset.taskSuccess,
  };

  for (const row of sortRows(rows)) {
    for (const signal of sessionSignals) {
      if (signal.aggregate === 'push-truthy') {
        const value =
          signal.parseGuard === 'guarded'
            ? row[signal.column]
              ? JSON.parse(row[signal.column])
              : null
            : JSON.parse(row[signal.column]);
        if (value) out[signal.datasetKey].push(value);
      } else if (signal.aggregate === 'spread') {
        for (const value of JSON.parse(row[signal.column]) || []) {
          out[signal.datasetKey].push(value);
        }
      } else if (signal.id === 'perm') {
        const perm = JSON.parse(row[signal.column]) || {
          perModeEntries: [],
          changes: [],
        };
        dataset.permissionRows.push(...(perm.perModeEntries || []));
        dataset.permissionChanges.push(...(perm.changes || []));
      } else if (signal.id === 'entries') {
        dataset.entries.push(...(JSON.parse(row[signal.column]) || []));
      }
    }
  }
  return dataset;
}

async function parseSerial(ingest, sessions) {
  const rows = [];
  for (const session of sessions) {
    const sig = ingest.sessionFileSignature(session);
    rows.push(ingest.parseSessionBlobRowFromDisk(session, sig).byColumn);
  }
  return rows;
}

function parseWorkerChunk(chunk, workerId, home) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./cold-ingest-worker.mjs', import.meta.url), {
      workerData: { sessions: chunk, workerId },
      execArgv: ['--import', REGISTER_TS],
      env: {
        ...process.env,
        HOME: home,
        CHD_DB_PATH: ':memory:',
      },
    });
    worker.once('message', (message) => {
      if (message?.ok) resolve(message.rows);
      else reject(new Error(message?.error || 'cold ingest worker failed'));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`cold ingest worker exited ${code}`));
    });
  });
}

async function parseParallel(sessions, workerCount, home) {
  const chunks = Array.from({ length: workerCount }, () => []);
  sessions.forEach((session, index) => {
    chunks[index % workerCount].push(session);
  });
  const results = await Promise.all(
    chunks
      .filter((chunk) => chunk.length > 0)
      .map((chunk, index) => parseWorkerChunk(chunk, index, home))
  );
  return results.flat();
}

const targetMb = envInt('CHD_COLD_INGEST_TARGET_MB', 384, 1, 1024);
const targetBytes = targetMb * 1024 * 1024;
const defaultWorkers = Math.max(1, Math.min(4, availableParallelism() - 1));
const workerCount = envInt('CHD_COLD_INGEST_WORKERS', defaultWorkers, 1, 32);
const minSpeedup = Number(process.env.CHD_COLD_INGEST_MIN_SPEEDUP || '2');

console.log('\n=== cold ingest worker prototype (#855) ===\n');
console.log(`Target corpus: ${targetMb} MiB`);
console.log(`Workers: ${workerCount} (bounded by CHD_COLD_INGEST_WORKERS)`);
console.log(`Minimum speedup: ${minSpeedup.toFixed(2)}x\n`);

const fixture = buildLargeFixtureHome(targetBytes);
const dbPath = join(tmpdir(), `chd-cold-ingest-${RUN_ID}.db`);
const originalHome = process.env.HOME;
const originalDbPath = process.env.CHD_DB_PATH;

try {
  process.env.HOME = fixture.home;
  process.env.CHD_DB_PATH = dbPath;
  const ingest = await import(`./ingest.mjs?cold-main=${RUN_ID}`);
  const sessions = ingest
    .listSessions()
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));

  console.log(
    `Corpus: ${sessions.length} sessions, ${(fixture.totalTranscriptBytes / 1024 / 1024).toFixed(1)} MiB transcript JSONL\n`
  );

  const serialStart = hrMs();
  const serialRows = await parseSerial(ingest, sessions);
  const serialMs = hrMs() - serialStart;

  const parallelStart = hrMs();
  const parallelRows = await parseParallel(sessions, workerCount, fixture.home);
  const parallelMs = hrMs() - parallelStart;

  const serialRowJson = JSON.stringify(sortRows(serialRows));
  const parallelRowJson = JSON.stringify(sortRows(parallelRows));
  if (serialRowJson !== parallelRowJson) {
    throw new Error('parallel session rows differ from serial rows');
  }

  const serialDataset = assembleTranscriptDataset(serialRows, ingest.SESSION_SIGNALS);
  const parallelDataset = assembleTranscriptDataset(
    parallelRows,
    ingest.SESSION_SIGNALS
  );
  const serialDatasetJson = JSON.stringify(serialDataset);
  const parallelDatasetJson = JSON.stringify(parallelDataset);
  if (serialDatasetJson !== parallelDatasetJson) {
    throw new Error('parallel transcript-derived dataset differs from serial');
  }

  const speedup = serialMs / parallelMs;
  const summary = {
    corpus: {
      sessions: sessions.length,
      transcriptMiB: +(fixture.totalTranscriptBytes / 1024 / 1024).toFixed(1),
    },
    workers: workerCount,
    serialMs: +serialMs.toFixed(1),
    parallelMs: +parallelMs.toFixed(1),
    speedup: +speedup.toFixed(2),
    rowHash: sha1(JSON.stringify(portableRowsForHash(serialRows))),
    transcriptDatasetHash: sha1(serialDatasetJson),
    sqliteWritePolicy: 'single-writer parent merge; workers return rows only',
  };

  console.log(`Serial read+parse:   ${serialMs.toFixed(1)} ms`);
  console.log(`Worker read+parse:   ${parallelMs.toFixed(1)} ms`);
  console.log(`Speedup:             ${speedup.toFixed(2)}x`);
  console.log(`Row hash:            ${summary.rowHash} (file signatures normalized)`);
  console.log(`Dataset hash:        ${summary.transcriptDatasetHash}`);
  console.log('\nJSON summary:');
  console.log(JSON.stringify(summary, null, 2));

  if (speedup < minSpeedup) {
    throw new Error(
      `speedup ${speedup.toFixed(2)}x is below required ${minSpeedup.toFixed(2)}x`
    );
  }
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDbPath === undefined) delete process.env.CHD_DB_PATH;
  else process.env.CHD_DB_PATH = originalDbPath;
  try {
    rmSync(fixture.home, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
}
