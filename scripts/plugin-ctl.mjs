#!/usr/bin/env node
// Cross-platform supervisor for the Claude History Dashboard plugin server.
//
// Usage:
//   node scripts/plugin-ctl.mjs start   -- boot detached server (idempotent)
//   node scripts/plugin-ctl.mjs stop    -- terminate running server
//   node scripts/plugin-ctl.mjs status  -- report whether server is running
//
// State files (PID + port) land in CHD_CACHE_DIR (default ~/.claude/.cache/chd/).
// The server always binds 127.0.0.1; HOST overrides the bind address.
// Logs go to CHD_CACHE_DIR/plugin-ctl.log.
//
// Constraints:
//   - Zero npm imports -- pure Node built-ins only (this file must never pull
//     node_modules so it is safe to run from the plugin install dir without npm ci).
//   - Node >= 24 required (native TS strip + node:sqlite used by server.mjs).
//   - Cross-platform: Windows/Mac/Linux (no systemd, no bash).
//
// Implementation notes on detached spawn:
//   child_process.spawn(..., { detached: true, windowsHide: true }).unref()
//   On Unix the child is put in its own process group so it outlives this process.
//   On Windows windowsHide prevents a console window; detached creates a new
//   console group. unref() lets this process exit without waiting for the child.

import { createServer as createNetServer } from 'node:net';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import {
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  realpathSync,
  constants as fsConstants,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  pluginCacheDir,
  pluginPortFile,
  preferredDashboardPort,
} from './plugin-runtime-state.mjs';

