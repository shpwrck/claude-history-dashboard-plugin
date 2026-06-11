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
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  if (process.env.CHD_CACHE_DIR) return process.env.CHD_CACHE_DIR;
  return join(homedir(), '.claude', '.cache', 'chd');
}

function pidFile() {
  return join(cacheDir(), 'plugin-ctl.pid');
}

function portFile() {
  return join(cacheDir(), 'plugin-ctl.port');
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
    return Number.isFinite(n) && n > 0 ? n : null;
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

  // Clean up stale state files from a dead process.
  if (existingPid !== null) {
    await rm(pidFile(), { force: true });
    await rm(portFile(), { force: true });
  }

  const host = process.env.HOST || '127.0.0.1';
  const port = await freePort(5173);

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
  if (!isRunning(pid)) {
    process.stdout.write(`Dashboard (pid ${pid}) is already gone.\n`);
    await rm(pidFile(), { force: true });
    await rm(portFile(), { force: true });
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }

  // Wait up to 5 s for the process to exit.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isRunning(pid)) {
    await new Promise((r) => setTimeout(r, 100));
  }

  if (isRunning(pid)) {
    // Force-kill if graceful shutdown didn't happen.
    try {
      process.kill(pid, 'SIGKILL');
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
