import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  buildModelEvalBatchSpec,
  buildFixtureBackedBatchSpec,
} from '../src/lib/model-eval-batch.ts';
import { CURATED_CORPUS } from '../src/lib/model-eval-corpus.ts';
import { CURRENT_MODEL_IDS } from '../src/lib/model-registry.ts';

function usage() {
  return [
    'Usage: node --import ./scripts/register-ts.mjs scripts/model-eval-batch.mjs --candidate=<model> [options]',
    '',
    'Options:',
    '  --candidate=<id>    Candidate model to compare. Repeatable or comma-separated.',
    '  --baseline=<id>     Baseline model. Repeatable or comma-separated. Defaults to current Opus/Sonnet/Haiku.',
    '  --corpus=<source>   shadow-calls | replay-history | curated-fixtures. Default: shadow-calls.',
    '  --limit=<n>         Max tasks to include. Default: 20.',
    '  --out=<dir>         Output directory. Default: .claude/model-evals.',
    '  --print            Print JSON to stdout instead of writing the artifact.',
  ].join('\n');
}

function valuesFor(args, name) {
  const prefix = `--${name}=`;
  return args
    .filter((arg) => arg.startsWith(prefix))
    .flatMap((arg) => arg.slice(prefix.length).split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function valueFor(args, name) {
  const found = valuesFor(args, name);
  return found.length > 0 ? found[found.length - 1] : undefined;
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(usage());
  process.exit(0);
}

const candidates = valuesFor(args, 'candidate');
const baselines = valuesFor(args, 'baseline');
const corpus = valueFor(args, 'corpus');
const limitRaw = valueFor(args, 'limit');
const outDir = valueFor(args, 'out') ?? '.claude/model-evals';
const printOnly = args.includes('--print');
const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

if (limitRaw && (!Number.isFinite(limit) || (limit ?? 0) <= 0)) {
  console.error('--limit must be a positive integer.');
  process.exit(1);
}

try {
  const batchInput = {
    candidates,
    baselines: baselines.length > 0
      ? baselines
      : [CURRENT_MODEL_IDS.opus, CURRENT_MODEL_IDS.sonnet, CURRENT_MODEL_IDS.haiku],
    corpus,
    limit,
    outDir,
  };
  const spec = corpus === 'curated-fixtures'
    ? buildFixtureBackedBatchSpec(batchInput, CURATED_CORPUS)
    : buildModelEvalBatchSpec(batchInput);
  const json = `${JSON.stringify(spec, null, 2)}\n`;

  if (printOnly) {
    process.stdout.write(json);
  } else {
    const outputPath = resolve(spec.output.path);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, json, 'utf8');
    console.log(`Wrote ${outputPath}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error('');
  console.error(usage());
  process.exit(1);
}