// ---------------------------------------------------------------------------
// Node >= 24 preflight
// ---------------------------------------------------------------------------
// Runs only when this module is invoked directly (see the entry point below),
// so importing the helpers into a test does not exit the test process.
function preflightNode() {
  const [nodeMajor] = process.versions.node.split('.').map(Number);
  if (nodeMajor < 24) {
    process.stderr.write(
      `plugin-ctl: Node.js >= 24 is required (found ${process.versions.node}).\n` +
        `  The dashboard server uses native TypeScript stripping and node:sqlite,\n` +
        `  both of which require Node 24+. Please upgrade Node.js.\n`
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, '..');

export function cacheDir() {
  return pluginCacheDir(process.env);
}

function pidFile() {
  return join(cacheDir(), 'plugin-ctl.pid');
}

function portFile() {
  return pluginPortFile(process.env);
}

function logFile() {
  return join(cacheDir(), 'plugin-ctl.log');
}

function identityFile() {
  return join(cacheDir(), 'plugin-ctl.identity.json');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read PID from the PID file. Returns null if absent or non-numeric. */
export async function readPid() {
  try {
    const raw = await readFile(pidFile(), 'utf8');
    const n = parseInt(raw.trim(), 10);
    // POSIX kill(-1, signal) targets every process the caller may signal, not
    // process group 1. Never allow corrupted state to reach that special case.
    return Number.isFinite(n) && n > 1 ? n : null;
  } catch {
    return null;
  }
}

/** Read port from the port file. Returns null if absent or non-numeric. */
export async function readPort() {
  try {
    const raw = await readFile(portFile(), 'utf8');
    const n = parseInt(raw.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Launch-identity binding (#3095)
// ---------------------------------------------------------------------------
// A bare PID in a user-writable state file is not proof of ownership: after an
// unclean exit the number can be reused by an unrelated process (or the file
// can simply be edited), and a later `stop` would SIGTERM/SIGKILL whatever
// process group holds that number today. So `start` records, alongside the
// PID, (a) an immutable start-identity signature of the process it actually
// spawned and (b) a random launch nonce placed in the child's environment,
// and `stop` refuses to signal anything whose current identity does not match
// the recorded one. Same-user tampering with the state file is not a privilege
// boundary (that user can already signal processes directly); the point is
// that stale or replaced state can never redirect our signals.

/**
 * Immutable start-identity signature of a live process, or null when it cannot
 * be read (process gone, or no readable identity source on this platform).
 * The signature combines the kernel's process start time — which a PID reuse
 * cannot preserve — with a digest of the process's argv, so it is stable for
 * the lifetime of one process incarnation and different for any other.
 */
export function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // comm (field 2) may contain spaces/parens; fields after the LAST ')'
      // start at field 3, so starttime (field 22) is index 19 there.
      const rparen = stat.lastIndexOf(')');
      if (rparen === -1) return null;
      const fields = stat.slice(rparen + 2).split(' ');
      const starttime = fields[19];
      if (!starttime || !/^[0-9]+$/.test(starttime)) return null;
      const argvDigest = createHash('sha256')
        .update(readFileSync(`/proc/${pid}/cmdline`))
        .digest('hex');
      return `linux:${starttime}:${argvDigest}`;
    } catch {
      return null;
    }
  }
  if (process.platform === 'win32') {
    try {
      const out = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`],
        { encoding: 'utf8', windowsHide: true }
      );
      const ticks = out.status === 0 ? out.stdout.trim() : '';
      return /^[0-9]+$/.test(ticks) ? `win32:${ticks}` : null;
    } catch {
      return null;
    }
  }
  // Other POSIX (macOS, BSDs): ps start time + command line.
  try {
    const lstart = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
    });
    const started = lstart.status === 0 ? lstart.stdout.trim() : '';
    if (!started) return null;
    const cmd = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    });
    const argvDigest = createHash('sha256')
      .update(cmd.status === 0 ? cmd.stdout.trim() : '')
      .digest('hex');
    return `posix:${started}:${argvDigest}`;
  } catch {
    return null;
  }
}

/**
 * Whether any live member of process group `pgid` carries our launch nonce in
 * its environment. Used when the group leader is gone but descendants remain:
 * the leader's identity can no longer be read, but every descendant inherited
 * `CHD_LAUNCH_NONCE` from the spawn, and /proc/<pid>/environ is readable only
 * by the owning user — a protected channel a group-id reuse cannot forge.
 * Returns true/false on Linux, null where group membership cannot be checked.
 */
export function groupContainsNonce(pgid, nonce) {
  if (process.platform !== 'linux') return null;
  if (!Number.isInteger(pgid) || pgid <= 1) return null;
  if (typeof nonce !== 'string' || nonce.length === 0) return null;
  try {
    const needle = `CHD_LAUNCH_NONCE=${nonce}`;
    for (const entry of readdirSync('/proc')) {
      if (!/^[0-9]+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
        const rparen = stat.lastIndexOf(')');
        if (rparen === -1) continue;
        const fields = stat.slice(rparen + 2).split(' ');
        // fields[2] is pgrp (field 5 overall).
        if (parseInt(fields[2], 10) !== pgid) continue;
        const environ = readFileSync(`/proc/${entry}/environ`, 'utf8');
        if (environ.split('\0').includes(needle)) return true;
      } catch {
        // Raced exit or another user's process — not verifiable, skip it.
      }
    }
    return false;
  } catch {
    return null;
  }
}

/**
 * Read the launch-identity record written by `start`. Returns
 * `{ pid, nonce, identity }` or null when absent/malformed — a bare legacy
 * PID file with no identity record is deliberately NOT trusted for signaling.
 */
export async function readIdentity() {
  try {
    const parsed = JSON.parse(await readFile(identityFile(), 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    const { pid, nonce, identity } = parsed;
    if (!Number.isInteger(pid) || pid <= 1) return null;
    if (typeof nonce !== 'string' || nonce.length < 8) return null;
    if (identity !== null && typeof identity !== 'string') return null;
    return { pid, nonce, identity };
  } catch {
    return null;
  }
}

/** Remove every state file `start` writes (pid, port, identity). */
async function removeStateFiles() {
  await rm(pidFile(), { force: true });
  await rm(portFile(), { force: true });
  await rm(identityFile(), { force: true });
}

/**
 * Decide whether the recorded launch identity authorizes signaling `pid`'s
 * managed target (#3095). Pure decision logic — exported so the verify/refuse
 * behaviour stays testable by IMPORT on every Node version (spawning the real
 * CLI trips the Node >= 24 preflight). Returns `{ verified: true }` or
 * `{ verified: false, refusal }`.
 */
export function verifyStopTarget(pid, stored) {
  if (stored === null || stored.pid !== pid) {
    return {
      verified: false,
      refusal:
        'the state files carry no launch identity for this pid (legacy or tampered state)',
    };
  }
  if (isRunning(pid)) {
    const current = processIdentity(pid);
    if (stored.identity !== null && current === stored.identity) {
      return { verified: true };
    }
    if (stored.identity === null && current === null) {
      // Platform where start identity is unreadable end to end: there is
      // nothing to compare, and refusing forever would make stop useless
      // there. The nonce/identity path covers every platform we launch on.
      return { verified: true };
    }
    return {
      verified: false,
      refusal: `pid ${pid} is not the dashboard this supervisor launched (identity mismatch — pid reuse or modified state)`,
    };
  }
  // Leader gone, descendants remain: verify a group member still carries
  // our launch nonce before signaling the whole group.
  const member = groupContainsNonce(pid, stored.nonce);
  if (member === true) {
    return { verified: true };
  }
  return {
    verified: false,
    refusal:
      member === false
        ? `no member of process group ${pid} carries this launch's nonce (group-id reuse or modified state)`
        : `process group ${pid} cannot be identity-checked on this platform`,
  };
}

/**
 * Check whether a PID corresponds to a running process.
 * Uses process.kill(pid, 0) -- signal 0 tests reachability without sending a
 * real signal. Works on Unix and Windows (Node translates it to OpenProcess).
 */
export function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it (still running).
    // ESRCH means no such process.
    return err.code === 'EPERM';
  }
}

/**
 * Detached children own a process group on POSIX, so lifecycle signals must
 * target the group rather than only its leader. Windows does not support
 * negative process-group PIDs through process.kill().
 */
function managedTarget(pid) {
  return process.platform === 'win32' ? pid : -pid;
}

function isManagedTargetRunning(pid) {
  return isRunning(managedTarget(pid));
}

function signalManagedTarget(pid, signal) {
  process.kill(managedTarget(pid), signal);
}

/** Find a free TCP port by letting the OS pick one on 127.0.0.1. */
export async function freePort(preferredPort) {
  // Try the preferred port first (allows a stable default).
  if (preferredPort) {
    const available = await new Promise((resolve) => {
      const s = createNetServer();
      s.once('error', () => resolve(false));
      s.listen(preferredPort, '127.0.0.1', () => {
        s.close(() => resolve(true));
      });
    });
    if (available) return preferredPort;
  }
  // Fall back to OS-assigned port.
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = /** @type {import('node:net').AddressInfo} */ (s.address());
      s.close(() => resolve(addr.port));
    });
  });
}

