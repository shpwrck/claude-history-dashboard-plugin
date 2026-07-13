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
import { openSync, closeSync, constants as fsConstants } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  pluginCacheDir,
  pluginPortFile,
  preferredDashboardPort,
} from './plugin-runtime-state.mjs';

// ---------------------------------------------------------------------------
// Node >= 24 preflight
// ---------------------------------------------------------------------------
const [nodeMajor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 24) {
  process.stderr.write(
    `plugin-ctl: Node.js >= 24 is required (found ${process.versions.node}).\n` +
      `  The dashboard server uses native TypeScript stripping and node:sqlite,\n` +
      `  both of which require Node 24+. Please upgrade Node.js.\n`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, '..');

function cacheDir() {
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read PID from the PID file. Returns null if absent or non-numeric. */
async function readPid() {
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
async function readPort() {
  try {
    const raw = await readFile(portFile(), 'utf8');
    const n = parseInt(raw.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Check whether a PID corresponds to a running process.
 * Uses process.kill(pid, 0) -- signal 0 tests reachability without sending a
 * real signal. Works on Unix and Windows (Node translates it to OpenProcess).
 */
function isRunning(pid) {
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
async function freePort(preferredPort) {
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
async function ensureCacheDir() {
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
    const port = await readPort();
    const host = process.env.HOST || '127.0.0.1';
    const url = `http://${host}:${port}`;
    process.stdout.write(`Dashboard already running (pid ${existingPid})\n`);
    process.stdout.write(`  ${url}\n`);
    return;
  }

  // A detached descendant can outlive the server leader on POSIX. Keep the
  // group id in the state file so `stop` can still reap it instead of silently
  // abandoning that group and starting a second server.
  if (existingPid !== null && isManagedTargetRunning(existingPid)) {
    process.stderr.write(
      `plugin-ctl: dashboard pid ${existingPid} exited but its process group is still active.\n` +
        `  Run \`node scripts/plugin-ctl.mjs stop\` before starting again.\n`
    );
    process.exitCode = 1;
    return;
  }

  // Clean up stale state files from a dead process.
  if (existingPid !== null) {
    await rm(pidFile(), { force: true });
    await rm(portFile(), { force: true });
  }

  const host = process.env.HOST || '127.0.0.1';
  const port = await freePort(preferredDashboardPort(process.env));

  const [outFd, errFd] = await openLogFds();

  const serverScript = join(PROJECT_DIR, 'scripts', 'server.mjs');
  const registerScript = join(PROJECT_DIR, 'scripts', 'register-ts.mjs');

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

  // Write state files before printing so callers can race-read them.
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
    await rm(pidFile(), { force: true });
    await rm(portFile(), { force: true });
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

  await rm(pidFile(), { force: true });
  await rm(portFile(), { force: true });
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
    await rm(pidFile(), { force: true });
    await rm(portFile(), { force: true });
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
