// Prototype benchmark for a first-ever empty-cache ingest fan-out (#855).
//
// This intentionally stops before production wiring: workers read + parse
// per-session signal rows, then stream bounded row batches back to parent-owned
// fingerprints in deterministic worker-shard order. SQLite remains a
// single-writer concern for the later wiring slice. Run with:
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

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { buildSampleCorpus } from './sample-data/build-corpus.mjs';
import {
  combineColdIngestFingerprints,
  createColdIngestFingerprint,
} from './lib/cold-ingest-fingerprint.mjs';
import { envNumber } from './lib/env-number.mjs';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTER_TS = join(PROJECT_DIR, 'scripts', 'register-ts.mjs');
const RUN_ID = randomUUID();
const ROW_BATCH_SIZE = 32;

function hrMs() {
  const [s, ns] = process.hrtime();
  return s * 1e3 + ns / 1e6;
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

function shardSessions(sessions, workerCount) {
  const chunks = Array.from({ length: workerCount }, () => []);
  sessions.forEach((session, index) => {
    chunks[index % workerCount].push(session);
  });
  return chunks.filter((chunk) => chunk.length > 0);
}

async function parseSerial(ingest, chunks) {
  const fingerprints = [];
  for (const chunk of chunks) {
    const fingerprint = createColdIngestFingerprint(ingest.SESSION_SIGNALS);
    for (const session of chunk) {
      const sig = ingest.sessionFileSignature(session);
      fingerprint.addRow(
        ingest.parseSessionBlobRowFromDisk(session, sig).byColumn
      );
    }
    fingerprints.push(fingerprint.finish());
  }
  return fingerprints;
}

function parseWorkerChunk(chunk, workerId, home, sessionSignals) {
  return new Promise((resolve, reject) => {
    const fingerprint = createColdIngestFingerprint(sessionSignals);
    let expectedSequence = 0;
    let receivedRows = 0;
    let settled = false;
    const worker = new Worker(new URL('./cold-ingest-worker.mjs', import.meta.url), {
      workerData: {
        sessions: chunk,
        workerId,
        rowBatchSize: ROW_BATCH_SIZE,
      },
      execArgv: ['--import', REGISTER_TS],
      env: {
        ...process.env,
        HOME: home,
        CHD_DB_PATH: ':memory:',
      },
    });

    function fail(error) {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(error instanceof Error ? error : new Error(String(error)));
    }

    worker.on('message', (message) => {
      if (settled) return;
      try {
        if (message?.ok === false) {
          throw new Error(message.error || 'cold ingest worker failed');
        }
        if (message?.type === 'rows') {
          if (
            message.workerId !== workerId ||
            message.sequence !== expectedSequence ||
            !Array.isArray(message.rows) ||
            message.rows.length < 1 ||
            message.rows.length > ROW_BATCH_SIZE
          ) {
            throw new Error(
              `cold ingest worker ${workerId}: invalid row batch ${JSON.stringify({
                workerId: message?.workerId,
                sequence: message?.sequence,
                rows: message?.rows?.length,
              })}`
            );
          }
          for (const row of message.rows) fingerprint.addRow(row);
          receivedRows += message.rows.length;
          expectedSequence += 1;
          // The worker parses no more rows until this acknowledgement arrives,
          // bounding transport to one ROW_BATCH_SIZE payload per worker while
          // preserving the parent-side merge/future SQLite-writer seam.
          worker.postMessage({ type: 'ack', sequence: message.sequence });
          return;
        }
        if (message?.type === 'done') {
          if (
            message.workerId !== workerId ||
            message.batches !== expectedSequence ||
            message.rows !== receivedRows ||
            receivedRows !== chunk.length
          ) {
            throw new Error(
              `cold ingest worker ${workerId}: incomplete row stream (${receivedRows}/${chunk.length})`
            );
          }
          settled = true;
          resolve(fingerprint.finish());
          return;
        }
        throw new Error(`cold ingest worker ${workerId}: invalid protocol message`);
      } catch (err) {
        fail(err);
      }
    });
    worker.once('error', fail);
    worker.once('exit', (code) => {
      if (!settled) {
        fail(
          new Error(
            code === 0
              ? `cold ingest worker ${workerId} exited before completing its row stream`
              : `cold ingest worker ${workerId} exited ${code}`
          )
        );
      }
    });
  });
}

async function parseParallel(chunks, home, sessionSignals) {
  return Promise.all(
    chunks.map((chunk, index) =>
      parseWorkerChunk(chunk, index, home, sessionSignals)
    )
  );
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
  const chunks = shardSessions(sessions, workerCount);

  console.log(
    `Corpus: ${sessions.length} sessions, ${(fixture.totalTranscriptBytes / 1024 / 1024).toFixed(1)} MiB transcript JSONL\n`
  );

  const serialStart = hrMs();
  const serialFingerprints = await parseSerial(ingest, chunks);
  const serialMs = hrMs() - serialStart;

  const parallelStart = hrMs();
  const parallelFingerprints = await parseParallel(
    chunks,
    fixture.home,
    ingest.SESSION_SIGNALS
  );
  const parallelMs = hrMs() - parallelStart;

  if (JSON.stringify(serialFingerprints) !== JSON.stringify(parallelFingerprints)) {
    throw new Error(
      'parallel session rows or transcript-derived datasets differ from serial'
    );
  }

  const speedup = serialMs / parallelMs;
  const equivalence = combineColdIngestFingerprints(serialFingerprints);
  const parallelEquivalence = combineColdIngestFingerprints(
    parallelFingerprints
  );
  if (equivalence.rows !== sessions.length) {
    throw new Error(
      `fingerprinted ${equivalence.rows} rows for ${sessions.length} sessions`
    );
  }
  if (parallelEquivalence.rows !== sessions.length) {
    throw new Error(
      `parent consumed ${parallelEquivalence.rows} worker rows for ${sessions.length} sessions`
    );
  }
  const peakRssMiB = +(process.resourceUsage().maxRSS / 1024).toFixed(1);
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
    rowHash: equivalence.rowHash,
    transcriptDatasetHash: equivalence.transcriptDatasetHash,
    peakRssMiB,
    rowBatchSize: ROW_BATCH_SIZE,
    parentConsumedRows: parallelEquivalence.rows,
    memoryPolicy:
      'one acknowledged bounded row batch per worker; parent fingerprints rows incrementally',
    sqliteWritePolicy:
      'single-writer parent consumes every parsed row; workers never write SQLite',
  };

  console.log(`Serial read+parse:   ${serialMs.toFixed(1)} ms`);
  console.log(`Worker read+parse:   ${parallelMs.toFixed(1)} ms`);
  console.log(`Speedup:             ${speedup.toFixed(2)}x`);
  console.log(`Row hash:            ${summary.rowHash} (file signatures normalized)`);
  console.log(`Dataset hash:        ${summary.transcriptDatasetHash}`);
  console.log(`Peak RSS:            ${summary.peakRssMiB.toFixed(1)} MiB`);
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