/** Ensure the cache directory exists. */
export async function ensureCacheDir() {
  await mkdir(cacheDir(), { recursive: true });
}

/** Open (or create) the log file and return file descriptors [out, err]. */
async function openLogFds() {
  const log = logFile();
  await ensureCacheDir();
  // O_CREAT | O_WRONLY | O_APPEND
  const flags = fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_APPEND;
  const fd = openSync(log, flags, 0o644);
  return [fd, fd]; // both stdout and stderr go to the same log file
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdStart() {
  await ensureCacheDir();

  // Check for an already-running instance.
  const existingPid = await readPid();
  if (existingPid !== null && isRunning(existingPid)) {
    // #3095: a live process holding that number is only "already running"
    // when it is provably the one we launched. On a verified identity
    // MISMATCH the number was reused by an unrelated process — never signal
    // it, just drop the stale state and boot fresh. Legacy state with no
    // identity record (or a platform where identity is unreadable end to
    // end) keeps the conservative already-running answer: start sends no
    // signal, so assuming "running" is the safe direction here.
    const stored = await readIdentity();
    const current = processIdentity(existingPid);
    const mismatch =
      stored === null
        ? false
        : stored.pid !== existingPid ||
          (stored.identity === null ? current !== null : current !== stored.identity);
    if (!mismatch) {
      const port = await readPort();
      const host = process.env.HOST || '127.0.0.1';
      const url = `http://${host}:${port}`;
      process.stdout.write(`Dashboard already running (pid ${existingPid})\n`);
      process.stdout.write(`  ${url}\n`);
      return;
    }
    process.stdout.write(
      `plugin-ctl: pid ${existingPid} is no longer the dashboard this supervisor launched ` +
        `(pid reuse); discarding stale state.\n`
    );
    await removeStateFiles();
  } else if (existingPid !== null && isManagedTargetRunning(existingPid)) {
    // A detached descendant can outlive the server leader on POSIX. Keep the
    // group id in the state file so `stop` can still reap it instead of
    // silently abandoning that group and starting a second server.
    process.stderr.write(
      `plugin-ctl: dashboard pid ${existingPid} exited but its process group is still active.\n` +
        `  Run \`node scripts/plugin-ctl.mjs stop\` before starting again.\n`
    );
    process.exitCode = 1;
    return;
  } else if (existingPid !== null) {
    // Clean up stale state files from a dead process.
    await removeStateFiles();
  }

  const host = process.env.HOST || '127.0.0.1';
  const port = await freePort(preferredDashboardPort(process.env));

  const [outFd, errFd] = await openLogFds();

  const serverScript = join(PROJECT_DIR, 'scripts', 'server.mjs');
  const registerScript = join(PROJECT_DIR, 'scripts', 'register-ts.mjs');

  // Random launch nonce (#3095): inherited by every descendant of this spawn,
  // it lets `stop` verify group membership through /proc/<pid>/environ (a
  // channel only the owning user can read) when the leader is already gone.
  const nonce = randomUUID();

  const child = spawn(
    process.execPath,
    ['--import', registerScript, serverScript],
    {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
      env: {
        ...process.env,
        HOST: host,
        PORT: String(port),
        // Ensure the cache dir is forwarded so the child respects it too.
        CHD_CACHE_DIR: cacheDir(),
        CHD_LAUNCH_NONCE: nonce,
      },
      cwd: PROJECT_DIR,
    }
  );

  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch (err) {
    closeSync(outFd);
    process.stderr.write(`plugin-ctl: failed to start dashboard: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  // Close the fds in the parent -- the child inherits them.
  closeSync(outFd);

  child.unref();

  // Write state files before printing so callers can race-read them. The
  // identity record lands FIRST so a pid file never exists without the
  // identity `stop` requires before it will signal anything (#3095). The
  // signature is captured from the child we just spawned — at this instant the
  // number provably names our process, so the recorded identity is authentic.
  await writeFile(
    identityFile(),
    JSON.stringify({ pid: child.pid, nonce, identity: processIdentity(child.pid) }),
    'utf8'
  );
  await writeFile(pidFile(), String(child.pid), 'utf8');
  await writeFile(portFile(), String(port), 'utf8');

  const url = `http://${host}:${port}`;
  process.stdout.write(`Dashboard started (pid ${child.pid})\n`);
  process.stdout.write(`  ${url}\n`);
  process.stdout.write(`  Logs: ${logFile()}\n`);
}

async function cmdStop() {
  const pid = await readPid();
  if (pid === null) {
    process.stdout.write('Dashboard is not running (no pid file).\n');
    return;
  }
  if (!isManagedTargetRunning(pid)) {
    process.stdout.write(`Dashboard (pid ${pid}) is already gone.\n`);
    await removeStateFiles();
    return;
  }

  // #3095: something live answers to that number — prove it is the process
  // (group) we launched before sending any signal. A stale or edited state
  // file must never redirect SIGTERM/SIGKILL at an unrelated process group.
  const verdict = verifyStopTarget(pid, await readIdentity());

  if (!verdict.verified) {
    await removeStateFiles();
    process.stderr.write(
      `plugin-ctl: refusing to signal pid/group ${pid}: ${verdict.refusal}.\n` +
        `  Removed the stale state without sending any signal. If a dashboard is\n` +
        `  really running, locate it with your process tools and stop it manually.\n`
    );
    process.exitCode = 1;
    return;
  }

  try {
    signalManagedTarget(pid, 'SIGTERM');
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }

  // Windows implements SIGTERM as TerminateProcess rather than a graceful
  // signal, but termination can still complete asynchronously while I/O drains.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isManagedTargetRunning(pid)) {
    await new Promise((r) => setTimeout(r, 100));
  }

  if (isManagedTargetRunning(pid)) {
    if (process.platform === 'win32') {
      process.stderr.write(`plugin-ctl: dashboard pid ${pid} did not finish terminating.\n`);
      process.exitCode = 1;
      return;
    }

    // POSIX SIGTERM is graceful; force-kill any remaining children and leader.
    try {
      signalManagedTarget(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }

  await removeStateFiles();
  process.stdout.write(`Dashboard stopped (pid ${pid}).\n`);
}

async function cmdStatus() {
  const pid = await readPid();
  if (pid === null) {
    process.stdout.write('stopped (no pid file)\n');
    return;
  }
  if (!isRunning(pid)) {
    if (isManagedTargetRunning(pid)) {
      process.stdout.write(
        `stopped (pid ${pid} not found; descendant process remains -- run stop to clean up)\n`
      );
      return;
    }
    process.stdout.write(`stopped (pid ${pid} not found; stale pid file)\n`);
    await removeStateFiles();
    return;
  }
  const port = await readPort();
  const host = process.env.HOST || '127.0.0.1';
  const url = port ? `http://${host}:${port}` : '(port unknown)';
  process.stdout.write(`running  pid=${pid}  ${url}\n`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
// Only run the preflight + command dispatcher when this file is executed
// directly (`node plugin-ctl.mjs …`). When it is imported — e.g. by
// plugin-ctl.test.mjs to exercise the real helpers — none of this runs, so the
// import has no side effects and does not consume process.argv.
const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) {
  preflightNode();

  const [, , command] = process.argv;
  switch (command) {
    case 'start':
      await cmdStart();
      break;
    case 'stop':
      await cmdStop();
      break;
    case 'status':
      await cmdStatus();
      break;
    default:
      process.stderr.write(
        `plugin-ctl: unknown command "${command ?? ''}".\n` +
          `  Usage: node plugin-ctl.mjs start|stop|status\n`
      );
      process.exit(1);
  }
}
