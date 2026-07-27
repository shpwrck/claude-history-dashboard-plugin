#!/usr/bin/env node
// Live usage reader for the v0.6 audit orchestrator.
//
// Claude remains delegated to the shared session-usage skill. Codex 0.145 no
// longer emits a dependable rate-limit event into session JSONL, so its current
// limits are read from the local app-server JSON-RPC API instead.
//
// Usage:
//   node scripts/audits/check-harness-usage.mjs --source codex|claude --json

import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_TIMEOUT_MS = 20_000;
export const FIVE_HOURS_MINUTES = 300;
export const SEVEN_DAYS_MINUTES = 10_080;

const INITIALIZE_ID = 'chd-audit-usage-initialize';
const RATE_LIMITS_ID = 'chd-audit-usage-rate-limits';

function objectOrNull(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

export function parseJsonRpcLine(line) {
  let message;
  try {
    message = JSON.parse(String(line));
  } catch (error) {
    throw new Error(
      `Codex app-server returned malformed JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!objectOrNull(message)) {
    throw new Error('Codex app-server response must be a JSON object');
  }
  return message;
}

export function parseRateLimitsResponse(message) {
  const response = objectOrNull(message);
  if (!response) {
    throw new Error('Codex app-server rate-limit response must be an object');
  }
  if (objectOrNull(response.error)) {
    const detail = typeof response.error.message === 'string'
      ? response.error.message
      : JSON.stringify(response.error);
    throw new Error(`Codex app-server rate-limit read failed: ${detail}`);
  }

  const result = objectOrNull(response.result);
  if (!result) {
    throw new Error('Codex app-server rate-limit response has no result object');
  }
  const byLimitId = objectOrNull(result.rateLimitsByLimitId);
  const snapshot = objectOrNull(result.rateLimits)
    || objectOrNull(byLimitId?.codex);
  if (!snapshot) {
    throw new Error('Codex app-server rate-limit response has no rateLimits snapshot');
  }
  return snapshot;
}

function normalizeWindow(value, slot) {
  const window = objectOrNull(value);
  if (!window) {
    throw new Error(`Codex ${slot} rate-limit window must be an object or null`);
  }
  if (
    typeof window.usedPercent !== 'number'
    || !Number.isFinite(window.usedPercent)
    || window.usedPercent < 0
    || window.usedPercent > 100
  ) {
    throw new Error(`Codex ${slot}.usedPercent must be a number in [0, 100]`);
  }
  if (
    typeof window.windowDurationMins !== 'number'
    || !Number.isInteger(window.windowDurationMins)
    || window.windowDurationMins <= 0
  ) {
    throw new Error(`Codex ${slot}.windowDurationMins must be a positive integer`);
  }
  if (
    typeof window.resetsAt !== 'number'
    || !Number.isInteger(window.resetsAt)
    || window.resetsAt <= 0
  ) {
    throw new Error(`Codex ${slot}.resetsAt must be a positive Unix timestamp`);
  }
  return window;
}

function fraction(usedPercent) {
  return String(usedPercent / 100);
}

// Convert the app-server camelCase response to the historical session-usage
// header object consumed by orchestrate.decideBudget. Window position is not
// stable: current Codex can return the weekly window as `primary`, so duration
// is the only safe discriminator.
export function rateLimitsToHeaders(rateLimits) {
  const snapshot = objectOrNull(rateLimits);
  if (!snapshot) {
    throw new Error('Codex rateLimits snapshot must be an object');
  }

  const windows = new Map();
  for (const slot of ['primary', 'secondary']) {
    const candidate = snapshot[slot];
    if (candidate === null || candidate === undefined) continue;
    const window = normalizeWindow(candidate, slot);
    const duration = window.windowDurationMins;
    if (duration !== FIVE_HOURS_MINUTES && duration !== SEVEN_DAYS_MINUTES) {
      continue;
    }
    if (windows.has(duration)) {
      throw new Error(`Codex rateLimits snapshot contains a duplicate ${duration}-minute window`);
    }
    windows.set(duration, window);
  }

  // Codex Pro currently exposes only a weekly bucket. That known plan shape
  // means the 5-hour bucket is genuinely unmetered. For every other plan, an
  // absent short window is unknown and must fail closed instead of inventing
  // capacity.
  const fiveHour = windows.get(FIVE_HOURS_MINUTES) || null;
  const sevenDay = windows.get(SEVEN_DAYS_MINUTES);
  if (!sevenDay) {
    throw new Error('Codex rateLimits snapshot has no 10080-minute (7d) window');
  }
  if (!fiveHour && snapshot.planType !== 'pro') {
    throw new Error('Codex non-Pro rateLimits snapshot has no 300-minute (5h) window');
  }

  if (
    snapshot.rateLimitReachedType !== null
    && snapshot.rateLimitReachedType !== undefined
    && typeof snapshot.rateLimitReachedType !== 'string'
  ) {
    throw new Error('Codex rateLimitReachedType must be a string or null');
  }
  if (
    snapshot.spendControlReached !== null
    && snapshot.spendControlReached !== undefined
    && typeof snapshot.spendControlReached !== 'boolean'
  ) {
    throw new Error('Codex spendControlReached must be a boolean or null');
  }
  if (
    snapshot.planType !== null
    && snapshot.planType !== undefined
    && typeof snapshot.planType !== 'string'
  ) {
    throw new Error('Codex planType must be a string or null');
  }

  const backendRejected = Boolean(snapshot.rateLimitReachedType)
    || snapshot.spendControlReached === true;
  const status = (window) => (
    backendRejected || window.usedPercent >= 100 ? 'rejected' : 'ok'
  );

  return {
    '5h-utilization': fiveHour ? fraction(fiveHour.usedPercent) : '0',
    '5h-reset': fiveHour ? String(fiveHour.resetsAt) : '',
    '5h-status': fiveHour ? status(fiveHour) : 'ok',
    '5h-stale': 'false',
    '7d-utilization': fraction(sevenDay.usedPercent),
    '7d-reset': String(sevenDay.resetsAt),
    '7d-status': status(sevenDay),
    '7d-stale': 'false',
    'overage-in-use': 'false',
    'representative-claim':
      fiveHour && fiveHour.usedPercent >= sevenDay.usedPercent
        ? 'five_hour'
        : 'seven_day',
    'source-harness': 'codex',
    'plan-type': snapshot.planType || '',
  };
}

function stderrDetail(stderr) {
  const detail = String(stderr || '').trim();
  return detail ? `: ${detail}` : '';
}

// Resolve only after the app-server exits cleanly. A malformed line, RPC error,
// premature exit, or timeout rejects, so the orchestrator sees a nonzero reader
// exit and assigns Codex zero budget.
export function queryCodexRateLimits({
  command = 'codex',
  commandArgs = ['app-server', '--stdio'],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnProcess = spawn,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error('Codex app-server timeout must be a positive number'));
  }

  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawnProcess(command, commandArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      rejectPromise(error);
      return;
    }

    let settled = false;
    let initialized = false;
    let snapshot = null;
    let stdoutBuffer = '';
    let stderr = '';

    const terminate = () => {
      if (!child.killed) child.kill('SIGTERM');
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminate();
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(snapshot);
    };
    const send = (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const handleLine = (line) => {
      if (settled || !line.trim()) return;
      const message = parseJsonRpcLine(line);
      if (message.id === INITIALIZE_ID) {
        if (initialized) {
          throw new Error('Codex app-server returned duplicate initialize response');
        }
        if (objectOrNull(message.error)) {
          const detail = typeof message.error.message === 'string'
            ? message.error.message
            : JSON.stringify(message.error);
          throw new Error(`Codex app-server initialize failed: ${detail}`);
        }
        if (!objectOrNull(message.result)) {
          throw new Error('Codex app-server initialize response has no result object');
        }
        initialized = true;
        send({ method: 'initialized' });
        send({ id: RATE_LIMITS_ID, method: 'account/rateLimits/read', params: null });
      } else if (message.id === RATE_LIMITS_ID) {
        if (!initialized) {
          throw new Error('Codex app-server returned rate limits before initialize completed');
        }
        if (snapshot) {
          throw new Error('Codex app-server returned duplicate rate-limit response');
        }
        snapshot = parseRateLimitsResponse(message);
        child.stdin.end();
      }
    };
    const drainLines = (flush = false) => {
      for (;;) {
        const newline = stdoutBuffer.indexOf('\n');
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        handleLine(line);
      }
      if (flush && stdoutBuffer.trim()) {
        const line = stdoutBuffer.replace(/\r$/, '');
        stdoutBuffer = '';
        handleLine(line);
      }
    };

    const timer = setTimeout(() => {
      fail(new Error(`Codex app-server timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      stdoutBuffer += chunk;
      try {
        drainLines();
      } catch (error) {
        fail(error);
      }
    });
    child.stderr.on('data', (chunk) => {
      // Preserve enough diagnostic context without letting a noisy child grow
      // memory without bound.
      stderr = `${stderr}${chunk}`.slice(-8_192);
    });
    child.stdin.on('error', (error) => {
      if (!settled && !snapshot) fail(error);
    });
    child.on('error', fail);
    child.on('close', (code, signal) => {
      if (settled) return;
      try {
        drainLines(true);
      } catch (error) {
        fail(error);
        return;
      }
      if (!snapshot) {
        fail(new Error(
          `Codex app-server exited before returning rate limits`
          + ` (code=${String(code)}, signal=${String(signal)})${stderrDetail(stderr)}`,
        ));
        return;
      }
      if (code !== 0) {
        fail(new Error(
          `Codex app-server exited nonzero (code=${String(code)}, signal=${String(signal)})`
          + stderrDetail(stderr),
        ));
        return;
      }
      succeed();
    });

    try {
      send({
        id: INITIALIZE_ID,
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'claude-history-dashboard-audit-usage',
            version: '1.0.0',
          },
        },
      });
    } catch (error) {
      fail(error);
    }
  });
}

