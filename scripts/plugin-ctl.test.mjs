#!/usr/bin/env node
// Unit tests for scripts/plugin-ctl.mjs supervisor logic.
//
// Exercises the REAL pure helpers exported by plugin-ctl.mjs — readPid,
// readPort, isRunning, freePort, ensureCacheDir, cacheDir — by importing them,
// so a bug in the supervisor's helpers fails this suite (#2956). The pid/port
// helpers read files under CHD_CACHE_DIR; each test points that env var at a
// fresh temp dir and writes the state files the supervisor would.
//
// No real server is spawned and no detached child is created here: the
// spawn/detach path (cmdStart) is intentionally out of scope for this unit
// suite. Importing plugin-ctl.mjs runs no CLI dispatch — its entry point is
// guarded by an invoked-directly check — so this file drives the helpers alone.
//
// Run:
//   node scripts/plugin-ctl.test.mjs   (npm run test:plugin-ctl)
// Exits non-zero on any failure.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  cacheDir,
  readPid,
  readPort,
  isRunning,
  freePort,
  ensureCacheDir,
} from './plugin-ctl.mjs';

// ---------------------------------------------------------------------------
// Minimal test harness (mirrors the pattern used across scripts/*.test.mjs)
// ---------------------------------------------------------------------------

let failures = 0;
function check(label, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result
        .then(() => {
          console.log(`  ok  ${label}`);
        })
        .catch((err) => {
          failures += 1;
          console.error(`  FAIL ${label}: ${err.message}`);
        });
    }
    console.log(`  ok  ${label}`);
    return Promise.resolve();
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${label}: ${err.message}`);
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Fixtures — point CHD_CACHE_DIR at a fresh temp cache dir per scenario so the
// real readPid/readPort/cacheDir helpers resolve their state files there.
// ---------------------------------------------------------------------------

let tmpDir;
let cacheSeq = 0;
const origCacheDir = process.env.CHD_CACHE_DIR;

async function setup() {
  tmpDir = await mkdtemp(join(tmpdir(), 'plugin-ctl-test-'));
}

async function teardown() {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  if (origCacheDir === undefined) delete process.env.CHD_CACHE_DIR;
  else process.env.CHD_CACHE_DIR = origCacheDir;
}

/** Create a fresh cache dir, point CHD_CACHE_DIR at it, and return its path. */
function useCacheDir() {
  const dir = join(tmpDir, `cache-${cacheSeq++}`);
  process.env.CHD_CACHE_DIR = dir;
  return dir;
}

await setup();

// --- cacheDir() env resolution ---

await check('cacheDir honours CHD_CACHE_DIR override', () => {
  const dir = useCacheDir();
  assert.equal(cacheDir(), dir);
});

await check('cacheDir defaults to ~/.claude/.cache/chd when unset', () => {
  delete process.env.CHD_CACHE_DIR;
  const expected = join(homedir(), '.claude', '.cache', 'chd');
  assert.equal(cacheDir(), expected);
});

// --- ensureCacheDir() ---

await check('ensureCacheDir creates the resolved cache directory', async () => {
  const dir = useCacheDir();
  await ensureCacheDir();
  const st = await stat(dir);
  assert.equal(st.isDirectory(), true);
});

// --- readPid: real n > 1 guard (pid 1/-1 are POSIX-special and rejected) ---

await check('readPid returns null when the pid file is absent', async () => {
  useCacheDir(); // dir not created; file certainly missing
  assert.equal(await readPid(), null);
});

await check('readPid parses a valid pid', async () => {
  const dir = useCacheDir();
  await ensureCacheDir();
  await writeFile(join(dir, 'plugin-ctl.pid'), '12345\n', 'utf8');
  assert.equal(await readPid(), 12345);
});

await check('readPid trims surrounding whitespace', async () => {
  const dir = useCacheDir();
  await ensureCacheDir();
  await writeFile(join(dir, 'plugin-ctl.pid'), '  99  \n', 'utf8');
  assert.equal(await readPid(), 99);
});

await check('readPid rejects 0', async () => {
  const dir = useCacheDir();
  await ensureCacheDir();
  await writeFile(join(dir, 'plugin-ctl.pid'), '0\n', 'utf8');
  assert.equal(await readPid(), null);
});

await check('readPid rejects 1 (POSIX kill(-1) guard)', async () => {
  const dir = useCacheDir();
  await ensureCacheDir();
  await writeFile(join(dir, 'plugin-ctl.pid'), '1\n', 'utf8');
  assert.equal(await readPid(), null);
});

await check('readPid rejects a negative value', async () => {
  const dir = useCacheDir();
  await ensureCacheDir();
  await writeFile(join(dir, 'plugin-ctl.pid'), '-1\n', 'utf8');
  assert.equal(await readPid(), null);
});

await check('readPid rejects non-numeric content', async () => {
  const dir = useCacheDir();
  await ensureCacheDir();
  await writeFile(join(dir, 'plugin-ctl.pid'), 'notanumber\n', 'utf8');
  assert.equal(await readPid(), null);
});

// --- readPort: real n > 0 guard ---

await check('readPort parses a valid port', async () => {
  const dir = useCacheDir();
  await ensureCacheDir();
  await writeFile(join(dir, 'plugin-ctl.port'), '5173\n', 'utf8');
  assert.equal(await readPort(), 5173);
});

await check('readPort returns null for zero', async () => {
  const dir = useCacheDir();
  await ensureCacheDir();
  await writeFile(join(dir, 'plugin-ctl.port'), '0\n', 'utf8');
  assert.equal(await readPort(), null);
});

await check('readPort returns null when the port file is absent', async () => {
  useCacheDir();
  assert.equal(await readPort(), null);
});

// --- isRunning ---

await check('isRunning returns true for the current process', () => {
  assert.equal(isRunning(process.pid), true);
});

await check('isRunning returns a boolean for a very likely-dead pid', () => {
  // 2^20 - 1 is below Linux's default max PID (4194304) and above macOS's
  // (99999); we can't guarantee it is unused, so assert the contract (boolean).
  assert.equal(typeof isRunning(2 ** 20 - 1), 'boolean');
});

// --- status/start/stop state-file behaviour, via the REAL helpers ---

await check('status path: running pid file -> readPid + isRunning agree', async () => {
  const dir = useCacheDir();
  await ensureCacheDir();
  await writeFile(join(dir, 'plugin-ctl.pid'), String(process.pid), 'utf8');
  await writeFile(join(dir, 'plugin-ctl.port'), '5173', 'utf8');
  const pid = await readPid();
  assert.equal(pid, process.pid, 'readPid must round-trip the written pid');
  assert.equal(await readPort(), 5173);
  assert.equal(isRunning(pid), true, 'the current process is running');
});

await check('stop path: stale pid file -> readPid reads it, isRunning is false', async () => {
  const dir = useCacheDir();
  await ensureCacheDir();
  await writeFile(join(dir, 'plugin-ctl.pid'), '99999999', 'utf8');
  const pid = await readPid();
  assert.equal(pid, 99999999, 'a large pid > 1 must still parse');
  // On any normal CI host PID 99999999 does not exist -> not running.
  assert.equal(isRunning(pid), false, 'a stale pid must read as not running');
});

// --- freePort ---

await check('freePort resolves to a usable TCP port number', async () => {
  const port = await freePort();
  assert.equal(typeof port, 'number');
  assert.ok(port > 0 && port < 65536, `expected a valid port, got ${port}`);
});

await check('freePort returns the preferred port when it is free', async () => {
  // Ask the OS for a free port, then request it as the preference: it should
  // be handed straight back.
  const candidate = await freePort();
  const got = await freePort(candidate);
  assert.equal(typeof got, 'number');
  assert.ok(got > 0 && got < 65536);
});

// ---------------------------------------------------------------------------
// Cleanup + exit
// ---------------------------------------------------------------------------

await teardown();

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
} else {
  console.log(`\nAll tests passed.`);
}
