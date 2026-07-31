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
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, stat, access } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cacheDir,
  readPid,
  readPort,
  readIdentity,
  isRunning,
  freePort,
  ensureCacheDir,
  processIdentity,
  groupContainsNonce,
  verifyStopTarget,
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
// #3095: launch-identity binding — stale/replaced PID state must never let
// `stop` signal an unrelated process group, while a genuinely launched
// process with matching identity is still terminated.
// ---------------------------------------------------------------------------

const CLI = fileURLToPath(new URL('./plugin-ctl.mjs', import.meta.url));

// Spawning the real CLI trips plugin-ctl's own preflight (`Node.js >= 24 is
// required`, exit 1) before any stop logic runs, so end-to-end CLI checks can
// only run on Node >= 24. Mirror the `platform === 'linux'` skip pattern: on
// older runtimes they skip with a message, while the import-based
// verifyStopTarget/processIdentity/groupContainsNonce checks below still
// exercise the #3095 verify/refuse logic on every Node version.
const CLI_SPAWN_OK = Number(process.versions.node.split('.')[0]) >= 24;

/** `check`, but skipped (with a message) where the CLI preflight would exit 1. */
async function checkCli(label, fn) {
  if (!CLI_SPAWN_OK) {
    console.log(
      `  skip ${label} (CLI spawn needs Node >= 24; running ${process.versions.node})`
    );
    return;
  }
  return check(label, fn);
}

/** Run the real CLI against a given cache dir. */
function runCli(args, dir) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CHD_CACHE_DIR: dir },
  });
}

/** Spawn a detached, group-leading node process that idles until signaled. */
function spawnDetachedDummy(extraEnv = {}, script = 'setInterval(() => {}, 1000)') {
  const child = spawn(process.execPath, ['-e', script], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...extraEnv },
  });
  child.unref();
  return child;
}