export async function readCodexHeaders(options = {}) {
  return rateLimitsToHeaders(await queryCodexRateLimits(options));
}

export function parseArgs(argv) {
  const options = { source: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--source') {
      options.source = argv[++i];
    } else if (value === '--json') {
      options.json = true;
    } else {
      throw new Error(`unknown argument ${value}`);
    }
  }
  if (options.source !== 'codex' && options.source !== 'claude') {
    throw new Error('--source must be codex or claude');
  }
  if (!options.json) {
    throw new Error('--json is required');
  }
  return options;
}

export function delegateClaudeUsage({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const script = join(
    homedir(),
    '.agents',
    'skills',
    'session-usage',
    'scripts',
    'check-usage.mjs',
  );
  const result = spawnSync(
    process.execPath,
    [script, '--source', 'claude', '--json'],
    { stdio: 'inherit', timeout: timeoutMs },
  );
  if (result.error) {
    console.error(`check-harness-usage: Claude usage reader failed: ${result.error.message}`);
    return 1;
  }
  if (Number.isInteger(result.status)) return result.status;
  console.error(
    `check-harness-usage: Claude usage reader ended without an exit status`
    + `${result.signal ? ` (signal ${result.signal})` : ''}`,
  );
  return 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.source === 'claude') {
    process.exitCode = delegateClaudeUsage();
    return;
  }

  const headers = await readCodexHeaders();
  process.stdout.write(`${JSON.stringify(headers, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(
      `check-harness-usage: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
