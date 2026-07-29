#!/usr/bin/env node
/**
 * Host-only free-form vs schema-constrained structured-edit repair runner (#2726).
 *
 * Thin loopback driver for the edit-class repair lever. For each committed task
 * it generates BOTH arms' produced files against an in-process synthetic
 * (loopback-equivalent) endpoint — free-form (the whole file) and constrained
 * (the #2682 edit-DSL repair loop + deterministic apply) — writes them into a
 * `--responses`-style DIR, scores each produced file through the EXISTING offline
 * scorer `scoreStructuredEdit` (the same function scripts/model-eval-run.mjs's
 * `--responses DIR` path calls), and prints the per-task-class two-arm comparison
 * record (shaped for #2138's confidence loop).
 *
 * OFFLINE + ZERO EXTERNAL EGRESS. The endpoint replays each sample's scripted
 * completions; this runner opens no socket and calls no external service. It adds
 * NO transport to model-eval-run.mjs's live mode — the generated DIRs stay
 * independently scoreable by `model-eval-run.mjs --responses <dir>/<arm>`. The
 * record is stamped `endpointKind: 'scripted'` so a fixture run can never be
 * over-read as a live receipt. HOST-ONLY (ADR 0007): imports src/lib TypeScript
 * + the host-only scorer; copied into the image but inert, never in the server
 * boot graph.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildStructuredEditArmComparison,
} from '../src/lib/structured-edit-eval.ts';
import {
  generateStructuredEditArmSample,
  parseStructuredEditArmCorpus,
  scriptedStructuredEditTransport,
} from '../src/lib/structured-edit-arm-eval.ts';
import { DEFAULT_MAX_REPAIR_ROUNDS } from '../src/lib/schema-repair.ts';
import { scoreStructuredEdit } from './lib/model-edit-benchmark.ts';

/**
 * The one transport this runner uses. Both the completions and the record's
 * provenance come from it, so they cannot disagree (#3430).
 */
const TRANSPORT = scriptedStructuredEditTransport;

const RUNNER_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(RUNNER_PATH), '..');
const DEFAULT_CORPUS = join(REPO_ROOT, 'fixtures', 'structured-edit-arm-eval', 'corpus.json');

function usage() {
  return `Usage: npm run eval:structured-edit-arm -- [options]

Offline, zero external egress. Reads a committed structured-edit arm corpus,
generates both arms' produced files against a synthetic loopback endpoint, scores
them through the existing offline scorer, and prints the free-form vs
schema-constrained per-task-class comparison record.

Options:
  --corpus PATH         Corpus JSON (default fixtures/structured-edit-arm-eval/corpus.json).
  --responses-dir DIR   Also write DIR/<arm>/<task-id>/task.ts (scoreable by
                        model-eval-run.mjs --responses DIR/<arm>).
  --out PATH            Also write the comparison record JSON to PATH.
  -h, --help            Show this help.`;
}

function parseArgs(argv) {
  const args = {
    corpus: DEFAULT_CORPUS,
    responsesDir: null,
    out: null,
    help: false,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--corpus') args.corpus = rest[++i];
    else if (arg === '--responses-dir') args.responsesDir = rest[++i];
    else if (arg === '--out') args.out = rest[++i];
    else if (arg === '-h' || arg === '--help') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.corpus === undefined) throw new Error('--corpus requires a path');
  if (args.responsesDir === undefined) throw new Error('--responses-dir requires a path');
  if (args.out === undefined) throw new Error('--out requires a path');
  return args;
}

async function writeArmResponse(responsesDir, arm, taskId, content) {
  const dir = join(resolve(responsesDir), arm, taskId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'task.ts'), content);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const raw = await readFile(args.corpus, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`corpus at ${args.corpus} is not valid JSON`);
  }
  const samples = parseStructuredEditArmCorpus(parsed);
  if (!samples) {
    throw new Error(`corpus at ${args.corpus} is malformed (fail-closed parse rejected it)`);
  }

  const outcomes = [];
  for (const sample of samples) {
    const gen = await generateStructuredEditArmSample(
      sample,
      TRANSPORT,
      DEFAULT_MAX_REPAIR_ROUNDS
    );
    if (args.responsesDir) {
      await writeArmResponse(args.responsesDir, 'free-form', sample.id, gen.freeFormContent);
      await writeArmResponse(args.responsesDir, 'constrained', sample.id, gen.constrainedContent);
    }
    // Score both arms' produced files through the SAME offline scorer the
    // `--responses DIR` path uses; verification_passed is the quality gate.
    const [freeScore, constrainedScore] = await Promise.all([
      scoreStructuredEdit(sample.expected, gen.freeFormContent, 'task.ts'),
      scoreStructuredEdit(sample.expected, gen.constrainedContent, 'task.ts'),
    ]);
    outcomes.push({
      task_id: sample.id,
      task_class: sample.taskClass,
      pass_free_form: freeScore.verification_passed,
      pass_constrained: constrainedScore.verification_passed,
      repair_rounds: gen.repairRounds,
    });
  }

  const record = buildStructuredEditArmComparison(outcomes, {
    asOf: new Date().toISOString(),
    maxRepairRounds: DEFAULT_MAX_REPAIR_ROUNDS,
    // Read off the transport that produced the completions above, never a
    // hand-written literal (#3430).
    endpointKind: TRANSPORT.kind,
  });

  const json = `${JSON.stringify(record, null, 2)}\n`;
  process.stdout.write(json);
  if (args.out) {
    await mkdir(dirname(resolve(args.out)), { recursive: true });
    await writeFile(args.out, json);
    console.error(`Wrote ${args.out}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === RUNNER_PATH) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('');
    console.error(usage());
    process.exitCode = 1;
  });
}