async function waitUntil(cond, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

async function fileGone(path) {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

await check('processIdentity is stable for a live process and null for a dead pid', () => {
  const a = processIdentity(process.pid);
  const b = processIdentity(process.pid);
  assert.notEqual(a, null, 'current process identity must be readable');
  assert.equal(a, b, 'identity must be stable across reads');
  assert.equal(processIdentity(99999999), null, 'a dead pid has no identity');
  assert.equal(processIdentity(1), null, 'pid <= 1 is never identified');
});

await check('readIdentity round-trips a valid record and rejects malformed ones', async () => {
  const dir = useCacheDir();
  await ensureCacheDir();
  const file = join(dir, 'plugin-ctl.identity.json');
  const record = { pid: 4242, nonce: 'nonce-0123456789', identity: 'linux:1:abc' };
  await writeFile(file, JSON.stringify(record), 'utf8');
  assert.deepEqual(await readIdentity(), record);
  await writeFile(file, JSON.stringify({ pid: 4242, nonce: 'short', identity: null }), 'utf8');
  assert.equal(await readIdentity(), null, 'a too-short nonce is rejected');
  await writeFile(file, JSON.stringify({ pid: 1, nonce: 'nonce-0123456789', identity: null }), 'utf8');
  assert.equal(await readIdentity(), null, 'pid <= 1 is rejected');
  await writeFile(file, 'not json', 'utf8');
  assert.equal(await readIdentity(), null, 'malformed JSON is rejected');
});

// --- verifyStopTarget: the verify/refuse decision, by import (all Node versions) ---

await check('verifyStopTarget refuses legacy state with no identity record', () => {
  const verdict = verifyStopTarget(process.pid, null);
  assert.equal(verdict.verified, false);
  assert.match(verdict.refusal, /no launch identity/);
});

await check('verifyStopTarget refuses a record whose pid does not match', () => {
  const verdict = verifyStopTarget(process.pid, {
    pid: process.pid + 1,
    nonce: 'nonce-0123456789',
    identity: processIdentity(process.pid),
  });
  assert.equal(verdict.verified, false);
  assert.match(verdict.refusal, /no launch identity/);
});

await check('verifyStopTarget refuses a live pid on identity mismatch', () => {
  const verdict = verifyStopTarget(process.pid, {
    pid: process.pid,
    nonce: 'nonce-0123456789',
    identity: 'linux:1:not-this-process',
  });
  assert.equal(verdict.verified, false);
  assert.match(verdict.refusal, /identity mismatch/);
});

await check('verifyStopTarget refuses a crafted null identity when one is readable', () => {
  // identity:null must not verify a live pid on any platform where
  // processIdentity works — a tampered record cannot dodge the comparison.
  if (processIdentity(process.pid) === null) return; // exotic platform: n/a
  const verdict = verifyStopTarget(process.pid, {
    pid: process.pid,
    nonce: 'nonce-0123456789',
    identity: null,
  });
  assert.equal(verdict.verified, false);
  assert.match(verdict.refusal, /identity mismatch/);
});

await check('verifyStopTarget verifies a live pid whose recorded identity matches', () => {
  const identity = processIdentity(process.pid);
  assert.notEqual(identity, null, 'current process identity must be readable');
  const verdict = verifyStopTarget(process.pid, {
    pid: process.pid,
    nonce: 'nonce-0123456789',
    identity,
  });
  assert.equal(verdict.verified, true);
});

await check('verifyStopTarget refuses a dead leader whose group lacks the nonce', () => {
  // Leader dead, no group member carries the nonce (linux) or membership is
  // uncheckable (elsewhere): both must refuse rather than blind-fire.
  const verdict = verifyStopTarget(99999999, {
    pid: 99999999,
    nonce: 'nonce-definitely-not-present-anywhere',
    identity: 'linux:1:gone',
  });
  assert.equal(verdict.verified, false);
});

await checkCli('stop refuses to signal a live unrelated process on identity mismatch', async () => {
  const dir = useCacheDir();
  await ensureCacheDir();
  const dummy = spawnDetachedDummy();
  try {
    assert.ok(await waitUntil(() => isRunning(dummy.pid)), 'dummy must be running');
    await writeFile(join(dir, 'plugin-ctl.pid'), String(dummy.pid), 'utf8');
    await writeFile(join(dir, 'plugin-ctl.port'), '5199', 'utf8');
    // The recorded identity is NOT the dummy's — this is the pid-reuse /
    // tampered-state shape.
    await writeFile(
      join(dir, 'plugin-ctl.identity.json'),
      JSON.stringify({ pid: dummy.pid, nonce: 'nonce-0123456789', identity: 'linux:1:not-the-dummy' }),
      'utf8'
    );

    const res = runCli(['stop'], dir);

    assert.equal(res.status, 1, `stop must refuse (stderr: ${res.stderr})`);
    assert.match(res.stderr, /refusing to signal/);
    assert.equal(isRunning(dummy.pid), true, 'the unrelated process must be untouched');
    assert.ok(await fileGone(join(dir, 'plugin-ctl.pid')), 'stale pid state must be removed');
    assert.ok(await fileGone(join(dir, 'plugin-ctl.identity.json')), 'stale identity state must be removed');
  } finally {
    killGroup(dummy.pid);
  }
});

await checkCli('stop refuses a bare legacy pid file pointing at a live process', async () => {
  const dir = useCacheDir();
  await ensureCacheDir();
  const dummy = spawnDetachedDummy();
  try {
    assert.ok(await waitUntil(() => isRunning(dummy.pid)), 'dummy must be running');
    await writeFile(join(dir, 'plugin-ctl.pid'), String(dummy.pid), 'utf8');

    const res = runCli(['stop'], dir);

    assert.equal(res.status, 1, `stop must refuse (stderr: ${res.stderr})`);
    assert.match(res.stderr, /no launch identity/);
    assert.equal(isRunning(dummy.pid), true, 'the process must be untouched');
    assert.ok(await fileGone(join(dir, 'plugin-ctl.pid')), 'stale pid state must be removed');
  } finally {
    killGroup(dummy.pid);
  }
});

await checkCli('stop still terminates a launch with matching recorded identity', async () => {
  const dir = useCacheDir();
  await ensureCacheDir();
  const dummy = spawnDetachedDummy();
  try {
    assert.ok(await waitUntil(() => isRunning(dummy.pid)), 'dummy must be running');
    const identity = processIdentity(dummy.pid);
    assert.notEqual(identity, null, 'identity of our own spawn must be readable');
    await writeFile(join(dir, 'plugin-ctl.pid'), String(dummy.pid), 'utf8');
    await writeFile(join(dir, 'plugin-ctl.port'), '5199', 'utf8');
    await writeFile(
      join(dir, 'plugin-ctl.identity.json'),
      JSON.stringify({ pid: dummy.pid, nonce: 'nonce-0123456789', identity }),
      'utf8'
    );

    const res = runCli(['stop'], dir);

    assert.equal(res.status, 0, `stop must succeed (stderr: ${res.stderr})`);
    assert.match(res.stdout, /Dashboard stopped/);
    assert.ok(await waitUntil(() => !isRunning(dummy.pid)), 'the launched process must be terminated');
    assert.ok(await fileGone(join(dir, 'plugin-ctl.pid')), 'state must be cleaned up');
  } finally {
    killGroup(dummy.pid);
  }
});

if (process.platform === 'linux') {
  await check('groupContainsNonce finds our nonce and rejects a foreign one (linux)', async () => {
    const nonce = 'nonce-3095-abcdef';
    const dummy = spawnDetachedDummy({ CHD_LAUNCH_NONCE: nonce });
    try {
      assert.ok(await waitUntil(() => isRunning(dummy.pid)), 'dummy must be running');
      assert.equal(groupContainsNonce(dummy.pid, nonce), true, 'own nonce must verify');
      assert.equal(groupContainsNonce(dummy.pid, 'nonce-some-other-launch'), false, 'foreign nonce must not verify');
    } finally {
      killGroup(dummy.pid);
    }
  });

  // The leader spawns a same-group grandchild and lets its own event loop
  // drain (the grandchild handle is unref'd), so the leader pid dies while
  // the group lives on — the descendant-outlives-leader shape.
  const orphanScript =
    "const{spawn}=require('node:child_process');" +
    "spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{stdio:'ignore'}).unref();" +
    'setTimeout(() => {}, 300);';

  await checkCli('stop reaps an orphaned descendant group that carries our nonce (linux)', async () => {
    const dir = useCacheDir();
    await ensureCacheDir();
    const nonce = 'nonce-3095-orphan-ok';
    // Leader spawns a same-group grandchild, then exits: leader pid dead,
    // group alive — the descendant-outlives-leader shape.
    const leader = spawnDetachedDummy({ CHD_LAUNCH_NONCE: nonce }, orphanScript);
    try {
      assert.ok(
        await waitUntil(() => !isRunning(leader.pid) && isRunning(-leader.pid)),
        'leader must exit while its group stays alive'
      );
      await writeFile(join(dir, 'plugin-ctl.pid'), String(leader.pid), 'utf8');
      await writeFile(
        join(dir, 'plugin-ctl.identity.json'),
        JSON.stringify({ pid: leader.pid, nonce, identity: 'linux:gone:leader' }),
        'utf8'
      );

      const res = runCli(['stop'], dir);

      assert.equal(res.status, 0, `stop must reap the verified group (stderr: ${res.stderr})`);
      assert.ok(await waitUntil(() => !isRunning(-leader.pid)), 'the orphaned group must be terminated');
    } finally {
      killGroup(leader.pid);
    }
  });

  await checkCli('stop refuses an orphaned group that does NOT carry our nonce (linux)', async () => {
    const dir = useCacheDir();
    await ensureCacheDir();
    // The group exists but was launched with a DIFFERENT (or no) nonce: the
    // group-id-reuse / tampered-state shape.
    const leader = spawnDetachedDummy({}, orphanScript);
    try {
      assert.ok(
        await waitUntil(() => !isRunning(leader.pid) && isRunning(-leader.pid)),
        'leader must exit while its group stays alive'
      );
      await writeFile(join(dir, 'plugin-ctl.pid'), String(leader.pid), 'utf8');
      await writeFile(
        join(dir, 'plugin-ctl.identity.json'),
        JSON.stringify({ pid: leader.pid, nonce: 'nonce-3095-not-that-group', identity: 'linux:gone:leader' }),
        'utf8'
      );

      const res = runCli(['stop'], dir);

      assert.equal(res.status, 1, `stop must refuse (stderr: ${res.stderr})`);
      assert.match(res.stderr, /refusing to signal/);
      assert.equal(isRunning(-leader.pid), true, 'the unrelated group must be untouched');
    } finally {
      killGroup(leader.pid);
    }
  });
}

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
