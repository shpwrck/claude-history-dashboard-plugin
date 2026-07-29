// Prototype benchmark for a first-ever empty-cache ingest fan-out (#855).
//
// This intentionally stops before production wiring: workers read + parse
// per-session signal rows, then the parent process merges rows in deterministic
// session_id order. SQLite remains a single-writer concern for the later wiring
// slice. Run with:
//
//   npm run bench:ingest:cold
//
// Tuning (every value is fail-closed — a value that does not parse stops the
// run instead of silently becoming something else; see scripts/lib/env-number.mjs):
//   CHD_COLD_INGEST_TARGET_MB=128       integer, 1..1024
//   CHD_COLD_INGEST_WORKERS=4           integer, 1..32
//   CHD_COLD_INGEST_MIN_SPEEDUP=2       finite, strictly positive
//
// Flags:
//   --measure-only    report the timings and exit 0 without gating on the
//                     speedup threshold. This is the explicit way to take a
//                     measurement; do NOT reach for a threshold value that
//                     happens to be unreachable (see #3076 — the old
//                     "MIN_SPEEDUP=0" recipe worked only because a comparison
//                     against a nonsense threshold is always false, the same
//                     accident that let a real regression exit green).

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { buildSampleCorpus } from './sample-data/build-corpus.mjs';
import { envNumber } from './lib/env-number.mjs';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTER_TS = join(PROJECT_DIR, 'scripts', 'register-ts.mjs');
const RUN_ID = randomUUID();

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
  // The accumulator keys are DERIVED from the signal descriptors, never
  // restated. A hand-written key list is a second copy of SESSION_SIGNALS that
  // rots the moment ingest gains a signal — and it did: `valueFlow` and
  // `secretsAtRest` were added after this bench was last touched (#1373), so
  // `out[signal.datasetKey]` was `undefined` and the benchmark died with
  // "Cannot read properties of undefined (reading 'push')" before it ever
  // reached the speedup comparison. Deriving the keys makes that
  // unrepresentable; the explicit throws below turn the NEXT descriptor change
  // into a named failure instead of a TypeError.
  const dataset = {};
  for (const signal of sessionSignals) {
    if (signal.datasetKey) dataset[signal.datasetKey] = [];
  }
  for (const key of ['permissionRows', 'permissionChanges', 'entries']) {
    dataset[key] ??= [];
  }

  for (const row of sortRows(rows)) {
    for (const signal of sessionSignals) {
      if (signal.aggregate === 'push-truthy') {
        const value =
          signal.parseGuard === 'guarded'
            ? row[signal.column]
              ? JSON.parse(row[signal.column])
              : null
            : JSON.parse(row[signal.column]);
        if (value) dataset[signal.datasetKey].push(value);
      } else if (signal.aggregate === 'spread') {
        for (const value of JSON.parse(row[signal.column]) || []) {
          dataset[signal.datasetKey].push(value);
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
      } else {
        throw new Error(
          `cold ingest bench: unhandled session signal '${signal.id}' (aggregate '${signal.aggregate}') — teach assembleTranscriptDataset about it`
        );
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

const measureOnly = process.argv.includes('--measure-only');
const defaultWorkers = Math.max(1, Math.min(4, availableParallelism() - 1));

// Validate every control BEFORE building the fixture: a 384 MiB corpus is an
// expensive way to discover a typo, and a threshold that does not parse must
// never reach the comparison at the bottom of this file.
let targetMb;
let workerCount;
let minSpeedup;
try {
  targetMb = envNumber('CHD_COLD_INGEST_TARGET_MB', {
    fallback: 384,
    integer: true,
    min: 1,
    max: 1024,
  });
  workerCount = envNumber('CHD_COLD_INGEST_WORKERS', {
    fallback: defaultWorkers,
    integer: true,
    min: 1,
    max: 32,
  });
  minSpeedup = envNumber('CHD_COLD_INGEST_MIN_SPEEDUP', {
    fallback: 2,
    // Number.MIN_VALUE is the smallest positive double, so this means
    // "strictly positive": NaN, Infinity, 0 and negatives are all rejected.
    // A non-positive threshold can never fail, which is a disabled gate
    // wearing a number's clothes — use --measure-only to say that out loud.
    min: Number.MIN_VALUE,
  });
} catch (err) {
  console.error(`\n✗ cold ingest bench ERROR — ${err.message}\n`);
  process.exit(2);
}

const targetBytes = targetMb * 1024 * 1024;

console.log('\n=== cold ingest worker prototype (#855) ===\n');
console.log(`Target corpus: ${targetMb} MiB`);
console.log(`Workers: ${workerCount} (bounded by CHD_COLD_INGEST_WORKERS)`);
console.log(
  `Minimum speedup: ${
    measureOnly ? 'not gated (--measure-only)' : `${minSpeedup.toFixed(2)}x`
  }\n`
);

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
    minSpeedup,
    gated: !measureOnly,
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

  if (!measureOnly && speedup < minSpeedup) {
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
