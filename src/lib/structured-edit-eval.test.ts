import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  buildStructuredEditEvalResult,
  buildStructuredEditTaskResult,
  mergeStructuredEditTelemetry,
  parseStructuredEditCorpus,
  summarizeStructuredEditByTaskClass,
  type StructuredEditRunTelemetry,
  type StructuredEditTask,
  type StructuredEditTaskResult,
} from './structured-edit-eval';
import {
  applyStructuredEditMutation,
  scoreStructuredEdit,
} from '../../scripts/lib/model-edit-benchmark';
// @ts-expect-error - host-only .mjs runner has no declaration file.
import {
  MAX_LIVE_TASK_BYTES,
  RUNNER_VERSION,
  defaultReceiptPath,
  readLiveTaskFile,
  replayAttemptTelemetry,
  runJailedAttempt,
  runLiveTask,
  runTaskBatch,
  sanitizeToolEvidence,
  spawnWorker,
  toolClassificationDigest,
  toolTelemetry,
  versionProbeEnv,
  workerEnvironment,
  within,
  writeReceipt,
} from '../../scripts/model-eval-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const CORPUS_ROOT = resolve(REPO_ROOT, 'fixtures/model-eval-corpus');
const MANIFEST_PATH = resolve(CORPUS_ROOT, 'structured-edit-corpus.json');
const MANIFEST_TEXT = readFileSync(MANIFEST_PATH, 'utf8');
const CORPUS = parseStructuredEditCorpus(JSON.parse(MANIFEST_TEXT));
const RECEIPT_PATH = resolve(
  CORPUS_ROOT,
  'receipts/claude-haiku-4-5-2026-07-13.json'
);
const CONTRACT_PATH = resolve(CORPUS_ROOT, 'runner-contract.json');

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function telemetry(overrides: Partial<StructuredEditRunTelemetry> = {}): StructuredEditRunTelemetry {
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

function task(overrides: Partial<StructuredEditTask> = {}): StructuredEditTask {
  return {
    id: 'test-task',
    title: 'Test task',
    instruction: 'Fix task.ts.',
    taskClass: 'authoring',
    sourcePath: 'structured-edit/x/source.ts',
    inputPath: 'structured-edit/x/input.ts',
    expectedPath: 'structured-edit/x/expected.ts',
    mutation: { kind: 'swap-comparison', candidateIndex: 0, from: '<=', to: '<' },
    tags: ['structured-edit'],
    ...overrides,
  };
}

function runnerFixtureJail({
  events = [],
  malformedLines = 0,
}: {
  events?: unknown[];
  malformedLines?: number;
} = {}) {
  return {
    seedTempHome(path: string) {
      mkdirSync(path, { recursive: true });
      return path;
    },
    buildWorkerLaunch({ worktree, tempHome }: { worktree: string; tempHome: string }) {
      return {
        argv: ['fixture-worker', resolve(worktree, 'task.ts')],
        env: { HOME: tempHome, TMPDIR: resolve(tempHome, 'tmp') },
        settings: {
          filesystem: { allowWrite: [worktree] },
          network: { allowedDomains: ['api.example.test'] },
        },
      };
    },
    parseWorkerOutputText() {
      const parsedEvents = events.length > 0 ? events : [{ type: 'result' }];
      return {
        usage: { input_tokens: 5, output_tokens: 1 },
        events: parsedEvents,
        format: 'stream-json',
        eventCount: parsedEvents.length,
        malformedLines,
        final: { is_error: false },
        model: 'fixture-model-v1',
        durationMs: 10,
        totalCostUsd: 0.001,
      };
    },
  };
}

describe('structured-edit corpus (#2296)', () => {
  it('loads a unique, three-class, pinned-MIT manifest', () => {
    expect(CORPUS).not.toBeNull();
    expect(CORPUS?.tasks).toHaveLength(6);
    expect(new Set(CORPUS?.tasks.map((entry) => entry.id)).size).toBe(6);
    expect(new Set(CORPUS?.tasks.map((entry) => entry.taskClass))).toEqual(
      new Set(['authoring', 'mechanical', 'review'])
    );
    expect(CORPUS?.provenance).toMatchObject({
      method: 'adapted',
      license: 'MIT',
      upstreamCommit: 'afc79e4cda8c5308c4d4d7290acb250e040a3f3c',
      noticePath: 'oh-my-pi-NOTICE.md',
    });
  });

  it('fails closed on path traversal, malformed mutations, and missing class coverage', () => {
    const raw = JSON.parse(MANIFEST_TEXT);
    raw.tasks[0].sourcePath = '../secret.ts';
    expect(parseStructuredEditCorpus(raw)).toBeNull();

    const badMutation = JSON.parse(MANIFEST_TEXT);
    badMutation.tasks[0].mutation.candidateIndex = -1;
    expect(parseStructuredEditCorpus(badMutation)).toBeNull();

    const unpinnedProvenance = JSON.parse(MANIFEST_TEXT);
    unpinnedProvenance.provenance.upstreamCommit = 'main';
    expect(parseStructuredEditCorpus(unpinnedProvenance)).toBeNull();

    const missingClass = JSON.parse(MANIFEST_TEXT);
    missingClass.tasks = missingClass.tasks.filter(
      (entry: { taskClass: string }) => entry.taskClass !== 'review'
    );
    expect(parseStructuredEditCorpus(missingClass)).toBeNull();
  });

  it('replays every Babel mutation to the committed one-bug input bytes', () => {
    expect(CORPUS).not.toBeNull();
    for (const entry of CORPUS?.tasks ?? []) {
      const source = readFileSync(resolve(CORPUS_ROOT, entry.sourcePath), 'utf8');
      const input = readFileSync(resolve(CORPUS_ROOT, entry.inputPath), 'utf8');
      const expected = readFileSync(resolve(CORPUS_ROOT, entry.expectedPath), 'utf8');
      const applied = applyStructuredEditMutation(source, entry.mutation);
      expect(applied.content, entry.id).toBe(input);
      expect(input, entry.id).not.toBe(expected);
      expect(source, entry.id).toBe(expected);
      expect(applied.lineNumber, entry.id).toBeGreaterThan(0);
      expect(applied.originalSnippet, entry.id).not.toBe(applied.mutatedSnippet);
    }
  });

  it('detects mutation selector drift instead of silently editing another node', () => {
    expect(() =>
      applyStructuredEditMutation('export const n = 1 < 2;\n', {
        kind: 'swap-comparison',
        candidateIndex: 0,
        from: '>=',
        to: '>',
      })
    ).toThrow(/drifted/i);
    expect(() =>
      applyStructuredEditMutation('export const n = 1 < 2;\n', {
        kind: 'swap-comparison',
        candidateIndex: 2,
        from: '<',
        to: '<=',
      })
    ).toThrow(/unavailable/i);
  });

  it('mutates the Babel operator token without rewriting matching comment text', () => {
    const beforeOperator = 'export const ok = left /* && */ && right;\n';
    const afterOperator = 'export const ok = left && /* && */ right;\n';
    const mutation = {
      kind: 'swap-logical' as const,
      candidateIndex: 0,
      from: '&&',
      to: '||',
    };

    expect(applyStructuredEditMutation(beforeOperator, mutation).content).toBe(
      'export const ok = left /* && */ || right;\n'
    );
    expect(applyStructuredEditMutation(afterOperator, mutation).content).toBe(
      'export const ok = left || /* && */ right;\n'
    );
  });
});

describe('structured-edit scorer', () => {
  it('reports literal byte equality separately from the normalized quality gate', async () => {
    const expected = 'export const n = 1;\n';
    expect(await scoreStructuredEdit(expected, expected)).toMatchObject({
      byte_exact_match: true,
      normalized_exact_match: true,
      normalized_match: true,
      verification_passed: true,
      comparison: 'byte-exact',
    });

    const oneBlankLine = 'export const n = 1;\n\n';
    const extraBlankLines = 'export const n = 1;\n\n\n\n';
    expect(await scoreStructuredEdit(oneBlankLine, extraBlankLines)).toMatchObject({
      byte_exact_match: false,
      normalized_exact_match: false,
      normalized_match: true,
      verification_passed: true,
      comparison: 'prettier-equivalent',
    });
  });

  it('uses Prettier equivalence as a fallback and keeps indent score diagnostic-only', async () => {
    const expected =
      'export const add = (left: number, right: number): number => left + right;\n';
    const reformatted = [
      'export const add = (',
      'left: number,',
      'right: number',
      '): number => left + right;',
      '',
    ].join('\n');
    const score = await scoreStructuredEdit(expected, reformatted);
    expect(score).toMatchObject({
      byte_exact_match: false,
      normalized_exact_match: false,
      normalized_match: true,
      verification_passed: true,
      comparison: 'prettier-equivalent',
    });
    expect(score.indent_score).toBeGreaterThanOrEqual(0);

    const wrong = await scoreStructuredEdit(expected, expected.replace('+', '-'));
    expect(wrong.verification_passed).toBe(false);
    expect(wrong.comparison).toBe('mismatch');
  });

  it('never erases semantically meaningful whitespace inside string literals', async () => {
    const expected = 'export const label = "a b";\n';
    const actual = 'export const label = "ab";\n';
    const score = await scoreStructuredEdit(expected, actual);
    expect(score.normalized_exact_match).toBe(false);
    expect(score.normalized_match).toBe(false);
    expect(score.verification_passed).toBe(false);
  });

  it('never normalizes semantic blank lines or indentation inside template literals', async () => {
    const expected = 'export const message = `a\n\nb`;\n';
    const extraBlankLines = 'export const message = `a\n\n\n\nb`;\n';
    const changedIndentation = 'export const message = `a\n  \nb`;\n';

    for (const actual of [extraBlankLines, changedIndentation]) {
      const score = await scoreStructuredEdit(expected, actual);
      expect(score.normalized_exact_match).toBe(false);
      expect(score.normalized_match).toBe(false);
      expect(score.verification_passed).toBe(false);
      expect(score.comparison).toBe('mismatch');
    }
  });

  it('does not let Prettier erase runtime-significant tagged-template raw bytes', async () => {
    const expected =
      "const css = (strings: TemplateStringsArray) => strings.raw[0];\n" +
      "export const value = css`a{color:red}`;\n";
    const actual =
      "const css = (strings: TemplateStringsArray) => strings.raw[0];\n" +
      "export const value = css`a { color: red; }`;\n";

    expect(await scoreStructuredEdit(expected, actual)).toMatchObject({
      normalized_exact_match: false,
      normalized_match: false,
      verification_passed: false,
      comparison: 'mismatch',
    });
  });
});

describe('structured-edit receipt contract', () => {
  it('keeps the committed jailed model receipt reproducible against its pinned inputs', async () => {
    const receipt = JSON.parse(readFileSync(RECEIPT_PATH, 'utf8'));
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      kind: 'structured-edit-model-eval',
      source: 'model-eval',
      model_id: 'claude-haiku-4-5',
      execution: {
        mode: 'jailed-model',
        jail: 'srt',
        egress: 'model-only',
        max_budget_usd: 0.1,
      },
      completion: {
        status: 'complete',
        selected_tasks: 6,
        completed_tasks: 6,
      },
      // The generation that PRODUCED this run, never re-stamped. This paid run
      // predates #3093, so it stays at 3 even though the current contract is 4:
      // re-stamping it would erase the only signal separating a generation-3
      // `read_calls` (shell evidence counted) from a generation-4 one.
      runner: { version: 3 },
      totals: {
        n: 6,
        byte_exact_matches: 6,
        verification_passes: 6,
        edit_attempts: 6,
        edit_successes: 6,
        ghost_runs: 0,
        transport_failures: 0,
        retries_used: 0,
      },
    });
    expect(receipt.tasks).toHaveLength(6);
    expect(receipt.by_task_class.map((entry: { n: number }) => entry.n)).toEqual([2, 2, 2]);
    expect(receipt.tasks.every((entry: { telemetry: { resolved_model_id: string } }) =>
      entry.telemetry.resolved_model_id === 'claude-haiku-4-5-20251001'
    )).toBe(true);
    expect(receipt.corpus.manifest_sha256).toBe(sha256(MANIFEST_TEXT));
    // A receipt may be older than the current contract but never newer: a
    // version above RUNNER_VERSION is a generation this code cannot honour.
    expect(receipt.runner.version).toBeLessThanOrEqual(RUNNER_VERSION);
    // Why a superseded receipt needs no paid re-run, stated as a check rather
    // than a judgement: generation 4 changed only how SHELL evidence is
    // classified, and this receipt records none. Every event it holds is a
    // literal read or edit, which both generations classify identically — so
    // its recorded numbers are the numbers the current code produces, as the
    // re-derivation below then proves. A receipt carrying shell evidence would
    // not land here; its counters would stop matching and it would fail.
    for (const entry of receipt.tasks) {
      for (const attempt of entry.attempts) {
        for (const event of attempt.tool_events) {
          if (event.type !== 'tool_use') continue;
          expect(event.name).toMatch(/^(read|edit)$/);
          expect(event.input.read_evidence).toBeUndefined();
        }
      }
    }
    // Recorded runner/scorer hashes are as-of-run provenance and are checked
    // for shape only. Comparing them to the working tree froze both files: any
    // byte change, including a comment, demanded a fresh paid model run. The
    // reproducibility claim is carried instead by the re-derivation below.
    expect(receipt.runner.script_path).toBe('scripts/model-eval-run.mjs');
    expect(receipt.runner.script_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.runner.scorer_path).toBe('scripts/lib/model-edit-benchmark.ts');
    expect(receipt.runner.scorer_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.runner.jail).toMatchObject({
      gate: { ok: true, reason: null },
      modules: [
        { name: 'sandbox', path: '~/.claude/shadow-calls/lib/sandbox.mjs' },
        { name: 'worker-output', path: '~/.claude/shadow-calls/lib/worker-output.mjs' },
        { name: 'file-evidence', path: '~/.claude/shadow-calls/lib/file-evidence.mjs' },
        { name: 'killswitch', path: '~/.claude/shadow-calls/lib/killswitch.mjs' },
      ],
    });
    for (const module of receipt.runner.jail.modules) {
      expect(module.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(receipt.runner.jail.binaries.map((entry: { name: string }) => entry.name)).toEqual([
      'srt',
      'claude',
    ]);
    for (const binary of receipt.runner.jail.binaries) {
      expect(binary.path).toMatch(/^~\//);
      expect(binary.version).toEqual(expect.any(String));
      expect(binary.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const entry of receipt.tasks) {
      expect(entry.attempts).toHaveLength(1);
      const attempt = entry.attempts[0];
      expect(attempt).toMatchObject({
        attempt: 1,
        phase: 'worker',
        output_parsed: true,
        parser: { format: 'stream-json', malformed_lines: 0 },
        telemetry: { telemetry_complete: true },
      });
      expect(attempt.parser.event_count).toBeGreaterThan(0);
      expect(attempt.worker_output_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(attempt.worker_stderr_sha256).toMatch(/^[0-9a-f]{64}$/);
      // Every counter the attempt claims is recomputed by the current runner
      // from the evidence the attempt itself records.
      expect(attempt.telemetry).toEqual(replayAttemptTelemetry(attempt));
      expect(attempt.launch.argv_sha256).toBe(sha256(JSON.stringify(attempt.launch.argv)));
      expect(attempt.launch.settings_sha256).toBe(
        sha256(JSON.stringify(attempt.launch.settings))
      );
    }

    // Re-derive the whole receipt: feed the recorded inputs back through the
    // CURRENT runner, scorer, and fold, and require the recorded outputs to
    // come back out. Only the model call itself is unrepeatable; its produced
    // bytes are pinned by the recorded hashes.
    if (!CORPUS) throw new Error('corpus manifest did not parse; nothing to re-derive against');
    const runs = [];
    for (const recorded of receipt.tasks) {
      const task = CORPUS.tasks.find((entry) => entry.id === recorded.task_id);
      if (!task) throw new Error(`receipt task is not in the corpus: ${recorded.task_id}`);

      // Input side: the mutated file the model was handed is regenerated from
      // the committed source by the current Babel mutation.
      const source = readFileSync(resolve(CORPUS_ROOT, task.sourcePath), 'utf8');
      const expectedText = readFileSync(resolve(CORPUS_ROOT, task.expectedPath), 'utf8');
      const input = applyStructuredEditMutation(source, task.mutation).content;
      expect(input).toBe(readFileSync(resolve(CORPUS_ROOT, task.inputPath), 'utf8'));
      expect(sha256(input)).toBe(recorded.input_sha256);
      expect(sha256(expectedText)).toBe(recorded.expected_sha256);
      // The corpus must still be a repair challenge under the current scorer.
      // Without this, a scorer that passed everything would "reproduce" an
      // all-passing receipt.
      expect(await scoreStructuredEdit(expectedText, input, 'task.ts')).toMatchObject({
        verification_passed: false,
        comparison: 'mismatch',
      });

      // Output side: the receipt records the produced bytes only as a hash, so
      // they are recoverable exactly when the run was byte-exact. A task that
      // is not byte-exact must fail loudly here rather than be waved through —
      // such a receipt has to carry its produced bytes to stay replayable.
      expect(recorded.byte_exact_match).toBe(true);
      expect(recorded.actual_sha256).toBe(recorded.expected_sha256);
      const produced = expectedText;
      const score = await scoreStructuredEdit(expectedText, produced, 'task.ts');

      const attempts = recorded.attempts.map(
        (attempt: { score: unknown; telemetry: unknown }) => ({
          ...attempt,
          score,
          telemetry: replayAttemptTelemetry(attempt),
        })
      );
      const telemetry = attempts
        .map((attempt: { telemetry: StructuredEditRunTelemetry }) => attempt.telemetry)
        .reduce((left: StructuredEditRunTelemetry, right: StructuredEditRunTelemetry) =>
          mergeStructuredEditTelemetry(left, right)
        );
      runs.push(
        buildStructuredEditTaskResult({
          task,
          modelId: receipt.model_id,
          inputSha256: sha256(input),
          score,
          telemetry,
          attempts,
        })
      );
    }

    expect(
      buildStructuredEditEvalResult({
        modelId: receipt.model_id,
        corpus: CORPUS,
        runs,
        manifestSha256: sha256(MANIFEST_TEXT),
        // Provenance the run measured and this replay cannot recompute: the
        // wall-clock stamp, the jail/binary identities, and the as-of-run file
        // hashes. Everything scored is re-derived above.
        runner: receipt.runner,
        execution: receipt.execution,
        completion: receipt.completion,
        createdAt: receipt.createdAt,
      })
    ).toEqual(receipt);
  });

  it('ties the contract generation to what the classifier does, not to what the code declares', () => {
    const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));

    // RUNNER_VERSION is a hand-maintained integer, so on its own it proves
    // nothing: #3093 changed what `read_calls` means while every receipt went
    // on claiming generation 3, and no test noticed. The digest is the part
    // that cannot be faked by declaration — it is computed from the
    // classifier's behaviour over the committed battery, so it moves when
    // meaning moves and holds still for comments and refactors.
    expect(contract.semantics_digest).toBe(toolClassificationDigest(contract.cases));
    expect(contract.version).toBe(RUNNER_VERSION);
    expect(contract.generations.at(-1).version).toBe(RUNNER_VERSION);

    // The battery has to actually cover the surface that moved, or the digest
    // is a fingerprint of nothing. Generation 3 counted this shell evidence as
    // a successful task read; generation 4 must not.
    const generationThreeShell = contract.cases.find(
      (entry: { id: string }) => entry.id === 'replay-of-generation-3-shell-evidence'
    );
    expect(toolTelemetry(generationThreeShell.events)).toMatchObject({
      read: 0,
      unknownReads: 1,
    });
  });

  it('rejects a receipt whose counters were scored under the previous contract', () => {
    const receipt = JSON.parse(readFileSync(RECEIPT_PATH, 'utf8'));
    // A hypothetical generation-3 receipt, constructed here rather than
    // committed: the same run plus one shell command, counted the way
    // generation 3 counted it (read_calls 2, because the token `task.ts` in a
    // command was taken to prove inspection).
    const attempt = structuredClone(receipt.tasks[0].attempts[0]);
    attempt.tool_events = [
      ...attempt.tool_events,
      { type: 'tool_use', id: 'tool-3', name: 'bash', input: { task_path: true } },
      { type: 'tool_result', tool_use_id: 'tool-3', is_error: false },
    ];
    attempt.telemetry = { ...attempt.telemetry, read_calls: 2 };

    // Under the current contract that claim no longer follows from the
    // evidence, so the receipt fails instead of being carried forward as if
    // its numbers still meant what they did when they were written.
    expect(replayAttemptTelemetry(attempt)).toMatchObject({ read_calls: 1 });
    expect(attempt.telemetry).not.toEqual(replayAttemptTelemetry(attempt));
  });

  it('keeps task quality, edit-tool success, ghosts, and read-without-edit distinct', async () => {
    const expected = 'export const ok = true;\n';
    const passed = await scoreStructuredEdit(expected, expected);
    const failed = await scoreStructuredEdit(expected, 'export const ok = false;\n');

    const toolSuccess = buildStructuredEditTaskResult({
      task: task(),
      modelId: 'model-a',
      inputSha256: 'b'.repeat(64),
      score: passed,
      telemetry: telemetry({
        read_calls: 1,
        edit_calls: 2,
        edit_successes: 1,
        edit_failures: 1,
      }),
    });
    expect(toolSuccess).toMatchObject({
      verification_passed: true,
      edit_success: true,
      edit_attempts: 2,
      edit_successes: 1,
      ghost_run: false,
      read_without_edit: false,
      zero_activity_run: false,
    });

    const noEdit = buildStructuredEditTaskResult({
      task: task(),
      modelId: 'model-a',
      inputSha256: 'b'.repeat(64),
      score: failed,
      telemetry: telemetry({ read_calls: 1, retries_used: 1 }),
    });
    expect(noEdit).toMatchObject({
      verification_passed: false,
      edit_success: false,
      ghost_run: true,
      read_without_edit: true,
      zero_activity_run: false,
      retries_used: 1,
    });

    const ghost = buildStructuredEditTaskResult({
      task: task(),
      modelId: 'model-a',
      inputSha256: 'b'.repeat(64),
      score: failed,
      telemetry: telemetry(),
    });
    expect(ghost.ghost_run).toBe(false);
    expect(ghost.read_without_edit).toBe(false);
    expect(ghost.zero_activity_run).toBe(true);

    const unknownActivity = buildStructuredEditTaskResult({
      task: task(),
      modelId: 'model-a',
      inputSha256: 'b'.repeat(64),
      score: failed,
      telemetry: telemetry({
        read_calls: 1,
        telemetry_complete: false,
        transport_failure: true,
      }),
    });
    expect(unknownActivity.zero_activity_run).toBe(false);
    expect(unknownActivity.read_without_edit).toBe(false);
    expect(unknownActivity.ghost_run).toBe(false);
  });

  it('preserves a ghosted attempt when a later retry succeeds', async () => {
    const expected = 'export const ok = true;\n';
    const score = await scoreStructuredEdit(expected, expected);
    const aggregate = mergeStructuredEditTelemetry(
      telemetry({
        input_tokens: 20,
        read_calls: 1,
        read_without_edit_attempts: 1,
      }),
      telemetry({
        input_tokens: 30,
        read_calls: 1,
        edit_calls: 1,
        edit_successes: 1,
        retries_used: 1,
      })
    );
    const result = buildStructuredEditTaskResult({
      task: task(),
      modelId: 'model-a',
      inputSha256: 'b'.repeat(64),
      score,
      telemetry: aggregate,
    });

    expect(result).toMatchObject({
      verification_passed: true,
      ghost_run: false,
      read_without_edit: false,
      read_without_edit_attempts: 1,
      retries_used: 1,
    });
    expect(result.telemetry.read_without_edit_attempts).toBe(1);
    expect(summarizeStructuredEditByTaskClass([result])[0]).toMatchObject({
      ghost_runs: 0,
      read_without_edit_runs: 0,
      read_without_edit_attempts: 1,
    });
  });

  it('rolls quality and tool reliability up per task class with honest denominators', async () => {
    const expected = 'export const ok = true;\n';
    const passed = await scoreStructuredEdit(expected, expected);
    const failed = await scoreStructuredEdit(expected, 'export const ok = false;\n');
    const runs: StructuredEditTaskResult[] = [
      buildStructuredEditTaskResult({
        task: task({ id: 'a', taskClass: 'authoring' }),
        modelId: 'model-a',
        inputSha256: 'b'.repeat(64),
        score: passed,
        telemetry: telemetry({ edit_calls: 1, edit_successes: 1 }),
      }),
      buildStructuredEditTaskResult({
        task: task({ id: 'm', taskClass: 'mechanical' }),
        modelId: 'model-a',
        inputSha256: 'b'.repeat(64),
        score: failed,
        telemetry: telemetry({ read_calls: 1, retries_used: 2 }),
      }),
      buildStructuredEditTaskResult({
        task: task({ id: 'r', taskClass: 'review' }),
        modelId: 'model-a',
        inputSha256: 'b'.repeat(64),
        score: passed,
        telemetry: telemetry({ edit_calls: 2, edit_successes: 1, edit_failures: 1 }),
      }),
    ];
    const byClass = summarizeStructuredEditByTaskClass(runs);
    expect(byClass.map((entry) => entry.task_class)).toEqual([
      'authoring',
      'mechanical',
      'review',
    ]);
    expect(byClass[0]).toMatchObject({ n: 1, verification_rate: 1, edit_success_rate: 1 });
    expect(byClass[1]).toMatchObject({
      n: 1,
      verification_rate: 0,
      edit_success_rate: null,
      read_without_edit_runs: 1,
      ghost_runs: 1,
      zero_activity_runs: 0,
      retries_used: 2,
    });
    expect(byClass[2]).toMatchObject({
      n: 1,
      verification_rate: 1,
      edit_attempts: 2,
      edit_successes: 1,
      edit_success_rate: 0.5,
    });

    const emptyClasses = summarizeStructuredEditByTaskClass([runs[0]]);
    expect(emptyClasses[1]).toMatchObject({
      task_class: 'mechanical',
      n: 0,
      verification_rate: null,
      edit_success_rate: null,
    });

    expect(CORPUS).not.toBeNull();
    const receipt = buildStructuredEditEvalResult({
      modelId: 'model-a',
      corpus: CORPUS!,
      runs,
      manifestSha256: 'a'.repeat(64),
      execution: {
        mode: 'jailed-model',
        jail: 'srt',
        egress: 'model-only',
        max_budget_usd: 0.25,
      },
      runner: {
        version: 3,
        script_path: 'scripts/model-eval-run.mjs',
        script_sha256: 'c'.repeat(64),
        scorer_path: 'scripts/lib/model-edit-benchmark.ts',
        scorer_sha256: 'd'.repeat(64),
        jail: null,
      },
      createdAt: '2026-07-10T00:00:00.000Z',
    });
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      kind: 'structured-edit-model-eval',
      source: 'model-eval',
      model_id: 'model-a',
      totals: { n: 3, verification_passes: 2, edit_attempts: 3, edit_successes: 2 },
      execution: { jail: 'srt', egress: 'model-only' },
    });
  });
});

