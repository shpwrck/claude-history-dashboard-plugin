#!/usr/bin/env node
/**
 * Host-only TypeScript structured-edit eval runner (#2296).
 *
 * Offline scoring is the default-capable path and performs no model/network
 * invocation. A live run is opt-in (`CHD_MODEL_EDIT_EVAL=1`) and dynamically
 * reuses shadow-calls' mandatory `srt` jail with model-only egress. There is no
 * unjailed fallback and no direct API client in this repository.
 */

import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants, createReadStream, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildStructuredEditEvalResult,
  buildStructuredEditTaskResult,
  mergeStructuredEditTelemetry,
  parseStructuredEditCorpus,
} from '../src/lib/structured-edit-eval.ts';
import {
  applyStructuredEditMutation,
  scoreStructuredEdit,
} from './lib/model-edit-benchmark.ts';

const RUNNER_PATH = fileURLToPath(import.meta.url);
const __dirname = dirname(RUNNER_PATH);
const REPO_ROOT = resolve(__dirname, '..');
const SCORER_PATH = join(__dirname, 'lib', 'model-edit-benchmark.ts');
const DEFAULT_MANIFEST = join(
  REPO_ROOT,
  'fixtures',
  'model-eval-corpus',
  'structured-edit-corpus.json'
);
const MODEL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
export const MAX_LIVE_TASK_BYTES = 1024 * 1024;
export const MAX_WORKER_STREAM_BYTES = 4 * 1024 * 1024;

const WORKER_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USERPROFILE',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_COLLATE',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_MONETARY',
  'LC_NUMERIC',
  'LC_TIME',
  'TZ',
  'TERM',
  'NO_COLOR',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
];

