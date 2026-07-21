#!/usr/bin/env node
/**
 * Host-only free-form vs schema-constrained analyze repair-rate runner (#2725).
 *
 * Runs the two-arm measurement over the committed corpus and prints the
 * comparison record `{ taskClass, nSamples, passFreeForm, passConstrained,
 * repairRoundsHistogram, asOf }` (shaped for #2138's confidence loop).
 *
 * OFFLINE + ZERO EXTERNAL EGRESS. The "endpoint" is an in-process synthetic
 * (loopback-equivalent) transport that replays each sample's scripted
 * completions; this runner opens no socket and calls no external service. The
 * record it emits is stamped `endpointKind: 'scripted'` so a fixture run can
 * never be over-read as a live receipt. It is HOST-ONLY (ADR 0007): it imports
 * the analyze contract + the #2682 repair loop from src/lib TypeScript. It is
 * copied into the image but stays inert — it must never enter the server boot
 * graph.
 *
 * The constrained arm reuses `runLocalAnalyze` (local-analyze.ts), which runs
 * the bounded repair loop from schema-repair.ts verbatim — no forked logic.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseAnalyzeEvalCorpus,
  runAnalyzeEval,
  scriptedAnalyzeEndpoint,
} from '../src/lib/local-analyze-eval.ts';

const RUNNER_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(RUNNER_PATH), '..');
const DEFAULT_CORPUS = join(REPO_ROOT, 'fixtures', 'local-analyze-eval', 'corpus.json');

function usage() {
  return `Usage: npm run eval:analyze-repair -- [options]

Offline, zero external egress. Reads a committed analyze corpus and prints the
free-form vs schema-constrained repair-rate comparison record.

Options:
  --corpus PATH   Corpus JSON (default fixtures/local-analyze-eval/corpus.json).
  --out PATH      Also write the record JSON to PATH.
  -h, --help      Show this help.`;
}

function parseArgs(argv) {
  const args = { corpus: DEFAULT_CORPUS, out: null, help: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--corpus') args.corpus = rest[++i];
    else if (arg === '--out') args.out = rest[++i];
    else if (arg === '-h' || arg === '--help') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.corpus === undefined) throw new Error('--corpus requires a path');
  if (args.out === undefined) throw new Error('--out requires a path');
  return args;
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
  const samples = parseAnalyzeEvalCorpus(parsed);
  if (!samples) {
    throw new Error(`corpus at ${args.corpus} is malformed (fail-closed parse rejected it)`);
  }

  const record = await runAnalyzeEval({
    samples,
    endpoint: scriptedAnalyzeEndpoint,
    endpointKind: 'scripted',
    asOf: new Date().toISOString(),
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
