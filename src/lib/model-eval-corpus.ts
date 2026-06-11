/**
 * model-eval-corpus.ts — curated fixture corpus for model-routing evals
 * (#1080, epic #975, Unit 1 shared substrate). "History prices, fixtures prove":
 * the hindsight miner (#1081) ranks candidates from real history, but a
 * defensible model comparison needs a CONTROLLED corpus — tasks with a
 * deterministic, objective gate (build / test / diff) that any model's attempt
 * either passes or fails, with no human judgement in the loop.
 *
 * This module is the typed corpus + its sanitizing loader. It is pure and
 * deterministic: {@link CURATED_CORPUS} is the in-repo source of truth, the
 * `fixtures/model-eval-corpus/` JSON manifests mirror it byte-for-byte (a drift
 * test guards that), and nothing here calls a live API. The fixture-backed batch
 * generation lives in `model-eval-batch.ts` and consumes {@link CorpusTask}s
 * from here.
 */

/** The objective-gate kinds. Each is a deterministic pass/fail check. */
export const OBJECTIVE_GATE_KINDS = ['build', 'test', 'diff'] as const;
export type ObjectiveGateKind = (typeof OBJECTIVE_GATE_KINDS)[number];

/**
 * A deterministic objective gate for a corpus task. The eval RUNNER (a later
 * unit) executes `command` in the task's checkout and compares the result to
 * the expectation; this module only carries the manifest.
 */
export interface ObjectiveGate {
  kind: ObjectiveGateKind;
  /** The shell command the runner executes to evaluate the attempt. */
  command: string;
  /** Required process exit code for a pass. Defaults to 0. */
  expectExitCode: number;
  /** Optional substring the command output must contain for a pass. */
  expectMatch?: string;
}

/** One curated corpus task with its objective gate. */
export interface CorpusTask {
  /** Stable, unique id (kebab-case). */
  id: string;
  title: string;
  /** What the model is asked to do — the prompt the runner issues. */
  instruction: string;
  gate: ObjectiveGate;
  /** Free-form tags for clustering/filtering (e.g. 'pure-fn', 'bugfix'). */
  tags: string[];
}

/** A lightweight reference to a corpus task, embedded in a batch spec. */
export interface CorpusTaskRef {
  taskId: string;
  gateKind: ObjectiveGateKind;
}

const MAX_ID_LEN = 80;
const MAX_TEXT_LEN = 600;
const MAX_TAGS = 12;
const MAX_TAG_LEN = 40;

/**
 * The curated corpus — the in-repo source of truth. Small, deterministic, and
 * gate-objective. Covers all three gate kinds so a batch can exercise each.
 */
export const CURATED_CORPUS: CorpusTask[] = [
  {
    id: 'pure-fn-fizzbuzz',
    title: 'Implement a pure FizzBuzz function',
    instruction:
      'Implement `fizzbuzz(n: number): string` returning "Fizz"/"Buzz"/"FizzBuzz"/the number, with no side effects.',
    gate: { kind: 'test', command: 'npm test -- fizzbuzz', expectExitCode: 0 },
    tags: ['pure-fn', 'trivial'],
  },
  {
    id: 'fix-off-by-one',
    title: 'Fix an off-by-one bug surfaced by a failing test',
    instruction:
      'A unit test fails because a loop bound is off by one. Make the failing test pass without changing the test.',
    gate: { kind: 'test', command: 'npm test -- off-by-one', expectExitCode: 0 },
    tags: ['bugfix', 'moderate'],
  },
  {
    id: 'typed-export-build-clean',
    title: 'Add a typed export that keeps the typecheck clean',
    instruction:
      'Add an exported, fully-typed helper to the target module so that `tsc -b` still passes with no errors.',
    gate: { kind: 'build', command: 'npm run typecheck', expectExitCode: 0 },
    tags: ['types', 'moderate'],
  },
  {
    id: 'mechanical-rename-diff',
    title: 'Apply a mechanical rename matching an expected diff',
    instruction:
      'Rename the symbol `oldName` to `newName` across the target file. The result must match the recorded expected diff exactly.',
    gate: {
      kind: 'diff',
      command: 'git diff --exit-code -- fixtures/expected/mechanical-rename.diff',
      expectExitCode: 0,
    },
    tags: ['codemod', 'trivial'],
  },
];

function cleanString(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  return trimmed;
}

function parseGate(raw: unknown): ObjectiveGate | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Record<string, unknown>;
  const kind = g.kind;
  if (typeof kind !== 'string' || !OBJECTIVE_GATE_KINDS.includes(kind as ObjectiveGateKind)) {
    return null;
  }
  const command = cleanString(g.command, MAX_TEXT_LEN);
  if (!command) return null;
  const expectExitCode =
    typeof g.expectExitCode === 'number' && Number.isInteger(g.expectExitCode)
      ? g.expectExitCode
      : 0;
  const gate: ObjectiveGate = { kind: kind as ObjectiveGateKind, command, expectExitCode };
  const expectMatch = cleanString(g.expectMatch, MAX_TEXT_LEN);
  if (expectMatch) gate.expectMatch = expectMatch;
  return gate;
}

function parseTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    const tag = cleanString(t, MAX_TAG_LEN);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * Parse one raw object into a {@link CorpusTask}, or null if it fails validation.
 * Pure and total — never throws on malformed input.
 */
export function parseCorpusTask(raw: unknown): CorpusTask | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = cleanString(r.id, MAX_ID_LEN);
  const title = cleanString(r.title, MAX_TEXT_LEN);
  const instruction = cleanString(r.instruction, MAX_TEXT_LEN);
  const gate = parseGate(r.gate);
  if (!id || !title || !instruction || !gate) return null;
  return { id, title, instruction, gate, tags: parseTags(r.tags) };
}

/**
 * Parse + validate a raw corpus (array of task objects), dropping malformed
 * tasks and de-duplicating by id (first id wins). Deterministic: same input →
 * same output, in input order.
 */
export function parseCorpus(raw: unknown): CorpusTask[] {
  if (!Array.isArray(raw)) return [];
  const out: CorpusTask[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const task = parseCorpusTask(item);
    if (!task || seen.has(task.id)) continue;
    seen.add(task.id);
    out.push(task);
  }
  return out;
}

/** A corpus is valid when it is non-empty and round-trips through the parser
 *  unchanged (no malformed/duplicate tasks). */
export function validateCorpus(tasks: CorpusTask[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (tasks.length === 0) errors.push('corpus is empty');
  const reparsed = parseCorpus(tasks);
  if (reparsed.length !== tasks.length) {
    errors.push(`${tasks.length - reparsed.length} task(s) failed validation or were duplicates`);
  }
  return { ok: errors.length === 0, errors };
}

/** The lightweight ref embedded in a fixture-backed batch spec. */
export function corpusTaskRef(task: CorpusTask): CorpusTaskRef {
  return { taskId: task.id, gateKind: task.gate.kind };
}