function usage() {
  return `Usage: npm run eval:model-edit -- [options]

Offline modes (zero model/network calls):
  --score-expected            Score the committed expected bytes (corpus self-check).
  --responses DIR            Score DIR/<task-id>/task.ts; optional telemetry.json.

Live mode (when neither offline flag is supplied):
  CHD_MODEL_EDIT_EVAL=1       Required explicit opt-in.
  --model ID                  Jailed worker model (required for live mode).
  --max-retries N             Retry failed/no-edit tasks (default 1).
  --max-budget-usd USD        Hard cap per jailed worker (default 0.25).
  --total-budget-usd USD      Hard worst-case batch cap (default 3).

Common:
  --manifest PATH             Corpus manifest (default committed v1 manifest).
  --task ID                   Run one task; repeatable.
  --out PATH                  Write one atomic JSON receipt.
  --print                     Print the receipt to stdout.
  --help                      Show this text.

Live runs always checkpoint under --out or
.claude/model-evals/structured-edit-results/, including with --print. Offline
runs use that default only when neither --out nor --print is supplied. This is
separate from model-evals/results because the general ingester does not accept
structured-edit-model-eval receipts.`;
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const options = {
    manifest: DEFAULT_MANIFEST,
    tasks: [],
    model: null,
    scoreExpected: false,
    responses: null,
    maxRetries: 1,
    maxBudgetUsd: 0.25,
    totalBudgetUsd: 3,
    out: null,
    print: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--manifest':
        options.manifest = valueAfter(argv, index, arg);
        index += 1;
        break;
      case '--task':
        options.tasks.push(valueAfter(argv, index, arg));
        index += 1;
        break;
      case '--model':
        options.model = valueAfter(argv, index, arg);
        index += 1;
        break;
      case '--responses':
        options.responses = valueAfter(argv, index, arg);
        index += 1;
        break;
      case '--max-retries':
        options.maxRetries = Number(valueAfter(argv, index, arg));
        index += 1;
        break;
      case '--max-budget-usd':
        options.maxBudgetUsd = Number(valueAfter(argv, index, arg));
        index += 1;
        break;
      case '--total-budget-usd':
        options.totalBudgetUsd = Number(valueAfter(argv, index, arg));
        index += 1;
        break;
      case '--out':
        options.out = valueAfter(argv, index, arg);
        index += 1;
        break;
      case '--score-expected':
        options.scoreExpected = true;
        break;
      case '--print':
        options.print = true;
        break;
      case '--help':
      case '-h':
        console.log(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag: ${arg}`);
    }
  }
  if (options.scoreExpected && options.responses) {
    throw new Error('--score-expected and --responses are mutually exclusive');
  }
  if (!Number.isInteger(options.maxRetries) || options.maxRetries < 0 || options.maxRetries > 5) {
    throw new Error('--max-retries must be an integer between 0 and 5');
  }
  if (!Number.isFinite(options.maxBudgetUsd) || options.maxBudgetUsd <= 0) {
    throw new Error('--max-budget-usd must be positive');
  }
  if (!Number.isFinite(options.totalBudgetUsd) || options.totalBudgetUsd <= 0) {
    throw new Error('--total-budget-usd must be positive');
  }
  return options;
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', rejectHash);
    stream.on('end', resolveHash);
  });
  return hash.digest('hex');
}

export function within(
  root,
  candidate,
  pathApi = { relative, isAbsolute, sep }
) {
  const rel = pathApi.relative(root, candidate);
  return (
    rel === '' ||
    (!pathApi.isAbsolute(rel) &&
      !rel.startsWith(`..${pathApi.sep}`) &&
      rel !== '..' &&
      !rel.startsWith(pathApi.sep))
  );
}

function resolveCorpusPath(root, path) {
  const absolute = resolve(root, path);
  if (!within(root, absolute)) throw new Error(`corpus path escapes its root: ${path}`);
  return absolute;
}

async function resolveCorpusFile(root, path) {
  const lexical = resolveCorpusPath(root, path);
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(lexical)]);
  if (!within(realRoot, realFile)) {
    throw new Error(`corpus path resolves outside its root: ${path}`);
  }
  return realFile;
}

function emptyTelemetry(overrides = {}) {
  return {
    input_tokens: 0,
    output_tokens: 0,
    read_calls: 0,
    edit_calls: 0,
    write_calls: 0,
    edit_successes: 0,
    edit_failures: 0,
    write_successes: 0,
    write_failures: 0,
    read_without_edit_attempts: 0,
    retries_used: 0,
    duration_ms: null,
    cost_usd: null,
    resolved_model_id: null,
    telemetry_complete: true,
    transport_failure: false,
    failure_reason: null,
    ...overrides,
  };
}

function finiteNonNegative(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseOfflineTelemetry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return emptyTelemetry({ telemetry_complete: false });
  }
  const requiredCounts = [
    'input_tokens',
    'output_tokens',
    'read_calls',
    'edit_calls',
    'write_calls',
    'edit_successes',
    'edit_failures',
    'write_successes',
    'write_failures',
    'retries_used',
  ];
  const activityComplete = requiredCounts.every(
    (field) => nullableNonNegative(raw[field]) !== null
  );
  const durationMs = nullableNonNegative(raw.duration_ms);
  const costUsd = nullableNonNegative(raw.cost_usd);
  const resolvedModelId =
    typeof raw.resolved_model_id === 'string' && raw.resolved_model_id.length > 0
      ? raw.resolved_model_id.slice(0, 160)
      : null;
  return emptyTelemetry({
    input_tokens: finiteNonNegative(raw.input_tokens),
    output_tokens: finiteNonNegative(raw.output_tokens),
    read_calls: finiteNonNegative(raw.read_calls),
    edit_calls: finiteNonNegative(raw.edit_calls),
    write_calls: finiteNonNegative(raw.write_calls),
    edit_successes: finiteNonNegative(raw.edit_successes),
    edit_failures: finiteNonNegative(raw.edit_failures),
    write_successes: finiteNonNegative(raw.write_successes),
    write_failures: finiteNonNegative(raw.write_failures),
    read_without_edit_attempts:
      raw.read_without_edit_attempts == null && activityComplete
        ? raw.read_calls > 0 && raw.edit_calls === 0 && raw.write_calls === 0
          ? 1
          : 0
        : finiteNonNegative(raw.read_without_edit_attempts),
    retries_used: finiteNonNegative(raw.retries_used),
    duration_ms: durationMs,
    cost_usd: costUsd,
    resolved_model_id: resolvedModelId,
    telemetry_complete:
      raw.telemetry_complete !== false &&
      activityComplete &&
      durationMs !== null &&
      costUsd !== null &&
      resolvedModelId !== null,
    transport_failure: raw.transport_failure === true,
    failure_reason: typeof raw.failure_reason === 'string' ? raw.failure_reason.slice(0, 500) : null,
  });
}

async function readJsonIfPresent(root, path) {
  try {
    const absolute = await resolveCorpusFile(root, path);
    return JSON.parse(await readFile(absolute, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function loadCorpus(manifestPath) {
  const absoluteManifest = await realpath(resolve(manifestPath));
  const text = await readFile(absoluteManifest, 'utf8');
  const corpus = parseStructuredEditCorpus(JSON.parse(text));
  if (!corpus) throw new Error(`invalid structured-edit corpus: ${absoluteManifest}`);
  const root = dirname(absoluteManifest);
  await readFile(await resolveCorpusFile(root, corpus.provenance.noticePath), 'utf8');
  return { corpus, root, manifestSha256: sha256(text), absoluteManifest };
}

async function loadCommittedTask(root, task) {
  const [sourcePath, inputPath, expectedPath] = await Promise.all([
    resolveCorpusFile(root, task.sourcePath),
    resolveCorpusFile(root, task.inputPath),
    resolveCorpusFile(root, task.expectedPath),
  ]);
  const [source, input, expected] = await Promise.all([
    readFile(sourcePath, 'utf8'),
    readFile(inputPath, 'utf8'),
    readFile(expectedPath, 'utf8'),
  ]);
  const applied = applyStructuredEditMutation(source, task.mutation);
  if (source !== expected) {
    throw new Error(`${task.id}: source bytes drifted from the expected repair bytes`);
  }
  if (applied.content !== input) {
    throw new Error(`${task.id}: committed input bytes drifted from its Babel mutation`);
  }
  if (input === expected) throw new Error(`${task.id}: mutation produced no repair challenge`);
  return {
    source,
    input,
    expected,
    applied,
    fileName: basename(inputPath),
    inputSha256: sha256(input),
  };
}

function selectedTasks(corpus, allowlist) {
  if (allowlist.length === 0) return corpus.tasks;
  const selected = [];
  const unique = new Set(allowlist);
  for (const id of unique) {
    const task = corpus.tasks.find((candidate) => candidate.id === id);
    if (!task) throw new Error(`unknown task: ${id}`);
    selected.push(task);
  }
  return selected;
}

function promptFor(task, retryNumber) {
  const retry =
    retryNumber > 0
      ? `\nThis is retry ${retryNumber}. The previous attempt did not reproduce the expected repair; read the file and make one concrete edit.\n`
      : '';
  return `You are in a cold, jailed structured-edit benchmark workspace.\n\n${task.instruction}\n\nRead task.ts, edit task.ts in place, and stop. Do not create files, use the network, or explain the answer.\n${retry}`;
}

function contentParts(event) {
  const direct = Array.isArray(event?.content) ? event.content : [];
  const message = Array.isArray(event?.message?.content) ? event.message.content : [];
  // Claude stream events can expose the same message in both shapes. Prefer
  // the canonical nested message so one tool call cannot be counted twice.
  return message.length > 0 ? message : direct;
}

function isEditTool(name) {
  return (
    name === 'edit' ||
    name === 'multiedit' ||
    name === 'multi_edit' ||
    name.endsWith('__edit') ||
    name.endsWith('__multiedit') ||
    name.endsWith('__multi_edit')
  );
}

function toolLeaf(name) {
  return name.split('__').at(-1) ?? name;
}

function knownFileTarget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  for (const field of ['file_path', 'filePath', 'path']) {
    const value = input[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function targetsTaskFile(input, taskPath) {
  if (input?.task_path === true) return true;
  if (input?.task_path === false) return false;
  const candidate = knownFileTarget(input);
  if (!candidate) return false;
  const expected = resolve(taskPath);
  const absolute = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(dirname(expected), candidate);
  return absolute === expected;
}

function commandMentionsTask(input) {
  const command = typeof input?.command === 'string' ? input.command : '';
  return /(^|[^a-zA-Z0-9_.-])task\.ts([^a-zA-Z0-9_.-]|$)/.test(command);
}

function isReadToolUse(name, input, taskPath) {
  const leaf = toolLeaf(name);
  if (leaf === 'read') return targetsTaskFile(input, taskPath);
  if (leaf === 'bash') return input?.task_path === true || commandMentionsTask(input);
  const search =
    leaf === 'grep' ||
    leaf === 'rg' ||
    leaf === 'ripgrep' ||
    leaf.includes('search');
  return search && targetsTaskFile(input, taskPath);
}

function isWriteTool(name) {
  return toolLeaf(name) === 'write';
}

function isLiteralReadTool(name) {
  return toolLeaf(name) === 'read';
}

export function toolTelemetry(events, taskPath = 'task.ts') {
  const counts = {
    read: 0,
    edit: 0,
    write: 0,
    editSuccesses: 0,
    editFailures: 0,
    writeSuccesses: 0,
    writeFailures: 0,
  };
  const reads = new Set();
  const edits = new Set();
  const writes = new Set();
  const completedReads = new Set();
  const completedMutations = new Set();
  for (const event of events) {
    for (const part of contentParts(event)) {
      if (part?.type === 'tool_use') {
        const name = String(part.name ?? '').toLowerCase();
        // Match the proof-batch adherence proxy: a shell/search tool that
        // explicitly mentions task.ts inspected the benchmark input even when
        // the worker did not use Claude's literal Read tool.
        if (isReadToolUse(name, part.input, taskPath) && part.id) {
          reads.add(part.id);
        }
        if (isEditTool(name) && targetsTaskFile(part.input, taskPath)) {
          counts.edit += 1;
          if (part.id) edits.add(part.id);
        }
        if (isWriteTool(name) && targetsTaskFile(part.input, taskPath)) {
          counts.write += 1;
          if (part.id) writes.add(part.id);
        }
      }
      if (
        part?.type === 'tool_result' &&
        part.tool_use_id &&
        reads.has(part.tool_use_id) &&
        !completedReads.has(part.tool_use_id)
      ) {
        completedReads.add(part.tool_use_id);
        if (part.is_error !== true) counts.read += 1;
      }
      if (
        part?.type === 'tool_result' &&
        part.tool_use_id &&
        !completedMutations.has(part.tool_use_id) &&
        (edits.has(part.tool_use_id) || writes.has(part.tool_use_id))
      ) {
        completedMutations.add(part.tool_use_id);
        if (edits.has(part.tool_use_id)) {
          if (part.is_error === true) counts.editFailures += 1;
          else counts.editSuccesses += 1;
        } else if (part.is_error === true) counts.writeFailures += 1;
        else counts.writeSuccesses += 1;
      }
    }
  }
  return counts;
}

/**
 * Keep only the tool facts needed to recompute adherence and mutation
 * telemetry. Tool inputs and results may contain source text or shell output,
 * so the receipt records a task.ts marker and deterministic IDs instead.
 */
export function sanitizeToolEvidence(events, taskPath = 'task.ts') {
  const evidence = [];
  const ids = new Map();
  let nextId = 1;
  for (const event of events) {
    for (const part of contentParts(event)) {
      if (part?.type === 'tool_use') {
        const name = String(part.name ?? '').toLowerCase();
        const literalRead = isLiteralReadTool(name);
        const read = isReadToolUse(name, part.input, taskPath);
        const mutating = isEditTool(name) || isWriteTool(name);
        if (!read && !literalRead && !mutating) continue;
        const taskTarget = read || (mutating && targetsTaskFile(part.input, taskPath));
        const id = `tool-${nextId}`;
        nextId += 1;
        if (part.id) ids.set(part.id, id);
        evidence.push({
          type: 'tool_use',
          id,
          name,
          input: { task_path: taskTarget },
        });
        continue;
      }
      if (part?.type !== 'tool_result' || !part.tool_use_id) continue;
      const id = ids.get(part.tool_use_id);
      if (!id) continue;
      evidence.push({
        type: 'tool_result',
        tool_use_id: id,
        is_error: part.is_error === true,
      });
    }
  }
  return evidence;
}

function nullableNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function usageEvidence(parsed) {
  if (!parsed || typeof parsed.usage !== 'object' || parsed.usage === null) return null;
  return {
    input_tokens: nullableNonNegative(parsed.usage.input_tokens),
    output_tokens: nullableNonNegative(parsed.usage.output_tokens),
    cache_read_input_tokens: nullableNonNegative(parsed.usage.cache_read_input_tokens),
    cache_creation_input_tokens: nullableNonNegative(parsed.usage.cache_creation_input_tokens),
  };
}

function parserEvidence(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const format = parsed.format === 'json' || parsed.format === 'stream-json' ? parsed.format : null;
  const eventCount = Number.isInteger(parsed.eventCount) && parsed.eventCount >= 0
    ? parsed.eventCount
    : Array.isArray(parsed.events)
      ? parsed.events.length
      : null;
  const malformedLines =
    Number.isInteger(parsed.malformedLines) && parsed.malformedLines >= 0
      ? parsed.malformedLines
      : null;
  return {
    format,
    event_count: eventCount,
    malformed_lines: malformedLines,
  };
}

function parserEvidenceComplete(parsed, evidence = parserEvidence(parsed)) {
  return (
    evidence !== null &&
    evidence.format !== null &&
    evidence.event_count !== null &&
    evidence.event_count > 0 &&
    Array.isArray(parsed?.events) &&
    evidence.event_count === parsed.events.length &&
    evidence.malformed_lines === 0
  );
}

function sanitizeLaunchString(value, paths) {
  let sanitized = value;
  const replacements = [
    [paths.taskPath, '<task>'],
    [paths.promptPath, '<prompt>'],
    [paths.worktree, '<worktree>'],
    [paths.tempHome, '<temp-home>'],
    [paths.scratch, '<scratch>'],
    [homedir(), '~'],
  ]
    .filter(([path]) => typeof path === 'string' && path.length > 0)
    .sort((left, right) => right[0].length - left[0].length);
  for (const [path, replacement] of replacements) {
    sanitized = sanitized.split(path).join(replacement);
  }
  return sanitized;
}

function sanitizeLaunchValue(value, paths) {
  if (typeof value === 'string') return sanitizeLaunchString(value, paths);
  if (Array.isArray(value)) return value.map((entry) => sanitizeLaunchValue(entry, paths));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeLaunchValue(entry, paths)])
    );
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

export function workerEnvironment(overrides = {}, host = process.env) {
  const effective = {};
  for (const key of WORKER_ENV_KEYS) {
    const value = overrides?.[key] ?? host?.[key];
    if (typeof value === 'string') effective[key] = value;
  }
  return effective;
}

export function launchEvidence(launch, paths, effectiveEnv = workerEnvironment(launch?.env)) {
  const argv = Array.isArray(launch?.argv)
    ? launch.argv.map((entry) => sanitizeLaunchString(String(entry), paths))
    : [];
  const settings =
    launch?.settings && typeof launch.settings === 'object'
      ? sanitizeLaunchValue(launch.settings, paths)
      : null;
  return {
    launcher: basename(argv[0] ?? ''),
    argv,
    argv_sha256: sha256(JSON.stringify(argv)),
    env_override_keys: Object.keys(launch?.env ?? {}).sort(),
    effective_env_keys: Object.keys(effectiveEnv ?? {}).sort(),
    settings,
    settings_sha256: settings === null ? null : sha256(JSON.stringify(settings)),
  };
}

function workerTelemetry(parsed, retriesUsed, taskPath = 'task.ts') {
  const usage = parsed?.usage ?? {};
  const tools = toolTelemetry(
    Array.isArray(parsed?.events) ? parsed.events : [],
    taskPath
  );
  const parser = parserEvidence(parsed);
  const parserComplete = parserEvidenceComplete(parsed, parser);
  const durationMs = parserComplete ? nullableNonNegative(parsed?.durationMs) : null;
  const costUsd = parserComplete ? nullableNonNegative(parsed?.totalCostUsd) : null;
  const usageComplete =
    parsed !== null &&
    parsed !== undefined &&
    parsed.usage !== null &&
    typeof parsed.usage === 'object' &&
    nullableNonNegative(usage.input_tokens) !== null &&
    nullableNonNegative(usage.output_tokens) !== null &&
    parserComplete;
  return emptyTelemetry({
    input_tokens:
      finiteNonNegative(usage.input_tokens) +
      finiteNonNegative(usage.cache_read_input_tokens) +
      finiteNonNegative(usage.cache_creation_input_tokens),
    output_tokens: finiteNonNegative(usage.output_tokens),
    read_calls: tools.read,
    edit_calls: tools.edit,
    write_calls: tools.write,
    edit_successes: tools.editSuccesses,
    edit_failures: tools.editFailures,
    write_successes: tools.writeSuccesses,
    write_failures: tools.writeFailures,
    read_without_edit_attempts:
      tools.read > 0 && tools.edit === 0 && tools.write === 0 ? 1 : 0,
    retries_used: retriesUsed,
    duration_ms: durationMs,
    cost_usd: costUsd,
    resolved_model_id:
      typeof parsed?.model === 'string' ? parsed.model.slice(0, 160) : null,
    telemetry_complete: usageComplete && durationMs !== null && costUsd !== null,
  });
}

/**
 * Read the post-worker task without following symlinks or blocking on special
 * files. lstat rejects the common cases before open; O_NOFOLLOW/O_NONBLOCK plus
 * inode comparison closes the practical swap-to-symlink/FIFO race on POSIX.
 */
export async function readLiveTaskFile(
  taskPath,
  maxBytes = MAX_LIVE_TASK_BYTES
) {
  const before = await lstat(taskPath);
  if (!before.isFile()) {
    throw new Error('task.ts must remain a regular file (symlinks and special files are rejected)');
  }
  if (before.size > maxBytes) {
    throw new Error(`task.ts exceeds the ${maxBytes}-byte live-eval limit`);
  }
  const flags =
    fsConstants.O_RDONLY |
    (fsConstants.O_NOFOLLOW ?? 0) |
    (fsConstants.O_NONBLOCK ?? 0);
  const handle = await open(taskPath, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error('task.ts changed to a non-regular file before read');
    if (opened.size > maxBytes) {
      throw new Error(`task.ts exceeds the ${maxBytes}-byte live-eval limit`);
    }
    if (before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new Error('task.ts changed between validation and open');
    }
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset
      );
      if (bytesRead === 0) throw new Error('task.ts changed while it was being read');
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, opened.size);
    const after = await handle.stat();
    if (
      extraBytes > 0 ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error('task.ts changed or exceeded its validated size while being read');
    }
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Narrow read allowances needed when Claude is a standalone binary under $HOME. */
function claudeRuntimeReadRoots() {
  try {
    const command = execFileSync('sh', ['-c', 'command -v claude'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!command) return [];
    const resolved = realpathSync(command);
    return [...new Set([dirname(command), dirname(resolved)])];
  } catch {
    return [];
  }
}

function signalWorkerGroup(child, signal, detached) {
  if (detached && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code === 'ESRCH') return;
      // Fall back to the immediate child where process-group signaling is unavailable.
    }
  }
  try {
    child.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

export function spawnWorker(
  argv,
  env,
  timeoutMs = 5 * 60_000,
  timeoutGraceMs = 2_000,
  maxStreamBytes = MAX_WORKER_STREAM_BYTES
) {
  return new Promise((resolveRun, rejectRun) => {
    const detached = process.platform !== 'win32';
    const streamLimit =
      Number.isSafeInteger(maxStreamBytes) && maxStreamBytes > 0
        ? maxStreamBytes
        : MAX_WORKER_STREAM_BYTES;
    const child = spawn(argv[0], argv.slice(1), {
      env: workerEnvironment(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached,
    });
    const stdoutBuffer = Buffer.alloc(streamLimit);
    const stderrBuffer = Buffer.alloc(streamLimit);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let outputLimitReason = null;
    let terminationStarted = false;
    let hardKillTimer = null;
    const snapshot = (code, signal) => ({
      code,
      signal,
      stdout: stdoutBuffer.subarray(0, stdoutBytes).toString('utf8'),
      stderr: stderrBuffer.subarray(0, stderrBytes).toString('utf8'),
      timedOut,
      timeoutReason: timedOut ? `worker timed out after ${timeoutMs}ms` : null,
      outputLimitExceeded: outputLimitReason !== null,
      outputLimitReason,
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      resolveRun(result);
    };
    const terminate = ({ timeout = false, outputReason = null }) => {
      if (terminationStarted || settled) return;
      terminationStarted = true;
      timedOut = timeout;
      outputLimitReason = outputReason;
      if (outputReason) clearTimeout(timeoutTimer);
      signalWorkerGroup(child, 'SIGTERM', detached);
      if (outputReason) {
        // Stop accepting bytes immediately; the process group is reaped below.
        child.stdout.destroy();
        child.stderr.destroy();
      }
      hardKillTimer = setTimeout(() => {
        signalWorkerGroup(child, 'SIGKILL', detached);
        // A descendant that inherited these pipes can otherwise delay `close`.
        child.stdout.destroy();
        child.stderr.destroy();
        const result = snapshot(null, 'SIGKILL');
        if (timeout) {
          result.timeoutReason =
            `worker timed out after ${timeoutMs}ms and exceeded ` +
            `${timeoutGraceMs}ms termination grace`;
        }
        finish(result);
      }, timeoutGraceMs);
    };
    const timeoutTimer = setTimeout(() => terminate({ timeout: true }), timeoutMs);
    const collect = (stream, chunk) => {
      if (settled || outputLimitReason) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const target = stream === 'stdout' ? stdoutBuffer : stderrBuffer;
      const used = stream === 'stdout' ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, streamLimit - used);
      const accepted = Math.min(buffer.length, remaining);
      if (accepted > 0) buffer.copy(target, used, 0, accepted);
      if (stream === 'stdout') stdoutBytes += accepted;
      else stderrBytes += accepted;
      if (buffer.length > remaining) {
        terminate({
          outputReason: `worker ${stream} exceeded ${streamLimit}-byte limit`,
        });
      }
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    child.on('error', (error) => {
      if (settled) return;
      if (terminationStarted) {
        finish(snapshot(null, null));
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      rejectRun(error);
    });
    child.on('close', (code, signal) => {
      finish(snapshot(code, signal));
    });
  });
}

function commandPath(name) {
  try {
    const path = execFileSync('sh', ['-c', 'command -v "$1"', 'sh', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return path || null;
  } catch {
    return null;
  }
}

export function versionProbeEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.toLowerCase().startsWith('npm_'))
  );
}

async function binaryEvidence(name) {
  const command = commandPath(name);
  if (!command) return { name, path: null, version: null, sha256: null };
  let resolved = command;
  try {
    resolved = await realpath(command);
  } catch {
    // Retain the shell-resolved command when its target cannot be resolved.
  }
  let version = null;
  try {
    // npm exports the dashboard's own npm_package_version into child
    // processes. Some CLI wrappers consult that generic variable for
    // --version, which would mislabel srt as the dashboard version.
    version = execFileSync(command, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
      env: versionProbeEnv(),
    })
      .trim()
      .slice(0, 200);
  } catch {
    // A missing version string must not hide the resolved binary identity.
  }
  let binarySha256 = null;
  try {
    binarySha256 = await sha256File(resolved);
  } catch {
    // Some platform launchers are not regular readable files.
  }
  return {
    name,
    path: sanitizeLaunchString(resolved, {
      taskPath: null,
      promptPath: null,
      worktree: null,
      tempHome: null,
      scratch: null,
    }),
    version,
    sha256: binarySha256,
  };
}

export async function loadJail() {
  const shadowLib = join(homedir(), '.claude', 'shadow-calls', 'lib');
  const moduleSpecs = [
    { name: 'sandbox', file: 'sandbox.mjs' },
    { name: 'worker-output', file: 'worker-output.mjs' },
    { name: 'file-evidence', file: 'file-evidence.mjs' },
    { name: 'killswitch', file: 'killswitch.mjs' },
  ];
  const moduleEvidence = await Promise.all(
    moduleSpecs.map(async ({ name, file }) => ({
      name,
      path: `~/.claude/shadow-calls/lib/${file}`,
      sha256: await sha256File(join(shadowLib, file)),
    }))
  );
  const sandbox = await import(pathToFileURL(join(shadowLib, 'sandbox.mjs')).href);
  const killswitch = await import(pathToFileURL(join(shadowLib, 'killswitch.mjs')).href);
  const workerOutput = await import(pathToFileURL(join(shadowLib, 'worker-output.mjs')).href);
  if (killswitch.isKilled()) {
    throw new Error(`shadow-calls killswitch engaged (${killswitch.killReason() || 'no reason'})`);
  }
  const gate = sandbox.sandboxGate();
  if (!gate.ok) throw new Error(`jail unavailable: ${gate.reason}`);
  const binaries = await Promise.all(['srt', 'claude'].map(binaryEvidence));
  return {
    buildWorkerLaunch: sandbox.buildWorkerLaunch,
    seedTempHome: sandbox.seedTempHome,
    parseWorkerOutputText: workerOutput.parseWorkerOutputText,
    provenance: {
      gate: { ok: gate.ok === true, reason: typeof gate.reason === 'string' ? gate.reason : null },
      modules: moduleEvidence,
      binaries,
    },
  };
}

function errorText(error) {
  if (error instanceof Error) {
    const code = typeof error.code === 'string' ? `${error.code}: ` : '';
    return `${code}${error.message}`;
  }
  return String(error);
}

export async function runJailedAttempt({
  jail,
  task,
  committed,
  model,
  maxBudgetUsd,
  retryNumber,
  spawnWorkerFn = spawnWorker,
}) {
  const scratch = await mkdtemp(join(tmpdir(), `chd-model-edit-${task.id}-`));
  let result = null;
  let pendingError = null;
  let receiptPaths = null;
  try {
    const worktree = join(scratch, 'worktree');
    await mkdir(worktree, { recursive: true });
    const tempHome = jail.seedTempHome(join(scratch, 'home'));
    const promptPath = join(tempHome, 'prompt.txt');
    const taskPath = join(worktree, 'task.ts');
    receiptPaths = { scratch, worktree, tempHome, promptPath, taskPath };
    await Promise.all([
      writeFile(promptPath, promptFor(task, retryNumber), 'utf8'),
      writeFile(taskPath, committed.input, 'utf8'),
    ]);
    const launch = jail.buildWorkerLaunch({
      worktree,
      promptPath,
      tempHome,
      model,
      maxBudgetUsd,
      coldStart: true,
      // `claude` may be a standalone binary under ~/.local rather than an
      // nvm global. Re-allow only its symlink dir + resolved binary dir; the
      // rest of $HOME (including ~/.claude source artifacts) stays denied.
      repoReadRoots: claudeRuntimeReadRoots(),
      // Deliberately no allowDomains: sandbox.mjs adds only its configured model endpoint.
    });
    const effectiveEnv = workerEnvironment(launch.env);
    let processResult;
    let spawnFailure = null;
    try {
      processResult = await spawnWorkerFn(launch.argv, effectiveEnv);
    } catch (error) {
      spawnFailure = errorText(error);
      processResult = {
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        timeoutReason: null,
        outputLimitExceeded: false,
        outputLimitReason: null,
      };
    }
    let parsed = null;
    try {
      parsed = jail.parseWorkerOutputText(processResult.stdout);
    } catch {
      // A failed/empty worker is scored as an unchanged attempt and may retry.
    }
    const parser = parserEvidence(parsed);
    let actual = '';
    let taskReadFailure = null;
    try {
      actual = await readLiveTaskFile(taskPath);
    } catch (error) {
      // A destructive model edit is a scored attempt, not a batch-level crash.
      taskReadFailure = `task.ts unreadable after worker exit (${errorText(error)})`;
    }
    const score = await scoreStructuredEdit(committed.expected, actual, taskPath);
    const failureReasons = [];
    if (processResult.timedOut) {
      failureReasons.push(processResult.timeoutReason ?? 'worker timed out');
    }
    if (processResult.outputLimitExceeded) {
      failureReasons.push(
        processResult.outputLimitReason ?? 'worker output exceeded byte limit'
      );
    }
    if (spawnFailure) failureReasons.push(`worker spawn failed (${spawnFailure})`);
    if (parsed === null) failureReasons.push('worker output was empty or unparseable');
    else if ((parser?.malformed_lines ?? 0) > 0) {
      failureReasons.push(
        `worker output contained ${parser.malformed_lines} malformed JSONL line(s)`
      );
    } else if (!parserEvidenceComplete(parsed, parser)) {
      failureReasons.push('worker output parser evidence was incomplete');
    }
    if (processResult.code !== 0) {
      failureReasons.push(
        `worker exit=${processResult.code ?? 'null'} signal=${processResult.signal ?? 'none'}`
      );
    }
    if (parsed?.final?.is_error === true) failureReasons.push('worker reported an error');
    if (taskReadFailure) failureReasons.push(taskReadFailure);
    const transportFailure = failureReasons.length > 0;
    const failureReason = transportFailure
      ? sanitizeLaunchString(failureReasons.join('; '), receiptPaths).slice(0, 1_000)
      : null;
    const telemetry = {
      ...workerTelemetry(parsed, retryNumber, taskPath),
      transport_failure: transportFailure,
      failure_reason: failureReason,
    };
    result = {
      score,
      telemetry,
      exitCode: processResult.code,
      signal: processResult.signal,
      evidence: {
        attempt: retryNumber + 1,
        phase: 'worker',
        worker_output_sha256: sha256(String(processResult.stdout ?? '')),
        worker_stderr_sha256: sha256(String(processResult.stderr ?? '')),
        output_parsed: parsed !== null,
        parser,
        usage: usageEvidence(parsed),
        duration_ms: nullableNonNegative(parsed?.durationMs),
        cost_usd: nullableNonNegative(parsed?.totalCostUsd),
        resolved_model_id: telemetry.resolved_model_id,
        tool_events: sanitizeToolEvidence(
          Array.isArray(parsed?.events) ? parsed.events : [],
          taskPath
        ),
        launch: launchEvidence(launch, receiptPaths, effectiveEnv),
        exit_code: processResult.code,
        signal: processResult.signal,
        score,
        telemetry,
      },
    };
  } catch (error) {
    pendingError = error;
  } finally {
    try {
      await rm(scratch, { recursive: true, force: true });
    } catch (error) {
      const cleanupText = `scratch cleanup failed (${errorText(error)})`;
      const cleanupReason = receiptPaths
        ? sanitizeLaunchString(cleanupText, receiptPaths)
        : cleanupText;
      if (result) {
        result.telemetry = {
          ...result.telemetry,
          transport_failure: true,
          failure_reason: [result.telemetry.failure_reason, cleanupReason]
            .filter(Boolean)
            .join('; ')
            .slice(0, 1_000),
        };
        result.evidence = { ...result.evidence, telemetry: result.telemetry };
      } else if (pendingError) {
        pendingError = new Error(`${errorText(pendingError)}; ${cleanupReason}`);
      } else {
        pendingError = error;
      }
    }
  }
  if (pendingError) throw pendingError;
  return result;
}

export async function runLiveTask({
  jail,
  task,
  committed,
  model,
  maxRetries,
  maxBudgetUsd,
  attemptRunner = runJailedAttempt,
}) {
  let aggregate = null;
  let lastScore = await scoreStructuredEdit(committed.expected, committed.input, 'task.ts');
  let bestPassingScore = null;
  const attempts = [];
  const qualityRank = (score) =>
    score.byte_exact_match ? 3 : score.normalized_exact_match ? 2 : score.normalized_match ? 1 : 0;
  for (let retryNumber = 0; retryNumber <= maxRetries; retryNumber += 1) {
    let attempt;
    try {
      attempt = await attemptRunner({
        jail,
        task,
        committed,
        model,
        maxBudgetUsd,
        retryNumber,
      });
    } catch (error) {
      const reason = `task attempt boundary failure (${errorText(error)})`
        .split(homedir())
        .join('~')
        .split(tmpdir())
        .join('<tmp>')
        .slice(0, 1_000);
      const failureTelemetry = emptyTelemetry({
        retries_used: retryNumber,
        telemetry_complete: false,
        transport_failure: true,
        failure_reason: reason,
      });
      aggregate =
        aggregate === null
          ? failureTelemetry
          : mergeStructuredEditTelemetry(aggregate, failureTelemetry);
      attempts.push({
        attempt: retryNumber + 1,
        phase: 'task-boundary',
        worker_output_sha256: null,
        worker_stderr_sha256: null,
        output_parsed: false,
        parser: null,
        usage: null,
        duration_ms: null,
        cost_usd: null,
        resolved_model_id: null,
        tool_events: [],
        launch: null,
        exit_code: null,
        signal: null,
        score: lastScore,
        telemetry: failureTelemetry,
      });
      console.error(`${task.id}: ${reason}`);
      break;
    }
    aggregate =
      aggregate === null
        ? attempt.telemetry
        : mergeStructuredEditTelemetry(aggregate, attempt.telemetry);
    if (attempt.evidence) attempts.push(attempt.evidence);
    if (attempt.telemetry.transport_failure) {
      console.error(`${task.id}: ${attempt.telemetry.failure_reason}`);
    }
    lastScore = attempt.score;
    if (
      attempt.score.verification_passed &&
      (bestPassingScore === null || qualityRank(attempt.score) > qualityRank(bestPassingScore))
    ) {
      bestPassingScore = attempt.score;
    }
    if (attempt.score.verification_passed && !attempt.telemetry.transport_failure) break;
  }
  return buildStructuredEditTaskResult({
    task,
    modelId: model,
    inputSha256: committed.inputSha256,
    score: bestPassingScore ?? lastScore,
    telemetry: aggregate ?? emptyTelemetry({ telemetry_complete: false }),
    attempts,
  });
}

async function runOfflineTask({ task, committed, model, scoreExpected, responses }) {
  if (scoreExpected) {
    const score = await scoreStructuredEdit(committed.expected, committed.expected, 'task.ts');
    return buildStructuredEditTaskResult({
      task,
      modelId: model,
      inputSha256: committed.inputSha256,
      score,
      telemetry: emptyTelemetry(),
    });
  }
  const taskDir = await resolveCorpusFile(resolve(responses), task.id);
  const actualPath = await resolveCorpusFile(taskDir, 'task.ts');
  // Quality scoring is independent of the optional telemetry sidecar. A bad
  // sidecar must not convert byte-correct task.ts into a task-boundary failure.
  const actual = await readFile(actualPath, 'utf8');
  let telemetryRaw = null;
  try {
    telemetryRaw = await readJsonIfPresent(taskDir, 'telemetry.json');
  } catch {
    // Missing, malformed, unreadable, and escaping sidecars are all unknown
    // telemetry. task.ts remains independently scoreable.
  }
  const score = await scoreStructuredEdit(committed.expected, actual, actualPath);
  return buildStructuredEditTaskResult({
    task,
    modelId: model,
    inputSha256: committed.inputSha256,
    score,
    telemetry: parseOfflineTelemetry(telemetryRaw),
  });
}

export async function buildTaskBoundaryFailure({ task, root, model, error }) {
  let input = `/* ${task.id}: input unavailable */\n`;
  let expected = `/* ${task.id}: expected unavailable */\n`;
  try {
    input = await readFile(await resolveCorpusFile(root, task.inputPath), 'utf8');
  } catch {
    // The failure row remains usable even when corpus setup itself is broken.
  }
  try {
    expected = await readFile(await resolveCorpusFile(root, task.expectedPath), 'utf8');
  } catch {
    // The scorer receives a deterministic sentinel when expected bytes are unavailable.
  }
  let actual = input;
  if (actual === expected) actual = `${actual}\n/* task-boundary failure */\n`;
  let score;
  try {
    score = await scoreStructuredEdit(expected, actual, 'task.ts');
  } catch {
    // A broken scorer is itself a transport failure. Keep the batch moving
    // with a conservative mismatch whose byte hashes remain auditable.
    score = {
      byte_exact_match: false,
      normalized_exact_match: false,
      normalized_match: false,
      verification_passed: false,
      comparison: 'mismatch',
      indent_score: 0,
      expected_sha256: sha256(expected),
      actual_sha256: sha256(actual),
    };
  }
  const reason = `task boundary failure (${errorText(error)})`
    .split(root)
    .join('<corpus>')
    .split(homedir())
    .join('~')
    .split(tmpdir())
    .join('<tmp>')
    .slice(0, 1_000);
  const boundaryTelemetry = emptyTelemetry({
    telemetry_complete: false,
    transport_failure: true,
    failure_reason: reason,
  });
  return buildStructuredEditTaskResult({
    task,
    modelId: model,
    inputSha256: sha256(input),
    score,
    telemetry: boundaryTelemetry,
    attempts: [
      {
        attempt: 1,
        phase: 'task-boundary',
        worker_output_sha256: null,
        worker_stderr_sha256: null,
        output_parsed: false,
        parser: null,
        usage: null,
        duration_ms: null,
        cost_usd: null,
        resolved_model_id: null,
        tool_events: [],
        launch: null,
        exit_code: null,
        signal: null,
        score,
        telemetry: boundaryTelemetry,
      },
    ],
  });
}

export async function runTaskBatch({ tasks, runOne, buildFailure, onCompleted }) {
  const runs = [];
  for (const task of tasks) {
    let run;
    try {
      run = await runOne(task);
    } catch (error) {
      run = await buildFailure(task, error);
    }
    runs.push(run);
    await onCompleted([...runs]);
  }
  return runs;
}

export async function writeReceipt(path, receipt) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    await rename(temporary, absolute);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return absolute;
}

export function defaultReceiptPath(createdAt, repoRoot = REPO_ROOT) {
  return join(
    repoRoot,
    '.claude',
    'model-evals',
    'structured-edit-results',
    `structured-edit-${createdAt.replace(/[:.]/g, '-')}.json`
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const { corpus, root, manifestSha256 } = await loadCorpus(args.manifest);
  const tasks = selectedTasks(corpus, args.tasks);
  if (tasks.length === 0) throw new Error('no tasks selected');
  const offline = args.scoreExpected || args.responses !== null;
  const model = args.model ?? (args.scoreExpected ? 'fixture-expected' : null);
  if (!model || !MODEL_ID_RE.test(model)) {
    throw new Error('--model is required and must contain only letters, digits, dot, underscore, colon, or dash');
  }

  let jail = null;
  if (!offline) {
    if (process.env.CHD_MODEL_EDIT_EVAL !== '1') {
      throw new Error(
        'live model invocation is disabled; set CHD_MODEL_EDIT_EVAL=1 explicitly, or use --score-expected/--responses for zero-network scoring'
      );
    }
    const worstCase = tasks.length * (args.maxRetries + 1) * args.maxBudgetUsd;
    if (worstCase > args.totalBudgetUsd + 1e-9) {
      throw new Error(
        `worst-case batch cap is $${worstCase.toFixed(2)}, above --total-budget-usd $${args.totalBudgetUsd.toFixed(2)}`
      );
    }
    jail = await loadJail();
  }

  const createdAt = new Date().toISOString();
  const [runnerSource, scorerSource] = await Promise.all([
    readFile(RUNNER_PATH, 'utf8'),
    readFile(SCORER_PATH, 'utf8'),
  ]);
  const runner = {
    version: 3,
    script_path: 'scripts/model-eval-run.mjs',
    script_sha256: sha256(runnerSource),
    scorer_path: 'scripts/lib/model-edit-benchmark.ts',
    scorer_sha256: sha256(scorerSource),
    jail: offline ? null : jail.provenance,
  };
  const execution = offline
    ? { mode: 'offline-score', jail: 'none', egress: 'none', max_budget_usd: null }
    : {
        mode: 'jailed-model',
        jail: 'srt',
        egress: 'model-only',
        max_budget_usd: args.maxBudgetUsd,
      };
  const buildReceipt = (runs, status) =>
    buildStructuredEditEvalResult({
      modelId: model,
      corpus,
      runs,
      manifestSha256,
      runner,
      createdAt,
      execution,
      completion: {
        status,
        selected_tasks: tasks.length,
        completed_tasks: runs.length,
      },
    });
  const liveCheckpoint = args.out ?? defaultReceiptPath(createdAt);
  const runs = await runTaskBatch({
    tasks,
    runOne: async (task) => {
      const committed = await loadCommittedTask(root, task);
      return offline
        ? runOfflineTask({
            task,
            committed,
            model,
            scoreExpected: args.scoreExpected,
            responses: args.responses,
          })
        : runLiveTask({
            jail,
            task,
            committed,
            model,
            maxRetries: args.maxRetries,
            maxBudgetUsd: args.maxBudgetUsd,
          });
    },
    buildFailure: (task, error) => buildTaskBoundaryFailure({ task, root, model, error }),
    onCompleted: async (completedRuns) => {
      if (!offline) {
        await writeReceipt(liveCheckpoint, buildReceipt(completedRuns, 'in-progress'));
      }
    },
  });
  const receipt = buildReceipt(runs, 'complete');
  let written = null;
  if (!offline || args.out || !args.print) {
    written = await writeReceipt(offline ? (args.out ?? defaultReceiptPath(createdAt)) : liveCheckpoint, receipt);
  }
  if (args.print) process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (written) console.error(`Wrote ${written}`);
}

if (process.argv[1] && resolve(process.argv[1]) === RUNNER_PATH) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('');
    console.error(usage());
    process.exitCode = 1;
  });
}