describe('model-eval live-runner reliability', () => {
  it('passes only allowlisted execution/locale/home keys to the worker child', async () => {
    expect(
      workerEnvironment(
        {
          HOME: '/jail/home',
          TMPDIR: '/jail/tmp',
          GITHUB_TOKEN: 'override-must-not-pass',
        },
        {
          PATH: '/fixture/bin',
          LANG: 'C.UTF-8',
          ANTHROPIC_API_KEY: 'host-key-must-not-pass',
          DATABASE_SECRET: 'host-secret-must-not-pass',
        }
      )
    ).toEqual({
      PATH: '/fixture/bin',
      HOME: '/jail/home',
      TMPDIR: '/jail/tmp',
      LANG: 'C.UTF-8',
    });

    const secretKeys = ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'DATABASE_SECRET'];
    const previous = Object.fromEntries(secretKeys.map((key) => [key, process.env[key]]));
    for (const key of secretKeys) process.env[key] = 'fixture-never-print-this';
    try {
      const result = await spawnWorker(
        [
          process.execPath,
          '--input-type=commonjs',
          '-e',
          `process.stdout.write(JSON.stringify({` +
            `token:Object.hasOwn(process.env,'ANTHROPIC_API_KEY'),` +
            `key:Object.hasOwn(process.env,'GITHUB_TOKEN'),` +
            `secret:Object.hasOwn(process.env,'DATABASE_SECRET'),` +
            `home:process.env.HOME==='${tmpdir().replaceAll('\\', '\\\\')}'` +
            `}))`,
        ],
        {
          HOME: tmpdir(),
          TMPDIR: tmpdir(),
          ANTHROPIC_API_KEY: 'override-never-print-this',
        },
        5_000,
        50
      );
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        token: false,
        key: false,
        secret: false,
        home: true,
      });
    } finally {
      for (const key of secretKeys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  it('counts Edit, MultiEdit, and Write results in mutating-tool reliability', async () => {
    const counts = toolTelemetry([
      {
        content: [
          {
            type: 'tool_use',
            name: 'MultiEdit',
            id: 'multi-1',
            input: { file_path: 'task.ts' },
          },
          { type: 'tool_result', tool_use_id: 'multi-1' },
          {
            type: 'tool_use',
            name: 'mcp__editor__multi_edit',
            id: 'multi-2',
            input: { file_path: 'task.ts' },
          },
          { type: 'tool_result', tool_use_id: 'multi-2', is_error: true },
          {
            type: 'tool_use',
            name: 'Write',
            id: 'write-1',
            input: { file_path: 'task.ts' },
          },
          { type: 'tool_result', tool_use_id: 'write-1' },
          {
            type: 'tool_use',
            name: 'mcp__editor__write',
            id: 'write-2',
            input: { file_path: 'task.ts' },
          },
          { type: 'tool_result', tool_use_id: 'write-2', is_error: true },
        ],
      },
    ]);

    expect(counts).toEqual({
      read: 0,
      unknownReads: 0,
      edit: 2,
      write: 2,
      editSuccesses: 1,
      editFailures: 1,
      writeSuccesses: 1,
      writeFailures: 1,
    });

    const expected = 'export const ok = true;\n';
    const writeRepair = buildStructuredEditTaskResult({
      task: task(),
      modelId: 'model-a',
      inputSha256: 'b'.repeat(64),
      score: await scoreStructuredEdit(expected, expected),
      telemetry: telemetry({
        write_calls: 2,
        write_successes: 1,
        write_failures: 1,
      }),
    });
    expect(writeRepair).toMatchObject({
      verification_passed: true,
      edit_success: true,
      edit_attempts: 2,
      edit_successes: 1,
    });
    expect(summarizeStructuredEditByTaskClass([writeRepair])[0]).toMatchObject({
      edit_attempts: 2,
      edit_successes: 1,
      edit_success_rate: 0.5,
    });
  });

  it('counts only successful task.ts reads and task.ts-targeted mutations', async () => {
    const events = [
      {
        content: [
          {
            type: 'tool_use',
            name: 'Read',
            id: 'other-read',
            input: { file_path: 'notes.ts' },
          },
          { type: 'tool_result', tool_use_id: 'other-read', is_error: false },
          {
            type: 'tool_use',
            name: 'Read',
            id: 'failed-read',
            input: { file_path: 'task.ts' },
          },
          { type: 'tool_result', tool_use_id: 'failed-read', is_error: true },
          {
            type: 'tool_use',
            name: 'Read',
            id: 'task-read',
            input: { file_path: 'task.ts' },
          },
          { type: 'tool_result', tool_use_id: 'task-read', is_error: false },
          {
            type: 'tool_use',
            name: 'Edit',
            id: 'other-edit',
            input: { file_path: 'notes.ts' },
          },
          { type: 'tool_result', tool_use_id: 'other-edit', is_error: false },
        ],
      },
    ];

    const counts = toolTelemetry(events);
    expect(counts).toEqual({
      read: 1,
      unknownReads: 0,
      edit: 0,
      write: 0,
      editSuccesses: 0,
      editFailures: 0,
      writeSuccesses: 0,
      writeFailures: 0,
    });
    expect(sanitizeToolEvidence(events)).toEqual([
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'read',
        input: { task_path: false },
      },
      { type: 'tool_result', tool_use_id: 'tool-1', is_error: false },
      {
        type: 'tool_use',
        id: 'tool-2',
        name: 'read',
        input: { task_path: true },
      },
      { type: 'tool_result', tool_use_id: 'tool-2', is_error: true },
      {
        type: 'tool_use',
        id: 'tool-3',
        name: 'read',
        input: { task_path: true },
      },
      { type: 'tool_result', tool_use_id: 'tool-3', is_error: false },
      {
        type: 'tool_use',
        id: 'tool-4',
        name: 'edit',
        input: { task_path: false },
      },
      { type: 'tool_result', tool_use_id: 'tool-4', is_error: false },
    ]);

    const expected = 'export const ok = true;\n';
    const result = buildStructuredEditTaskResult({
      task: task(),
      modelId: 'model-a',
      inputSha256: 'b'.repeat(64),
      score: await scoreStructuredEdit(expected, 'export const ok = false;\n'),
      telemetry: telemetry({
        read_calls: counts.read,
        edit_calls: counts.edit,
        write_calls: counts.write,
      }),
    });
    expect(result).toMatchObject({
      edit_attempts: 0,
      edit_successes: 0,
      edit_success: false,
      read_without_edit: true,
      ghost_run: true,
    });
  });

  it('counts structured search inspection of task.ts and keeps only recomputable evidence', async () => {
    const events = [
      {
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              id: 'bash-secret-id',
              input: { command: 'sed -n "1,20p" task.ts', description: 'contains private text' },
            },
            {
              type: 'tool_use',
              name: 'mcp__search__grep',
              id: 'grep-secret-id',
              input: { pattern: 'private pattern', path: './task.ts' },
            },
            { type: 'tool_use', name: 'Bash', id: 'other', input: { command: 'pwd' } },
            { type: 'tool_result', tool_use_id: 'bash-secret-id', is_error: false },
            { type: 'tool_result', tool_use_id: 'grep-secret-id', is_error: false },
          ],
        },
      },
    ];

    // The shell command may well have read task.ts, but the receipt cannot tell
    // that from the token, so it is bucketed unknown rather than claimed (#3093).
    expect(toolTelemetry(events)).toMatchObject({ read: 1, unknownReads: 1 });
    const sanitized = sanitizeToolEvidence(events);
    expect(sanitized).toEqual([
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'bash',
        input: { task_path: false, read_evidence: 'unknown' },
      },
      {
        type: 'tool_use',
        id: 'tool-2',
        name: 'mcp__search__grep',
        input: { task_path: true },
      },
      { type: 'tool_result', tool_use_id: 'tool-1', is_error: false },
      { type: 'tool_result', tool_use_id: 'tool-2', is_error: false },
    ]);
    expect(JSON.stringify(sanitized)).not.toContain('private');
    expect(toolTelemetry([{ content: sanitized }])).toMatchObject({
      read: 1,
      unknownReads: 1,
    });

    const noEditAttempt = await runJailedAttempt({
      jail: runnerFixtureJail({ events }),
      task: task(),
      committed: {
        input: 'export const ok = false;\n',
        expected: 'export const ok = true;\n',
        inputSha256: 'b'.repeat(64),
      },
      model: 'fixture-model',
      maxBudgetUsd: 0.01,
      retryNumber: 0,
      spawnWorkerFn: async () => ({
        code: 0,
        signal: null,
        stdout: '{}',
        stderr: '',
        timedOut: false,
        timeoutReason: null,
      }),
    });
    expect(noEditAttempt.telemetry).toMatchObject({
      read_calls: 1,
      edit_calls: 0,
      write_calls: 0,
      read_without_edit_attempts: 1,
    });
    expect(noEditAttempt.evidence.launch).toMatchObject({
      launcher: 'fixture-worker',
      env_override_keys: ['HOME', 'TMPDIR'],
      effective_env_keys: expect.arrayContaining(['HOME', 'TMPDIR']),
      settings: { filesystem: { allowWrite: ['<worktree>'] } },
    });
    expect(JSON.stringify(noEditAttempt.evidence)).not.toContain('chd-model-edit-');
  });

  it('never infers a task.ts read from a shell command token (#3093)', async () => {
    const attemptFor = async (events: unknown[]) =>
      runJailedAttempt({
        jail: runnerFixtureJail({ events }),
        task: task(),
        committed: {
          input: 'export const ok = false;\n',
          expected: 'export const ok = true;\n',
          inputSha256: 'b'.repeat(64),
        },
        model: 'fixture-model',
        maxBudgetUsd: 0.01,
        retryNumber: 0,
        spawnWorkerFn: async () => ({
          code: 0,
          signal: null,
          stdout: '{}',
          stderr: '',
          timedOut: false,
          timeoutReason: null,
        }),
      });

    // A shell command that merely names the file inspected nothing.
    const echoEvents = [
      {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            id: 'echo-1',
            input: { command: 'echo task.ts' },
          },
          { type: 'tool_result', tool_use_id: 'echo-1', is_error: false },
        ],
      },
    ];
    expect(toolTelemetry(echoEvents)).toMatchObject({ read: 0, unknownReads: 1 });
    const echoAttempt = await attemptFor(echoEvents);
    expect(echoAttempt.telemetry).toMatchObject({
      read_calls: 0,
      read_without_edit_attempts: 0,
    });
    // The unknown evidence is carried in the receipt, not attributed, and a
    // replay of that receipt must not re-promote it to a read.
    expect(echoAttempt.evidence.tool_events).toEqual([
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'bash',
        input: { task_path: false, read_evidence: 'unknown' },
      },
      { type: 'tool_result', tool_use_id: 'tool-1', is_error: false },
    ]);
    expect(replayAttemptTelemetry(echoAttempt.evidence)).toMatchObject({
      read_calls: 0,
      read_without_edit_attempts: 0,
    });

    // A recognized read of the task file still counts.
    const readAttempt = await attemptFor([
      {
        content: [
          {
            type: 'tool_use',
            name: 'Read',
            id: 'read-1',
            input: { file_path: 'task.ts' },
          },
          { type: 'tool_result', tool_use_id: 'read-1', is_error: false },
        ],
      },
    ]);
    expect(readAttempt.telemetry).toMatchObject({
      read_calls: 1,
      read_without_edit_attempts: 1,
    });

    // A failed read result stays uncounted in both buckets.
    const failedEvents = [
      {
        content: [
          {
            type: 'tool_use',
            name: 'Read',
            id: 'read-2',
            input: { file_path: 'task.ts' },
          },
          { type: 'tool_result', tool_use_id: 'read-2', is_error: true },
          {
            type: 'tool_use',
            name: 'Bash',
            id: 'echo-2',
            input: { command: 'printf task.ts' },
          },
          { type: 'tool_result', tool_use_id: 'echo-2', is_error: true },
        ],
      },
    ];
    expect(toolTelemetry(failedEvents)).toMatchObject({ read: 0, unknownReads: 0 });
    const failedAttempt = await attemptFor(failedEvents);
    expect(failedAttempt.telemetry).toMatchObject({
      read_calls: 0,
      read_without_edit_attempts: 0,
    });
  });

  it('does not double-count mirrored top-level and message tool content', () => {
    const parts = [
      { type: 'tool_use', name: 'Read', id: 'read-1', input: { file_path: 'task.ts' } },
      { type: 'tool_result', tool_use_id: 'read-1', is_error: false },
      { type: 'tool_use', name: 'Edit', id: 'edit-1', input: { file_path: 'task.ts' } },
      { type: 'tool_result', tool_use_id: 'edit-1', is_error: false },
    ];
    const mirrored = [{ content: parts, message: { content: structuredClone(parts) } }];

    expect(toolTelemetry(mirrored)).toEqual({
      read: 1,
      unknownReads: 0,
      edit: 1,
      write: 0,
      editSuccesses: 1,
      editFailures: 0,
      writeSuccesses: 0,
      writeFailures: 0,
    });
    expect(sanitizeToolEvidence(mirrored)).toHaveLength(4);
  });

  it('marks partially parsed JSONL telemetry incomplete and records parser evidence', async () => {
    const events = [
      {
        message: {
          content: [
            { type: 'tool_use', name: 'Read', id: 'read-1', input: { file_path: 'task.ts' } },
            { type: 'tool_result', tool_use_id: 'read-1', is_error: false },
          ],
        },
      },
    ];
    const attempt = await runJailedAttempt({
      jail: runnerFixtureJail({ events, malformedLines: 1 }),
      task: task(),
      committed: {
        input: 'export const ok = false;\n',
        expected: 'export const ok = true;\n',
        inputSha256: 'b'.repeat(64),
      },
      model: 'fixture-model',
      maxBudgetUsd: 0.01,
      retryNumber: 0,
      spawnWorkerFn: async () => ({
        code: 0,
        signal: null,
        stdout: '{"type":"assistant"}\nnot-json\n',
        stderr: '',
        timedOut: false,
        timeoutReason: null,
      }),
    });

    expect(attempt.telemetry).toMatchObject({
      input_tokens: 5,
      output_tokens: 1,
      read_calls: 1,
      duration_ms: null,
      cost_usd: null,
      telemetry_complete: false,
      transport_failure: true,
      failure_reason: 'worker output contained 1 malformed JSONL line(s)',
    });
    expect(attempt.evidence).toMatchObject({
      output_parsed: true,
      parser: { format: 'stream-json', event_count: 1, malformed_lines: 1 },
      duration_ms: 10,
      cost_usd: 0.001,
      telemetry: { telemetry_complete: false, transport_failure: true },
    });
  });

  it('rejects cross-drive paths and unsafe post-worker task file types without blocking', async () => {
    expect(within('C:\\repo', 'D:\\outside\\task.ts', win32)).toBe(false);

    const root = mkdtempSync(resolve(tmpdir(), 'model-edit-safe-read-'));
    const outside = resolve(root, 'outside.ts');
    const taskPath = resolve(root, 'task.ts');
    try {
      writeFileSync(outside, 'export const ok = true;\n');
      symlinkSync(outside, taskPath);
      await expect(readLiveTaskFile(taskPath)).rejects.toThrow(/regular file/i);

      unlinkSync(taskPath);
      writeFileSync(taskPath, 'x'.repeat(MAX_LIVE_TASK_BYTES + 1));
      await expect(readLiveTaskFile(taskPath)).rejects.toThrow(/exceeds/i);

      if (process.platform !== 'win32') {
        unlinkSync(taskPath);
        execFileSync('mkfifo', [taskPath]);
        const startedAt = Date.now();
        await expect(readLiveTaskFile(taskPath)).rejects.toThrow(/regular file/i);
        expect(Date.now() - startedAt).toBeLessThan(1_000);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('hard-kills a timed-out worker process group after the grace period', async () => {
    const childScript =
      process.platform === 'win32'
        ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
        : [
            "const { spawn } = require('node:child_process');",
            "process.on('SIGTERM', () => {});",
            "spawn(process.execPath, ['--input-type=commonjs', '-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: ['ignore', 'inherit', 'inherit'] });",
            'setInterval(() => {}, 1000);',
          ].join(' ');
    const startedAt = Date.now();
    const result = await spawnWorker(
      [process.execPath, '--input-type=commonjs', '-e', childScript],
      {},
      500,
      50
    );

    expect(result).toMatchObject({
      code: null,
      signal: 'SIGKILL',
      timedOut: true,
    });
    expect(result.timeoutReason).toContain('timed out after 500ms');
    expect(Date.now() - startedAt).toBeLessThan(3_000);

    const timeoutAttempt = await runJailedAttempt({
      jail: runnerFixtureJail(),
      task: task(),
      committed: {
        input: 'export const ok = false;\n',
        expected: 'export const ok = true;\n',
        inputSha256: 'b'.repeat(64),
      },
      model: 'fixture-model',
      maxBudgetUsd: 0.01,
      retryNumber: 0,
      spawnWorkerFn: async () => result,
    });
    expect(timeoutAttempt.telemetry.transport_failure).toBe(true);
    expect(timeoutAttempt.telemetry.failure_reason).toContain('timed out after 500ms');
  });

  it.each(['stdout', 'stderr'] as const)(
    'caps worker %s by bytes and returns an explicit transport failure',
    async (stream) => {
      const childScript =
        `const out=process.${stream};` +
        `const chunk='x'.repeat(2048);` +
        `setInterval(()=>out.write(chunk),0);`;
      const startedAt = Date.now();
      const result = await spawnWorker(
        [process.execPath, '--input-type=commonjs', '-e', childScript],
        {},
        5_000,
        50,
        1_024
      );

      expect(result).toMatchObject({
        timedOut: false,
        outputLimitExceeded: true,
      });
      expect(result.outputLimitReason).toBe(
        `worker ${stream} exceeded 1024-byte limit`
      );
      expect(Buffer.byteLength(result[stream], 'utf8')).toBeLessThanOrEqual(1_024);
      expect(Date.now() - startedAt).toBeLessThan(3_000);

      const attempt = await runJailedAttempt({
        jail: runnerFixtureJail(),
        task: task(),
        committed: {
          input: 'export const ok = false;\n',
          expected: 'export const ok = true;\n',
          inputSha256: 'b'.repeat(64),
        },
        model: 'fixture-model',
        maxBudgetUsd: 0.01,
        retryNumber: 0,
        spawnWorkerFn: async () => result,
      });
      expect(attempt.telemetry.transport_failure).toBe(true);
      expect(attempt.telemetry.failure_reason).toContain(
        `worker ${stream} exceeded 1024-byte limit`
      );
    }
  );

  it('scores an unreadable task as a transport failure and retries it', async () => {
    const benchmarkTask = task();
    const committed = {
      input: 'export const ok = false;\n',
      expected: 'export const ok = true;\n',
      inputSha256: 'b'.repeat(64),
    };
    const jail = runnerFixtureJail();
    const failedAttempt = await runJailedAttempt({
      jail,
      task: benchmarkTask,
      committed,
      model: 'fixture-model',
      maxBudgetUsd: 0.01,
      retryNumber: 0,
      spawnWorkerFn: async (argv: string[]) => {
        unlinkSync(argv[1]);
        return {
          code: 0,
          signal: null,
          stdout: '{}',
          stderr: '',
          timedOut: false,
          timeoutReason: null,
        };
      },
    });

    expect(failedAttempt.score.verification_passed).toBe(false);
    expect(failedAttempt.telemetry).toMatchObject({
      transport_failure: true,
      resolved_model_id: 'fixture-model-v1',
    });
    expect(failedAttempt.telemetry.failure_reason).toContain('task.ts unreadable');

    const successfulAttempt = {
      score: await scoreStructuredEdit(committed.expected, committed.expected),
      telemetry: telemetry({
        read_calls: 1,
        edit_calls: 1,
        edit_successes: 1,
        retries_used: 1,
        resolved_model_id: 'fixture-model-v1',
      }),
      exitCode: 0,
      signal: null,
      stderr: '',
    };
    let attempts = 0;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runLiveTask({
        jail,
        task: benchmarkTask,
        committed,
        model: 'fixture-model',
        maxRetries: 1,
        maxBudgetUsd: 0.01,
        attemptRunner: async () => {
          attempts += 1;
          return attempts === 1 ? failedAttempt : successfulAttempt;
        },
      });
      expect(attempts).toBe(2);
      expect(result).toMatchObject({
        verification_passed: true,
        transport_failure: true,
        retries_used: 1,
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('preserves the best passing score when a transport retry later fails', async () => {
    const benchmarkTask = task();
    const committed = {
      input: 'export const ok = false;\n',
      expected: 'export const ok = true;\n',
      inputSha256: 'b'.repeat(64),
    };
    const passed = await scoreStructuredEdit(committed.expected, committed.expected);
    const failed = await scoreStructuredEdit(committed.expected, committed.input);
    const attemptRunner = vi
      .fn()
      .mockResolvedValueOnce({
        score: passed,
        telemetry: telemetry({
          duration_ms: 10,
          cost_usd: 0.01,
          transport_failure: true,
          failure_reason: 'worker exit was ambiguous',
        }),
      })
      .mockResolvedValueOnce({
        score: failed,
        telemetry: telemetry({ duration_ms: 20, cost_usd: 0.02, retries_used: 1 }),
      });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runLiveTask({
        jail: runnerFixtureJail(),
        task: benchmarkTask,
        committed,
        model: 'fixture-model',
        maxRetries: 1,
        maxBudgetUsd: 0.01,
        attemptRunner,
      });
      expect(result).toMatchObject({
        verification_passed: true,
        byte_exact_match: true,
        transport_failure: true,
        retries_used: 1,
        telemetry: { duration_ms: 30, cost_usd: 0.03 },
      });
      expect(attemptRunner).toHaveBeenCalledTimes(2);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('never turns unknown paid retry work into an apparently complete subtotal', () => {
    const aggregate = mergeStructuredEditTelemetry(
      telemetry({
        input_tokens: 0,
        duration_ms: null,
        cost_usd: null,
        telemetry_complete: false,
        transport_failure: true,
      }),
      telemetry({
        input_tokens: 20,
        duration_ms: 50,
        cost_usd: 0.02,
        retries_used: 1,
      })
    );

    expect(aggregate).toMatchObject({
      input_tokens: 20,
      duration_ms: null,
      cost_usd: null,
      telemetry_complete: false,
      transport_failure: true,
      retries_used: 1,
    });
  });

  it('retains earlier paid-attempt lower bounds when a later attempt throws', async () => {
    const committed = {
      input: 'export const ok = false;\n',
      expected: 'export const ok = true;\n',
      inputSha256: 'b'.repeat(64),
    };
    const failed = await scoreStructuredEdit(committed.expected, committed.input);
    const attemptRunner = vi
      .fn()
      .mockResolvedValueOnce({
        score: failed,
        telemetry: telemetry({
          input_tokens: 25,
          duration_ms: 10,
          cost_usd: 0.01,
          transport_failure: true,
          failure_reason: 'retry required',
        }),
      })
      .mockRejectedValueOnce(new Error('launch setup exploded'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runLiveTask({
        jail: runnerFixtureJail(),
        task: task(),
        committed,
        model: 'fixture-model',
        maxRetries: 1,
        maxBudgetUsd: 0.01,
        attemptRunner,
      });
      expect(result.telemetry).toMatchObject({
        input_tokens: 25,
        duration_ms: null,
        cost_usd: null,
        telemetry_complete: false,
        transport_failure: true,
        retries_used: 1,
      });
      expect(result.attempts).toMatchObject([
        {
          attempt: 2,
          phase: 'task-boundary',
          output_parsed: false,
          telemetry: { telemetry_complete: false },
        },
      ]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('continues after a task-boundary exception and checkpoints every completed row', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'model-edit-checkpoint-'));
    const checkpoint = resolve(root, 'receipt.json');
    const snapshots: number[] = [];
    try {
      const runs = await runTaskBatch({
        tasks: [{ id: 'first' }, { id: 'second' }],
        runOne: async (entry: { id: string }) => {
          if (entry.id === 'first') throw new Error('setup failed');
          return { id: entry.id, failed: false };
        },
        buildFailure: async (entry: { id: string }, error: Error) => ({
          id: entry.id,
          failed: true,
          reason: error.message,
        }),
        onCompleted: async (completed: unknown[]) => {
          snapshots.push(completed.length);
          await writeReceipt(checkpoint, {
            completion: { status: 'in-progress', completed_tasks: completed.length },
            tasks: completed,
          });
        },
      });

      expect(runs).toEqual([
        { id: 'first', failed: true, reason: 'setup failed' },
        { id: 'second', failed: false },
      ]);
      expect(snapshots).toEqual([1, 2]);
      expect(JSON.parse(readFileSync(checkpoint, 'utf8'))).toMatchObject({
        completion: { status: 'in-progress', completed_tasks: 2 },
        tasks: [{ id: 'first', failed: true }, { id: 'second', failed: false }],
      });
      expect(readdirSync(root).filter((name) => name.includes('.tmp-'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('model-eval-run CLI', () => {
  it('does not let npm package metadata impersonate a probed binary version', () => {
    expect(
      versionProbeEnv({
        PATH: '/fixture/bin',
        npm_package_version: '0.5.0',
        npm_config_user_agent: 'npm/11',
        NPM_COMMAND: 'run-script',
        SAFE_FLAG: '1',
      })
    ).toEqual({ PATH: '/fixture/bin', SAFE_FLAG: '1' });
  });

  it('keeps structured-edit defaults outside the incompatible general ingest directory', () => {
    const output = defaultReceiptPath(
      '2026-07-13T18:45:00.000Z',
      resolve(tmpdir(), 'structured-edit-default')
    );
    expect(output).toContain('/.claude/model-evals/structured-edit-results/');
    expect(output).not.toContain('/.claude/model-evals/results/');
    expect(output).toMatch(/structured-edit-2026-07-13T18-45-00-000Z\.json$/);
  });

  it('replays and scores all committed expected outputs without network access', () => {
    const stdout = execFileSync(
      process.execPath,
      [
        '--import',
        './scripts/register-ts.mjs',
        'scripts/model-eval-run.mjs',
        '--score-expected',
        '--print',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    const result = JSON.parse(stdout);
    expect(result.execution).toEqual({
      mode: 'offline-score',
      jail: 'none',
      egress: 'none',
      max_budget_usd: null,
    });
    expect(result.tasks).toHaveLength(6);
    expect(result.totals).toMatchObject({
      n: 6,
      byte_exact_matches: 6,
      normalized_matches: 6,
      verification_passes: 6,
    });
    expect(result.by_task_class.map((entry: { n: number }) => entry.n)).toEqual([2, 2, 2]);
  });

  it('scores byte-correct task.ts when optional offline telemetry is malformed', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'model-edit-malformed-telemetry-'));
    const id = 'authoring-retry-boundary';
    const taskDir = resolve(root, id);
    try {
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(
        resolve(taskDir, 'task.ts'),
        readFileSync(resolve(CORPUS_ROOT, `structured-edit/${id}/expected.ts`), 'utf8')
      );
      writeFileSync(resolve(taskDir, 'telemetry.json'), '{not-json');
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          './scripts/register-ts.mjs',
          'scripts/model-eval-run.mjs',
          '--responses',
          root,
          '--model',
          'fixture-model',
          '--task',
          id,
          '--print',
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' }
      );

      expect(result.status, result.stderr).toBe(0);
      const row = JSON.parse(result.stdout).tasks[0];
      expect(row).toMatchObject({
        byte_exact_match: true,
        verification_passed: true,
        transport_failure: false,
        ghost_run: false,
        zero_activity_run: false,
        telemetry: {
          telemetry_complete: false,
          duration_ms: null,
          cost_usd: null,
        },
      });
      expect(row.attempts).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats absent offline telemetry as unknown, never zero activity or ghost evidence', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'model-edit-missing-telemetry-'));
    const id = 'authoring-retry-boundary';
    const taskDir = resolve(root, id);
    try {
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(
        resolve(taskDir, 'task.ts'),
        readFileSync(resolve(CORPUS_ROOT, `structured-edit/${id}/input.ts`), 'utf8')
      );
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          './scripts/register-ts.mjs',
          'scripts/model-eval-run.mjs',
          '--responses',
          root,
          '--model',
          'fixture-model',
          '--task',
          id,
          '--print',
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' }
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).tasks[0]).toMatchObject({
        verification_passed: false,
        read_without_edit: false,
        ghost_run: false,
        zero_activity_run: false,
        telemetry: {
          input_tokens: 0,
          output_tokens: 0,
          read_calls: 0,
          edit_calls: 0,
          write_calls: 0,
          telemetry_complete: false,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails before loading the jail when live invocation is not explicitly enabled', () => {
    const env = { ...process.env };
    delete env.CHD_MODEL_EDIT_EVAL;
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        './scripts/register-ts.mjs',
        'scripts/model-eval-run.mjs',
        '--model',
        'fixture-model',
        '--task',
        'authoring-retry-boundary',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', env }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('live model invocation is disabled');
    expect(result.stderr).toContain('CHD_MODEL_EDIT_EVAL=1');
  });

  it('records a corpus symlink escape as a task-boundary failure row', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'model-edit-corpus-'));
    const outside = mkdtempSync(resolve(tmpdir(), 'model-edit-outside-'));
    try {
      writeFileSync(resolve(outside, 'source.ts'), 'export const ok = true;\n');
      symlinkSync(resolve(outside, 'source.ts'), resolve(root, 'source.ts'));
      mkdirSync(resolve(root, 'task'), { recursive: true });
      writeFileSync(resolve(root, 'task/input.ts'), 'export const ok = false;\n');
      writeFileSync(resolve(root, 'task/expected.ts'), 'export const ok = true;\n');
      writeFileSync(resolve(root, 'NOTICE.md'), 'MIT\n');
      const entry = (id: string, taskClass: 'authoring' | 'mechanical' | 'review') => ({
        id,
        title: id,
        instruction: 'Fix task.ts.',
        taskClass,
        sourcePath: 'source.ts',
        inputPath: 'task/input.ts',
        expectedPath: 'task/expected.ts',
        mutation: { kind: 'flip-boolean', candidateIndex: 0, from: 'true', to: 'false' },
        tags: ['structured-edit'],
      });
      writeFileSync(
        resolve(root, 'manifest.json'),
        JSON.stringify({
          schemaVersion: 1,
          kind: 'structured-edit-corpus',
          id: 'symlink-test',
          provenance: {
            method: 'adapted',
            upstream: 'https://example.test/upstream',
            upstreamCommit: 'a'.repeat(40),
            license: 'MIT',
            noticePath: 'NOTICE.md',
          },
          tasks: [
            entry('authoring-link', 'authoring'),
            entry('mechanical-link', 'mechanical'),
            entry('review-link', 'review'),
          ],
        })
      );
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          './scripts/register-ts.mjs',
          'scripts/model-eval-run.mjs',
          '--manifest',
          resolve(root, 'manifest.json'),
          '--task',
          'authoring-link',
          '--score-expected',
          '--print',
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' }
      );
      expect(result.status).toBe(0);
      const receipt = JSON.parse(result.stdout);
      expect(receipt.completion).toEqual({
        status: 'complete',
        selected_tasks: 1,
        completed_tasks: 1,
      });
      expect(receipt.tasks[0]).toMatchObject({
        task_id: 'authoring-link',
        verification_passed: false,
        transport_failure: true,
        telemetry: { telemetry_complete: false },
        attempts: [{ phase: 'task-boundary', output_parsed: false }],
      });
      expect(receipt.tasks[0].telemetry.failure_reason).toContain(
        'corpus path resolves outside its root'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('records an offline response symlink escape without aborting the batch', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'model-edit-responses-'));
    const outside = mkdtempSync(resolve(tmpdir(), 'model-edit-response-outside-'));
    try {
      const taskDir = resolve(root, 'authoring-retry-boundary');
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(resolve(outside, 'task.ts'), 'export const escaped = true;\n');
      symlinkSync(resolve(outside, 'task.ts'), resolve(taskDir, 'task.ts'));
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          './scripts/register-ts.mjs',
          'scripts/model-eval-run.mjs',
          '--responses',
          root,
          '--model',
          'fixture-model',
          '--task',
          'authoring-retry-boundary',
          '--print',
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' }
      );
      expect(result.status).toBe(0);
      const receipt = JSON.parse(result.stdout);
      expect(receipt.tasks[0]).toMatchObject({
        task_id: 'authoring-retry-boundary',
        verification_passed: false,
        transport_failure: true,
        telemetry: { telemetry_complete: false, cost_usd: null, duration_ms: null },
        attempts: [{ phase: 'task-boundary', output_parsed: false }],
      });
      expect(receipt.tasks[0].telemetry.failure_reason).toContain(
        'corpus path resolves outside its root'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
